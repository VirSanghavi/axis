import { Mutex } from "async-mutex";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import fs from "fs/promises";
import path from "path";
import { logger } from "../utils/logger.js";

// Interfaces
interface FileLock {
    agentId: string;
    filePath: string;
    intent: string;
    userPrompt: string;
    timestamp: number;
}

interface Job {
    id: string;
    title: string;
    description: string;
    priority: "low" | "medium" | "high" | "critical";
    status: "todo" | "in_progress" | "done" | "cancelled";
    assignedTo?: string; // agentId
    dependencies?: string[]; // IDs of other jobs
    createdAt: number;
    updatedAt: number;
    completionKey?: string;
}

interface JobRecord {
    id: string;
    title: string;
    description: string;
    priority: Job["priority"];
    status: Job["status"];
    assigned_to: string | null;
    dependencies: string[] | null;
    completion_key: string | null;
    created_at: string;
    updated_at: string;
}

interface NerveCenterState {
    locks: Record<string, FileLock>; // Fallback local locks
    jobs: Record<string, Job>; // Fallback local jobs
    liveNotepad: string;
}

const STATE_FILE = process.env.NERVE_CENTER_STATE_FILE || path.join(process.cwd(), "history", "nerve-center-state.json");
const LOCK_TIMEOUT_DEFAULT = 30 * 60 * 1000; // 30 minutes

interface NerveCenterOptions {
    stateFilePath?: string;
    lockTimeout?: number;
    supabaseUrl?: string;
    supabaseServiceRoleKey?: string;
    projectName?: string;
}

/**
 * The Central Brain of the Shared Context System.
 * Manages concurrency (File Locks), Orchestration (Job Board), and Short-term Memory (Live Notepad).
 */
export class NerveCenter {
    private mutex: Mutex;
    private state: NerveCenterState;
    private contextManager: any;
    private stateFilePath: string;
    private lockTimeout: number;
    private supabase?: SupabaseClient;
    private _projectId?: string; // Renamed backing field
    private projectName: string;
    private useSupabase: boolean;

    /**
     * @param contextManager - Instance of ContextManager for legacy operations
     * @param options - Configuration options for state persistence and timeouts
     */
    constructor(contextManager: any, options: NerveCenterOptions = {}) {
        this.mutex = new Mutex();
        this.contextManager = contextManager; // this handles apiUrl/apiSecret
        this.stateFilePath = options.stateFilePath || STATE_FILE;
        this.lockTimeout = options.lockTimeout || LOCK_TIMEOUT_DEFAULT;
        this.projectName = options.projectName || process.env.PROJECT_NAME || "default";

        // Hybrid Persistence: Prefer direct Supabase if available, fallback to Remote API
        const supabaseUrl = options.supabaseUrl || process.env.NEXT_PUBLIC_SUPABASE_URL;
        const supabaseKey = options.supabaseServiceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;

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

        this.state = {
            locks: {},
            jobs: {},
            liveNotepad: "Session Start: " + new Date().toISOString() + "\n"
        };
    }

    public get projectId(): string | undefined {
        return this._projectId;
    }

    public get currentProjectName(): string {
        return this.projectName;
    }

    async init() {
        await this.loadState();

        // Always try to detect project name if we have API or Supabase
        if (this.useSupabase || this.contextManager.apiUrl) {
            await this.detectProjectName();
        }

        if (this.useSupabase) {
            await this.ensureProjectId();
        }

        // Recover notepad from cloud if local state is default/empty
        if (this.contextManager.apiUrl && (!this.state.liveNotepad || this.state.liveNotepad.startsWith("Session Start:"))) {
            try {
                const { liveNotepad } = await this.callCoordination(`sessions/sync?projectName=${this.projectName}`) as { liveNotepad: string };
                if (liveNotepad) {
                    this.state.liveNotepad = liveNotepad;
                    logger.info(`NerveCenter: Recovered live notepad from cloud for project: ${this.projectName}`);
                }
            } catch (e: any) {
                logger.warn("Failed to recover notepad from API. Using local.", e);
            }
        }
    }

    private async detectProjectName() {
        try {
            const axisConfigPath = path.join(process.cwd(), ".axis", "axis.json");
            const configData = await fs.readFile(axisConfigPath, "utf-8");
            const config = JSON.parse(configData);
            if (config.project) {
                this.projectName = config.project;
                logger.info(`Detected project name from .axis/axis.json: ${this.projectName}`);
                console.error(`[NerveCenter] Loaded project name '${this.projectName}' from ${axisConfigPath}`);
            } else {
                console.error(`[NerveCenter] .axis/axis.json found but no 'project' field.`);
            }
        } catch (e) {
            console.error(`[NerveCenter] Could not load .axis/axis.json at ${path.join(process.cwd(), ".axis", "axis.json")}: ${e}`);
        }
    }

