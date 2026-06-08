/**
 * Agent presence roster.
 *
 * Field report: "a user should be able to start multiple agents while you're
 * still deciding which jobs to post." Today `claim_next_job` returns a dead
 * NO_JOBS_AVAILABLE, so early-started workers look idle and invisible — the
 * human can't tell anyone is waiting, and the orchestrator can't see its team.
 *
 * The roster tracks who is online and whether they are actively working or idle
 * (waiting for work). `claim_next_job` registers presence and, when the board is
 * empty, returns WAITING plus the roster so the orchestrator knows workers are
 * ready before it finishes posting jobs.
 */

export type PresenceStatus = "active" | "idle";

export interface AgentPresence {
    agentId: string;
    status: PresenceStatus;
    firstSeenAt: number;
    lastSeenAt: number;
    /** Short description of the most recent action (e.g. "claimed JOB-2", "waiting"). */
    lastActivity?: string;
}

const DEFAULT_PRESENCE_TTL_MS = 5 * 60 * 1000; // consider an agent offline after 5 min of silence

export class PresenceRoster {
    private agents = new Map<string, AgentPresence>();

    /** Record activity from an agent. Idempotent per call; updates lastSeenAt. */
    seen(agentId: string, now: number, status: PresenceStatus = "active", activity?: string): AgentPresence {
        const existing = this.agents.get(agentId);
        const presence: AgentPresence = existing
            ? { ...existing, status, lastSeenAt: now, lastActivity: activity ?? existing.lastActivity }
            : { agentId, status, firstSeenAt: now, lastSeenAt: now, lastActivity: activity };
        this.agents.set(agentId, presence);
        return presence;
    }

    /** Agents seen within the TTL window, most-recently-active first. */
    list(now: number, ttlMs: number = DEFAULT_PRESENCE_TTL_MS): AgentPresence[] {
        return [...this.agents.values()]
            .filter((a) => now - a.lastSeenAt <= ttlMs)
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    }

    /** Count online agents, optionally filtered by status. */
    count(now: number, ttlMs: number = DEFAULT_PRESENCE_TTL_MS, status?: PresenceStatus): number {
        return this.list(now, ttlMs).filter((a) => !status || a.status === status).length;
    }

    /** Drop agents that have been silent past the TTL. Returns removed ids. */
    prune(now: number, ttlMs: number = DEFAULT_PRESENCE_TTL_MS): string[] {
        const removed: string[] = [];
        for (const [id, a] of this.agents) {
            if (now - a.lastSeenAt > ttlMs) {
                this.agents.delete(id);
                removed.push(id);
            }
        }
        return removed;
    }

    /** Test/inspection helper. */
    size(): number {
        return this.agents.size;
    }
}

export { DEFAULT_PRESENCE_TTL_MS };
