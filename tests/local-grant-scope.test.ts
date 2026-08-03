/**
 * A lock granted by the local fallback path binds this machine and nothing
 * else, and until now the response said only "Access granted for <path>".
 *
 * That is not a cosmetic gap. An agent handed a bare GRANTED tells its user the
 * file is safe to edit, which on a team is false: a teammate's agent, on their
 * clone, is not blocked by anything. The only signal that scope was limited was
 * a logger.warn on stderr, and MCP clients do not surface stderr to anyone.
 *
 * The two local cases are distinguished on purpose. Never having configured a
 * board is a choice; having one configured and unreachable is a failure, and
 * the user should be able to tell which one they are in from the response.
 */
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

async function makeLocalNerveCenter() {
    const dir = await mkdtemp(path.join(tmpdir(), "axis-grantscope-"));
    const stateFile = path.join(dir, "state.json");
    await writeFile(stateFile, JSON.stringify({ locks: {}, jobs: {}, liveNotepad: "x" }));
    await writeFile(path.join(dir, "auth.ts"), "export const x = 1;\n");
    process.chdir(dir);
    // Explicit nulls, not omissions: credentials sitting in the environment
    // would otherwise point this at a real hosted board and the test would
    // exercise Path 1 instead of the local fallback it is about.
    const nc = new NerveCenter(new MockManager() as never, {
        stateFilePath: stateFile,
        projectRoot: dir,
        projectName: "grant-scope-test",
        supabaseUrl: null,
        supabaseServiceRoleKey: null,
    } as never);
    await nc.init();
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return nc;
}

afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
});

describe("local grants state their real scope", () => {
    test("an unconfigured local grant says it covers this machine only", async () => {
        const nc = await makeLocalNerveCenter();

        const result = await nc.proposeFileAccess("agent-A", "auth.ts", "adding refresh tokens", "p") as
            { status: string; message: string; scope?: string };

        expect(result.status).toBe("GRANTED");
        expect(result.scope).toBe("local");
        // The specific false belief being prevented is "my teammate is blocked".
        // Asserting merely that the message is non-empty would have passed
        // against the old code, which is exactly the mistake that shipped a
        // regression test asserting a bug as intended behavior.
        expect(result.message).toContain("this machine only");
        expect(result.message.toLowerCase()).toContain("not blocked");
    });

    test("the scope note names other people, not just other processes", async () => {
        const nc = await makeLocalNerveCenter();

        const result = await nc.proposeFileAccess("agent-A", "auth.ts", "editing", "p") as
            { message: string };

        // A user who reads "other processes" concludes the risk is their own
        // second terminal. The risk that matters is a different human.
        expect(result.message).toContain("other people");
    });

    test("a grant is still a grant: the lock is real and still excludes locally", async () => {
        const nc = await makeLocalNerveCenter();

        await nc.proposeFileAccess("agent-A", "auth.ts", "adding refresh tokens", "p");
        const second = await nc.proposeFileAccess("agent-B", "auth.ts", "also editing", "p") as
            { status: string; message: string };

        // Advertising limited scope must not have weakened the exclusion it
        // does provide.
        expect(second.status).toBe("REQUIRES_ORCHESTRATION");
        expect(second.message).toContain("agent-A");
    });
});
