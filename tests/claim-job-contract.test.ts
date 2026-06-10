import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { NerveCenter } from "../src/local/nerve-center.js";

/**
 * Regression for the live mis-claim bug: the hosted API treats
 * action:"claim" as claim-NEXT (jobId silently ignored), so claimJob must
 * send action:"claim_by_id". Twice in real sessions an agent asked for one
 * job and was handed the head of the queue.
 */

class RemoteMockManager {
    apiUrl = "https://api.test/v1";
    apiSecret = "test-key";
    async embedContent() { /* no-op */ }
    async readFile() { return "content"; }
}

const cleanups: Array<() => Promise<void> | void> = [];
const realFetch = globalThis.fetch;

afterEach(async () => {
    globalThis.fetch = realFetch;
    for (const fn of cleanups.splice(0)) await fn();
});

/** Stub fetch FIRST (init() already talks to the API), then build the NerveCenter. */
async function makeRemoteNerveCenter(onJobsPost: (body: Record<string, unknown>) => Response) {
    const calls = stubFetch(onJobsPost);
    const dir = await mkdtemp(path.join(tmpdir(), "axis-claim-"));
    const stateFile = path.join(dir, "state.json");
    await writeFile(stateFile, JSON.stringify({ locks: {}, jobs: {}, liveNotepad: "x" }));
    process.chdir(dir);
    const nc = new NerveCenter(new RemoteMockManager() as never, { stateFilePath: stateFile });
    await nc.init();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return { nc, calls };
}

const TODO_JOB = {
    id: "job-target",
    title: "Target",
    description: "d",
    priority: "low",
    status: "todo",
    assigned_to: null,
    dependencies: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
};

function stubFetch(onJobsPost: (body: Record<string, unknown>) => Response) {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, body });
        if (url.includes("/jobs") && init?.method === "POST") return onJobsPost(body);
        if (url.includes("/jobs")) return Response.json({ jobs: [TODO_JOB] });
        if (url.includes("/sessions/sync")) return Response.json({ liveNotepad: "", projectId: "proj-1" });
        if (url.includes("/locks")) return Response.json({ locks: [] });
        return Response.json({});
    }) as typeof fetch;
    return calls;
}

describe("claimJob hosted-API contract", () => {
    test("sends action claim_by_id with the requested jobId (NOT claim)", async () => {
        const { nc, calls } = await makeRemoteNerveCenter(() =>
            Response.json({ status: "CLAIMED", job: { ...TODO_JOB, status: "in_progress", assigned_to: "A" } })
        );

        const result = await nc.claimJob("A", "job-target");
        expect(result.status).toBe("CLAIMED");

        const claimCall = calls.find((c) => c.body?.action);
        expect(claimCall?.body?.action).toBe("claim_by_id");
        expect(claimCall?.body?.jobId).toBe("job-target");
    });

    test("the claimed job is the one that was asked for", async () => {
        const { nc } = await makeRemoteNerveCenter((body) => {
            // Faithful server: honors claim_by_id with the requested id.
            expect(body.action).toBe("claim_by_id");
            return Response.json({ status: "CLAIMED", job: { ...TODO_JOB, id: String(body.jobId), status: "in_progress" } });
        });

        const result = await nc.claimJob("A", "job-target") as { status: string; job: { id: string } };
        expect(result.job.id).toBe("job-target");
    });

    test("a 409 BLOCKED_BY_DEPENDENCIES body is surfaced as a status, not a raw error", async () => {
        const { nc } = await makeRemoteNerveCenter(() =>
            new Response(JSON.stringify({ status: "BLOCKED_BY_DEPENDENCIES", unmet: ["dep-1"] }), { status: 409 })
        );

        const result = await nc.claimJob("A", "job-target") as { status: string; unmet?: string[] };
        expect(result.status).toBe("BLOCKED_BY_DEPENDENCIES");
        expect(result.unmet).toEqual(["dep-1"]);
    });

    test("an ALREADY_CLAIMED response passes through untouched", async () => {
        const { nc } = await makeRemoteNerveCenter(() =>
            Response.json({ status: "ALREADY_CLAIMED", job: { ...TODO_JOB, status: "in_progress", assigned_to: "B" } })
        );

        const result = await nc.claimJob("A", "job-target");
        expect(result.status).toBe("ALREADY_CLAIMED");
    });
});
