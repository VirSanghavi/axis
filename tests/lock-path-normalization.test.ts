/**
 * Regression tests for job 9f3a0faa: repo-name-prefixed relative lock paths
 * ("<repoDir>/src/x.ts", sent by agents whose shell cwd is the repo's parent)
 * must collapse onto the repo-relative key ("src/x.ts"). Before the fix the
 * two spellings coexisted as distinct lock keys and two agents were GRANTED
 * the same file simultaneously — observed live during the audit swarm.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "fs/promises";
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

    /**
     * Symlinked routes to one physical file must collapse to one lock key.
     *
     * Found by running examples/two-agent-collision.ts: on macOS `/var` is a
     * symlink to `/private/var`, so a literal prefix comparison against a
     * resolved cwd treats the two spellings as different files. That is the same
     * "two agents GRANTED on one file" failure as the repo-prefix case above,
     * reached by a different route, and it is not exotic: symlinked workspace
     * folders and home directories hit it too.
     */
    test("a symlinked path and a direct path are the same lock", async () => {
        const nc = await makeNerveCenter();
        const root = process.cwd();
        await mkdir(path.join(root, "src"), { recursive: true });
        await writeFile(path.join(root, "src", "z.ts"), "v1");

        // A symlinked alias of the repo root, the way /var aliases /private/var.
        const alias = path.join(path.dirname(root), `${path.basename(root)}-alias`);
        await symlink(root, alias, "dir");
        cleanups.push(() => rm(alias, { recursive: true, force: true }));

        expect((await nc.proposeFileAccess("agent-A", "src/z.ts", "editing", "p")).status).toBe("GRANTED");

        // Same file, reached through the symlink. It must be DENIED because
        // agent-A holds it. Asserting only "not GRANTED" is too weak: before the
        // fix this path came back REJECTED as "outside the project root", which
        // would satisfy a negative assertion while proving nothing about locking.
        const second = await nc.proposeFileAccess("agent-B", path.join(alias, "src", "z.ts"), "also editing", "p");
        expect(second.status).toBe("REQUIRES_ORCHESTRATION");
        expect(second.message).toContain("agent-A");

        const locks = await nc.listLocks();
        const entries = Object.values(locks as Record<string, { agentId: string; filePath: string }>);
        expect(entries).toHaveLength(1);
        expect(entries[0].agentId).toBe("agent-A");
    });

    /**
     * The configured projectRoot must actually govern lock containment.
     *
     * Before this fix, lock-paths always compared against process.cwd(), so a
     * server launched outside the repo (or one whose root detection walked up to
     * an ancestor) refused every lock with "outside the project root". The option
     * was accepted and silently ignored.
     */
    test("locks resolve against the configured projectRoot, not the process cwd", async () => {
        const repo = await realpath(await mkdtemp(path.join(tmpdir(), "axis-repo-")));
        const elsewhere = await realpath(await mkdtemp(path.join(tmpdir(), "axis-elsewhere-")));
        cleanups.push(() => rm(repo, { recursive: true, force: true }));
        cleanups.push(() => rm(elsewhere, { recursive: true, force: true }));

        await mkdir(path.join(repo, "src"), { recursive: true });
        await writeFile(path.join(repo, "src", "a.ts"), "v1");

        const stateFile = path.join(repo, "state.json");
        await writeFile(stateFile, JSON.stringify({ locks: {}, jobs: {}, liveNotepad: "x" }));

        // The server is running somewhere that is NOT the repo.
        process.chdir(elsewhere);

        const nc = new NerveCenter(new MockManager() as never, {
            stateFilePath: stateFile,
            projectRoot: repo,
        });
        await nc.init();

        const res = await nc.proposeFileAccess("agent-A", path.join(repo, "src", "a.ts"), "editing", "p");
        expect(res.status).toBe("GRANTED");

        // And the key is repo-relative, not an absolute path that happens to work.
        const locks = await nc.listLocks();
        const entries = Object.values(locks as Record<string, { filePath: string }>);
        expect(entries).toHaveLength(1);
        expect(entries[0].filePath).toBe("src/a.ts");
    });

    test("a symlinked path inside the repo is not rejected as outside it", async () => {
        const nc = await makeNerveCenter();
        const root = process.cwd();
        await mkdir(path.join(root, "src"), { recursive: true });
        await writeFile(path.join(root, "src", "w.ts"), "v1");

        const alias = path.join(path.dirname(root), `${path.basename(root)}-alias2`);
        await symlink(root, alias, "dir");
        cleanups.push(() => rm(alias, { recursive: true, force: true }));

        // Before canonicalization this returned REJECTED, "outside the project root".
        const res = await nc.proposeFileAccess("agent-A", path.join(alias, "src", "w.ts"), "editing", "p");
        expect(res.status).toBe("GRANTED");
    });
});