    private async ensureProjectId() {
        if (!this.supabase) return;

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

    private async callCoordination(endpoint: string, method: string = "GET", body?: any) {
        if (!this.contextManager.apiUrl) throw new Error("Remote API not configured");

        const url = this.contextManager.apiUrl.endsWith("/v1")
            ? `${this.contextManager.apiUrl}/${endpoint}`
            : `${this.contextManager.apiUrl}/v1/${endpoint}`;

        const response = await fetch(url, {
            method,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.contextManager.apiSecret || ""}`
            },
            body: body ? JSON.stringify({ ...body, projectName: this.projectName }) : undefined
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Coordination API Error (${response.status}): ${text}`);
        }

        return await response.json();
    }

    private jobFromRecord(record: JobRecord): Job {
        return {
            id: record.id,
            title: record.title,
            description: record.description,
            priority: record.priority,
            status: record.status,
            assignedTo: record.assigned_to || undefined,
            dependencies: record.dependencies || undefined,
            completionKey: record.completion_key || undefined,
            createdAt: Date.parse(record.created_at),
            updatedAt: Date.parse(record.updated_at)
        };
    }

    // --- Data Access Layers (Hybrid: Supabase > Local) ---

    private async listJobs(): Promise<Job[]> {
        if (this.useSupabase && this.supabase && this._projectId) {
            const { data, error } = await this.supabase
                .from("jobs")
                .select("id,title,description,priority,status,assigned_to,dependencies,created_at,updated_at")
                .eq("project_id", this._projectId);

            if (error || !data) {
                logger.error("Failed to load jobs from Supabase", error);
                return [];
            }
            return (data as any[]).map((record) => this.jobFromRecord(record as JobRecord));
        }

        if (this.contextManager.apiUrl) {
            try {
                const url = `jobs?projectName=${this.projectName}`;
                const res = await this.callCoordination(url) as { jobs: JobRecord[] };
                return (res.jobs || []).map((record: JobRecord) => this.jobFromRecord(record));
            } catch (e: any) {
                logger.error("Failed to load jobs from API", e);
                return Object.values(this.state.jobs);
            }
        }

        return Object.values(this.state.jobs);
    }

