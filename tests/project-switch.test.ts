import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ContextManager } from "../src/local/context-manager.js";
import { NerveCenter } from "../src/local/nerve-center.js";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

class MockContextManager extends ContextManager {
    constructor() {
        super();
    }
    async readFile(_filename: string) { return "content"; }
    async searchContext(_query: string) { return "[]"; }
    async updateFile(_filename: string, _content: string, _append: boolean) { return "ok"; }
}

describe("NerveCenter project switching", () => {
    let rootA: string;
    let rootB: string;
    let nerveCenter: NerveCenter;

    beforeEach(async () => {
        rootA = await mkdtemp(path.join(tmpdir(), "axis-switch-a-"));
        rootB = await mkdtemp(path.join(tmpdir(), "axis-switch-b-"));

        await Promise.all([
            mkdir(path.join(rootA, ".git")),
            mkdir(path.join(rootB, ".git")),
            mkdir(path.join(rootA, ".axis")),
            mkdir(path.join(rootB, ".axis"))
        ]);

        await writeFile(path.join(rootA, ".axis", "axis.json"), JSON.stringify({ project: "ProjectA" }));
        await writeFile(path.join(rootB, ".axis", "axis.json"), JSON.stringify({ project: "ProjectB" }));

        nerveCenter = new NerveCenter(new MockContextManager(), { projectRoot: rootA });
        await nerveCenter.init();
    });

    afterEach(async () => {
        await rm(rootA, { recursive: true, force: true });
        await rm(rootB, { recursive: true, force: true });
    });

    test("switchProject reloads per-project state without reconnecting", async () => {
        const aJob = await nerveCenter.postJob("A Job", "first");
        await nerveCenter.proposeFileAccess("AgentA", "a.ts", "edit", "prompt");

        expect((await nerveCenter.listJobs()).some((job) => job.id === aJob.jobId)).toBe(true);
        expect((await nerveCenter.listLocks()).some((lock) => lock.filePath === "a.ts")).toBe(true);

        const switched = await nerveCenter.switchProject({ root: rootB, projectName: "ProjectB" });
        expect(switched.projectRoot).toBe(path.resolve(rootB));
        expect(switched.projectName).toBe("ProjectB");
        expect((await nerveCenter.listJobs()).length).toBe(0);
        expect((await nerveCenter.listLocks()).length).toBe(0);

        const bJob = await nerveCenter.postJob("B Job", "second");
        await nerveCenter.proposeFileAccess("AgentB", "b.ts", "edit", "prompt");
        expect((await nerveCenter.listJobs()).some((job) => job.id === bJob.jobId)).toBe(true);

        await nerveCenter.switchProject({ root: rootA, projectName: "ProjectA" });
        const restoredJobs = await nerveCenter.listJobs();
        const restoredLocks = await nerveCenter.listLocks();

        expect(restoredJobs.some((job) => job.id === aJob.jobId)).toBe(true);
        expect(restoredJobs.some((job) => job.id === bJob.jobId)).toBe(false);
        expect(restoredLocks.some((lock) => lock.filePath === "a.ts")).toBe(true);
        expect(restoredLocks.some((lock) => lock.filePath === "b.ts")).toBe(false);
    });
});
