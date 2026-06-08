import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { NerveCenter } from "../src/local/nerve-center.js";
import { denyWrites, locksEnforced, restoreWrites } from "../src/local/fs-guard.js";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

class MockManager {
    async embedContent() { /* no-op */ }
    async readFile() { return "content"; }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    process.chdir(REPO_ROOT);
    for (const c of cleanups.splice(0)) await c();
});

async function makeNerveCenter(enforceLocks: boolean) {
    const dir = await mkdtemp(path.join(tmpdir(), "axis-enf-"));
    const stateFile = path.join(dir, "state.json");
    await writeFile(stateFile, JSON.stringify({ locks: {}, jobs: {}, liveNotepad: "x" }));
    process.chdir(dir); // lock validation is cwd-relative
    const nc = new NerveCenter(new MockManager() as never, { stateFilePath: stateFile, enforceLocks });
    await nc.init();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return nc;
}

const isWritable = (mode: number) => (mode & 0o200) !== 0;

describe("fs-guard", () => {
    test("locksEnforced parses the env flag", () => {
        expect(locksEnforced({ AXIS_ENFORCE_LOCKS: "1" })).toBe(true);
        expect(locksEnforced({ AXIS_ENFORCE_LOCKS: "true" })).toBe(true);
        expect(locksEnforced({ AXIS_ENFORCE_LOCKS: "on" })).toBe(true);
        expect(locksEnforced({ AXIS_ENFORCE_LOCKS: "0" })).toBe(false);
        expect(locksEnforced({})).toBe(false);
    });

    test("denyWrites strips write bits (returns prior mode); restoreWrites puts them back", async () => {
        await makeNerveCenter(false); // just to set up an isolated cwd + cleanup
        const f = path.join(process.cwd(), "x.ts");
        await writeFile(f, "a");
        const prior = await denyWrites(f);
        expect(prior).toBeDefined();
        expect(isWritable((await stat(f)).mode)).toBe(false);
        await restoreWrites(f, prior);
        expect(isWritable((await stat(f)).mode)).toBe(true);
    });
});

describe("enforced locks (AXIS_ENFORCE_LOCKS)", () => {
    test("locking makes the file read-only; raw writes fail; guarded_write works; release restores", async () => {
        const nc = await makeNerveCenter(true);
        const f = path.join(process.cwd(), "ShopView.ts");
        await writeFile(f, "v1");

        expect((await nc.proposeFileAccess("A", f, "edit", "p")).status).toBe("GRANTED");

        // Physically read-only now — a process that ignores Axis cannot write.
        expect(isWritable((await stat(f)).mode)).toBe(false);
        await expect(writeFile(f, "rogue clobber")).rejects.toThrow();

        // The holder writes through the enforced path.
        expect((await nc.guardedWrite("A", f, "v2 via axis")).status).toBe("WRITTEN");
        expect(isWritable((await stat(f)).mode)).toBe(false); // still locked-on-disk

        // Release restores writability.
        await nc.releaseFileAccess("A", f);
        expect(isWritable((await stat(f)).mode)).toBe(true);
        await expect(writeFile(f, "ok now")).resolves.toBeUndefined();
    });

    test("default (no enforcement) leaves the file writable", async () => {
        const nc = await makeNerveCenter(false);
        const f = path.join(process.cwd(), "free.ts");
        await writeFile(f, "v1");
        await nc.proposeFileAccess("A", f, "edit", "p");
        expect(isWritable((await stat(f)).mode)).toBe(true);
        await expect(writeFile(f, "still works")).resolves.toBeUndefined();
    });

    test("finalize_session restores perms for every locked file", async () => {
        const nc = await makeNerveCenter(true);
        const f = path.join(process.cwd(), "a.ts");
        await writeFile(f, "x");
        await nc.proposeFileAccess("A", f, "edit", "p");
        expect(isWritable((await stat(f)).mode)).toBe(false);
        await nc.finalizeSession();
        expect(isWritable((await stat(f)).mode)).toBe(true);
    });

    test("complete_job restores perms for the assignee's locked files", async () => {
        const nc = await makeNerveCenter(true);
        const f = path.join(process.cwd(), "feature.ts");
        await writeFile(f, "x");
        const posted = await nc.postJob("Build feature", "desc");
        await nc.claimJob("A", posted.jobId);
        await nc.proposeFileAccess("A", f, "edit", "p");
        expect(isWritable((await stat(f)).mode)).toBe(false);
        await nc.completeJob("A", posted.jobId, "done", posted.completionKey);
        expect(isWritable((await stat(f)).mode)).toBe(true);
    });
});
