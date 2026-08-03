import { Mutex } from "async-mutex";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import { deriveOrgId, deriveProjectName, projectStateFilePath } from "./project-identity.js";
import { locksEnforced } from "./fs-guard.js";
import {
    collectSessionTranscript,
    mergeTranscriptEvents,
    transcriptTitle,
} from "./session-transcript.js";
import {
    CoordinationContext,
    Job,
    NerveCenterOptions,
    LOCK_TIMEOUT_DEFAULT,
} from "./coordination-types.js";
import { CoordinationClient } from "./coordination-client.js";
import { normalizeLockPath } from "./lock-paths.js";
import { EnforcedPerms } from "./enforced-perms.js";
import { ProtocolTranscript } from "./protocol-transcript.js";
import { StateStore } from "./state-store.js";
import { JobBoard } from "./job-board.js";
import { LockRegistry } from "./lock-registry.js";
import type { CoreServices } from "./core-services.js";

export type { Job, JobRecord } from "./coordination-types.js";

/**
 * The Central Brain of the Shared Context System — now a FACADE (audit #3).
 *
 * NerveCenter owns identity/org/project scoping, bootstrap, the live notepad,
 * session finalization, and billing passthrough. Everything else is delegated:
 *
 *   - JobBoard            (job-board.ts)         post/claim/release/complete
 *   - LockRegistry        (lock-registry.ts)     locks, verify, guarded write
 *   - CoordinationClient  (coordination-client.ts) hosted API + circuit breaker
 *   - StateStore          (state-store.ts)       local JSON fallback state
 *   - EnforcedPerms       (enforced-perms.ts)    opt-in chmod enforcement
 *   - ProtocolTranscript  (protocol-transcript.ts) MCP tool-call capture
 *
 * The public API is unchanged: mcp-server.ts and the test suite are untouched.
 * See ARCHITECTURE.md for the module map.
 */
export class NerveCenter {
    private mutex: Mutex;
    private contextManager: CoordinationContext;
    private store: StateStore;
    private stateFilePathExplicit: boolean;
    private projectRoot: string;
    private lockTimeout: number;
    private supabase?: SupabaseClient;
    private _projectId?: string;
    private projectName: string;
    private projectNameExplicit: boolean;
    private orgId?: string;
    private useSupabase: boolean;
    private coordination: CoordinationClient;
    private enforcement: EnforcedPerms;
    private transcript: ProtocolTranscript;
    private jobBoard: JobBoard;
    private lockRegistry: LockRegistry;

