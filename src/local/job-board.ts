import { logger } from "../utils/logger.js";
import { findReclaimable, isReclaimable } from "./job-hygiene.js";
import { Job, JobRecord, jobFromRecord } from "./coordination-types.js";
import type { CoreServices } from "./core-services.js";

/**
 * Job Board protocol: post / claim / complete / cancel across the three
 * persistence tiers (direct Supabase in dev, hosted API for customers,
 * local JSON-file fallback). Extracted verbatim from NerveCenter (audit #3);
 * NerveCenter delegates and keeps the public API.
 */
export class JobBoard {
    constructor(private core: CoreServices) {}

    async listJobs(): Promise<Job[]> {
        const { supabase, useSupabase, projectId, coordination, store, projectName } = this.core;

        if (useSupabase && supabase && projectId) {
            const { data, error } = await supabase
                .from("jobs")
                .select("id,title,description,priority,status,assigned_to,dependencies,created_at,updated_at")
                .eq("project_id", projectId);

            if (error || !data) {
                logger.error("Failed to load jobs from Supabase", error);
                return [];
            }
            return (data as JobRecord[]).map((record) => jobFromRecord(record));
        }

        if (coordination.enabled) {
            try {
                const url = `jobs?projectName=${projectName}`;
                const res = await coordination.call(url) as { jobs: JobRecord[] };
                return (res.jobs || []).map((record: JobRecord) => jobFromRecord(record));
            } catch (e: unknown) {
                logger.error("Failed to load jobs from API", e);
                return Object.values(store.current.jobs);
            }
        }

        return Object.values(store.current.jobs);
    }

