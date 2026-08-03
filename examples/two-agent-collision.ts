/**
 * The Axis demo, in one file.
 *
 *   bun examples/two-agent-collision.ts
 *
 * Two agents go for the same file at the same time. One wins. The other is told
 * who holds it and what they are doing, so it can go do something else instead
 * of silently overwriting their work.
 *
 * Nothing here is staged output. Every status and message printed below is a real
 * return value from the same NerveCenter the MCP server runs.
 *
 * This runs fully local and offline. It builds a throwaway repo in your temp
 * directory and forces local-only persistence, so it never touches a hosted board,
 * your Supabase, or your real org, even if you have credentials in the environment.
 */

import { NerveCenter } from "../src/local/nerve-center.js";
import { mkdtemp, rm, writeFile, mkdir, realpath } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** The MCP server injects a real one. The demo needs nothing from it. */
class NoopContextManager {
    async embedContent(_items: unknown) {}
    async readFile(_filename: string) {
        return "";
    }
}

/**
 * The shared logger writes structured JSON to stderr at info level and above,
 * which is right for a server and useless in a demo. Quiet it for the run.
 */
function muteServerLogs(): () => void {
    const original = console.error;
    console.error = () => {};
    return () => {
        console.error = original;
    };
}

function beat(title: string) {
    console.log(`\n${BOLD}${title}${RESET}`);
}

/** Colour by what actually came back, never by what we hoped for. */
function status(s: string | undefined): string {
    const value = s ?? "UNKNOWN";
    if (value === "GRANTED" || value === "CLAIMED" || value === "COMPLETED") return `${GREEN}${value}${RESET}`;
    if (value === "REQUIRES_ORCHESTRATION") return `${YELLOW}${value}${RESET}`;
    return `${RED}${value}${RESET}`;
}

async function main() {
    // realpath matters on macOS: mkdtemp hands back /var/..., which is a symlink
    // to /private/var/.... Path containment compares against the resolved cwd, so
    // an unresolved root reads as a different tree and every lock is refused.
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "axis-demo-")));
    await mkdir(path.join(root, "src"), { recursive: true });

    const stateFile = path.join(root, ".axis-state.json");
    await writeFile(stateFile, JSON.stringify({ locks: {}, jobs: {}, liveNotepad: "" }));

    // A real file inside the demo repo, so the lock is on something that exists.
    const contested = path.join(root, "src", "auth.ts");
    await writeFile(contested, "export function login() {\n  // session cookies\n}\n");

    // Axis resolves the project root from the working directory, which is how the
    // MCP server runs in practice: the client launches it inside the repo.
    const originalCwd = process.cwd();
    process.chdir(root);

    const restoreLogs = muteServerLogs();

    const axis = new NerveCenter(new NoopContextManager(), {
        stateFilePath: stateFile,
        projectRoot: root,
        projectName: "axis-demo",
        // Force the local-only path. Without these, credentials sitting in the
        // environment would point this demo at a real hosted board.
        supabaseUrl: null,
        supabaseServiceRoleKey: null,
    });
    await axis.init();

    console.log(`${DIM}Two developers, two agents, one repo. Watch the second one get told.${RESET}`);

    beat("1. Someone posts the work");
    await axis.postJob("refactor auth to issue JWTs", "swap session cookies for JWTs", "high");
    await axis.postJob("add rate limiting to the login route", "token bucket per IP", "medium");
    console.log(`   2 jobs on the board`);

    beat("2. Dana's agent (Claude Code) claims the top job and takes the file");
    const danaJob = await axis.claimNextJob("dana-claude-code");
    console.log(`   claim_next_job      -> ${status(danaJob.status)}  ${DIM}${danaJob.job?.title}${RESET}`);
    const danaLock = await axis.proposeFileAccess(
        "dana-claude-code",
        contested,
        "refactor auth to issue JWTs instead of session cookies",
        "refactor auth"
    );
    console.log(`   propose_file_access -> ${status(danaLock.status)}  ${DIM}src/auth.ts${RESET}`);

    beat("3. Sam's agent (Cursor, different machine) goes for the same file");
    const samLock = await axis.proposeFileAccess(
        "sam-cursor",
        contested,
        "add refresh token rotation",
        "add refresh rotation"
    );
    console.log(`   propose_file_access -> ${status(samLock.status)}`);
    console.log(`\n${samLock.message}\n`);
    console.log(`${DIM}   Not "permission denied". Who holds it, what they are doing, what to do next.${RESET}`);

    beat("4. So it takes the other job instead of colliding");
    const samJob = await axis.claimNextJob("sam-cursor");
    console.log(`   claim_next_job      -> ${status(samJob.status)}  ${DIM}${samJob.job?.title}${RESET}`);

    beat("5. Dana finishes. Completing the job releases the lock.");
    const done = await axis.completeJob(
        "dana-claude-code",
        danaJob.job!.id,
        "swapped to JWTs",
        danaJob.job!.completionKey
    );
    console.log(`   complete_job        -> ${status(done.status)}`);
    const retry = await axis.proposeFileAccess(
        "sam-cursor",
        contested,
        "add refresh token rotation",
        "add refresh rotation"
    );
    console.log(`   sam retries         -> ${status(retry.status)}  ${DIM}src/auth.ts${RESET}`);

    restoreLogs();

    console.log(
        `\n${BOLD}Same file. Correct order. Nobody negotiated it.${RESET}\n` +
            `${DIM}Across real machines this is the same code path, with the board in Postgres\n` +
            `so every teammate and every agent vendor sees it.\n\n` +
            `  claude mcp add --transport http axis https://useaxis.dev/api/mcp${RESET}\n`
    );

    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
