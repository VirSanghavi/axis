
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { NerveCenter } from "../src/local/nerve-center.js";
import { ContextManager } from "../src/local/context-manager.js";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

// Mocks
class MockContextManager extends ContextManager {
    constructor() { super(); }
    async search() { return []; }
    async storeMemory() { return true; }
    async embedContent() { return undefined; }
}

describe("NerveCenter Advanced Features", () => {
    let nerveCenter: NerveCenter;
    let testDir: string;

    beforeEach(async () => {
        testDir = await mkdtemp(path.join(tmpdir(), "axis-advanced-"));
        const stateFile = path.join(testDir, "state.json");
        await writeFile(stateFile, JSON.stringify({ locks: {}, jobs: {}, liveNotepad: "" }));

        nerveCenter = new NerveCenter(new MockContextManager(), { stateFilePath: stateFile });
        await nerveCenter.init();
    });

    afterEach(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    it("should prioritize critical jobs", async () => {
        await nerveCenter.postJob("Low Job", "desc", "low");
        await nerveCenter.postJob("Critical Job", "desc", "critical");
        await nerveCenter.postJob("Medium Job", "desc", "medium");

        const claim1 = await nerveCenter.claimNextJob("Agent1");
        expect(claim1.job?.title).toBe("Critical Job");

        const claim2 = await nerveCenter.claimNextJob("Agent2");
        expect(claim2.job?.title).toBe("Medium Job");
    });

    it("should respect job dependencies", async () => {
        const parent = await nerveCenter.postJob("Parent", "desc");
        const parentId = parent.jobId;

        await nerveCenter.postJob("Child", "desc", "medium", [parentId]);

        // First claim should get Parent (Child is blocked)
        const claim1 = await nerveCenter.claimNextJob("Agent1");
        expect(claim1.job?.id).toBe(parentId);

        // Second claim should find nothing because Child is blocked by Parent (which is in_progress, not done)
        const claim2 = await nerveCenter.claimNextJob("Agent2");
        expect(claim2.status).toBe("NO_JOBS_AVAILABLE");

        // Complete Parent
        await nerveCenter.completeJob("Agent1", parentId, "Done");

        // Now Child is available
        const claim3 = await nerveCenter.claimNextJob("Agent2");
        expect(claim3.job?.title).toBe("Child");
    });

    it("should allow admin to force unlock", async () => {
        await nerveCenter.proposeFileAccess("Agent1", "file.ts", "edit", "prompt");
        
        // Agent 2 is blocked
        const conflict = await nerveCenter.proposeFileAccess("Agent2", "file.ts", "edit", "prompt");
        expect(conflict.status).toBe("REQUIRES_ORCHESTRATION");

        // Admin force unlock
        await nerveCenter.forceUnlock("file.ts", "Emergency");

        // Agent 2 can now lock
        const success = await nerveCenter.proposeFileAccess("Agent2", "file.ts", "edit", "prompt");
        expect(success.status).toBe("GRANTED");
    });

    it("should cancel a job", async () => {
        const job = await nerveCenter.postJob("To Cancel", "desc");
        await nerveCenter.cancelJob(job.jobId, "Mistake");

        const claim = await nerveCenter.claimNextJob("Agent1");
        expect(claim.status).toBe("NO_JOBS_AVAILABLE");
    });

    it("should claim a specific available job", async () => {
        const first = await nerveCenter.postJob("First", "desc", "critical");
        const second = await nerveCenter.postJob("Second", "desc", "low");

        const claim = await nerveCenter.claimJob("Agent2", second.jobId);
        expect(claim.status).toBe("CLAIMED");
        expect(claim.job?.id).toBe(second.jobId);

        const next = await nerveCenter.claimNextJob("Agent1");
        expect(next.job?.id).toBe(first.jobId);
    });

    it("should reject a specific claim with unmet dependencies", async () => {
        const parent = await nerveCenter.postJob("Parent", "desc");
        const child = await nerveCenter.postJob("Child", "desc", "medium", [parent.jobId]);

        const claim = await nerveCenter.claimJob("Agent2", child.jobId);
        expect(claim.status).toBe("BLOCKED_BY_DEPENDENCIES");
        expect(claim.dependencies).toEqual([parent.jobId]);
    });

    it("should release only locks owned by the requesting agent", async () => {
        await nerveCenter.proposeFileAccess("Agent1", "owned.ts", "edit", "prompt");

        const denied = await nerveCenter.releaseFileAccess("Agent2", "owned.ts");
        expect(denied.status).toBe("NOT_OWNER");

        const released = await nerveCenter.releaseFileAccess("Agent1", "owned.ts");
        expect(released.status).toBe("RELEASED");
        expect(await nerveCenter.listLocks()).toHaveLength(0);
    });

    it("should release an assigned agent's locks when its job completes", async () => {
        const posted = await nerveCenter.postJob("Locked work", "desc");
        await nerveCenter.claimJob("Agent1", posted.jobId);
        await nerveCenter.proposeFileAccess("Agent1", "work.ts", "edit", "prompt");

        await nerveCenter.completeJob("Agent1", posted.jobId, "done");

        expect(await nerveCenter.listLocks()).toHaveLength(0);
    });
});
