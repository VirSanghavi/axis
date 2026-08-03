import fs from "fs/promises";
import path from "path";
import { logger } from "../utils/logger.js";
import { buildIntegrityReport, hashContent, hashFileIfExists } from "./lock-integrity.js";
import { withTempWrite } from "./fs-guard.js";
import { normalizeLockPath, orchestrationMessage, validateFileOnly } from "./lock-paths.js";
import { FileLock } from "./coordination-types.js";
import type { CoreServices } from "./core-services.js";

/**
 * File lock protocol: acquire / batch-acquire / release / force-unlock /
 * verify / guarded-write across the three persistence tiers (hosted API,
 * direct Supabase, local JSON fallback), plus lock-event audit logging and
 * opt-in physical enforcement. Extracted verbatim from NerveCenter
 * (audit #3); NerveCenter delegates and keeps the public API.
 */
export class LockRegistry {
    constructor(private core: CoreServices) {}

    private message(normalizedPath: string, ownerId?: string, intent?: string): string {
        return orchestrationMessage(this.core.lockTimeout, normalizedPath, ownerId, intent);
    }

    async listLocks(): Promise<FileLock[]> {
        const { supabase, useSupabase, projectId, coordination, store, projectName, lockTimeout } = this.core;

        // Priority: Remote API if available (for customers), then Supabase, then local
        logger.info(`[getLocks] Starting - projectName: ${projectName}`);
        logger.info(`[getLocks] Config - remoteApi: ${coordination.enabled}, useSupabase: ${useSupabase}, hasSupabase: ${!!supabase}`);

        if (coordination.enabled) {
            if (!useSupabase || !supabase) {
                // Use remote API when Supabase is not configured (customer mode)
                try {
                    logger.info(`[getLocks] Fetching locks from API for project: ${projectName}`);
                    const res = await coordination.call(`locks?projectName=${projectName}`) as { locks: Record<string, string>[] };
                    logger.info(`[getLocks] API returned ${res.locks?.length || 0} locks`);
                    return (res.locks || []).map((row) => ({
                        agentId: row.agent_id,
                        filePath: row.file_path,
                        intent: row.intent,
                        userPrompt: row.user_prompt,
                        timestamp: Date.parse(row.updated_at || row.timestamp),
                        contentHash: row.content_hash ?? undefined
                    }));
                } catch (e: unknown) {
                    logger.error(`[getLocks] Failed to fetch locks from API: ${(e as Error).message}`, e);
                    // Fall through to local fallback
                }
            }
        }

        if (useSupabase && supabase && projectId) {
            // Use direct Supabase when configured (development mode)
            try {
                // Lazy clean
                await supabase.rpc('clean_stale_locks', {
                    p_project_id: projectId,
                    p_timeout_seconds: Math.floor(lockTimeout / 1000)
                });

                const { data, error } = await supabase
                    .from('locks')
                    .select('*')
                    .eq('project_id', projectId);

                if (error) throw error;

                return (data || []).map((row: Record<string, string>) => ({
                    agentId: row.agent_id,
                    filePath: row.file_path,
                    intent: row.intent,
                    userPrompt: row.user_prompt,
                    timestamp: Date.parse(row.updated_at),
                    contentHash: row.content_hash ?? undefined
                }));
            } catch (e) {
                logger.warn("Failed to fetch locks from DB", e as Error);
                // Fall through to API or local fallback
            }
        }

        // Fallback: Try API if available, otherwise local
        if (coordination.enabled) {
            try {
                const res = await coordination.call(`locks?projectName=${projectName}`) as { locks: Record<string, string>[] };
                return (res.locks || []).map((row) => ({
                    agentId: row.agent_id,
                    filePath: row.file_path,
                    intent: row.intent,
                    userPrompt: row.user_prompt,
                    timestamp: Date.parse(row.updated_at || row.timestamp),
                    contentHash: row.content_hash ?? undefined
                }));
            } catch (e: unknown) {
                logger.error("Failed to fetch locks from API in fallback", e);
            }
        }

        return Object.values(store.current.locks);
    }

    // --- Lock Event Logging ---