    /**
     * @param contextManager - Instance of ContextManager for legacy operations
     * @param options - Configuration options for state persistence and timeouts
     */
    constructor(contextManager: CoordinationContext, options: NerveCenterOptions = {}) {
        this.mutex = new Mutex();
        this.contextManager = contextManager; // this handles apiUrl/apiSecret
        this.enforcement = new EnforcedPerms(options.enforceLocks ?? locksEnforced());
        this.transcript = new ProtocolTranscript();
        this.projectRoot = path.resolve(options.projectRoot || process.cwd());
        this.stateFilePathExplicit = options.stateFilePath !== undefined;
        this.store = new StateStore(options.stateFilePath || projectStateFilePath(this.projectRoot));
        this.lockTimeout = options.lockTimeout || LOCK_TIMEOUT_DEFAULT;

        // Check if remote API is configured (customer mode)
        const hasRemoteApi = !!this.contextManager.apiUrl;

        // Hybrid Persistence: Prefer direct Supabase if available, fallback to Remote API
        // If options explicitly set to null OR undefined when remote API is configured, disable Supabase (customer mode)
        const supabaseUrl = options.supabaseUrl !== undefined
            ? options.supabaseUrl
            : (hasRemoteApi ? null : process.env.NEXT_PUBLIC_SUPABASE_URL);
        const supabaseKey = options.supabaseServiceRoleKey !== undefined
            ? options.supabaseServiceRoleKey
            : (hasRemoteApi ? null : process.env.SUPABASE_SERVICE_ROLE_KEY);

        if (supabaseUrl && supabaseKey) {
            this.supabase = createClient(supabaseUrl, supabaseKey);
            this.useSupabase = true;
            logger.info("NerveCenter: Using direct Supabase persistence.");
        } else if (this.contextManager.apiUrl) {
            this.supabase = undefined;
            this.useSupabase = false;
            logger.info(`NerveCenter: Using Remote API persistence (${this.contextManager.apiUrl})`);
        } else {
            this.supabase = undefined;
            this.useSupabase = false;
            logger.warn("NerveCenter: Running in local-only mode. Coordination restricted to this machine.");
        }

        // Project name: prioritize explicit option, then env var, then detect from .axis/axis.json, then default
        // But if remote API is configured (customer mode), prefer env var over detected name
        const explicitProjectName = options.projectName || process.env.PROJECT_NAME;
        this.projectNameExplicit = !!explicitProjectName;
        if (explicitProjectName) {
            this.projectName = explicitProjectName;
        } else {
            // Will be set by detectProjectName() in init() if needed, or default to "default"
            this.projectName = "default";
        }

        // Org scoping: without this the API resolves every call to the
        // caller's PERSONAL org, so two teammates on the same repo silently
        // get two disjoint boards. An org here (option → env → committed
        // .axis/axis.json "org") pins coordination to the shared org.
        this.orgId = options.orgId || deriveOrgId(this.projectRoot);
        this.contextManager.orgId = this.orgId;
        if (this.orgId) {
            logger.info(`NerveCenter: Coordinating under org ${this.orgId}`);
        }

        // The coordination client reads config through accessors because
        // apiUrl/apiSecret live on the ContextManager and orgId/projectName
        // change on switch_project.
        this.coordination = new CoordinationClient({
            getApiUrl: () => this.contextManager.apiUrl,
            getApiSecret: () => this.contextManager.apiSecret,
            getOrgId: () => this.orgId,
            getProjectName: () => this.projectName,
        });

        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        const core: CoreServices = {
            mutex: this.mutex,
            store: this.store,
            coordination: this.coordination,
            enforcement: this.enforcement,
            get supabase() { return self.supabase; },
            get useSupabase() { return self.useSupabase; },
            get projectId() { return self._projectId; },
            get projectName() { return self.projectName; },
            // A getter, not a snapshot: detectProjectName can reassign the root
            // to a discovered ancestor after construction.
            get projectRoot() { return self.projectRoot; },
            get lockTimeout() { return self.lockTimeout; },
            appendToNotepad: (text: string) => this.appendToNotepad(text),
        };
        this.jobBoard = new JobBoard(core);
        this.lockRegistry = new LockRegistry(core);
    }

    // --- Identity & scope accessors ---

    public get projectId(): string | undefined {
        return this._projectId;
    }

    public get currentProjectName(): string {
        return this.projectName;
    }

    public get currentOrgId(): string | undefined {
        return this.orgId;
    }

    /** The workspace this session is currently scoped to (see workspace-watch.ts). */
    get activeProjectRoot(): string {
        return this.projectRoot;
    }

    /** Current notepad content, for ambient team-update deltas (see team-updates.ts). */
    get notepadSnapshot(): string {
        return this.store.current.liveNotepad;
    }

    /** Kept for compatibility: path normalization now lives in lock-paths.ts. */
    static normalizeLockPath(filePath: string): string {
        return normalizeLockPath(filePath);
    }

    // --- MCP transcript capture ---

    async captureToolExecution<T>(
        toolName: string,
        args: unknown,
        agent: string,
        execute: () => Promise<T>
    ): Promise<T> {
        return this.transcript.capture(toolName, args, agent, execute);
    }

    // --- Bootstrap & workspace switching ---

    async init() {
        await this.store.load();

        // Only detect project name from .axis/axis.json if:
        // 1. Project name is still "default" (wasn't set explicitly)
        // 2. We're in dev mode (not using remote API only)
        // This ensures customer mode uses consistent project names from env vars
        if (!this.projectNameExplicit) {
            await this.detectProjectName(this.projectRoot);
        }

        if (this.useSupabase) {
            await this.ensureProjectId();
        }

        await this.syncRemoteProjectState();
    }

