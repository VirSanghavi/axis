/**
 * Agent identity resolution.
 *
 * Problem this solves: multiple agent sessions on one project used to share a
 * generic id (e.g. every Claude Code window sent "claude-code"). Because
 * `NerveCenter.findExactConflict` skips locks whose `agentId` matches the
 * requester, two sessions sharing an id would skip *each other's* locks and
 * both be GRANTED the same file — silent collisions, and "whose lock/note is
 * this?" confusion. Operators had to rename sessions to "-2"/"-3" by hand.
 *
 * Fix: mint a unique, stable id per MCP server process (one process == one
 * session). Each incoming `agentId` is normalized onto that session id, so
 * locks, jobs, and notepad attribution disambiguate downstream with no schema
 * change. `AXIS_AGENT_ID` is honored verbatim as a deliberate fixed override
 * (e.g. a long-lived orchestrator that must keep one id across restarts).
 */

export type AgentIdentitySource = "explicit" | "derived";

export interface SessionIdentity {
    /** The resolved, session-unique id used when this session calls tools without a specific id. */
    readonly id: string;
    /** Human label before the session suffix (e.g. "claude-code"). */
    readonly base: string;
    /** "explicit" when AXIS_AGENT_ID forced the id; "derived" when a suffix was added. */
    readonly source: AgentIdentitySource;
    /** Map any incoming agent id from this session onto a stable, session-unique id. */
    resolve(incoming?: string): string;
}

/** Env markers exposed by common agent hosts, used to label otherwise-anonymous sessions. */
function detectHostBase(env: NodeJS.ProcessEnv): string | undefined {
    if (env.CURSOR_TRACE_ID || env.CURSOR_SESSION_ID) return "cursor";
    if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SSE_PORT) return "claude-code";
    if (env.CODEX_MANAGED_BY_NPM || env.CODEX_SANDBOX) return "codex";
    if (env.WINDSURF_SESSION_ID || env.WINDSURF_SESSION) return "windsurf";
    if (env.GITHUB_COPILOT || env.COPILOT_AGENT_SESSION || env.COPILOT_MCP_SESSION) return "github-copilot";
    if (env.ANTIGRAVITY_AGENT || env.ANTIGRAVITY_SESSION_ID) return "antigravity";
    if (env.GEMINI_CLI || env.GEMINI_SESSION_ID) return "gemini";
    if (env.CLINE_TASK_ID) return "cline";
    if (env.ROO_CODE || env.ROO_TASK_ID) return "roo-code";
    if (env.CONTINUE_GLOBAL_DIR || env.CONTINUE_SESSION_ID) return "continue";
    if (env.AIDER_MODEL || env.AIDER_SESSION_ID) return "aider";
    return undefined;
}

/**
 * Normalize a raw agent label into a safe slug. Empty/invalid input becomes
 * "agent" so we never produce an id that starts or ends with the suffix joiner.
 */
export function normalizeBase(raw?: string): string {
    const cleaned = (raw || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^[-_.]+|[-_.]+$/g, "");
    // Require at least one alphanumeric char so all-punctuation input (e.g. "___")
    // falls back rather than producing a meaningless id.
    return /[a-z0-9]/.test(cleaned) ? cleaned : "agent";
}

/**
 * A short token that is stable for the lifetime of one process but distinct
 * across concurrent sessions. PID disambiguates local sessions; the random salt
 * guards against PID reuse across machines sharing a remote backend.
 */
export function defaultSessionSuffix(env: NodeJS.ProcessEnv = process.env): string {
    const override = env.AXIS_AGENT_SUFFIX?.trim();
    if (override) return normalizeBase(override);
    const pid = typeof process !== "undefined" && process.pid ? process.pid : 0;
    const salt = Math.random().toString(36).slice(2, 6);
    return `${pid.toString(36)}${salt}`;
}

/**
 * Pure resolution of a single id. Exposed for testing and reuse; production code
 * should prefer {@link createSessionIdentity} so the suffix is minted once.
 *
 * Precedence:
 *   1. `AXIS_AGENT_ID` — deliberate fixed override, returned verbatim.
 *   2. A specific `requestedId` — kept as the label, made unique with `token`.
 *   3. Host detection / `AXIS_AGENT_BASE` — when no usable id was supplied.
 */
export function resolveAgentId(
    requestedId: string | undefined,
    env: NodeJS.ProcessEnv,
    token: string
): string {
    const explicit = env.AXIS_AGENT_ID?.trim();
    if (explicit) return explicit;

    const requestedBase = normalizeBase(requestedId);
    const base = requestedBase !== "agent"
        ? requestedBase
        : (detectHostBase(env) || normalizeBase(env.AXIS_AGENT_BASE));

    return `${base}-${token}`;
}

/**
 * Mint one identity for the lifetime of this MCP server process. Call once at
 * startup and route every tool call's `agentId` through `resolve()`.
 */
export function createSessionIdentity(env: NodeJS.ProcessEnv = process.env): SessionIdentity {
    const token = defaultSessionSuffix(env);
    const explicit = env.AXIS_AGENT_ID?.trim();
    const base = explicit || detectHostBase(env) || normalizeBase(env.AXIS_AGENT_BASE);
    // Honor the per-call label (via resolveAgentId) so a client that sends a
    // specific id keeps it, while still pinning every result to this process's
    // token for uniqueness. AXIS_AGENT_ID overrides regardless of `incoming`.
    const resolve = (incoming?: string): string => resolveAgentId(incoming, env, token);

    return {
        id: resolve(),
        base,
        source: explicit ? "explicit" : "derived",
        resolve,
    };
}