    async logLockEvent(eventType: string, filePath: string, requestingAgent: string, blockingAgent?: string, intent?: string) {
        const { supabase, useSupabase, projectId, coordination } = this.core;
        try {
            if (coordination.enabled) {
                logger.info(`[logLockEvent] Logging ${eventType} event via API for ${filePath} (agent: ${requestingAgent}, blocker: ${blockingAgent || 'none'})`);
                await coordination.call("lock-events", "POST", {
                    eventType,
                    filePath,
                    requestingAgent,
                    blockingAgent: blockingAgent || null,
                    intent: intent || null,
                });
                logger.info(`[logLockEvent] Successfully logged ${eventType} event`);
            } else if (useSupabase && supabase && projectId) {
                logger.info(`[logLockEvent] Logging ${eventType} event via Supabase for ${filePath}`);
                await supabase.from("lock_events").insert({
                    project_id: projectId,
                    event_type: eventType,
                    file_path: filePath,
                    requesting_agent: requestingAgent,
                    blocking_agent: blockingAgent || null,
                    intent: intent || null,
                });
                logger.info(`[logLockEvent] Successfully logged ${eventType} event`);
            } else {
                logger.warn(`[logLockEvent] No persistence backend available — ${eventType} event for ${filePath} will not be recorded`);
            }
        } catch (e: unknown) {
            logger.error(`[logLockEvent] Failed to log ${eventType} event for ${filePath}: ${(e as Error).message}`);
        }
    }

    /**
     * Find an existing lock that conflicts with the requested path (exact match).
     * Paths are normalized before comparison so absolute and relative paths
     * targeting the same file are correctly detected as conflicts.
     */
    private findExactConflict(requestedPath: string, requestingAgent: string, locks: FileLock[]): FileLock | null {
        const normalizedRequested = normalizeLockPath(requestedPath, this.core.projectRoot);
        for (const lock of locks) {
            if (lock.agentId === requestingAgent) continue;
            const isStale = (Date.now() - lock.timestamp) > this.core.lockTimeout;
            if (isStale) continue;
            const normalizedLock = normalizeLockPath(lock.filePath, this.core.projectRoot);
            if (normalizedRequested === normalizedLock) {
                return lock;
            }
        }
        return null;
    }

    /**
     * Batch lock acquisition: one round-trip for a multi-file edit (field
     * report: the coordination-to-code ratio was too high when every file
     * cost a separate call). All-or-nothing — if any file is denied, locks
     * granted earlier in the batch are released so a partial set never
     * blocks another agent.
     *
     * Each underlying acquisition stays atomic; this wrapper must not take
     * the mutex itself (proposeFileAccess/releaseFileAccess already do).
     */
    async proposeFilesAccess(agentId: string, filePaths: string[], intent: string, userPrompt: string) {
        const results: Array<{ filePath: string; status: string; message?: string }> = [];
        const granted: string[] = [];
        for (const filePath of filePaths) {
            const result = await this.proposeFileAccess(agentId, filePath, intent, userPrompt) as { status: string; message?: string };
            results.push({ filePath, status: result.status, message: result.message });
            if (result.status === "GRANTED") {
                granted.push(filePath);
                continue;
            }
            for (const lockedPath of granted) {
                await this.releaseFileAccess(agentId, lockedPath);
            }
            return {
                status: result.status,
                message: `Batch lock failed on '${filePath}' — ${result.message ?? "denied"}. `
                    + `All-or-nothing: ${granted.length} lock(s) acquired earlier in this batch were released.`,
                failedOn: filePath,
                results
            };
        }
        return {
            status: "GRANTED",
            message: `Access granted for ${filePaths.length} file(s).`,
            results
        };
    }