    async switchProject(identity: { root: string; projectName?: string; orgId?: string }) {
        return await this.mutex.runExclusive(async () => {
            await this.store.save();

            this.projectRoot = path.resolve(identity.root);
            process.chdir(this.projectRoot);
            if (!this.stateFilePathExplicit) {
                this.store.setFilePath(projectStateFilePath(this.projectRoot));
            }

            this.projectName = identity.projectName || deriveProjectName(this.projectRoot);
            this.projectNameExplicit = Boolean(identity.projectName);
            // Each workspace can pin a different org via its own .axis/axis.json.
            this.orgId = identity.orgId || deriveOrgId(this.projectRoot);
            this.contextManager.orgId = this.orgId;
            this._projectId = undefined;
            this.store.reset();

            await this.store.load();
            if (this.useSupabase) {
                await this.ensureProjectId();
            }
            await this.syncRemoteProjectState();

            return {
                status: "SWITCHED",
                projectRoot: this.projectRoot,
                projectName: this.projectName,
                stateFilePath: this.store.stateFilePath
            };
        });
    }

    private async syncRemoteProjectState() {
        if (!this.coordination.enabled) return;
        try {
            const { liveNotepad, projectId } = await this.coordination.call(`sessions/sync?projectName=${this.projectName}`) as { liveNotepad: string, projectId: string };
            if (projectId) {
                this._projectId = projectId;
                logger.info(`NerveCenter: Resolved projectId from cloud: ${this._projectId}`);
            }
            if (liveNotepad && (!this.store.current.liveNotepad || this.store.current.liveNotepad.startsWith("Session Start:"))) {
                this.store.current.liveNotepad = liveNotepad;
                logger.info(`NerveCenter: Recovered live notepad from cloud for project: ${this.projectName}`);
            }
        } catch (e: unknown) {
            logger.warn("Failed to sync project/notepad with Remote API. Using local/fallback.", e as Error);
        }
    }

