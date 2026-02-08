
import { describe, it, expect, beforeEach } from "bun:test";
import { NerveCenter } from "../src/local/nerve-center.js";
import { ContextManager } from "../src/local/context-manager.js";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

// Mocks
class MockContextManager extends ContextManager {
    constructor() { super("url", "key"); }
    async search() { return []; }
    async storeMemory() { return true; }
    async embedContent() { return undefined; }
}

const TEST_STATE_FILE = join(process.cwd(), "tests", "temp-state-adv.json");

describe("NerveCenter Advanced Features", () => {
    let nerveCenter: NerveCenter;

    beforeEach(async () => {
        // Reset state file before each test to ensure isolation
        if (existsSync(TEST_STATE_FILE)) unlinkSync(TEST_STATE_FILE);
        writeFileSync(TEST_STATE_FILE, JSON.stringify({ locks: {}, jobs: {}, liveNotepad: "" }));

        nerveCenter = new NerveCenter(new MockContextManager(), { stateFilePath: TEST_STATE_FILE });
        await nerveCenter.init();
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
});
