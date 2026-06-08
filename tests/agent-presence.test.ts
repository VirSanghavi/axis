import { describe, expect, test } from "bun:test";
import { PresenceRoster } from "../src/local/agent-presence.js";

describe("PresenceRoster", () => {
    test("records and lists agents seen within the TTL", () => {
        const r = new PresenceRoster();
        r.seen("a-1", 1000, "active", "claimed JOB-2");
        r.seen("b-2", 1500, "idle", "waiting");
        const list = r.list(2000, 10_000);
        expect(list.map((a) => a.agentId)).toEqual(["b-2", "a-1"]); // most recent first
        expect(list[1].lastActivity).toBe("claimed JOB-2");
    });

    test("updates lastSeenAt and status, preserves firstSeenAt", () => {
        const r = new PresenceRoster();
        r.seen("a-1", 1000, "idle", "waiting");
        const updated = r.seen("a-1", 2000, "active", "claimed JOB-9");
        expect(updated.firstSeenAt).toBe(1000);
        expect(updated.lastSeenAt).toBe(2000);
        expect(updated.status).toBe("active");
        expect(r.size()).toBe(1);
    });

    test("preserves prior activity when none supplied", () => {
        const r = new PresenceRoster();
        r.seen("a-1", 1000, "active", "indexing");
        const after = r.seen("a-1", 1100, "active");
        expect(after.lastActivity).toBe("indexing");
    });

    test("excludes agents silent past the TTL from list/count", () => {
        const r = new PresenceRoster();
        r.seen("stale", 0, "active");
        r.seen("fresh", 9_000, "idle");
        expect(r.list(10_000, 5_000).map((a) => a.agentId)).toEqual(["fresh"]);
        expect(r.count(10_000, 5_000)).toBe(1);
        expect(r.count(10_000, 5_000, "idle")).toBe(1);
        expect(r.count(10_000, 5_000, "active")).toBe(0);
    });

    test("prune removes only stale agents and reports them", () => {
        const r = new PresenceRoster();
        r.seen("stale", 0);
        r.seen("fresh", 9_000);
        expect(r.prune(10_000, 5_000)).toEqual(["stale"]);
        expect(r.size()).toBe(1);
    });

    test("idle workers are visible before any jobs exist (the early-start case)", () => {
        const r = new PresenceRoster();
        r.seen("worker-a", 100, "idle", "waiting for work");
        r.seen("worker-b", 200, "idle", "waiting for work");
        // Orchestrator can see 2 idle workers ready before posting jobs.
        expect(r.count(300, 60_000, "idle")).toBe(2);
    });
});