    private async detectProjectName(startDir: string = this.projectRoot) {
        let projectRoot = startDir;
        let current = startDir;
        const filesystemRoot = path.parse(current).root;

        while (current !== filesystemRoot) {
            if (
                existsSync(path.join(current, ".axis", "axis.json")) ||
                existsSync(path.join(current, ".git")) ||
                existsSync(path.join(current, "package.json"))
            ) {
                projectRoot = current;
                break;
            }
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }

        try {
            const axisConfigPath = path.join(projectRoot, ".axis", "axis.json");
            const configData = await fs.readFile(axisConfigPath, "utf-8");
            const config = JSON.parse(configData);
            if (config.project) {
                this.projectName = String(config.project);
                logger.info(`Detected project name from .axis/axis.json: ${this.projectName}`);
                return;
            }
        } catch {
            // Fall through to a deterministic repository-root name.
        }

        const derived = path.basename(projectRoot)
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, "-")
            .replace(/^-+|-+$/g, "");
        this.projectName = derived || "default";
        logger.info(`Derived project name '${this.projectName}' from ${projectRoot}`);
    }

    private async ensureProjectId() {
        if (!this.supabase || this._projectId) return; // Skip if already set (e.g. from API)

        const { data: project, error } = await this.supabase
            .from("projects")
            .select("id")
            .eq("name", this.projectName)
            .maybeSingle();

        if (error) {
            logger.error("Failed to load project", error);
            return;
        }

        if (project?.id) {
            this._projectId = project.id;
            return;
        }

        // WARNING: This create projects without owner_id if done directly via Service Role.
        // The Remote API is preferred for project creation.
        const { data: created, error: createError } = await this.supabase
            .from("projects")
            .insert({ name: this.projectName })
            .select("id")
            .single();

        if (createError) {
            logger.error("Failed to create project", createError);
            return;
        }

        this._projectId = created.id;
    }

    // --- Job Board (delegated) ---

    async listJobs(): Promise<Job[]> {
        return this.jobBoard.listJobs();
    }

    async postJob(title: string, description: string, priority: Job["priority"] = "medium", dependencies: string[] = []) {
        return this.jobBoard.postJob(title, description, priority, dependencies);
    }

    async claimNextJob(agentId: string) {
        return this.jobBoard.claimNextJob(agentId);
    }

    async claimJob(agentId: string, jobId: string) {
        return this.jobBoard.claimJob(agentId, jobId);
    }

    async releaseJob(jobId: string, force = false, releasedBy?: string) {
        return this.jobBoard.releaseJob(jobId, force, releasedBy);
    }

    async cancelJob(jobId: string, reason: string) {
        return this.jobBoard.cancelJob(jobId, reason);
    }

    async completeJob(agentId: string, jobId: string, outcome: string, completionKey?: string) {
        return this.jobBoard.completeJob(agentId, jobId, outcome, completionKey);
    }

    // --- Locks (delegated) ---

    async listLocks() {
        return this.lockRegistry.listLocks();
    }

    async proposeFileAccess(agentId: string, filePath: string, intent: string, userPrompt: string) {
        return this.lockRegistry.proposeFileAccess(agentId, filePath, intent, userPrompt);
    }

    async proposeFilesAccess(agentId: string, filePaths: string[], intent: string, userPrompt: string) {
        return this.lockRegistry.proposeFilesAccess(agentId, filePaths, intent, userPrompt);
    }

    async releaseFileAccess(agentId: string, filePath: string) {
        return this.lockRegistry.releaseFileAccess(agentId, filePath);
    }

    async forceUnlock(filePath: string, reason: string) {
        return this.lockRegistry.forceUnlock(filePath, reason);
    }

    async verifyFileAccess(agentId: string, filePath: string) {
        return this.lockRegistry.verifyFileAccess(agentId, filePath);
    }

    async guardedWrite(agentId: string, filePath: string, content: string) {
        return this.lockRegistry.guardedWrite(agentId, filePath, content);
    }

    // --- Live Notepad ---

    private async getNotepad(): Promise<string> {
        if (this.useSupabase && this.supabase && this._projectId) {
            const { data, error } = await this.supabase
                .from("projects")
                .select("live_notepad")
                .eq("id", this._projectId)
                .single();

            if (!error && data) return data.live_notepad || "";
        }

        // In hybrid mode, we trust our local copy of liveNotepad as the "hot" state
        // but it is continuously synced to cloud in appendToNotepad
        return this.store.current.liveNotepad;
    }

    /**
     * The shared Live Notepad, same response shape as the hosted
     * `get_shared_context` tool ({ notepad, projectName }).
     */
    async getSharedContext(): Promise<{ notepad: string; projectName: string }> {
        if (!(this.useSupabase && this.supabase && this._projectId) && this.coordination.enabled) {
            try {
                const data = await this.coordination.call(
                    `notepad?projectName=${encodeURIComponent(this.projectName)}`
                ) as { notepad?: string };
                return { notepad: data?.notepad || "", projectName: this.projectName };
            } catch (e: unknown) {
                logger.warn("Failed to fetch notepad from remote API; serving local copy", e as Error);
            }
        }
        return { notepad: await this.getNotepad(), projectName: this.projectName };
    }

    private async appendToNotepad(text: string) {
        this.store.current.liveNotepad += text;
        await this.store.save();

        if (this.useSupabase && this.supabase && this._projectId) {
            try {
                await this.supabase.rpc('append_to_project_notepad', {
                    p_project_id: this._projectId,
                    p_text: text
                });
            } catch (e) {
                logger.warn("Notepad RPC append failed", e as Error);
            }
        }

        if (this.coordination.enabled) {
            // Sync current state to sessions/sync for cloud RAG and backup
            try {
                const res = await this.coordination.call('sessions/sync', 'POST', {
                    title: `Current Session: ${this.projectName}`,
                    context: this.store.current.liveNotepad,
                    metadata: { source: "mcp-server-live" }
                }) as { projectId?: string };

                // If the API resolved/created a project, capture its ID
                if (res.projectId && !this._projectId) {
                    this._projectId = res.projectId;
                    logger.info(`NerveCenter: Captured projectId from sync API: ${this._projectId}`);
                }
            } catch (e: unknown) {
                logger.warn("Failed to sync notepad to remote API", e as Error);
            }
        }
    }

    async updateSharedContext(text: string, agentId: string) {
        return await this.mutex.runExclusive(async () => {
            await this.appendToNotepad(`\n- [${agentId}] ${text}`);
            return "Notepad updated.";
        });
    }

    // --- Aggregate context & session lifecycle ---

    async getCoreContext() {
        const jobs = await this.listJobs();
        const locks = await this.listLocks();
        const notepad = await this.getNotepad();

        const jobSummary = jobs
            .filter((j) => j.status !== "done" && j.status !== "cancelled")
            .map((j) => `- [${j.status.toUpperCase()}] ${j.title} (ID: ${j.id}, Priority: ${j.priority}${j.assignedTo ? `, Assigned: ${j.assignedTo}` : ""})`)
            .join("\n");

        const lockSummary = locks
            .map((l) => `- ${l.filePath} (Locked by: ${l.agentId}, Intent: ${l.intent})`)
            .join("\n");

        return `# Active Session Context\n\n## Job Board (Active Orchestration)\n${jobSummary || "No active jobs."}\n\n## Task Registry (Locks)\n${lockSummary || "No active locks."}\n\n## Live Notepad\n${notepad}`;
    }

    async finalizeSession() {
        return await this.mutex.runExclusive(async () => {
            // Restore write permission on every file this session locked, so no
            // file is left read-only after the locks are cleared.
            await this.enforcement.restoreForAgent();
            const content = await this.getNotepad();
            const nativeTranscript = await collectSessionTranscript();
            const transcriptEvents = mergeTranscriptEvents(nativeTranscript.events, this.transcript.snapshot);
            const transcriptSource = nativeTranscript.metadata.source === "unknown"
                ? "mcp"
                : `${nativeTranscript.metadata.source}+mcp`;
            const sessionTitle = transcriptTitle(
                transcriptEvents,
                `Session ${new Date().toLocaleDateString()}`
            );
            const transcriptMetadata = {
                source: transcriptSource,
                provider: nativeTranscript.metadata.provider || "mcp",
                agent: nativeTranscript.metadata.agent,
                thread_id: nativeTranscript.metadata.thread_id,
            };
            const filename = `session-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
            const historyPath = path.join(this.projectRoot, "history", filename);

            try {
                await fs.mkdir(path.dirname(historyPath), { recursive: true });
                await fs.writeFile(historyPath, content);
            } catch (e: unknown) {
                logger.warn("Failed to write local session log", e as Error);
            }

            // Clear State
            if (this.useSupabase && this.supabase && this._projectId) {
                const { data: projectOwner } = await this.supabase
                    .from("projects")
                    .select("owner_id")
                    .eq("id", this._projectId)
                    .single();

                // Archive to sessions table first
                await this.supabase
                    .from("sessions")
                    .insert({
                        project_id: this._projectId,
                        user_id: projectOwner?.owner_id,
                        title: sessionTitle,
                        summary: content.substring(0, 500) + "...",
                        metadata: {
                            full_content: content,
                            transcript: transcriptEvents,
                            ...transcriptMetadata,
                        },
                        completed_at: new Date().toISOString(),
                    });

                // Clear live notepad
                await this.supabase
                    .from("projects")
                    .update({ live_notepad: "Session Start: " + new Date().toISOString() + "\n" })
                    .eq("id", this._projectId);

                // Clear done jobs
                await this.supabase
                    .from("jobs")
                    .delete()
                    .eq("project_id", this._projectId)
                    .in("status", ["done", "cancelled"]);

                // Clear all locks for this project
                await this.supabase
                    .from("locks")
                    .delete()
                    .eq("project_id", this._projectId);
            } else if (this.coordination.enabled) {
                try {
                    await this.coordination.call("sessions/finalize", "POST", {
                        content,
                        title: sessionTitle,
                        transcript: transcriptEvents,
                        metadata: transcriptMetadata,
                    });
                } catch (e: unknown) {
                    logger.error("Failed to finalize session via API", e);
                }
            }

            // Local Reset
            this.store.current.liveNotepad = "Session Start: " + new Date().toISOString() + "\n";
            this.store.current.locks = {};
            this.store.current.jobs = Object.fromEntries(
                Object.entries(this.store.current.jobs).filter(([_, j]) => j.status !== "done" && j.status !== "cancelled")
            );
            this.transcript.clear();

            await this.store.save();

            return {
                status: "SESSION_FINALIZED",
                archivePath: historyPath,
                transcriptEvents: transcriptEvents.length,
                transcriptSource,
            };
        });
    }

    // --- Project soul & remote presence ---

    async getProjectSoul() {
        let soul = "## Project Soul\n";
        let context = "";
        let couldNotRead = false;
        try {
            if (!this.contextManager.readFile) throw new Error("Context manager has no readFile");
            context = await this.contextManager.readFile("context.md");
            soul += `\n### Context\n${context}`;
            const conventions = await this.contextManager.readFile("conventions.md");
            soul += `\n### Conventions\n${conventions}`;
        } catch (_e) {
            couldNotRead = true;
            soul += "\n(Could not read local context files)";
        }
        // Distinguish three states so fresh customers get the right next step:
        //   uninit     — no .axis/instructions/ at all → point them at axis-init
        //   placeholder — file exists but still has template text → fill it
        //   filled     — real content, no nag
        const uninit = couldNotRead;
        const placeholder =
            !uninit && (
                /Describe your project|<!-- Describe|This project uses Axis/i.test(context) ||
                (context.trim().length < 450 && /# Project Context/i.test(context))
            );

        if (uninit) {
            soul += `

### MANDATORY: This project has not been initialized for Axis
There is no \`.axis/instructions/\` directory yet, so the project soul, the IDE rule files (CLAUDE.md, AGENTS.md, .cursorrules, .windsurfrules), and the agent protocol have not been installed.

**Fastest path — one command:**
\`\`\`
npx @virsanghavi/axis-init
\`\`\`
This creates the \`.axis/\` directory, installs the rule files in the repo root, and seeds template soul files. Then call \`update_project_soul\` to fill in the project-specific content.

**Manual path** (if the user doesn't want the init CLI):
1. Use \`search_codebase\` to explore the repo and infer what this project is about.
2. Call \`update_project_soul\` with \`context\` (overview, architecture, features) and \`conventions\` (language standards, agent norms).
3. If the codebase is empty: ask the user what the project is, then call \`update_project_soul\`.

Do NOT proceed with other work until one of these paths runs. Working without a soul means every decision lacks project context.`;
        } else if (placeholder) {
            soul += `

### MANDATORY: Project soul is not yet filled
The \`.axis/\` directory exists but \`context.md\` still has placeholder/template content. Fill it before doing any other work.

**How to fill the project soul:**
1. Use \`search_codebase\` to explore the repo and infer what this project is about.
2. Call \`update_project_soul\` with \`context\` (project overview, architecture, core features, deployment) and \`conventions\` (language standards, styling, code patterns, agent norms).
3. If the codebase is empty or has nothing to search: ask the user what the project is about, then call \`update_project_soul\` with their answer.

Do NOT skip this. Do NOT proceed with other work until the soul is populated. Working without a filled soul means every decision you make lacks context.`;
        }
        return soul;
    }

    /**
     * Teammates' agents as seen by the coordination server (derived from live
     * locks + in_progress jobs across the whole org project). Empty when no
     * remote API is configured — presence is then local-process only.
     */
    async listRemoteAgents(): Promise<Array<{ agentId: string; activeLocks: number; activeJobs: number; jobTitles: string[]; lastSeen: string }>> {
        if (!this.coordination.enabled) return [];
        try {
            const result = await this.coordination.call(
                `agents?projectName=${encodeURIComponent(this.projectName)}`
            ) as { agents?: Array<{ agentId: string; activeLocks: number; activeJobs: number; jobTitles: string[]; lastSeen: string }> };
            return result?.agents || [];
        } catch (e) {
            logger.warn(`[listRemoteAgents] Remote presence unavailable: ${e instanceof Error ? e.message : e}`);
            return [];
        }
    }

    // --- Billing & Usage ---

    async getSubscriptionStatus(email?: string) {
        // Priority: Remote API if available (for customers), then Supabase, then error
        // If no email provided, the remote API will use the API key identity
        logger.info(`[getSubscriptionStatus] Starting - email: ${email || "(API key identity)"}`);
        logger.info(`[getSubscriptionStatus] Config - remoteApi: ${this.coordination.enabled}, useSupabase: ${this.useSupabase}`);

        if (this.coordination.enabled) {
            try {
                const endpoint = email ? `usage?email=${encodeURIComponent(email)}` : "usage";
                logger.info(`[getSubscriptionStatus] Attempting API call to: ${endpoint}`);
                const result = await this.coordination.call(endpoint);
                logger.info(`[getSubscriptionStatus] API call successful: ${JSON.stringify(result).substring(0, 200)}`);
                return result;
            } catch (e: unknown) {
                logger.error(`[getSubscriptionStatus] API call failed: ${(e as Error).message}`, e);
                return { error: `API call failed: ${(e as Error).message}` };
            }
        } else {
            logger.warn("[getSubscriptionStatus] No API URL configured");
        }

        if (this.useSupabase && this.supabase && email) {
            // Use direct Supabase when configured (development mode) — requires email
            const { data: profile, error } = await this.supabase
                .from("profiles")
                .select("subscription_status, stripe_customer_id, current_period_end")
                .ilike("email", email)
                .single();

            if (error || !profile) {
                return { status: "unknown", message: "Profile not found." };
            }

            const isActive = profile.subscription_status === "pro" ||
                (profile.current_period_end && new Date(profile.current_period_end) > new Date());

            return {
                email,
                plan: isActive ? "Pro" : "Free",
                status: profile.subscription_status || "free",
                validUntil: profile.current_period_end
            };
        }

        return { error: "Coordination not configured. API URL not set and Supabase not available." };
    }

    async getUsageStats(email?: string) {
        // Priority: Remote API if available (for customers), then Supabase, then error
        // If no email provided, the remote API will use the API key identity
        logger.info(`[getUsageStats] Starting - email: ${email || "(API key identity)"}`);
        logger.info(`[getUsageStats] Config - remoteApi: ${this.coordination.enabled}, useSupabase: ${this.useSupabase}`);

        if (this.coordination.enabled) {
            try {
                const endpoint = email ? `usage?email=${encodeURIComponent(email)}` : "usage";
                logger.info(`[getUsageStats] Attempting API call to: ${endpoint}`);
                const result = await this.coordination.call(endpoint) as { usageCount?: number; email?: string; plan?: string; status?: string };
                logger.info(`[getUsageStats] API call successful: ${JSON.stringify(result).substring(0, 200)}`);
                return { email: email || result.email, usageCount: result.usageCount || 0 };
            } catch (e: unknown) {
                logger.error(`[getUsageStats] API call failed: ${(e as Error).message}`, e);
                return { error: `API call failed: ${(e as Error).message}` };
            }
        }

        if (this.useSupabase && this.supabase && email) {
            // Use direct Supabase when configured (development mode) — requires email
            const { data: profile } = await this.supabase
                .from("profiles")
                .select("usage_count")
                .ilike("email", email)
                .single();

            return { email, usageCount: (profile as { usage_count?: number } | null)?.usage_count || 0 };
        }

        return { error: "Coordination not configured. API URL not set and Supabase not available." };
    }
}
