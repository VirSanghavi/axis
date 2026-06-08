import { describe, expect, test, afterEach } from "bun:test";
import { NerveCenter } from "../src/local/nerve-center.js";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

class MockManager {
    async embedContent() { /* no-op */ }
    async readFile() { return "content"; }
}

// NerveCenter.init() chdir's to projectRoot, and other test files leave the
// process in a deleted temp dir. Pin each NerveCenter to its own temp dir and
// restore a known-good cwd after every test so we never depend on ambient cwd.
const REPO_ROOT = path.resolve(import.meta.dir, "..");

async function makeNerveCenter(options: Record<string, unknown> = {}, seedState?: unknown) {
    const dir = await mkdtemp(path.join(tmpdir(), "axis-hooks-"));
    const stateFile = path.join(dir, "state.json");
    await writeFile(stateFile, JSON.stringify(seedState ?? { locks: {}, jobs: {}, liveNotepad: "x" }));
    // Lock paths are validated against process.cwd(); work inside `dir` so the
    // test owns an isolated project root and writes no files into the repo.
    process.chdir(dir);
    const nc = new NerveCenter(new MockManager() as never, { stateFilePath: stateFile, ...options });
    await nc.init();
    return { nc, dir };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    process.chdir(REPO_ROOT);
    for (const c of cleanups.splice(0)) await c();
});

describe("tamper-evident locks (verifyFileAccess)", () => {
    test("NO_LOCK when the file isn't locked", async () => {
        const { nc, dir } = await makeNerveCenter();
        cleanups.push(() => rm(dir, { recursive: true, force: true }));
        const res = await nc.verifyFileAccess("A", "src/whatever.ts");
        expect(res.status).toBe("NO_LOCK");
    });

    test("UNKNOWN when the locked file had no fingerprint (didn't exist at lock time)", async () => {
        const { nc, dir } = await makeNerveCenter();
        cleanups.push(() => rm(dir, { recursive: true, force: true }));
        await nc.proposeFileAccess("A", "does-not-exist.ts", "create it", "p");
        const res = await nc.verifyFileAccess("A", "does-not-exist.ts");
        expect(res.status).toBe("UNKNOWN");
    });

    test("OK when unchanged, CONFLICT when edited under the lock (the ShopView case)", async () => {
        const { nc, dir } = await makeNerveCenter(); // cwd is now `dir`
        // Base on process.cwd() (canonicalized) not `dir` — on macOS mkdtemp
        // returns /var/... while cwd resolves to /private/var/..., and lock
        // validation compares against the canonical cwd.
        const realFile = path.join(process.cwd(), "ShopView.txt");
        await writeFile(realFile, "class ShopView {}");
        cleanups.push(() => rm(dir, { recursive: true, force: true }));

        const granted = await nc.proposeFileAccess("A", realFile, "edit ShopView", "p");
        expect(granted.status).toBe("GRANTED");

        const clean = await nc.verifyFileAccess("A", realFile);
        expect(clean.status).toBe("OK");

        // Someone rewrites the file out from under the advisory lock.
        await writeFile(realFile, "class ShopView { /* clobbered */ }");
        const conflict = await nc.verifyFileAccess("A", realFile);
        expect(conflict.status).toBe("CONFLICT");
        expect(conflict.verdict).toBe("modified");
    });
});

describe("actionable lock denials", () => {
    test("REQUIRES_ORCHESTRATION says who holds it, why, and how to recover", async () => {
        const { nc, dir } = await makeNerveCenter();
        cleanups.push(() => rm(dir, { recursive: true, force: true }));

        await nc.proposeFileAccess("agent-a", "shared.ts", "Refactor auth to JWT", "p");
        const denied = await nc.proposeFileAccess("agent-b", "shared.ts", "edit", "p");

        expect(denied.status).toBe("REQUIRES_ORCHESTRATION");
        expect(denied.message).toContain("agent-a");                 // who
        expect(denied.message).toContain("Refactor auth to JWT");    // why (their intent)
        expect(denied.message).toContain("force_unlock");            // recovery path
        expect(denied.message).toContain("update_shared_context");   // recovery path
        expect((denied as { currentLock?: unknown }).currentLock).toBeDefined();
    });

    test("REJECTED on a directory lock explains the rule", async () => {
        const { nc, dir } = await makeNerveCenter();
        cleanups.push(() => rm(dir, { recursive: true, force: true }));
        const res = await nc.proposeFileAccess("agent-a", "src", "lock the dir", "p");
        expect(res.status).toBe("REJECTED");
        expect(String(res.message).toLowerCase()).toContain("individual file");
    });
});

describe("stale-job auto-reclaim (claimNextJob)", () => {
    test("an abandoned in_progress job is reclaimed and handed to a new agent", async () => {
        const stale = {
            locks: {},
            jobs: {
                "old-1": {
                    id: "old-1",
                    title: "Abandoned ticket",
                    description: "",
                    priority: "high",
                    status: "in_progress",
                    assignedTo: "ghost-agent",
                    dependencies: [],
                    createdAt: 1,
                    updatedAt: 1, // ancient
                    completionKey: "K",
                },
            },
            liveNotepad: "x",
        };
        // lockTimeout: 1ms => the ancient in_progress job is immediately reclaimable.
        const { nc, dir } = await makeNerveCenter({ lockTimeout: 1 }, stale);
        cleanups.push(() => rm(dir, { recursive: true, force: true }));

        const res = await nc.claimNextJob("fresh-agent");
        expect(res.status).toBe("CLAIMED");
        expect(res.job.id).toBe("old-1");
        expect(res.job.assignedTo).toBe("fresh-agent");
    });

    test("a fresh in_progress job is NOT reclaimed", async () => {
        const fresh = {
            locks: {},
            jobs: {
                "busy-1": {
                    id: "busy-1",
                    title: "Active ticket",
                    description: "",
                    priority: "high",
                    status: "in_progress",
                    assignedTo: "working-agent",
                    dependencies: [],
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    completionKey: "K",
                },
            },
            liveNotepad: "x",
        };
        const { nc, dir } = await makeNerveCenter({}, fresh); // default 30-min TTL
        cleanups.push(() => rm(dir, { recursive: true, force: true }));

        const res = await nc.claimNextJob("other-agent");
        expect(res.status).toBe("NO_JOBS_AVAILABLE");
    });
});
