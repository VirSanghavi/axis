import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { NerveCenter } from "../src/local/nerve-center.js";

class MockManager {
    async embedContent() { /* no-op */ }
    async readFile() { return "content"; }
}

const cleanups: Array<() => Promise<void>> = [];

async function makeNerveCenter() {
    const dir = await mkdtemp(path.join(tmpdir(), "axis-batch-"));
    const stateFile = path.join(dir, "state.json");
    await writeFile(stateFile, JSON.stringify({ locks: {}, jobs: {}, liveNotepad: "x" }));
    process.chdir(dir); // lock validation is cwd-relative
    const nc = new NerveCenter(new MockManager() as never, { stateFilePath: stateFile });
    await nc.init();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return nc;
}

async function makeFiles(...names: string[]) {
    for (const name of names) await writeFile(path.join(process.cwd(), name), "v1");
}

afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
});

describe("proposeFilesAccess (batch, all-or-nothing)", () => {
    test("grants every file in one call", async () => {
        const nc = await makeNerveCenter();
        await makeFiles("a.ts", "b.ts", "c.ts");

        const result = await nc.proposeFilesAccess("A", ["a.ts", "b.ts", "c.ts"], "batch edit", "p");
        expect(result.status).toBe("GRANTED");
        expect(result.results).toHaveLength(3);

        const locks = await nc.listLocks();
        expect(Object.keys(locks)).toHaveLength(3);
    });

    test("denial midway releases the locks granted earlier in the batch", async () => {
        const nc = await makeNerveCenter();
        await makeFiles("a.ts", "b.ts", "c.ts");

        // Another agent owns b.ts.
        expect((await nc.proposeFileAccess("B", "b.ts", "other work", "p")).status).toBe("GRANTED");

        const result = await nc.proposeFilesAccess("A", ["a.ts", "b.ts", "c.ts"], "batch edit", "p");
        expect(result.status).toBe("REQUIRES_ORCHESTRATION");
        expect(result.failedOn).toBe("b.ts");
        expect(result.message).toContain("All-or-nothing");

        // a.ts was rolled back; only B's lock on b.ts remains; c.ts never attempted.
        const locks = await nc.listLocks();
        const owners = Object.values(locks as Record<string, { agentId: string; filePath: string }>);
        expect(owners).toHaveLength(1);
        expect(owners[0]?.agentId).toBe("B");
    });

    test("a directory in the batch rejects and rolls back", async () => {
        const nc = await makeNerveCenter();
        await makeFiles("a.ts");

        const result = await nc.proposeFilesAccess("A", ["a.ts", "."], "batch edit", "p");
        expect(result.status).toBe("REJECTED");
        expect(result.failedOn).toBe(".");
        expect(Object.keys(await nc.listLocks())).toHaveLength(0);
    });

    test("re-locking your own files in a batch refreshes instead of failing", async () => {
        const nc = await makeNerveCenter();
        await makeFiles("a.ts", "b.ts");
        expect((await nc.proposeFileAccess("A", "a.ts", "first", "p")).status).toBe("GRANTED");

        const result = await nc.proposeFilesAccess("A", ["a.ts", "b.ts"], "batch refresh", "p");
        expect(result.status).toBe("GRANTED");
    });
});
