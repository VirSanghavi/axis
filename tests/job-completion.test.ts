import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { NerveCenter } from "../src/local/nerve-center.js";
import fs from "fs/promises";
import path from "path";
import os from "os";

// Mock ContextManager
class MockManager {
    logs = [];
    async embedContent(items: any) { (this.logs as any).push(items); }
    async readFile(_filename: string) { return "content"; }
    async updateFile(_filename: string, _content: string, _append: boolean) { }
}

describe("Job Completion Keys", () => {
    let nerveCenter: NerveCenter;
    let manager: MockManager;
    let testDir: string;

    beforeEach(async () => {
        testDir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-completion-"));
        const statePath = path.join(testDir, "state.json");
        const cleanState = { locks: {}, jobs: {}, liveNotepad: "Fresh Start" };
        await fs.writeFile(statePath, JSON.stringify(cleanState));

        manager = new MockManager();
        nerveCenter = new NerveCenter(manager as any, { stateFilePath: statePath });
        await nerveCenter.init();
    });

    afterEach(async () => {
        await fs.rm(testDir, { recursive: true, force: true });
    });

    test("postJob should return a completionKey", async () => {
        const res: any = await nerveCenter.postJob("Test Job", "Desc");
        assert.strictEqual(res.status, "POSTED");
        assert.ok(res.completionKey);
        assert.strictEqual(res.completionKey.length, 8);
    });

    test("should allow completion with valid completionKey by non-assigned agent", async () => {
        // 1. Post job
        const postRes: any = await nerveCenter.postJob("Test Job", "Desc");
        const jobId = postRes.jobId;
        const key = postRes.completionKey;

        // 2. Claim job by Agent A
        await nerveCenter.claimNextJob("AgentA");

        // 3. Complete job by Agent B using the key
        const compRes: any = await nerveCenter.completeJob("AgentB", jobId, "Done by B using key", key);
        assert.strictEqual(compRes.status, "COMPLETED");

        // 4. Verify job is done
        await nerveCenter.getCoreContext();
        // Since getCoreContext filters out "done" jobs from the summary, we check it via all jobs
        const jobs = await (nerveCenter as any).listJobs();
        const job = jobs.find((j: any) => j.id === jobId);
        assert.strictEqual(job.status, "done");
    });

    test("should REJECT completion with WRONG completionKey by non-assigned agent", async () => {
        const postRes: any = await nerveCenter.postJob("Test Job", "Desc");
        const jobId = postRes.jobId;

        await nerveCenter.claimNextJob("AgentA");

        const compRes: any = await nerveCenter.completeJob("AgentB", jobId, "Done by B", "WRONGKEY");
        assert.ok(compRes.error);
        assert.strictEqual(compRes.status, undefined);
    });

    test("should still allow completion by assigned agent WITHOUT a key", async () => {
        const postRes: any = await nerveCenter.postJob("Test Job", "Desc");
        const jobId = postRes.jobId;

        await nerveCenter.claimNextJob("AgentA");

        const compRes: any = await nerveCenter.completeJob("AgentA", jobId, "Done by A");
        assert.strictEqual(compRes.status, "COMPLETED");
    });
});
