/**
 * Shared types for the coordination layer (locks, jobs, notepad state).
 * Extracted from nerve-center.ts so JobBoard, LockRegistry, and the
 * coordination client can share one vocabulary without importing the facade.
 */

export interface FileLock {
    agentId: string;
    filePath: string;
    intent: string;
    userPrompt: string;
    timestamp: number;
    /** Content fingerprint captured when the lock was granted (tamper detection). */
    contentHash?: string;
}

export interface Job {
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

/** Wire shape of a job row as returned by Supabase / the hosted API. */
export interface JobRecord {
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

export interface NerveCenterState {
    locks: Record<string, FileLock>; // Fallback local locks
    jobs: Record<string, Job>; // Fallback local jobs
    liveNotepad: string;
}

/**
 * The slice of ContextManager the coordination layer actually depends on.
 * Structural on purpose: tests inject bare mocks (even `{}`), and the real
 * ContextManager satisfies it without changes. This replaces the old
 * `contextManager: any`.
 */
export interface CoordinationContext {
    apiUrl?: string;
    apiSecret?: string;
    /** Org to coordinate under; kept in sync by NerveCenter on workspace switches. */
    orgId?: string;
    readFile?(filename: string): Promise<string>;
    embedContent?(items: { content: string; metadata: unknown }[], projectName?: string): Promise<unknown>;
}

export interface NerveCenterOptions {
    stateFilePath?: string;
    projectRoot?: string;
    lockTimeout?: number;
    supabaseUrl?: string | null;
    supabaseServiceRoleKey?: string | null;
    projectName?: string;
    /** Org to coordinate under (sent as X-Axis-Org). Defaults to AXIS_ORG_ID / .axis/axis.json "org". */
    orgId?: string;
    /** Physically enforce locks by chmod'ing locked files read-only. Defaults to AXIS_ENFORCE_LOCKS. */
    enforceLocks?: boolean;
}

export const LOCK_TIMEOUT_DEFAULT = 30 * 60 * 1000; // 30 minutes

export function jobFromRecord(record: JobRecord): Job {
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

export function createEmptyState(): NerveCenterState {
    return {
        locks: {},
        jobs: {},
        liveNotepad: "Session Start: " + new Date().toISOString() + "\n"
    };
}