    async proposeFileAccess(agentId: string, filePath: string, intent: string, userPrompt: string) {
        return await this.core.mutex.runExclusive(async () => {
            const { supabase, useSupabase, projectId, coordination, store, enforcement, lockTimeout } = this.core;

            logger.info(`[proposeFileAccess] Starting - agentId: ${agentId}, filePath: ${filePath}`);

            // --- Normalize and validate: file-only locks ---
            const normalizedPath = normalizeLockPath(filePath, this.core.projectRoot);
            logger.info(`[proposeFileAccess] Normalized path: '${normalizedPath}' (from '${filePath}')`);

            const fileCheck = await validateFileOnly(filePath, this.core.projectRoot);
            if (!fileCheck.valid) {
                logger.warn(`[proposeFileAccess] REJECTED — not a file: ${fileCheck.reason}`);
                return {
                    status: "REJECTED",
                    message: fileCheck.reason
                };
            }

            // --- Path 1: Remote API (customer mode) ---
            // Atomicity handled server-side via try_acquire_lock RPC.
            // File-only validation also enforced server-side.
            if (coordination.enabled) {
                try {
                    // Fingerprint the file locally so hosted mode can detect tampering.
                    const contentHash = await hashFileIfExists(path.resolve(process.cwd(), filePath));
                    const result = await coordination.call("locks", "POST", {
                        action: "lock",
                        filePath: normalizedPath,
                        agentId,
                        intent,
                        userPrompt,
                        contentHash
                    }) as { status?: string; message?: string; current_lock?: { agent_id?: string; intent?: string }; agent_id?: string };

                    if (result.status === "DENIED") {
                        logger.info(`[proposeFileAccess] DENIED by server: ${result.message}`);
                        await this.logLockEvent("BLOCKED", normalizedPath, agentId, result.current_lock?.agent_id, intent);
                        return {
                            status: "REQUIRES_ORCHESTRATION",
                            message: result.message
                                || this.message(normalizedPath, result.current_lock?.agent_id, result.current_lock?.intent),
                            currentLock: result.current_lock
                        };
                    }

                    if (result.status === "REJECTED") {
                        logger.warn(`[proposeFileAccess] REJECTED by server: ${result.message}`);
                        return {
                            status: "REJECTED",
                            message: result.message
                                || `Lock rejected for '${normalizedPath}'. Lock an individual file (not a directory) inside the project root.`
                        };
                    }

                    // Defense-in-depth: a GRANTED echo must be attributed to *us*.
                    // A mismatch means the server granted a different agent (or
                    // mangled attribution) — do not proceed to write on it.
                    const echoedAgent = result.agent_id;
                    if (echoedAgent && echoedAgent !== agentId) {
                        logger.error(`[proposeFileAccess] Grant attribution mismatch: server echoed '${echoedAgent}', expected '${agentId}'`);
                        return {
                            status: "REQUIRES_ORCHESTRATION",
                            message: `Lock grant attribution mismatch for '${normalizedPath}': server attributed the grant to '${echoedAgent}'. Re-sync (list_locks) and retry.`
                        };
                    }

                    logger.info(`[proposeFileAccess] GRANTED by server`);
                    await enforcement.enforce(normalizedPath, agentId, filePath);
                    await this.logLockEvent("GRANTED", normalizedPath, agentId, undefined, intent);
                    await this.core.appendToNotepad(`\n- [LOCK] ${agentId} locked ${normalizedPath}\n  Intent: ${intent}`);
                    return { status: "GRANTED", message: `Access granted for ${normalizedPath}` };
                } catch (e: unknown) {
                    const err = e as Error;
                    // If the API returned 409 (conflict), parse the DENIED response
                    if (err.message && err.message.includes("409")) {
                        logger.info(`[proposeFileAccess] Lock conflict (409)`);

                        let blockingAgent: string | undefined;
                        try {
                            const jsonMatch = err.message.match(/\{.*\}/s);
                            if (jsonMatch) {
                                const parsed = JSON.parse(jsonMatch[0]);
                                blockingAgent = parsed.current_lock?.agent_id;
                            }
                        } catch { /* best-effort extraction */ }

                        await this.logLockEvent("BLOCKED", normalizedPath, agentId, blockingAgent, intent);

                        return {
                            status: "REQUIRES_ORCHESTRATION",
                            message: this.message(normalizedPath, blockingAgent),
                        };
                    }
                    logger.error(`[proposeFileAccess] API lock failed: ${err.message}`, err);
                    return { error: `Failed to acquire lock via API: ${err.message}` };
                }
            }

            // --- Path 2: Direct Supabase (development mode) ---
            // Uses atomic try_acquire_lock RPC. Exact-path conflict only (no hierarchy).
            if (useSupabase && supabase && projectId) {
                try {
                    const { data, error } = await supabase.rpc("try_acquire_lock", {
                        p_project_id: projectId,
                        p_file_path: normalizedPath,
                        p_agent_id: agentId,
                        p_intent: intent,
                        p_user_prompt: userPrompt,
                        p_timeout_seconds: Math.floor(lockTimeout / 1000),
                    });

                    if (error) throw error;

                    const row = Array.isArray(data) ? data[0] : data;

                    if (row && row.status === "DENIED") {
                        await this.logLockEvent("BLOCKED", normalizedPath, agentId, row.owner_id, intent);
                        return {
                            status: "REQUIRES_ORCHESTRATION",
                            message: this.message(normalizedPath, row.owner_id, row.intent),
                            currentLock: {
                                agentId: row.owner_id,
                                filePath: normalizedPath,
                                intent: row.intent,
                                timestamp: row.updated_at ? Date.parse(row.updated_at) : Date.now()
                            }
                        };
                    }

                    // Persist a content fingerprint for tamper detection. Best-effort:
                    // tolerate the column being absent until migration 0009 is applied.
                    try {
                        const contentHash = await hashFileIfExists(path.resolve(process.cwd(), filePath));
                        if (contentHash) {
                            await supabase
                                .from("locks")
                                .update({ content_hash: contentHash })
                                .eq("project_id", projectId)
                                .eq("file_path", normalizedPath)
                                .eq("agent_id", agentId);
                        }
                    } catch (hashErr) {
                        logger.warn("[NerveCenter] Could not persist lock content_hash (migration 0009 applied?)", hashErr as Error);
                    }

                    await enforcement.enforce(normalizedPath, agentId, filePath);
                    await this.logLockEvent("GRANTED", normalizedPath, agentId, undefined, intent);
                    await this.core.appendToNotepad(`\n- [LOCK] ${agentId} locked ${normalizedPath}\n  Intent: ${intent}`);
                    return { status: "GRANTED", message: `Access granted for ${normalizedPath}` };
                } catch (e: unknown) {
                    logger.warn("[NerveCenter] Lock RPC failed. Falling back to local.", e as Error);
                }
            }

            // --- Path 3: Local-only fallback ---
            // Exact-path conflict check with normalized paths.
            const allLocks = Object.values(store.current.locks);
            const conflict = this.findExactConflict(filePath, agentId, allLocks);
            if (conflict) {
                await this.logLockEvent("BLOCKED", normalizedPath, agentId, conflict.agentId, intent);
                return {
                    status: "REQUIRES_ORCHESTRATION",
                    message: this.message(normalizedPath, conflict.agentId, conflict.intent),
                    currentLock: conflict
                };
            }

            const contentHash = await hashFileIfExists(path.resolve(process.cwd(), filePath));
            store.current.locks[normalizedPath] = { agentId, filePath: normalizedPath, intent, userPrompt, timestamp: Date.now(), contentHash };
            await store.save();
            await enforcement.enforce(normalizedPath, agentId, filePath);
            await this.logLockEvent("GRANTED", normalizedPath, agentId, undefined, intent);
            await this.core.appendToNotepad(`\n- [LOCK] ${agentId} locked ${normalizedPath}\n  Intent: ${intent}`);
            // Reaching Path 3 with a board configured means the board was
            // unreachable, which is a materially different situation from never
            // having had one.
            const degraded = coordination.enabled || useSupabase;
            return {
                status: "GRANTED",
                scope: "local" as const,
                message: this.localGrantMessage(normalizedPath, degraded)
            };
        });
    }

