import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { NerveCenter } from "../src/local/nerve-center.js";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

// Mock ContextManager
class MockManager {
    logs = [];
    async embedContent(items: any) { this.logs.push(items); }
    async readFile(_filename: string) { return "content"; }
}

describe("NerveCenter", () => {
    let nerveCenter: NerveCenter;
    let manager: MockManager;
    let testDir: string;

    beforeEach(async () => {
        testDir = await mkdtemp(path.join(tmpdir(), "axis-nerve-"));
        const stateFile = path.join(testDir, "state.json");
        const cleanState = { locks: {}, jobs: {}, liveNotepad: "Fresh Start" };
        await writeFile(stateFile, JSON.stringify(cleanState));

        manager = new MockManager();
        nerveCenter = new NerveCenter(manager, { stateFilePath: stateFile });
        await nerveCenter.init();
    });

    afterEach(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    test("should post a job", async () => {
        const res = await nerveCenter.postJob("Test Job", "Desc");
        expect(res.status).toBe("POSTED");
        expect(res.jobId).toBeDefined();
    });

    test("should claim a job", async () => {
        await nerveCenter.postJob("Test Job", "Desc");
        const res = await nerveCenter.claimNextJob("Agent007");
        expect(res.status).toBe("CLAIMED");
        expect(res.job.assignedTo).toBe("Agent007");
    });

    test("should lock file", async () => {
        const res = await nerveCenter.proposeFileAccess("AgentA", "file.ts", "edit", "prompt");
        expect(res.status).toBe("GRANTED");
    });

    test("should detect conflict", async () => {
        await nerveCenter.proposeFileAccess("AgentA", "file.ts", "edit", "prompt");
        const res = await nerveCenter.proposeFileAccess("AgentB", "file.ts", "edit", "prompt");
        expect(res.status).toBe("REQUIRES_ORCHESTRATION");
    });

    test("should reject locks outside the project root", async () => {
        const res = await nerveCenter.proposeFileAccess("AgentA", "../outside.ts", "edit", "prompt");
        expect(res.status).toBe("REJECTED");
        expect(res.message).toContain("outside the project root");
    });

    test("should normalize absolute and relative paths to the same lock", async () => {
        const absolutePath = `${process.cwd()}/same-file.ts`;
        await nerveCenter.proposeFileAccess("AgentA", absolutePath, "edit", "prompt");

        const res = await nerveCenter.proposeFileAccess("AgentB", "same-file.ts", "edit", "prompt");
        expect(res.status).toBe("REQUIRES_ORCHESTRATION");
    });
});
