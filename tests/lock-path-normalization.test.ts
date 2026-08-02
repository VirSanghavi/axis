/**
 * Regression tests for job 9f3a0faa: repo-name-prefixed relative lock paths
 * ("<repoDir>/src/x.ts", sent by agents whose shell cwd is the repo's parent)
 * must collapse onto the repo-relative key ("src/x.ts"). Before the fix the
 * two spellings coexisted as distinct lock keys and two agents were GRANTED
 * the same file simultaneously — observed live during the audit swarm.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { NerveCenter } from "../src/local/nerve-center.js";
import { normalizeLockPath } from "../src/local/lock-paths.js";

class MockManager {
    async embedContent() { /* no-op */ }
    async readFile() { return "content"; }
}

const cleanups: Array<() => Promise<void>> = [];

async function makeNerveCenter() {
    const dir = await mkdtemp(path.join(tmpdir(), "axis-lockpath-"));
    const stateFile = path.join(dir, "state.json");
    await writeFile(stateFile, JSON.stringify({ locks: {}, jobs: {}, liveNotepad: "x" }));
    process.chdir(dir); // lock validation is cwd-relative
    const nc = new NerveCenter(new MockManager() as never, { stateFilePath: stateFile });
    await nc.init();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return nc;
}

afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
});

describe("normalizeLockPath repo-prefix collapse", () => {
    test("strips a leading repo-dir segment when the stripped file exists", async () => {
        await makeNerveCenter();
        const repoDir = path.basename(process.cwd());
        await mkdir(path.join(process.cwd(), "src"), { recursive: true });
        await writeFile(path.join(process.cwd(), "src", "x.ts"), "v1");

        expect(normalizeLockPath(`${repoDir}/src/x.ts`)).toBe("src/x.ts");
    });

    test("strips the prefix for a new file when no same-named subdirectory exists", async () => {
        await makeNerveCenter();
        const repoDir = path.basename(process.cwd());
        expect(normalizeLockPath(`${repoDir}/src/new-file.ts`)).toBe("src/new-file.ts");
    });

    test("keeps the literal path when it names a real file in a same-named subdirectory", async () => {
        await makeNerveCenter();
        const repoDir = path.basename(process.cwd());
        await mkdir(path.join(process.cwd(), repoDir), { recursive: true });
        await writeFile(path.join(process.cwd(), repoDir, "inner.ts"), "v1");

        expect(normalizeLockPath(`${repoDir}/inner.ts`)).toBe(`${repoDir}/inner.ts`);
    });

    test("plain relative and absolute spellings still normalize as before", async () => {
        await makeNerveCenter();
        expect(normalizeLockPath("src/x.ts")).toBe("src/x.ts");
        expect(normalizeLockPath(path.join(process.cwd(), "src/x.ts"))).toBe("src/x.ts");
    });
});

describe("double-lock regression (the observed failure)", () => {
    test("repo-prefixed spelling of a locked file is DENIED, not granted", async () => {
        const nc = await makeNerveCenter();
        const repoDir = path.basename(process.cwd());
        await mkdir(path.join(process.cwd(), "src"), { recursive: true });
        await writeFile(path.join(process.cwd(), "src", "x.ts"), "v1");

        expect((await nc.proposeFileAccess("agent-A", "src/x.ts", "editing", "p")).status).toBe("GRANTED");

        const second = await nc.proposeFileAccess("agent-B", `${repoDir}/src/x.ts`, "also editing", "p");
        expect(second.status).not.toBe("GRANTED");

        // Exactly one lock exists, under the canonical key.
        const locks = await nc.listLocks();
        const entries = Object.values(locks as Record<string, { agentId: string; filePath: string }>);
        expect(entries).toHaveLength(1);
        expect(entries[0].agentId).toBe("agent-A");
    });

    test("the same agent re-locking through the other spelling stays one lock", async () => {
        const nc = await makeNerveCenter();
        const repoDir = path.basename(process.cwd());
        await mkdir(path.join(process.cwd(), "src"), { recursive: true });
        await writeFile(path.join(process.cwd(), "src", "y.ts"), "v1");

        expect((await nc.proposeFileAccess("agent-A", "src/y.ts", "editing", "p")).status).toBe("GRANTED");
        expect((await nc.proposeFileAccess("agent-A", `${repoDir}/src/y.ts`, "editing", "p")).status).toBe("GRANTED");

        const locks = await nc.listLocks();
        expect(Object.keys(locks)).toHaveLength(1);
    });
});