    /**
     * A grant from the local fallback binds this machine and nothing else.
     * Saying so in the response is correctness, not promotion: an agent handed
     * a bare "GRANTED" reports to its user that the file is safe to edit, and
     * on a team that is simply false. The lock is real, its scope is not what
     * the word implies, and stderr warnings do not reach anyone because MCP
     * clients do not surface them.
     */
    private localGrantMessage(normalizedPath: string, degraded: boolean): string {
        return degraded
            ? `Access granted for ${normalizedPath}, but on this machine only: the shared board was unreachable, so this lock is invisible to agents elsewhere and they are not blocked from this file.`
            : `Access granted for ${normalizedPath} (this machine only). No shared board is configured, so agents run by other people on this repository are not blocked from this file.`;
    }

    async releaseFileAccess(agentId: string, filePath: string) {
        return await this.core.mutex.runExclusive(async () => {
            const { supabase, useSupabase, projectId, coordination, store, enforcement } = this.core;
            const normalizedPath = normalizeLockPath(filePath, this.core.projectRoot);

            if (coordination.enabled) {
                try {
                    const result = await coordination.call("locks", "POST", {
                        action: "unlock",
                        filePath: normalizedPath,
                        agentId
                    }) as { status?: string };
                    await enforcement.restore(normalizedPath);
                    await this.core.appendToNotepad(`\n- [UNLOCK] ${agentId} released ${normalizedPath}`);
                    return result?.status ? result : { status: "RELEASED", filePath: normalizedPath };
                } catch (e: unknown) {
                    return { status: "ERROR", message: `Failed to release remote lock: ${(e as Error).message}` };
                }
            }

            if (useSupabase && supabase && projectId) {
                const { data, error } = await supabase
                    .from("locks")
                    .delete()
                    .eq("project_id", projectId)
                    .eq("file_path", normalizedPath)
                    .eq("agent_id", agentId)
                    .select("file_path");
                if (error) return { status: "ERROR", message: error.message };
                if (!data || data.length === 0) {
                    return { status: "NOT_OWNER", message: `No lock on '${normalizedPath}' is owned by '${agentId}'.` };
                }
                await enforcement.restore(normalizedPath);
                await this.core.appendToNotepad(`\n- [UNLOCK] ${agentId} released ${normalizedPath}`);
                return { status: "RELEASED", filePath: normalizedPath };
            }

            const lock = store.current.locks[normalizedPath];
            if (!lock) return { status: "NOT_FOUND", message: `No active lock for '${normalizedPath}'.` };
            if (lock.agentId !== agentId) {
                return {
                    status: "NOT_OWNER",
                    message: `Lock on '${normalizedPath}' belongs to '${lock.agentId}'.`
                };
            }
            delete store.current.locks[normalizedPath];
            await enforcement.restore(normalizedPath);
            await this.core.appendToNotepad(`\n- [UNLOCK] ${agentId} released ${normalizedPath}`);
            return { status: "RELEASED", filePath: normalizedPath };
        });
    }

