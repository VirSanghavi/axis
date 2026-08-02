import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

/**
 * Crash-safe, cross-process-safe file persistence primitives (audit #5).
 *
 * The local/free tier persists NerveCenter state as a JSON file. The historical
 * implementation did `fs.writeFile(file, JSON.stringify(state, null, 2))` on
 * every mutation: a crash mid-write corrupts the file, and two MCP server
 * processes sharing one state file silently clobber each other (the in-process
 * mutex protects neither case). These primitives fix both without new
 * dependencies:
 *
 *  - `atomicWriteFile`  — write to a temp file in the same directory, then
 *    rename over the target. Readers can never observe a torn write.
 *  - `withFileLock`     — advisory cross-process lockfile (O_EXCL create with
 *    pid+timestamp), with stale-lock breaking for dead PIDs and crashed hosts.
 *  - `serializeState`   — compact (non-pretty) JSON, ~40% smaller on disk and
 *    cheaper per mutation.
 *  - `CoalescedWriter`  — collapses bursts of save calls into at most one
 *    in-flight write plus one trailing write, so O(state) serialization no
 *    longer runs once per lock event.
 *
 * Locks here are advisory, same as the product's file-lock semantics: they
 * protect cooperating axis-server processes, not arbitrary external writers.
 */

const LOCK_SUFFIX = ".lock";

/** Options for withFileLock. Exposed for tests; defaults suit server use. */
export interface FileLockOptions {
    /** Total time to keep retrying before giving up (ms). */
    timeoutMs?: number;
    /** Delay between acquisition attempts (ms). */
    retryDelayMs?: number;
    /** A lockfile older than this is considered stale even if its PID looks alive (ms). */
    staleMs?: number;
}

interface LockfileContents {
    pid: number;
    hostname: string;
    acquiredAt: number;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if a process with this pid exists on this machine. */
function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        // EPERM means "exists but not ours" — still alive.
        return e?.code === "EPERM";
    }
}

async function readLockfile(lockPath: string): Promise<LockfileContents | undefined> {
    try {
        return JSON.parse(await fs.readFile(lockPath, "utf-8")) as LockfileContents;
    } catch {
        return undefined; // unreadable/corrupt lockfiles are handled via mtime staleness
    }
}

async function lockIsStale(lockPath: string, staleMs: number): Promise<boolean> {
    const contents = await readLockfile(lockPath);
    if (contents && contents.hostname === os.hostname() && !pidAlive(contents.pid)) {
        return true; // owner died on this machine
    }
    try {
        const stat = await fs.stat(lockPath);
        return Date.now() - stat.mtimeMs > staleMs;
    } catch {
        return false; // vanished — the next acquire attempt will settle it
    }
}

/**
 * Run `fn` while holding an advisory cross-process lock derived from `targetPath`.
 * The lock is a `<target>.lock` file created with O_EXCL; contention retries with
 * a short delay, and stale locks (dead PID on this host, or older than `staleMs`)
 * are broken. The lock is always released, even when `fn` throws.
 */
export async function withFileLock<T>(
    targetPath: string,
    fn: () => Promise<T>,
    options: FileLockOptions = {}
): Promise<T> {
    const { timeoutMs = 10_000, retryDelayMs = 50, staleMs = 30_000 } = options;
    const lockPath = targetPath + LOCK_SUFFIX;
    const deadline = Date.now() + timeoutMs;

    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    for (;;) {
        try {
            const payload: LockfileContents = {
                pid: process.pid,
                hostname: os.hostname(),
                acquiredAt: Date.now(),
            };
            // 'wx' = O_CREAT|O_EXCL: atomically fails if the lockfile exists.
            await fs.writeFile(lockPath, JSON.stringify(payload), { flag: "wx" });
            break;
        } catch (e: any) {
            if (e?.code !== "EEXIST") throw e;
            if (await lockIsStale(lockPath, staleMs)) {
                await fs.unlink(lockPath).catch(() => {});
                continue; // race back to acquisition
            }
            if (Date.now() >= deadline) {
                const holder = await readLockfile(lockPath);
                throw new Error(
                    `Timed out acquiring file lock '${lockPath}'` +
                    (holder ? ` held by pid ${holder.pid} on ${holder.hostname}` : "")
                );
            }
            await sleep(retryDelayMs);
        }
    }

    try {
        return await fn();
    } finally {
        await fs.unlink(lockPath).catch(() => {});
    }
}

/**
 * Atomically replace the contents of `filePath`: write a temp file in the same
 * directory (rename is only atomic within one filesystem), fsync it, then
 * rename over the target. A reader can only ever see the old or the new
 * contents, never a mixture, regardless of crashes.
 */
export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = path.join(
        dir,
        `.${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`
    );
    const handle = await fs.open(tmpPath, "w");
    try {
        await handle.writeFile(data, "utf-8");
        await handle.sync(); // durability: contents on disk before the rename publishes them
    } finally {
        await handle.close();
    }
    try {
        await fs.rename(tmpPath, filePath);
    } catch (e) {
        await fs.unlink(tmpPath).catch(() => {});
        throw e;
    }
}

/**
 * Atomic + cross-process-locked write: the standard way to persist shared
 * state. The lock closes the read-modify-write race between two cooperating
 * processes; the atomic rename closes the torn-write window within each.
 */
export async function lockedAtomicWriteFile(
    filePath: string,
    data: string,
    options?: FileLockOptions
): Promise<void> {
    await withFileLock(filePath, () => atomicWriteFile(filePath, data), options);
}

/** Compact JSON serialization for persisted state (no pretty-printing). */
export function serializeState(state: unknown): string {
    return JSON.stringify(state);
}

type WriteImpl = (filePath: string, data: string) => Promise<void>;

/**
 * Collapses bursts of writes to one file into at most one in-flight write and
 * one trailing write. Callers hand over the latest full serialized state; if a
 * write is already running, the payload is parked and only the newest parked
 * payload is written afterwards. `write()` resolves once the given (or a
 * newer) payload is durable, so callers keep write-through semantics.
 */
export class CoalescedWriter {
    private inFlight: Promise<void> | undefined;
    private pending: { data: string; settle: Array<{ resolve: () => void; reject: (e: unknown) => void }> } | undefined;
    /** Number of physical writes performed (exposed for tests/telemetry). */
    public writeCount = 0;

    constructor(
        private readonly filePath: string,
        private readonly writeImpl: WriteImpl = lockedAtomicWriteFile
    ) {}

    write(data: string): Promise<void> {
        if (!this.inFlight) {
            this.inFlight = this.performWrite(data);
            return this.inFlight;
        }
        if (!this.pending) {
            this.pending = { data, settle: [] };
        } else {
            this.pending.data = data; // newer state supersedes the parked one
        }
        return new Promise<void>((resolve, reject) => {
            this.pending!.settle.push({ resolve, reject });
        });
    }

    /** Resolves when everything handed to write() so far is durable. */
    async flush(): Promise<void> {
        // performWrite chains any parked payload into a fresh inFlight inside
        // its finally block, so looping until inFlight stays empty drains all.
        while (this.inFlight) {
            await this.inFlight.catch(() => {});
        }
    }

    private async performWrite(data: string): Promise<void> {
        try {
            this.writeCount++;
            await this.writeImpl(this.filePath, data);
        } finally {
            this.inFlight = undefined;
            const parked = this.pending;
            this.pending = undefined;
            if (parked) {
                this.inFlight = this.performWrite(parked.data);
                this.inFlight.then(
                    () => parked.settle.forEach((s) => s.resolve()),
                    (e) => parked.settle.forEach((s) => s.reject(e))
                );
            }
        }
    }
}
