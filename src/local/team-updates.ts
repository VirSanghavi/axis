/**
 * Ambient team context: per-agent notepad delta sync.
 *
 * Field report: the Live Notepad was the MVP of real multi-agent sessions —
 * but it is pull-only. Agents almost never re-read it mid-task, so they fell
 * back to `git log` for coordination, and a job got mis-claimed because the
 * board lagged what another agent was already implementing on disk.
 *
 * This module turns the notepad into ambient awareness: it tracks how much of
 * the notepad each agent has seen, and coordination tool calls return the
 * lines OTHER agents appended since the caller's last call — as a compact
 * trailer, capped so it never drowns the actual response. No new tool to
 * remember, nothing to poll: context arrives with the calls agents already make.
 */

/** Keep trailers readable — favor the most recent lines when clipping. */
const MAX_TRAILER_CHARS = 1500;

export class TeamUpdateTracker {
    /** agentId → notepad length already delivered to that agent. */
    private cursors = new Map<string, number>();

    /**
     * Return notepad content appended by other agents since `agentId`'s last
     * drain, or null when there is nothing new for them.
     *
     * The first call only establishes the cursor and returns null — a freshly
     * joined agent should not be greeted with the whole session history.
     */
    drain(agentId: string, notepad: string): string | null {
        const last = this.cursors.get(agentId);
        this.cursors.set(agentId, notepad.length);
        if (last === undefined) return null;
        // Shrinking notepad means a finalize/switch reset — nothing to replay.
        if (notepad.length <= last) return null;

        const foreign = notepad
            .slice(last)
            .split("\n")
            .filter((line) => {
                const trimmed = line.trim();
                // Session ids carry a unique suffix, so containment is a safe
                // self-authorship test across every entry format the nerve
                // center writes ("Agent 'x'", "- [x]", "[UNLOCK] x released").
                return trimmed.length > 0 && !trimmed.includes(agentId);
            });
        if (foreign.length === 0) return null;
        return clipTail(foreign.join("\n"));
    }

    /** Forget all cursors (project switch / session finalize). */
    reset(): void {
        this.cursors.clear();
    }
}

/** Clip to the most recent MAX_TRAILER_CHARS, marking the elision. */
function clipTail(text: string): string {
    if (text.length <= MAX_TRAILER_CHARS) return text;
    const tail = text.slice(-MAX_TRAILER_CHARS);
    // Start at the next full line so we never show half an entry.
    const firstNewline = tail.indexOf("\n");
    return "… (earlier updates truncated)\n" + (firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail);
}

/** Format the drained delta as a response trailer. */
export function formatTeamUpdates(delta: string): string {
    return `📢 Team activity since your last call:\n${delta}`;
}