    async forceUnlock(filePath: string, reason: string) {
        return await this.core.mutex.runExclusive(async () => {
            const { supabase, useSupabase, projectId, coordination, store, enforcement } = this.core;

            if (useSupabase && supabase && projectId) {
                await supabase
                    .from("locks")
                    .delete()
                    .eq("project_id", projectId)
                    .eq("file_path", filePath);
            } else if (coordination.enabled) {
                try {
                    // Deliberate admin override — distinct from a scoped "unlock"
                    // so the server can tell an owner-release (agent_id-scoped
                    // delete) from a force-unlock and audit them differently.
                    await coordination.call("locks", "POST", { action: "force_unlock", filePath, reason });
                } catch (e: unknown) {
                    const err = e as Error;
                    // Older deployed servers only know "unlock" — fall back so
                    // force-unlock keeps working across the deploy boundary.
                    if (typeof err.message === "string" && err.message.includes("Invalid action")) {
                        try {
                            await coordination.call("locks", "POST", { action: "unlock", filePath, reason });
                        } catch (legacyError: unknown) {
                            logger.error("Failed to force unlock via API (legacy path)", legacyError);
                        }
                    } else {
                        logger.error("Failed to force unlock via API", err);
                    }
                }
            }

            if (store.current.locks[filePath]) {
                delete store.current.locks[filePath];
                await store.save();
            }
            // Restore perms whether the path was stored normalized or absolute.
            await enforcement.restore(normalizeLockPath(filePath, this.core.projectRoot));

            await this.logLockEvent("FORCE_UNLOCKED", filePath, "admin", undefined, reason);
            await this.core.appendToNotepad(`\n- [FORCE UNLOCK] ${filePath} unlocked by admin. Reason: ${reason}`);
            return `File ${filePath} has been forcibly unlocked.`;
        });
    }

