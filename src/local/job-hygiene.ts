/**
 * Job board hygiene.
 *
 * Field report + live evidence: the shared "default" board was full of jobs stuck
 * `in_progress` since February, assigned to agents that are long gone. Abandoned
 * jobs never return to the board, so work silently stalls and the board stops
 * reflecting reality.
 *
 * A job claimed but not updated within a TTL is treated as abandoned and
 * reclaimed to `todo` so another agent can pick it up. The TTL mirrors the lock
 * timeout: if a crashed agent's locks expire, its jobs should too.
 */

export const DEFAULT_JOB_STALE_MS = 30 * 60 * 1000; // 30 min, matches LOCK_TIMEOUT_DEFAULT

export interface StalenessFields {
    status: "todo" | "in_progress" | "done" | "cancelled";
    updatedAt: number;
}

/** A job is reclaimable when it has sat `in_progress` past the TTL with no update. */
export function isReclaimable(job: StalenessFields, now: number, ttlMs: number = DEFAULT_JOB_STALE_MS): boolean {
    return job.status === "in_progress" && now - job.updatedAt > ttlMs;
}

/** How long (ms) a job has been stale; 0 if not stale. Useful for reporting. */
export function staleForMs(job: StalenessFields, now: number, ttlMs: number = DEFAULT_JOB_STALE_MS): number {
    return isReclaimable(job, now, ttlMs) ? now - job.updatedAt : 0;
}

/** Return the subset of jobs that should be auto-reclaimed to the board. */
export function findReclaimable<J extends StalenessFields>(
    jobs: J[],
    now: number,
    ttlMs: number = DEFAULT_JOB_STALE_MS
): J[] {
    return jobs.filter((j) => isReclaimable(j, now, ttlMs));
}
