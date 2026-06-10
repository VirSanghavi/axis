import { describe, expect, test } from "bun:test";
import { TeamUpdateTracker, formatTeamUpdates } from "../src/local/team-updates.js";

const A = "claude-code-smuwg1t";
const B = "cursor-agent-x9k2p";

describe("TeamUpdateTracker.drain", () => {
    test("first call establishes the cursor and returns null (no history dump)", () => {
        const t = new TeamUpdateTracker();
        expect(t.drain(A, "Session Start\n- [JOB POSTED] old stuff\n")).toBeNull();
    });

    test("delivers only what other agents appended since the last drain", () => {
        const t = new TeamUpdateTracker();
        let notepad = "Session Start\n";
        t.drain(A, notepad);

        notepad += `- [JOB CLAIMED] Agent '${B}' picked up: Build API\n`;
        const delta = t.drain(A, notepad);
        expect(delta).toContain("Build API");
        expect(delta).toContain(B);
    });

    test("an agent never sees its own entries", () => {
        const t = new TeamUpdateTracker();
        let notepad = "Session Start\n";
        t.drain(A, notepad);

        notepad += `- [JOB DONE] Agent '${A}' finished: My own job\n`;
        notepad += `- [${A}] my own standup note\n`;
        notepad += `- [UNLOCK] ${A} released src/x.ts\n`;
        expect(t.drain(A, notepad)).toBeNull();
    });

    test("continuation lines of own entries never leak (the live lock-intent echo)", () => {
        const t = new TeamUpdateTracker();
        let notepad = "Session Start\n";
        t.drain(A, notepad);

        notepad += `- [LOCK] ${A} locked README.md\n  Intent: remove npm path from docs\n`;
        expect(t.drain(A, notepad)).toBeNull();

        // A foreign multi-line entry keeps its continuation lines intact.
        notepad += `- [LOCK] ${B} locked src/api.ts\n  Intent: refactor auth flow\n`;
        const delta = t.drain(A, notepad);
        expect(delta).toContain("refactor auth flow");
        expect(delta).not.toContain("remove npm path");
    });

    test("mixed entries are filtered to foreign lines only", () => {
        const t = new TeamUpdateTracker();
        let notepad = "Session Start\n";
        t.drain(A, notepad);

        notepad += `- [JOB DONE] Agent '${A}' finished: mine\n`;
        notepad += `- [${B}] API contract changed: POST /v2/jobs\n`;
        const delta = t.drain(A, notepad);
        expect(delta).toContain("API contract changed");
        expect(delta).not.toContain("finished: mine");
    });

    test("drain advances the cursor — the same update is not delivered twice", () => {
        const t = new TeamUpdateTracker();
        let notepad = "Session Start\n";
        t.drain(A, notepad);
        notepad += `- [${B}] update one\n`;
        expect(t.drain(A, notepad)).toContain("update one");
        expect(t.drain(A, notepad)).toBeNull();
    });

    test("two agents have independent cursors", () => {
        const t = new TeamUpdateTracker();
        let notepad = "Session Start\n";
        t.drain(A, notepad);
        notepad += `- [${A}] from A\n`;
        t.drain(B, notepad); // B joins late: cursor only, no dump
        notepad += `- [${B}] from B\n`;

        expect(t.drain(A, notepad)).toContain("from B");
        expect(t.drain(B, notepad)).toBeNull(); // only its own entry since joining
    });

    test("a shrunken (reset) notepad yields null instead of garbage", () => {
        const t = new TeamUpdateTracker();
        t.drain(A, "a very long notepad that was archived........\n");
        expect(t.drain(A, "Session Start: fresh\n")).toBeNull();
    });

    test("long deltas are clipped to the most recent lines with a marker", () => {
        const t = new TeamUpdateTracker();
        let notepad = "Session Start\n";
        t.drain(A, notepad);
        for (let i = 0; i < 100; i++) notepad += `- [${B}] update number ${i} ${"x".repeat(40)}\n`;
        const delta = t.drain(A, notepad)!;
        expect(delta).toContain("… (earlier updates truncated)");
        expect(delta).toContain("update number 99");
        expect(delta.length).toBeLessThan(1700);
    });

    test("reset forgets cursors (next drain is a fresh join)", () => {
        const t = new TeamUpdateTracker();
        let notepad = "Session Start\n";
        t.drain(A, notepad);
        t.reset();
        notepad += `- [${B}] missed while reset\n`;
        expect(t.drain(A, notepad)).toBeNull(); // re-join, cursor re-established
    });
});

describe("formatTeamUpdates", () => {
    test("prefixes the delta with the team-activity banner", () => {
        expect(formatTeamUpdates("- [x] y")).toStartWith("📢 Team activity since your last call:");
    });
});