    private async getLocks(): Promise<FileLock[]> {
        if (this.useSupabase && this.supabase && this._projectId) {
            try {
                // Lazy clean
                await this.supabase.rpc('clean_stale_locks', {
                    p_project_id: this._projectId,
                    p_timeout_seconds: Math.floor(this.lockTimeout / 1000)
                });

                const { data, error } = await this.supabase
                    .from('locks')
                    .select('*')
                    .eq('project_id', this._projectId);

                if (error) throw error;

                return (data || []).map((row: any) => ({
                    agentId: row.agent_id,
                    filePath: row.file_path,
                    intent: row.intent,
                    userPrompt: row.user_prompt,
                    timestamp: Date.parse(row.updated_at)
                }));
            } catch (e) {
                logger.warn("Failed to fetch locks from DB", e as any);
            }
        }

        if (this.contextManager.apiUrl) {
            try {
                const res = await this.callCoordination(`locks?projectName=${this.projectName}`) as { locks: any[] };
                return (res.locks || []).map((row: any) => ({
                    agentId: row.agent_id,
                    filePath: row.file_path,
                    intent: row.intent,
                    userPrompt: row.user_prompt,
                    timestamp: Date.parse(row.updated_at || row.timestamp)
                }));
            } catch (e: any) {
                logger.error("Failed to fetch locks from API", e);
            }
        }

        return Object.values(this.state.locks);
    }

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
        return this.state.liveNotepad;
    }

    private async appendToNotepad(text: string) {
        this.state.liveNotepad += text;
        await this.saveState();

        if (this.useSupabase && this.supabase && this._projectId) {
            try {
                await this.supabase.rpc('append_to_project_notepad', {
                    p_project_id: this._projectId,
                    p_text: text
                });
            } catch (e) {
                // Ignore RPC errors for now
            }
        }

        if (this.contextManager.apiUrl) {
            // Sync current state to sessions/sync for cloud RAG and backup
            try {
                await this.callCoordination('sessions/sync', 'POST', {
                    title: `Current Session: ${this.projectName}`,
                    context: this.state.liveNotepad,
                    metadata: { source: "mcp-server-live" }
                });
            } catch (e: any) {
                logger.warn("Failed to sync notepad to remote API", e);
            }
        }
    }

    private async saveState() {
        try {
            await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
            await fs.writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2));
        } catch (error) {
            logger.error("Failed to persist state", error);
        }
    }

    private async loadState() {
        try {
            const data = await fs.readFile(this.stateFilePath, "utf-8");
            this.state = JSON.parse(data);
            logger.info("State loaded from disk");
        } catch (_error) {
            // Ignore ENOENT
        }
    }

    // --- Job Board Protocol (Active Orchestration) ---

    async postJob(title: string, description: string, priority: Job["priority"] = "medium", dependencies: string[] = []) {
        return await this.mutex.runExclusive(async () => {
            let id = `job-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            const completionKey = Math.random().toString(36).substring(2, 10).toUpperCase();

            if (this.useSupabase && this.supabase && this._projectId) {
                const { data, error } = await this.supabase
                    .from("jobs")
                    .insert({
                        project_id: this._projectId,
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
                if (error) logger.error("Failed to post job to Supabase", error);
            } else if (this.contextManager.apiUrl) {
                try {
                    const data = await this.callCoordination('jobs', 'POST', {
                        action: 'post',
                        title,
                        description,
                        priority,
                        dependencies,
                        completion_key: completionKey
                    }) as any;
                    if (data?.id) id = data.id;
                } catch (e: any) {
                    logger.error("Failed to post job to API", e);
                }
            }

            if (!this.useSupabase && !this.contextManager.apiUrl) {
                this.state.jobs[id] = {
                    id, title, description, priority, dependencies,
                    status: "todo", createdAt: Date.now(), updatedAt: Date.now(),
                    completionKey
                };
            }

            const depText = dependencies.length ? ` (Depends on: ${dependencies.join(", ")})` : "";
            const logEntry = `\n- [JOB POSTED] [${priority.toUpperCase()}] ${title} (ID: ${id})${depText}`;
            await this.appendToNotepad(logEntry);
            return { jobId: id, status: "POSTED", completionKey };
        });
    }

    async claimNextJob(agentId: string) {
        return await this.mutex.runExclusive(async () => {
            if (this.useSupabase && this.supabase && this._projectId) {
                const { data, error } = await this.supabase.rpc("claim_next_job", {
                    p_project_id: this._projectId,
                    p_agent_id: agentId
                });

                if (error) {
                    logger.error("Failed to claim job via RPC", error);
                } else if (data && data.status === "CLAIMED") {
                    const job = this.jobFromRecord(data.job as JobRecord);
                    await this.appendToNotepad(`\n- [JOB CLAIMED] Agent '${agentId}' picked up: ${job.title}`);
                    return { status: "CLAIMED", job };
                }

                return { status: "NO_JOBS_AVAILABLE", message: "Relax. No open tickets (or dependencies not met)." };
            }

            const priorities = ["critical", "high", "medium", "low"];
            const allJobs = await this.listJobs();
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

            const candidate = availableJobs[0];

            if (this.contextManager.apiUrl) {
                try {
                    const data = await this.callCoordination("jobs", "POST", {
                        action: "update",
                        jobId: candidate.id,
                        status: "in_progress",
                        assigned_to: agentId
                    }) as any;
                    const job = this.jobFromRecord(data as JobRecord);
                    await this.appendToNotepad(`\n- [JOB CLAIMED] Agent '${agentId}' picked up: ${job.title}`);
                    return { status: "CLAIMED", job };
                } catch (e: any) {
                    logger.error("Failed to claim job via API", e);
                }
            }

            // Local fallback
            if (!this.useSupabase && !this.contextManager.apiUrl) {
                const job = candidate;
                job.status = "in_progress";
                job.assignedTo = agentId;
                job.updatedAt = Date.now();
                await this.appendToNotepad(`\n- [JOB CLAIMED] Agent '${agentId}' picked up: ${job.title}`);
                return { status: "CLAIMED", job };
            }

            return { status: "NO_JOBS_AVAILABLE", message: "Could not claim job." };
        });
    }

    async cancelJob(jobId: string, reason: string) {
        return await this.mutex.runExclusive(async () => {
            if (this.useSupabase && this.supabase && this._projectId) {
                await this.supabase
                    .from("jobs")
                    .update({ status: "cancelled", cancel_reason: reason, updated_at: new Date().toISOString() })
                    .eq("id", jobId);
            } else if (this.contextManager.apiUrl) {
                try {
                    await this.callCoordination('jobs', 'POST', { action: 'update', jobId, status: 'cancelled', cancel_reason: reason });
                } catch (e: any) {
                    logger.error("Failed to cancel job via API", e);
                }
            }

            if (this.state.jobs[jobId]) {
                this.state.jobs[jobId].status = "cancelled";
                this.state.jobs[jobId].updatedAt = Date.now();
                await this.saveState();
            }

            await this.appendToNotepad(`\n- [JOB CANCELLED] ID: ${jobId}. Reason: ${reason}`);
            return "Job cancelled.";
        });
    }

    async completeJob(agentId: string, jobId: string, outcome: string, completionKey?: string) {
        return await this.mutex.runExclusive(async () => {
            if (this.useSupabase && this.supabase) {
                const { data, error } = await this.supabase
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

                const { error: updateError } = await this.supabase
                    .from("jobs")
                    .update({ status: "done", updated_at: new Date().toISOString() })
                    .eq("id", jobId);

                if (updateError) return { error: "Failed to complete job" };

                await this.appendToNotepad(`\n- [JOB DONE] Agent '${agentId}' finished: ${data.title}\n  Outcome: ${outcome}`);
                return { status: "COMPLETED" };
            } else if (this.contextManager.apiUrl) {
                try {
                    await this.callCoordination('jobs', 'POST', {
                        action: 'update',
                        jobId,
                        status: 'done',
                        assigned_to: agentId,
                        completion_key: completionKey
                    });
                    await this.appendToNotepad(`\n- [JOB DONE] Agent '${agentId}' finished: ${jobId}\n  Outcome: ${outcome}`);
                    return { status: "COMPLETED" };
                } catch (e: any) {
                    logger.error("Failed to complete job via API", e);
                }
            }

            const job = this.state.jobs[jobId];
            if (!job) return { error: "Job not found" };

            const isOwner = job.assignedTo === agentId;
            const isKeyValid = completionKey && job.completionKey === completionKey;

            if (!isOwner && !isKeyValid) {
                return { error: "You don't own this job and provided no valid key." };
            }

            job.status = "done";
            job.updatedAt = Date.now();
            await this.appendToNotepad(`\n- [JOB DONE] Agent '${agentId}' finished: ${job.title}\n  Outcome: ${outcome}`);
            return { status: "COMPLETED" };
        });
    }

    async forceUnlock(filePath: string, reason: string) {
        return await this.mutex.runExclusive(async () => {
            if (this.useSupabase && this.supabase && this._projectId) {
                await this.supabase
                    .from("locks")
                    .delete()
                    .eq("project_id", this._projectId)
                    .eq("file_path", filePath);
            } else if (this.contextManager.apiUrl) {
                try {
                    await this.callCoordination("locks", "POST", { action: "unlock", filePath, reason });
                } catch (e: any) {
                    logger.error("Failed to force unlock via API", e);
                }
            }

            if (this.state.locks[filePath]) {
                delete this.state.locks[filePath];
                await this.saveState();
            }

            await this.appendToNotepad(`\n- [FORCE UNLOCK] ${filePath} unlocked by admin. Reason: ${reason}`);
            return `File ${filePath} has been forcibly unlocked.`;
        });
    }

    async getCoreContext() {
        const jobs = await this.listJobs();
        const locks = await this.getLocks();
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

    // --- Decision & Orchestration ---

    async proposeFileAccess(agentId: string, filePath: string, intent: string, userPrompt: string) {
        return await this.mutex.runExclusive(async () => {
            if (this.useSupabase && this.supabase && this._projectId) {
                const { data, error } = await this.supabase.rpc("try_acquire_lock", {
                    p_project_id: this._projectId,
                    p_file_path: filePath,
                    p_agent_id: agentId,
                    p_intent: intent,
                    p_user_prompt: userPrompt,
                    p_timeout_seconds: Math.floor(this.lockTimeout / 1000)
                });

                if (error) {
                    logger.error("Failed to acquire lock via RPC", error);
                    return { status: "ERROR", message: "Database error" };
                }

                if (data.status === "GRANTED") {
                    await this.appendToNotepad(`\n- [LOCK] ${agentId} locked ${filePath}\n  Intent: ${intent}`);
                    return { status: "GRANTED", message: `Access granted for ${filePath}` };
                }

                return {
                    status: "REQUIRES_ORCHESTRATION",
                    message: `Conflict: File '${filePath}' is currently locked by '${data.owner_id}'`,
                    currentLock: {
                        agentId: data.owner_id,
                        filePath,
                        intent: data.intent,
                        timestamp: Date.parse(data.updated_at)
                    }
                };
            }

            // 1. Fetch current locks (hybrid fallback)
            const locks = await this.getLocks();
            const existing = locks.find(l => l.filePath === filePath);

            if (existing) {
                const isStale = (Date.now() - existing.timestamp) > this.lockTimeout;
                if (!isStale && existing.agentId !== agentId) {
                    return {
                        status: "REQUIRES_ORCHESTRATION",
                        message: `Conflict: File '${filePath}' is currently locked by '${existing.agentId}'`,
                        currentLock: existing
                    };
                }
            }

            if (this.contextManager.apiUrl) {
                try {
                    await this.callCoordination("locks", "POST", {
                        action: "lock",
                        filePath,
                        agentId,
                        intent,
                        userPrompt
                    });
                } catch (e: any) {
                    logger.error("API lock failed", e);
                }
            } else {
                this.state.locks[filePath] = { agentId, filePath, intent, userPrompt, timestamp: Date.now() };
                await this.saveState();
            }

            await this.appendToNotepad(`\n- [LOCK] ${agentId} locked ${filePath}\n  Intent: ${intent}`);
            return { status: "GRANTED", message: `Access granted for ${filePath}` };
        });
    }

    async updateSharedContext(text: string, agentId: string) {
        return await this.mutex.runExclusive(async () => {
            await this.appendToNotepad(`\n- [${agentId}] ${text}`);
            return "Notepad updated.";
        });
    }

    async finalizeSession() {
        return await this.mutex.runExclusive(async () => {
            const content = await this.getNotepad();
            const filename = `session-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
            const historyPath = path.join(process.cwd(), "history", filename);

            try {
                await fs.mkdir(path.dirname(historyPath), { recursive: true });
                await fs.writeFile(historyPath, content);
            } catch (e: any) {
                logger.warn("Failed to write local session log", e);
            }

            // Clear State
            if (this.useSupabase && this.supabase && this._projectId) {
                // Archive to sessions table first
                await this.supabase
                    .from("sessions")
                    .insert({
                        project_id: this._projectId,
                        title: `Session ${new Date().toLocaleDateString()}`,
                        summary: content.substring(0, 500) + "...",
                        metadata: { full_content: content }
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
            } else if (this.contextManager.apiUrl) {
                try {
                    await this.callCoordination("sessions/finalize", "POST", { content });
                } catch (e: any) {
                    logger.error("Failed to finalize session via API", e);
                }
            }

            // Local Reset
            this.state.liveNotepad = "Session Start: " + new Date().toISOString() + "\n";
            this.state.locks = {};
            this.state.jobs = Object.fromEntries(
                Object.entries(this.state.jobs).filter(([_, j]) => j.status !== "done" && j.status !== "cancelled")
            );

            await this.saveState();

            return {
                status: "SESSION_FINALIZED",
                archivePath: historyPath
            };
        });
    }

    async getProjectSoul() {
        let soul = "## Project Soul\n";
        try {
            const context = await this.contextManager.readFile("context.md");
            soul += `\n### Context\n${context}`;
            const conventions = await this.contextManager.readFile("conventions.md");
            soul += `\n### Conventions\n${conventions}`;
        } catch (_e) {
            soul += "\n(Could not read local context files)";
        }
        return soul;
    }

    // --- Billing & Usage ---

    async getSubscriptionStatus(email: string) {
        if (this.useSupabase && this.supabase) {
            const { data: profile, error } = await this.supabase
                .from("profiles")
                .select("subscription_status, stripe_customer_id, current_period_end")
                .eq("email", email)
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

        if (this.contextManager.apiUrl) {
            try {
                return await this.callCoordination("usage");
            } catch (e: any) {
                logger.error("Failed to fetch subscription status via API", e);
            }
        }

        return { error: "Coordination not configured." };
    }

    async getUsageStats(email: string) {
        if (this.useSupabase && this.supabase) {
            const { data: profile } = await this.supabase
                .from("profiles")
                .select("usage_count")
                .eq("email", email)
                .single();

            return { email, usageCount: (profile as any)?.usage_count || 0 };
        }

        if (this.contextManager.apiUrl) {
            try {
                return await this.callCoordination("usage");
            } catch (e: any) {
                logger.error("Failed to fetch usage stats via API", e);
            }
        }

        return { error: "Coordination not configured." };
    }
}