    /**
     * Tamper check for a held lock: compare the file's current content against
     * the fingerprint captured when the lock was granted. Lets a holder confirm
     * nobody rewrote the file out from under their (advisory) lock before they
     * overwrite it — the realistic defense against the "edited, then clobbered"
     * collision. Remote-backed locks without a stored hash return "unknown".
     */
    async verifyFileAccess(agentId: string, filePath: string) {
        return await this.core.mutex.runExclusive(async () => {
            const { store } = this.core;
            const normalizedPath = normalizeLockPath(filePath, this.core.projectRoot);
            const lock = store.current.locks[normalizedPath]
                || (await this.listLocks()).find(
                    (l) => normalizeLockPath(l.filePath, this.core.projectRoot) === normalizedPath
                );

            if (!lock) {
                return {
                    status: "NO_LOCK",
                    message: `No active lock for '${normalizedPath}'. Acquire one with propose_file_access first.`,
                };
            }

            const currentHash = await hashFileIfExists(path.resolve(process.cwd(), filePath));
            const report = buildIntegrityReport(lock.contentHash, currentHash, lock.contentHash !== undefined);
            const heldByOther = lock.agentId !== agentId;

            if (report.tampered) {
                return {
                    status: "CONFLICT",
                    verdict: report.verdict,
                    heldBy: lock.agentId,
                    message: `File '${normalizedPath}' was ${report.verdict} since the lock was granted${heldByOther ? ` (lock held by '${lock.agentId}')` : ""}. Re-read it before writing to avoid clobbering concurrent changes.`,
                };
            }

            if (report.verdict === "unknown") {
                return {
                    status: "UNKNOWN",
                    heldBy: lock.agentId,
                    message: `No fingerprint recorded for '${normalizedPath}' (remote-backed lock); integrity can't be verified.`,
                };
            }

            return {
                status: "OK",
                verdict: report.verdict,
                heldBy: lock.agentId,
                message: `'${normalizedPath}' is unchanged since the lock was granted.`,
            };
        });
    }

    /**
     * Write a file THROUGH the lock — the enforced (not just evident) path.
     * The server performs the write only if the caller holds the lock AND the
     * file hasn't changed since the lock was granted (optimistic concurrency),
     * then refreshes the fingerprint. Agents that route writes here cannot
     * clobber a file locked by someone else or overwrite concurrent changes —
     * real prevention, where verify_file_lock is only detection.
     */
    async guardedWrite(agentId: string, filePath: string, content: string) {
        return await this.core.mutex.runExclusive(async () => {
            const { store, enforcement } = this.core;
            const normalizedPath = normalizeLockPath(filePath, this.core.projectRoot);

            const fileCheck = await validateFileOnly(filePath, this.core.projectRoot);
            if (!fileCheck.valid) return { status: "REJECTED", message: fileCheck.reason };

            const lock = store.current.locks[normalizedPath]
                || (await this.listLocks()).find(
                    (l) => normalizeLockPath(l.filePath, this.core.projectRoot) === normalizedPath
                );
            if (!lock) {
                return { status: "NO_LOCK", message: `Acquire a lock with propose_file_access before writing '${normalizedPath}'.` };
            }
            if (lock.agentId !== agentId) {
                return { status: "DENIED", message: this.message(normalizedPath, lock.agentId, lock.intent) };
            }

            const absolutePath = path.resolve(process.cwd(), filePath);
            const currentHash = await hashFileIfExists(absolutePath);
            // Optimistic concurrency: refuse if the file changed since the lock
            // was granted (someone edited it outside this lock).
            if (lock.contentHash !== undefined && currentHash !== undefined && currentHash !== lock.contentHash) {
                return {
                    status: "CONFLICT",
                    message: `'${normalizedPath}' changed since you locked it. Re-read and re-lock before writing to avoid clobbering concurrent changes.`,
                };
            }

            const doWrite = async () => {
                await fs.mkdir(path.dirname(absolutePath), { recursive: true });
                await fs.writeFile(absolutePath, content);
            };
            const enforced = enforcement.get(normalizedPath);
            if (enforcement.isEnabled && enforced) {
                // File is read-only on disk; restore perms just for this write.
                await withTempWrite(absolutePath, enforced.mode, doWrite);
            } else {
                await doWrite();
            }

            // Refresh the fingerprint so later verifies/writes compare against
            // what we just wrote.
            if (store.current.locks[normalizedPath]) {
                store.current.locks[normalizedPath].contentHash = hashContent(content);
                store.current.locks[normalizedPath].timestamp = Date.now();
                await store.save();
            }
            await this.core.appendToNotepad(`\n- [WRITE] ${agentId} wrote ${normalizedPath} (guarded)`);
            return { status: "WRITTEN", filePath: normalizedPath, bytes: Buffer.byteLength(content) };
        });
    }
}
