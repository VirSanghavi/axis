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

// Circuit breaker constants
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000; // 60 seconds

class CircuitOpenError extends Error {
    constructor() {
        super("Circuit breaker open — remote API temporarily unavailable, falling back to local");
        this.name = "CircuitOpenError";
    }
}

interface NerveCenterOptions {
    stateFilePath?: string;
    lockTimeout?: number;
    supabaseUrl?: string | null;
    supabaseServiceRoleKey?: string | null;
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
    private _circuitFailures: number = 0;
    private _circuitOpenUntil: number = 0;

    /**
     * @param contextManager - Instance of ContextManager for legacy operations
     * @param options - Configuration options for state persistence and timeouts
     */
    constructor(contextManager: any, options: NerveCenterOptions = {}) {
        this.mutex = new Mutex();
        this.contextManager = contextManager; // this handles apiUrl/apiSecret
        this.stateFilePath = options.stateFilePath || STATE_FILE;
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
        if (explicitProjectName) {
            this.projectName = explicitProjectName;
        } else {
            // Will be set by detectProjectName() in init() if needed, or default to "default"
            this.projectName = "default";
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

        // Only detect project name from .axis/axis.json if:
        // 1. Project name is still "default" (wasn't set explicitly)
        // 2. We're in dev mode (not using remote API only)
        // This ensures customer mode uses consistent project names from env vars
        if (this.projectName === "default" && (this.useSupabase || !this.contextManager.apiUrl)) {
            await this.detectProjectName();
        }

        if (this.useSupabase) {
            await this.ensureProjectId();
        }

        // Recover notepad and projectId from cloud if Remote API is available
        if (this.contextManager.apiUrl) {
            try {
                const { liveNotepad, projectId } = await this.callCoordination(`sessions/sync?projectName=${this.projectName}`) as { liveNotepad: string, projectId: string };
                if (projectId) {
                    this._projectId = projectId;
                    logger.info(`NerveCenter: Resolved projectId from cloud: ${this._projectId}`);
                }
                if (liveNotepad && (!this.state.liveNotepad || this.state.liveNotepad.startsWith("Session Start:"))) {
                    this.state.liveNotepad = liveNotepad;
                    logger.info(`NerveCenter: Recovered live notepad from cloud for project: ${this.projectName}`);
                }
            } catch (e: any) {
                logger.warn("Failed to sync project/notepad with Remote API. Using local/fallback.", e);
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

    private async callCoordination(endpoint: string, method: string = "GET", body?: any) {
        logger.info(`[callCoordination] Starting - endpoint: ${endpoint}, method: ${method}`);
        logger.info(`[callCoordination] apiUrl: ${this.contextManager.apiUrl}, apiSecret: ${this.contextManager.apiSecret ? 'SET (' + this.contextManager.apiSecret.substring(0, 10) + '...)' : 'NOT SET'}`);

        if (!this.contextManager.apiUrl) {
            logger.error("[callCoordination] Remote API not configured - apiUrl is:", this.contextManager.apiUrl);
            throw new Error("Remote API not configured");
        }

        // Circuit breaker: if open, fail fast
        if (this._circuitFailures >= CIRCUIT_FAILURE_THRESHOLD && Date.now() < this._circuitOpenUntil) {
            logger.warn(`[callCoordination] Circuit breaker OPEN — skipping remote call (resets at ${new Date(this._circuitOpenUntil).toISOString()})`);
            throw new CircuitOpenError();
        }

        // If cooldown expired, allow a probe attempt (half-open)
        if (this._circuitFailures >= CIRCUIT_FAILURE_THRESHOLD && Date.now() >= this._circuitOpenUntil) {
            logger.info("[callCoordination] Circuit breaker half-open — allowing probe request");
        }

        const url = this.contextManager.apiUrl.endsWith("/v1")
            ? `${this.contextManager.apiUrl}/${endpoint}`
            : `${this.contextManager.apiUrl}/v1/${endpoint}`;

        logger.info(`[callCoordination] Full URL: ${method} ${url}`);
        logger.info(`[callCoordination] Request body: ${body ? JSON.stringify({ ...body, projectName: this.projectName }) : 'none'}`);

        const maxRetries = 3;
        const baseDelay = 1000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);

            try {
                const response = await fetch(url, {
                    method,
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${this.contextManager.apiSecret || ""}`
                    },
                    body: body ? JSON.stringify({ ...body, projectName: this.projectName }) : undefined,
                    signal: controller.signal,
                });
                clearTimeout(timeout);

                logger.info(`[callCoordination] Response status: ${response.status} ${response.statusText}`);

                if (!response.ok) {
                    const text = await response.text();
                    logger.error(`[callCoordination] API Error Response (${response.status}): ${text}`);

                    // 4xx errors: do NOT retry, do NOT trip circuit
                    if (response.status >= 400 && response.status < 500) {
                        if (response.status === 401) {
                            throw new Error(`Authentication failed (401): ${text}. Check if API key is valid and exists in api_keys table.`);
                        }
                        throw new Error(`API Error (${response.status}): ${text}`);
                    }

                    // 5xx: retry-eligible, trip circuit
                    if (attempt < maxRetries) {
                        const delay = baseDelay * Math.pow(2, attempt - 1);
                        logger.warn(`[callCoordination] 5xx error, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
                        await new Promise(r => setTimeout(r, delay));
                        continue;
                    }

                    // Final attempt failed with 5xx
                    this._circuitFailures++;
                    if (this._circuitFailures >= CIRCUIT_FAILURE_THRESHOLD) {
                        this._circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
                        logger.error(`[callCoordination] Circuit breaker OPENED after ${this._circuitFailures} consecutive failures`);
                    }
                    throw new Error(`Server error (${response.status}): ${text}. Check Vercel logs for details.`);
                }

                // Success — reset circuit breaker
                if (this._circuitFailures > 0) {
                    logger.info(`[callCoordination] Request succeeded, resetting circuit breaker (was at ${this._circuitFailures} failures)`);
                    this._circuitFailures = 0;
                    this._circuitOpenUntil = 0;
                }

                const jsonResult = await response.json();
                logger.info(`[callCoordination] Success - Response: ${JSON.stringify(jsonResult).substring(0, 200)}...`);
                return jsonResult;
            } catch (e: any) {
                clearTimeout(timeout);

                // Re-throw CircuitOpenError and 4xx errors without retry
                if (e instanceof CircuitOpenError) throw e;
                if (e.message.includes("Authentication failed") || e.message.includes("API Error (4")) {
                    throw e;
                }

                // Network error or abort — retry-eligible
                if (attempt < maxRetries) {
                    const delay = baseDelay * Math.pow(2, attempt - 1);
                    logger.warn(`[callCoordination] Network/timeout error, retrying in ${delay}ms (attempt ${attempt}/${maxRetries}): ${e.message}`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }

                // Final attempt failed
                this._circuitFailures++;
                if (this._circuitFailures >= CIRCUIT_FAILURE_THRESHOLD) {
                    this._circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
                    logger.error(`[callCoordination] Circuit breaker OPENED after ${this._circuitFailures} consecutive failures`);
                }

                logger.error(`[callCoordination] Fetch failed after ${maxRetries} attempts: ${e.message}`, e);
                if (e.message.includes("401")) {
                    throw new Error(`API Authentication Error: ${e.message}. Verify AXIS_API_KEY in MCP config matches a key in the api_keys table.`);
                }
                throw e;
            }
        }

        // Should not be reached, but satisfy TypeScript
        throw new Error("callCoordination: unexpected end of retry loop");
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
        // Priority: Remote API if available (for customers), then Supabase, then local
        logger.info(`[getLocks] Starting - projectName: ${this.projectName}`);
        logger.info(`[getLocks] Config - apiUrl: ${this.contextManager.apiUrl}, useSupabase: ${this.useSupabase}, hasSupabase: ${!!this.supabase}`);
        
        if (this.contextManager.apiUrl) {
            if (!this.useSupabase || !this.supabase) {
                // Use remote API when Supabase is not configured (customer mode)
                try {
                    logger.info(`[getLocks] Fetching locks from API for project: ${this.projectName}`);
                    const res = await this.callCoordination(`locks?projectName=${this.projectName}`) as { locks: any[] };
                    logger.info(`[getLocks] API returned ${res.locks?.length || 0} locks`);
                    return (res.locks || []).map((row: any) => ({
                        agentId: row.agent_id,
                        filePath: row.file_path,
                        intent: row.intent,
                        userPrompt: row.user_prompt,
                        timestamp: Date.parse(row.updated_at || row.timestamp)
                    }));
                } catch (e: any) {
                    logger.error(`[getLocks] Failed to fetch locks from API: ${e.message}`, e);
                    // Fall through to local fallback
                }
            }
        }
        
        if (this.useSupabase && this.supabase && this._projectId) {
            // Use direct Supabase when configured (development mode)
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
                // Fall through to API or local fallback
            }
        }

        // Fallback: Try API if available, otherwise local
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
                logger.error("Failed to fetch locks from API in fallback", e);
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
                logger.warn("Notepad RPC append failed", e as any);
            }
        }

        if (this.contextManager.apiUrl) {
            // Sync current state to sessions/sync for cloud RAG and backup
            try {
                const res = await this.callCoordination('sessions/sync', 'POST', {
                    title: `Current Session: ${this.projectName}`,
                    context: this.state.liveNotepad,
                    metadata: { source: "mcp-server-live" }
                }) as { projectId?: string };

                // If the API resolved/created a project, capture its ID
                if (res.projectId && !this._projectId) {
                    this._projectId = res.projectId;
                    logger.info(`NerveCenter: Captured projectId from sync API: ${this._projectId}`);
                }
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
            // --- Path 1: Direct Supabase (dev mode) - uses atomic RPC ---
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

            // --- Path 2: Remote API (customer mode) - uses atomic claim action ---
            if (this.contextManager.apiUrl) {
                try {
                    const data = await this.callCoordination("jobs", "POST", {
                        action: "claim",
                        agentId,
                    }) as any;

                    if (data && data.status === "CLAIMED") {
                        const job = this.jobFromRecord(data.job as JobRecord);
                        await this.appendToNotepad(`\n- [JOB CLAIMED] Agent '${agentId}' picked up: ${job.title}`);
                        return { status: "CLAIMED", job };
                    }

                    return { status: "NO_JOBS_AVAILABLE", message: "Relax. No open tickets (or dependencies not met)." };
                } catch (e: any) {
                    logger.error("Failed to claim job via API", e);
                    return { status: "NO_JOBS_AVAILABLE", message: `Claim failed: ${e.message}` };
                }
            }

            // --- Path 3: Local-only fallback ---
            const priorities = ["critical", "high", "medium", "low"];
            const allJobs = Object.values(this.state.jobs);
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
            await this.appendToNotepad(`\n- [JOB CLAIMED] Agent '${agentId}' picked up: ${job.title}`);
            return { status: "CLAIMED", job };
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

            this.logLockEvent("FORCE_UNLOCKED", filePath, "admin", undefined, reason);
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

    // --- Lock Event Logging ---

    private async logLockEvent(eventType: string, filePath: string, requestingAgent: string, blockingAgent?: string, intent?: string) {
        try {
            if (this.contextManager.apiUrl) {
                await this.callCoordination("lock-events", "POST", {
                    eventType,
                    filePath,
                    requestingAgent,
                    blockingAgent: blockingAgent || null,
                    intent: intent || null,
                });
            } else if (this.useSupabase && this.supabase && this._projectId) {
                await this.supabase.from("lock_events").insert({
                    project_id: this._projectId,
                    event_type: eventType,
                    file_path: filePath,
                    requesting_agent: requestingAgent,
                    blocking_agent: blockingAgent || null,
                    intent: intent || null,
                });
            }
        } catch (e: any) {
            logger.warn(`[logLockEvent] Failed to log ${eventType} event: ${e.message}`);
        }
    }

    // --- Decision & Orchestration ---

    /**
     * Check if two file paths conflict hierarchically.
     * A lock on a directory blocks locks on any file within it, and vice versa.
     * Examples:
     *   pathsConflict("/foo/bar", "/foo/bar/baz.ts") => true  (parent blocks child)
     *   pathsConflict("/foo/bar/baz.ts", "/foo/bar") => true  (child blocks parent)
     *   pathsConflict("/foo/bar", "/foo/bar")         => true  (exact match)
     *   pathsConflict("/foo/bar", "/foo/baz")         => false (siblings)
     */
    private static pathsConflict(pathA: string, pathB: string): boolean {
        const a = pathA.replace(/\/+$/, "");
        const b = pathB.replace(/\/+$/, "");
        if (a === b) return true;
        if (b.startsWith(a + "/")) return true;
        if (a.startsWith(b + "/")) return true;
        return false;
    }

    /**
     * Find any existing lock that conflicts hierarchically with the requested path.
     * Skips locks owned by the same agent and stale locks.
     */
    private findHierarchicalConflict(requestedPath: string, requestingAgent: string, locks: FileLock[]): FileLock | null {
        for (const lock of locks) {
            if (lock.agentId === requestingAgent) continue;
            const isStale = (Date.now() - lock.timestamp) > this.lockTimeout;
            if (isStale) continue;
            if (NerveCenter.pathsConflict(requestedPath, lock.filePath)) {
                return lock;
            }
        }
        return null;
    }

    async proposeFileAccess(agentId: string, filePath: string, intent: string, userPrompt: string) {
        return await this.mutex.runExclusive(async () => {
            logger.info(`[proposeFileAccess] Starting - agentId: ${agentId}, filePath: ${filePath}`);

            // --- Path 1: Remote API (customer mode) ---
            // Atomicity is handled server-side via try_acquire_lock RPC.
            // Hierarchical conflict checking is done server-side in the locks API route.
            if (this.contextManager.apiUrl) {
                try {
                    const result = await this.callCoordination("locks", "POST", {
                        action: "lock",
                        filePath,
                        agentId,
                        intent,
                        userPrompt
                    }) as { status?: string; message?: string; current_lock?: any };

                    if (result.status === "DENIED") {
                        logger.info(`[proposeFileAccess] DENIED by server: ${result.message}`);
                        this.logLockEvent("BLOCKED", filePath, agentId, result.current_lock?.agent_id, intent);
                        return {
                            status: "REQUIRES_ORCHESTRATION",
                            message: result.message || `File '${filePath}' is locked by another agent`,
                            currentLock: result.current_lock
                        };
                    }

                    logger.info(`[proposeFileAccess] GRANTED by server`);
                    this.logLockEvent("GRANTED", filePath, agentId, undefined, intent);
                    await this.appendToNotepad(`\n- [LOCK] ${agentId} locked ${filePath}\n  Intent: ${intent}`);
                    return { status: "GRANTED", message: `Access granted for ${filePath}` };
                } catch (e: any) {
                    // If the API returned 409 (conflict), parse the DENIED response
                    if (e.message && e.message.includes("409")) {
                        logger.info(`[proposeFileAccess] Lock conflict (409)`);

                        // Extract the blocking agent from the 409 JSON body embedded in the error
                        let blockingAgent: string | undefined;
                        try {
                            const jsonMatch = e.message.match(/\{.*\}/s);
                            if (jsonMatch) {
                                const parsed = JSON.parse(jsonMatch[0]);
                                blockingAgent = parsed.current_lock?.agent_id;
                            }
                        } catch { /* best-effort extraction */ }

                        // Log the BLOCKED event so it shows in the dashboard conflicts count
                        this.logLockEvent("BLOCKED", filePath, agentId, blockingAgent, intent);

                        return {
                            status: "REQUIRES_ORCHESTRATION",
                            message: `File '${filePath}' is locked by another agent`,
                        };
                    }
                    logger.error(`[proposeFileAccess] API lock failed: ${e.message}`, e);
                    return { error: `Failed to acquire lock via API: ${e.message}` };
                }
            }

            // --- Path 2: Direct Supabase (development mode) ---
            // Uses atomic try_acquire_lock RPC for exact-path locks.
            // Hierarchical conflict check: query existing locks first, then check path overlap.
            if (this.useSupabase && this.supabase && this._projectId) {
                try {
                    // Pre-flight: check for hierarchical conflicts among existing locks
                    const { data: existingLocks } = await this.supabase
                        .from("locks")
                        .select("agent_id, file_path, intent, updated_at")
                        .eq("project_id", this._projectId);

                    if (existingLocks && existingLocks.length > 0) {
                        const asFileLocks: FileLock[] = existingLocks.map((row: any) => ({
                            agentId: row.agent_id,
                            filePath: row.file_path,
                            intent: row.intent,
                            userPrompt: "",
                            timestamp: row.updated_at ? Date.parse(row.updated_at) : Date.now()
                        }));
                        const conflict = this.findHierarchicalConflict(filePath, agentId, asFileLocks);
                        if (conflict) {
                            logger.info(`[proposeFileAccess] Hierarchical conflict: '${filePath}' overlaps with locked '${conflict.filePath}' (owner: ${conflict.agentId})`);
                            this.logLockEvent("BLOCKED", filePath, agentId, conflict.agentId, intent);
                            return {
                                status: "REQUIRES_ORCHESTRATION",
                                message: `Conflict: '${filePath}' overlaps with '${conflict.filePath}' locked by '${conflict.agentId}'`,
                                currentLock: conflict
                            };
                        }
                    }

                    // No hierarchical conflict — proceed with atomic exact-path lock
                    const { data, error } = await this.supabase.rpc("try_acquire_lock", {
                        p_project_id: this._projectId,
                        p_file_path: filePath,
                        p_agent_id: agentId,
                        p_intent: intent,
                        p_user_prompt: userPrompt,
                        p_timeout_seconds: Math.floor(this.lockTimeout / 1000),
                    });

                    if (error) throw error;

                    const row = Array.isArray(data) ? data[0] : data;

                    if (row && row.status === "DENIED") {
                        this.logLockEvent("BLOCKED", filePath, agentId, row.owner_id, intent);
                        return {
                            status: "REQUIRES_ORCHESTRATION",
                            message: `Conflict: File '${filePath}' is locked by '${row.owner_id}'`,
                            currentLock: {
                                agentId: row.owner_id,
                                filePath,
                                intent: row.intent,
                                timestamp: row.updated_at ? Date.parse(row.updated_at) : Date.now()
                            }
                        };
                    }

                    this.logLockEvent("GRANTED", filePath, agentId, undefined, intent);
                    await this.appendToNotepad(`\n- [LOCK] ${agentId} locked ${filePath}\n  Intent: ${intent}`);
                    return { status: "GRANTED", message: `Access granted for ${filePath}` };
                } catch (e: any) {
                    logger.warn("[NerveCenter] Lock RPC failed. Falling back to local.", e);
                }
            }

            // --- Path 3: Local-only fallback ---
            // Full hierarchical conflict check against all local locks.
            const allLocks = Object.values(this.state.locks);
            const conflict = this.findHierarchicalConflict(filePath, agentId, allLocks);
            if (conflict) {
                logger.info(`[proposeFileAccess] Hierarchical conflict (local): '${filePath}' overlaps with locked '${conflict.filePath}' (owner: ${conflict.agentId})`);
                this.logLockEvent("BLOCKED", filePath, agentId, conflict.agentId, intent);
                return {
                    status: "REQUIRES_ORCHESTRATION",
                    message: `Conflict: '${filePath}' overlaps with '${conflict.filePath}' locked by '${conflict.agentId}'`,
                    currentLock: conflict
                };
            }

            this.state.locks[filePath] = { agentId, filePath, intent, userPrompt, timestamp: Date.now() };
            await this.saveState();
            this.logLockEvent("GRANTED", filePath, agentId, undefined, intent);
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

    async getSubscriptionStatus(email?: string) {
        // Priority: Remote API if available (for customers), then Supabase, then error
        // If no email provided, the remote API will use the API key identity
        logger.info(`[getSubscriptionStatus] Starting - email: ${email || "(API key identity)"}`);
        logger.info(`[getSubscriptionStatus] Config - apiUrl: ${this.contextManager.apiUrl}, apiSecret: ${this.contextManager.apiSecret ? 'SET' : 'NOT SET'}, useSupabase: ${this.useSupabase}`);
        
        if (this.contextManager.apiUrl) {
            try {
                const endpoint = email ? `usage?email=${encodeURIComponent(email)}` : "usage";
                logger.info(`[getSubscriptionStatus] Attempting API call to: ${endpoint}`);
                const result = await this.callCoordination(endpoint);
                logger.info(`[getSubscriptionStatus] API call successful: ${JSON.stringify(result).substring(0, 200)}`);
                return result;
            } catch (e: any) {
                logger.error(`[getSubscriptionStatus] API call failed: ${e.message}`, e);
                return { error: `API call failed: ${e.message}` };
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
        logger.info(`[getUsageStats] Config - apiUrl: ${this.contextManager.apiUrl}, apiSecret: ${this.contextManager.apiSecret ? 'SET' : 'NOT SET'}, useSupabase: ${this.useSupabase}`);
        
        if (this.contextManager.apiUrl) {
            try {
                const endpoint = email ? `usage?email=${encodeURIComponent(email)}` : "usage";
                logger.info(`[getUsageStats] Attempting API call to: ${endpoint}`);
                const result = await this.callCoordination(endpoint) as { usageCount?: number; email?: string; plan?: string; status?: string };
                logger.info(`[getUsageStats] API call successful: ${JSON.stringify(result).substring(0, 200)}`);
                return { email: email || result.email, usageCount: result.usageCount || 0 };
            } catch (e: any) {
                logger.error(`[getUsageStats] API call failed: ${e.message}`, e);
                return { error: `API call failed: ${e.message}` };
            }
        }
        
        if (this.useSupabase && this.supabase && email) {
            // Use direct Supabase when configured (development mode) — requires email
            const { data: profile } = await this.supabase
                .from("profiles")
                .select("usage_count")
                .ilike("email", email)
                .single();

            return { email, usageCount: (profile as any)?.usage_count || 0 };
        }

        return { error: "Coordination not configured. API URL not set and Supabase not available." };
    }
}
