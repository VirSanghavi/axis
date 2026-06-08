import { describe, expect, test } from "bun:test";
import {
    DEFAULT_JOB_STALE_MS,
    findReclaimable,
    isReclaimable,
    staleForMs,
} from "../src/local/job-hygiene.js";

const NOW = 1_000_000_000;

describe("isReclaimable", () => {
    test("in_progress past the TTL is reclaimable", () => {
        const job = { status: "in_progress" as const, updatedAt: NOW - DEFAULT_JOB_STALE_MS - 1 };
        expect(isReclaimable(job, NOW)).toBe(true);
    });
    test("recently-updated in_progress is not reclaimable", () => {
        const job = { status: "in_progress" as const, updatedAt: NOW - 1000 };
        expect(isReclaimable(job, NOW)).toBe(false);
    });
    test("todo/done/cancelled are never reclaimed regardless of age", () => {
        const old = NOW - DEFAULT_JOB_STALE_MS * 100;
        expect(isReclaimable({ status: "todo", updatedAt: old }, NOW)).toBe(false);
        expect(isReclaimable({ status: "done", updatedAt: old }, NOW)).toBe(false);
        expect(isReclaimable({ status: "cancelled", updatedAt: old }, NOW)).toBe(false);
    });
    test("respects a custom TTL", () => {
        const job = { status: "in_progress" as const, updatedAt: NOW - 2000 };
        expect(isReclaimable(job, NOW, 1000)).toBe(true);
        expect(isReclaimable(job, NOW, 5000)).toBe(false);
    });
});

describe("staleForMs", () => {
    test("reports age for stale jobs, 0 otherwise", () => {
        expect(staleForMs({ status: "in_progress", updatedAt: NOW - 5000 }, NOW, 1000)).toBe(5000);
        expect(staleForMs({ status: "in_progress", updatedAt: NOW - 500 }, NOW, 1000)).toBe(0);
    });
});

describe("findReclaimable", () => {
    test("selects only the abandoned in_progress jobs (the Feb-rot case)", () => {
        const jobs = [
            { id: "fresh", status: "in_progress" as const, updatedAt: NOW - 1000 },
            { id: "abandoned", status: "in_progress" as const, updatedAt: NOW - DEFAULT_JOB_STALE_MS - 1 },
            { id: "open", status: "todo" as const, updatedAt: NOW - DEFAULT_JOB_STALE_MS * 10 },
            { id: "finished", status: "done" as const, updatedAt: NOW - DEFAULT_JOB_STALE_MS * 10 },
        ];
        expect(findReclaimable(jobs, NOW).map((j) => j.id)).toEqual(["abandoned"]);
    });
});