    async postJob(title: string, description: string, priority: Job["priority"] = "medium", dependencies: string[] = []) {
        return await this.core.mutex.runExclusive(async () => {
            const { supabase, useSupabase, projectId, coordination, store } = this.core;
            let id = `job-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            const completionKey = Math.random().toString(36).substring(2, 10).toUpperCase();
            const now = Date.now();
            const localJob: Job = {
                id,
                title,
                description,
                priority,
                dependencies,
                status: "todo",
                createdAt: now,
                updatedAt: now,
                completionKey
            };

            if (useSupabase && supabase && projectId) {
                const { data, error } = await supabase
                    .from("jobs")
                    .insert({
                        project_id: projectId,
                        title,
                        description,
                        priority,
                        status: "todo",
                        dependencies,
                        completion_key: completionKey
                    })
                    .select("id")
                    .single();

                if (data?.id) id = data.id;
                if (error) {
                    logger.error("Failed to post job to Supabase", error);
                    return { status: "ERROR", error: "Failed to persist job to Supabase" };
                }
            } else if (coordination.enabled) {
                try {
                    const data = await coordination.call('jobs', 'POST', {
                        action: 'post',
                        title,
                        description,
                        priority,
                        dependencies,
                        completion_key: completionKey
                    }) as { id?: string };
                    if (data?.id) id = data.id;
                } catch (e: unknown) {
                    logger.error("Failed to post job to API", e);
                    return { status: "ERROR", error: `Failed to persist job to remote API: ${(e as Error).message}` };
                }
            } else {
                localJob.id = id;
                store.current.jobs[id] = localJob;
            }

            const depText = dependencies.length ? ` (Depends on: ${dependencies.join(", ")})` : "";
            const logEntry = `\n- [JOB POSTED] [${priority.toUpperCase()}] ${title} (ID: ${id})${depText}`;
            await this.core.appendToNotepad(logEntry);
            return { jobId: id, status: "POSTED", completionKey };
        });
    }

    async claimNextJob(agentId: string) {
        return await this.core.mutex.runExclusive(async () => {
            const { supabase, useSupabase, projectId, coordination, store, lockTimeout } = this.core;

            // --- Path 1: Direct Supabase (dev mode) - uses atomic RPC ---
            if (useSupabase && supabase && projectId) {
                const { data, error } = await supabase.rpc("claim_next_job", {
                    p_project_id: projectId,
                    p_agent_id: agentId
                });

                if (error) {
                    logger.error("Failed to claim job via RPC", error);
                } else if (data && data.status === "CLAIMED") {
                    const job = jobFromRecord(data.job as JobRecord);
                    await this.core.appendToNotepad(`\n- [JOB CLAIMED] Agent '${agentId}' picked up: ${job.title}`);
                    return { status: "CLAIMED", job };
                }

                return { status: "NO_JOBS_AVAILABLE", message: "Relax. No open tickets (or dependencies not met)." };
            }

            // --- Path 2: Remote API (customer mode) - uses atomic claim action ---
            if (coordination.enabled) {
                try {
                    const data = await coordination.call("jobs", "POST", {
                        action: "claim",
                        agentId,
                    }) as { status?: string; job?: JobRecord };

                    if (data && data.status === "CLAIMED" && data.job) {
                        const job = jobFromRecord(data.job);
                        await this.core.appendToNotepad(`\n- [JOB CLAIMED] Agent '${agentId}' picked up: ${job.title}`);
                        return { status: "CLAIMED", job };
                    }

                    return { status: "NO_JOBS_AVAILABLE", message: "Relax. No open tickets (or dependencies not met)." };
                } catch (e: unknown) {
                    logger.error("Failed to claim job via API", e);
                    return { status: "NO_JOBS_AVAILABLE", message: `Claim failed: ${(e as Error).message}` };
                }
            }

            // --- Path 3: Local-only fallback ---
            const priorities = ["critical", "high", "medium", "low"];
            const allJobs = Object.values(store.current.jobs);

            // Reclaim abandoned jobs: anything stuck in_progress past the lock
            // timeout (its agent is effectively gone) returns to the board so it
            // stops silently blocking work.
            const reclaimable = findReclaimable(
                allJobs.map((job) => ({ id: job.id, status: job.status, updatedAt: job.updatedAt })),
                Date.now(),
                lockTimeout
            );
            for (const stale of reclaimable) {
                const job = store.current.jobs[stale.id];
                if (job) {
                    job.status = "todo";
                    job.assignedTo = undefined;
                    job.updatedAt = Date.now();
                    await this.core.appendToNotepad(`\n- [JOB RECLAIMED] '${job.title}' was abandoned in_progress; returned to the board.`);
                }
            }

            const jobsById = new Map(allJobs.map((job) => [job.id, job]));
            const availableJobs = allJobs
                .filter((job) => job.status === "todo")
                .filter((job) => {
                    if (!job.dependencies || job.dependencies.length === 0) return true;
                    return job.dependencies.every((depId) => jobsById.get(depId)?.status === "done");
                })
                .sort((a, b) => {
                    const pA = priorities.indexOf(a.priority);
                    const pB = priorities.indexOf(b.priority);
                    if (pA !== pB) return pA - pB;
                    return a.createdAt - b.createdAt;
                });

            if (availableJobs.length === 0) {
                return { status: "NO_JOBS_AVAILABLE", message: "Relax. No open tickets (or dependencies not met)." };
            }

            const job = availableJobs[0];
            job.status = "in_progress";
            job.assignedTo = agentId;
            job.updatedAt = Date.now();
            await this.core.appendToNotepad(`\n- [JOB CLAIMED] Agent '${agentId}' picked up: ${job.title}`);
            return { status: "CLAIMED", job };
        });
    }

    async claimJob(agentId: string, jobId: string) {
        return await this.core.mutex.runExclusive(async () => {
            const { supabase, useSupabase, projectId, coordination, store } = this.core;

            const jobs = await this.listJobs();
            const job = jobs.find((candidate) => candidate.id === jobId);
            if (!job) return { status: "NOT_FOUND", message: `Job '${jobId}' was not found.` };
            if (job.status !== "todo") {
                return { status: "NOT_AVAILABLE", message: `Job '${jobId}' is ${job.status}.` };
            }

            const jobsById = new Map(jobs.map((candidate) => [candidate.id, candidate]));
            const unmetDependencies = (job.dependencies || []).filter(
                (dependencyId) => jobsById.get(dependencyId)?.status !== "done"
            );
            if (unmetDependencies.length > 0) {
                return {
                    status: "BLOCKED_BY_DEPENDENCIES",
                    message: `Job '${jobId}' is blocked by: ${unmetDependencies.join(", ")}`,
                    dependencies: unmetDependencies
                };
            }

            if (useSupabase && supabase && projectId) {
                const { data, error } = await supabase
                    .from("jobs")
                    .update({
                        status: "in_progress",
                        assigned_to: agentId,
                        updated_at: new Date().toISOString()
                    })
                    .eq("project_id", projectId)
                    .eq("id", jobId)
                    .eq("status", "todo")
                    .select("id,title,description,priority,status,assigned_to,dependencies,completion_key,created_at,updated_at")
                    .maybeSingle();

                if (error) return { status: "ERROR", message: error.message };
                if (!data) return { status: "NOT_AVAILABLE", message: `Job '${jobId}' was claimed by another agent.` };
                const claimed = jobFromRecord(data as JobRecord);
                await this.core.appendToNotepad(`\n- [JOB CLAIMED] Agent '${agentId}' picked up: ${claimed.title}`);
                return { status: "CLAIMED", job: claimed };
            }

            if (coordination.enabled) {
                try {
                    const data = await coordination.call("jobs", "POST", {
                        // The hosted API treats "claim" as claim-NEXT and silently
                        // ignores jobId — a specific claim must be "claim_by_id"
                        // (claim_specific_job RPC). Sending "claim" here was the
                        // live mis-claim bug: agents asked for one job and were
                        // handed the head of the queue.
                        action: "claim_by_id",
                        jobId,
                        agentId
                    }) as { status?: string; job?: JobRecord; message?: string };
                    if (data?.status !== "CLAIMED" || !data.job) {
                        return data || { status: "NOT_AVAILABLE", message: `Job '${jobId}' could not be claimed.` };
                    }
                    const claimed = jobFromRecord(data.job);
                    await this.core.appendToNotepad(`\n- [JOB CLAIMED] Agent '${agentId}' picked up: ${claimed.title}`);
                    return { status: "CLAIMED", job: claimed };
                } catch (e: unknown) {
                    // The API maps NOT_FOUND→404 and BLOCKED_BY_DEPENDENCIES→409,
                    // which the coordination client surfaces as thrown errors. Recover
                    // the structured body so callers see a status, not a raw HTTP error.
                    const message = (e as Error).message;
                    const jsonMatch = typeof message === "string" ? message.match(/\{.*\}/s) : null;
                    if (jsonMatch) {
                        try {
                            const parsed = JSON.parse(jsonMatch[0]);
                            if (parsed.status) return parsed;
                        } catch { /* fall through to the generic error */ }
                    }
                    return { status: "ERROR", message: `Claim failed: ${message}` };
                }
            }

            const localJob = store.current.jobs[jobId];
            if (!localJob || localJob.status !== "todo") {
                return { status: "NOT_AVAILABLE", message: `Job '${jobId}' is no longer available.` };
            }
            localJob.status = "in_progress";
            localJob.assignedTo = agentId;
            localJob.updatedAt = Date.now();
            await this.core.appendToNotepad(`\n- [JOB CLAIMED] Agent '${agentId}' picked up: ${localJob.title}`);
            return { status: "CLAIMED", job: localJob };
        });
    }

    /**
     * Put an abandoned in_progress job back on the board (parity with the
     * hosted `release_job` tool). Guarded by a staleness re-check so an
     * active agent can't be silently unseated; force=true overrides for a
     * human deliberately clearing a wedged board.
     */
    async releaseJob(jobId: string, force = false, releasedBy?: string) {
        return await this.core.mutex.runExclusive(async () => {
            const { supabase, useSupabase, projectId, coordination, store, lockTimeout } = this.core;

            const releaseGuard = (status: string, updatedAt: number) => {
                if (status !== "in_progress") {
                    return { status: "NOT_AVAILABLE", message: "Only in_progress jobs can be released." };
                }
                if (!force && !isReclaimable({ status: "in_progress", updatedAt }, Date.now(), lockTimeout)) {
                    return { status: "AGENT_ACTIVE", message: "Job's agent still looks active. Pass force: true to release anyway." };
                }
                return null;
            };

            // --- Path 1: Direct Supabase ---
            if (useSupabase && supabase && projectId) {
                const { data: job, error } = await supabase
                    .from("jobs")
                    .select("id,title,status,assigned_to,updated_at")
                    .eq("project_id", projectId)
                    .eq("id", jobId)
                    .maybeSingle();
                if (error) return { status: "ERROR", message: error.message };
                if (!job) return { status: "NOT_FOUND", message: `Job '${jobId}' was not found.` };
                const denied = releaseGuard(job.status, Date.parse(job.updated_at));
                if (denied) return denied;

                const { data, error: updateError } = await supabase
                    .from("jobs")
                    .update({
                        status: "todo",
                        assigned_to: null,
                        cancel_reason: `released from ${job.assigned_to || "unassigned"} by ${releasedBy || "unknown"}`,
                        updated_at: new Date().toISOString()
                    })
                    .eq("project_id", projectId)
                    .eq("id", jobId)
                    .eq("status", "in_progress")
                    .select("id,title,description,priority,status,assigned_to,dependencies,completion_key,created_at,updated_at")
                    .maybeSingle();
                if (updateError) return { status: "ERROR", message: updateError.message };
                if (!data) return { status: "NOT_AVAILABLE", message: `Job '${jobId}' changed state before it could be released.` };
                const released = jobFromRecord(data as JobRecord);
                await this.core.appendToNotepad(`\n- [JOB RELEASED] '${released.title}' returned to the board (was ${job.assigned_to || "unassigned"}).`);
                return { status: "RELEASED", job: released };
            }

            // --- Path 2: Remote API (customer mode) ---
            if (coordination.enabled) {
                try {
                    const data = await coordination.call("jobs", "POST", {
                        action: "release",
                        jobId,
                        force,
                        releasedBy
                    }) as { id?: string; job?: Job; title?: string };
                    const released = data?.id ? jobFromRecord(data as unknown as JobRecord) : data?.job;
                    await this.core.appendToNotepad(`\n- [JOB RELEASED] '${released?.title || jobId}' returned to the board.`);
                    return { status: "RELEASED", job: released };
                } catch (e: unknown) {
                    const message = (e as Error).message;
                    const jsonMatch = typeof message === "string" ? message.match(/\{.*\}/s) : null;
                    if (jsonMatch) {
                        try {
                            const parsed = JSON.parse(jsonMatch[0]);
                            if (parsed.error) return { status: "NOT_AVAILABLE", message: parsed.error };
                        } catch { /* fall through to the generic error */ }
                    }
                    return { status: "ERROR", message: `Release failed: ${message}` };
                }
            }

            // --- Path 3: Local-only fallback ---
            const job = store.current.jobs[jobId];
            if (!job) return { status: "NOT_FOUND", message: `Job '${jobId}' was not found.` };
            const denied = releaseGuard(job.status, job.updatedAt);
            if (denied) return denied;
            const previousAgent = job.assignedTo;
            job.status = "todo";
            job.assignedTo = undefined;
            job.updatedAt = Date.now();
            await store.save();
            await this.core.appendToNotepad(`\n- [JOB RELEASED] '${job.title}' returned to the board (was ${previousAgent || "unassigned"}).`);
            return { status: "RELEASED", job };
        });
    }

    async cancelJob(jobId: string, reason: string) {
        return await this.core.mutex.runExclusive(async () => {
            const { supabase, useSupabase, projectId, coordination, store } = this.core;

            if (useSupabase && supabase && projectId) {
                await supabase
                    .from("jobs")
                    .update({ status: "cancelled", cancel_reason: reason, updated_at: new Date().toISOString() })
                    .eq("id", jobId);
            } else if (coordination.enabled) {
                try {
                    await coordination.call('jobs', 'POST', { action: 'update', jobId, status: 'cancelled', cancel_reason: reason });
                } catch (e: unknown) {
                    logger.error("Failed to cancel job via API", e);
                }
            }

            if (store.current.jobs[jobId]) {
                store.current.jobs[jobId].status = "cancelled";
                store.current.jobs[jobId].updatedAt = Date.now();
                await store.save();
            }

            await this.core.appendToNotepad(`\n- [JOB CANCELLED] ID: ${jobId}. Reason: ${reason}`);
            return "Job cancelled.";
        });
    }

    async completeJob(agentId: string, jobId: string, outcome: string, completionKey?: string) {
        return await this.core.mutex.runExclusive(async () => {
            const { supabase, useSupabase, projectId, coordination, store, enforcement } = this.core;

            if (useSupabase && supabase) {
                const { data, error } = await supabase
                    .from("jobs")
                    .select("id,title,assigned_to,completion_key")
                    .eq("id", jobId)
                    .single();

                if (error || !data) return { error: "Job not found" };

                const isOwner = data.assigned_to === agentId;
                const isKeyValid = completionKey && data.completion_key === completionKey;

                if (!isOwner && !isKeyValid) {
                    return { error: "You don't own this job and provided no valid key." };
                }

                const { error: updateError } = await supabase
                    .from("jobs")
                    .update({ status: "done", updated_at: new Date().toISOString() })
                    .eq("id", jobId);

                if (updateError) return { error: "Failed to complete job" };

                await supabase
                    .from("locks")
                    .delete()
                    .eq("project_id", projectId)
                    .eq("agent_id", data.assigned_to);
                await enforcement.restoreForAgent(data.assigned_to || agentId);
                await this.core.appendToNotepad(`\n- [JOB DONE] Agent '${agentId}' finished: ${data.title}\n  Outcome: ${outcome}`);
                return { status: "COMPLETED" };
            } else if (coordination.enabled) {
                try {
                    await coordination.call('jobs', 'POST', {
                        action: 'update',
                        jobId,
                        status: 'done',
                        assigned_to: agentId,
                        completion_key: completionKey
                    });
                    await enforcement.restoreForAgent(agentId);
                    await this.core.appendToNotepad(`\n- [JOB DONE] Agent '${agentId}' finished: ${jobId}\n  Outcome: ${outcome}`);
                    return { status: "COMPLETED" };
                } catch (e: unknown) {
                    logger.error("Failed to complete job via API", e);
                }
            }

            const job = store.current.jobs[jobId];
            if (!job) return { error: "Job not found" };

            const isOwner = job.assignedTo === agentId;
            const isKeyValid = completionKey && job.completionKey === completionKey;

            if (!isOwner && !isKeyValid) {
                return { error: "You don't own this job and provided no valid key." };
            }

            job.status = "done";
            job.updatedAt = Date.now();
            for (const [lockedPath, lock] of Object.entries(store.current.locks)) {
                if (lock.agentId === job.assignedTo) delete store.current.locks[lockedPath];
            }
            await enforcement.restoreForAgent(job.assignedTo || agentId);
            await this.core.appendToNotepad(`\n- [JOB DONE] Agent '${agentId}' finished: ${job.title}\n  Outcome: ${outcome}`);
            return { status: "COMPLETED" };
        });
    }
}
