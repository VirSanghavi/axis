import { describe, expect, test } from "bun:test";
import {
    createSessionIdentity,
    defaultSessionSuffix,
    normalizeBase,
    resolveAgentId,
} from "../src/local/agent-identity.js";

describe("normalizeBase", () => {
    test("slugifies and lowercases", () => {
        expect(normalizeBase("Claude Code")).toBe("claude-code");
        expect(normalizeBase("  Cursor/Agent!! ")).toBe("cursor-agent");
    });

    test("falls back to 'agent' for empty/invalid input", () => {
        expect(normalizeBase("")).toBe("agent");
        expect(normalizeBase(undefined)).toBe("agent");
        expect(normalizeBase("___")).toBe("agent");
    });
});

describe("resolveAgentId", () => {
    test("AXIS_AGENT_ID is an exact override, ignoring requested id", () => {
        const id = resolveAgentId("claude-code", { AXIS_AGENT_ID: "orchestrator" }, "tok");
        expect(id).toBe("orchestrator");
    });

    test("keeps a specific requested label and appends the session token", () => {
        expect(resolveAgentId("claude-code", {}, "abc")).toBe("claude-code-abc");
        expect(resolveAgentId("cursor-agent", {}, "abc")).toBe("cursor-agent-abc");
    });

    test("two sessions with the same requested id get distinct ids", () => {
        // This is the core fix: shared 'claude-code' no longer collides, so
        // findExactConflict correctly treats the other session's lock as foreign.
        const a = resolveAgentId("claude-code", {}, "sess1");
        const b = resolveAgentId("claude-code", {}, "sess2");
        expect(a).not.toBe(b);
        expect(a).toBe("claude-code-sess1");
        expect(b).toBe("claude-code-sess2");
    });

    test("with no requested id, detects the host from env markers", () => {
        expect(resolveAgentId(undefined, { CLAUDECODE: "1" }, "t")).toBe("claude-code-t");
        expect(resolveAgentId("", { CURSOR_TRACE_ID: "x" }, "t")).toBe("cursor-t");
        expect(resolveAgentId(undefined, { CODEX_MANAGED_BY_NPM: "1" }, "t")).toBe("codex-t");
        expect(resolveAgentId(undefined, { COPILOT_AGENT_SESSION: "x" }, "t")).toBe("github-copilot-t");
        expect(resolveAgentId(undefined, { ANTIGRAVITY_SESSION_ID: "x" }, "t")).toBe("antigravity-t");
        expect(resolveAgentId(undefined, { GEMINI_CLI: "1" }, "t")).toBe("gemini-t");
    });

    test("honors AXIS_AGENT_BASE when no id and no host markers", () => {
        expect(resolveAgentId(undefined, { AXIS_AGENT_BASE: "ci-bot" }, "t")).toBe("ci-bot-t");
    });

    test("falls back to 'agent' when nothing identifies the session", () => {
        expect(resolveAgentId(undefined, {}, "t")).toBe("agent-t");
    });
});

describe("defaultSessionSuffix", () => {
    test("uses AXIS_AGENT_SUFFIX override (slugified) when provided", () => {
        expect(defaultSessionSuffix({ AXIS_AGENT_SUFFIX: "Lane_A" })).toBe("lane-a");
    });

    test("auto-generated suffix is non-empty", () => {
        expect(defaultSessionSuffix({}).length).toBeGreaterThan(0);
    });
});

describe("createSessionIdentity", () => {
    test("id is stable across resolve() calls within a session", () => {
        // CLAUDECODE host marker => session base "claude-code", matching the
        // label the client sends, so the canonical id and resolve() agree.
        const session = createSessionIdentity({ AXIS_AGENT_SUFFIX: "fixed", CLAUDECODE: "1" });
        const first = session.resolve("claude-code");
        const second = session.resolve("claude-code");
        expect(first).toBe(second);
        expect(first).toBe(session.id);
        expect(first).toBe("claude-code-fixed");
        expect(session.source).toBe("derived");
    });

    test("explicit override reports source and ignores incoming ids", () => {
        const session = createSessionIdentity({ AXIS_AGENT_ID: "orchestrator" });
        expect(session.id).toBe("orchestrator");
        expect(session.base).toBe("orchestrator");
        expect(session.source).toBe("explicit");
        expect(session.resolve("whatever-cursor")).toBe("orchestrator");
    });

    test("resolve() honors a specific incoming label, pinned to the session token", () => {
        const session = createSessionIdentity({ AXIS_AGENT_SUFFIX: "fixed" });
        // A client that sends a distinct, meaningful id keeps it (not discarded),
        // while still getting this session's unique suffix.
        expect(session.resolve("reviewer")).toBe("reviewer-fixed");
        expect(session.resolve("builder")).toBe("builder-fixed");
        // ...but an explicit AXIS_AGENT_ID still overrides any incoming label.
        const fixed = createSessionIdentity({ AXIS_AGENT_ID: "orchestrator", AXIS_AGENT_SUFFIX: "x" });
        expect(fixed.resolve("reviewer")).toBe("orchestrator");
    });

    test("two independent sessions never share an id", () => {
        // No fixed suffix => each session mints its own; ids must differ.
        const a = createSessionIdentity({ CLAUDECODE: "1" });
        const b = createSessionIdentity({ CLAUDECODE: "1" });
        expect(a.id).not.toBe(b.id);
        expect(a.base).toBe("claude-code");
        expect(b.base).toBe("claude-code");
    });
});
