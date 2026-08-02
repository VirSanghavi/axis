import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, stat, utimes } from "fs/promises";
import { tmpdir } from "os";
import * as os from "os";
import path from "path";
import {
    atomicWriteFile,
    lockedAtomicWriteFile,
    withFileLock,
    serializeState,
    CoalescedWriter,
} from "../src/local/atomic-file.js";

describe("atomic-file", () => {
    let dir: string;
    let target: string;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), "axis-atomic-"));
        target = path.join(dir, "state.json");
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    describe("atomicWriteFile", () => {
        test("writes contents and creates parent directories", async () => {
            const nested = path.join(dir, "a/b/state.json");
            await atomicWriteFile(nested, '{"ok":true}');
            expect(await readFile(nested, "utf-8")).toBe('{"ok":true}');
        });

        test("replaces existing contents completely", async () => {
            await atomicWriteFile(target, "x".repeat(10_000));
            await atomicWriteFile(target, "short");
            expect(await readFile(target, "utf-8")).toBe("short");
        });

        test("leaves no temp files behind", async () => {
            await atomicWriteFile(target, "data");
            const { readdir } = await import("fs/promises");
            const entries = await readdir(dir);
            expect(entries).toEqual(["state.json"]);
        });

        test("concurrent writers never produce a torn file", async () => {
            // 25 concurrent full-state writes; the survivor must be exactly one
            // of the payloads, parseable, never an interleaving.
            const payloads = Array.from({ length: 25 }, (_, i) =>
                JSON.stringify({ writer: i, fill: "y".repeat(2_000 + i) })
            );
            await Promise.all(payloads.map((p) => atomicWriteFile(target, p)));
            const result = await readFile(target, "utf-8");
            expect(payloads).toContain(result);
            expect(() => JSON.parse(result)).not.toThrow();
        });
    });

    describe("withFileLock", () => {
        test("runs the function and returns its result", async () => {
            expect(await withFileLock(target, async () => 42)).toBe(42);
        });

        test("provides mutual exclusion between concurrent critical sections", async () => {
            let inside = 0;
            let maxInside = 0;
            const critical = async () => {
                inside++;
                maxInside = Math.max(maxInside, inside);
                await new Promise((r) => setTimeout(r, 20));
                inside--;
            };
            await Promise.all([
                withFileLock(target, critical),
                withFileLock(target, critical),
                withFileLock(target, critical),
            ]);
            expect(maxInside).toBe(1);
        });

        test("releases the lock when the function throws", async () => {
            await expect(
                withFileLock(target, async () => {
                    throw new Error("boom");
                })
            ).rejects.toThrow("boom");
            // Lock must be free again: a follow-up acquisition succeeds fast.
            expect(await withFileLock(target, async () => "again", { timeoutMs: 200 })).toBe("again");
        });

        test("breaks a stale lock held by a dead PID on this host", async () => {
            // 2^22 exceeds the default macOS/Linux pid_max — guaranteed dead.
            await writeFile(
                target + ".lock",
                JSON.stringify({ pid: 4_194_304, hostname: os.hostname(), acquiredAt: Date.now() })
            );
            expect(await withFileLock(target, async () => "won", { timeoutMs: 1_000 })).toBe("won");
        });

        test("breaks a lock older than staleMs regardless of contents", async () => {
            const lockPath = target + ".lock";
            await writeFile(lockPath, "corrupt-not-json");
            const past = new Date(Date.now() - 60_000);
            await utimes(lockPath, past, past);
            expect(
                await withFileLock(target, async () => "won", { timeoutMs: 1_000, staleMs: 30_000 })
            ).toBe("won");
        });

        test("times out when a fresh lock is held by a live process", async () => {
            await writeFile(
                target + ".lock",
                JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() })
            );
            await expect(
                withFileLock(target, async () => "never", { timeoutMs: 150, retryDelayMs: 25 })
            ).rejects.toThrow(/Timed out acquiring file lock/);
        });
    });

    describe("cross-process safety", () => {
        test("two real processes hammering one file stay consistent", async () => {
            // Each subprocess performs 15 locked read-modify-write increments of
            // its own counter. Without cross-process locking the interleaved
            // read-modify-writes lose updates; with it, both counters land on 15.
            await writeFile(target, JSON.stringify({ a: 0, b: 0 }));
            const worker = (key: string) => `
                const { lockedAtomicWriteFile, withFileLock } = await import(${JSON.stringify(
                    path.resolve(import.meta.dir, "../src/local/atomic-file.ts")
                )});
                const { readFile } = await import("fs/promises");
                const target = ${JSON.stringify(target)};
                for (let i = 0; i < 15; i++) {
                    await withFileLock(target, async () => {
                        const state = JSON.parse(await readFile(target, "utf-8"));
                        state[${JSON.stringify(key)}]++;
                        const { atomicWriteFile } = await import(${JSON.stringify(
                            path.resolve(import.meta.dir, "../src/local/atomic-file.ts")
                        )});
                        await atomicWriteFile(target, JSON.stringify(state));
                    });
                }
            `;
            // process.execPath, not "bun", and an explicit cwd: other test files
            // in the shared suite process mutate PATH and chdir into temp dirs
            // they delete, and posix_spawn then fails ENOENT on both counts.
            const procs = ["a", "b"].map((key) =>
                Bun.spawn([process.execPath, "-e", worker(key)], { stdout: "pipe", stderr: "pipe", cwd: dir })
            );
            const exits = await Promise.all(procs.map((p) => p.exited));
            for (const [i, p] of procs.entries()) {
                if (exits[i] !== 0) {
                    throw new Error(`worker ${i} failed: ${await new Response(p.stderr).text()}`);
                }
            }
            const finalState = JSON.parse(await readFile(target, "utf-8"));
            expect(finalState).toEqual({ a: 15, b: 15 });
        }, 30_000);
    });

    describe("serializeState", () => {
        test("is compact (no pretty-printing) and round-trips", () => {
            const state = { locks: { "a.ts": { agentId: "x" } }, jobs: {}, liveNotepad: "n" };
            const compact = serializeState(state);
            expect(compact).not.toContain("\n");
            expect(compact.length).toBeLessThan(JSON.stringify(state, null, 2).length);
            expect(JSON.parse(compact)).toEqual(state);
        });
    });

    describe("CoalescedWriter", () => {
        test("write-through: a single write lands on disk before resolving", async () => {
            const writer = new CoalescedWriter(target);
            await writer.write('{"v":1}');
            expect(await readFile(target, "utf-8")).toBe('{"v":1}');
        });

        test("a burst collapses to far fewer physical writes, last state wins", async () => {
            const writer = new CoalescedWriter(target);
            const burst = Array.from({ length: 50 }, (_, i) => writer.write(`{"v":${i}}`));
            await Promise.all(burst);
            await writer.flush();
            expect(await readFile(target, "utf-8")).toBe('{"v":49}');
            expect(writer.writeCount).toBeLessThan(10); // typically 2: head + coalesced tail
        });

        test("callers of superseded payloads still resolve once newer state is durable", async () => {
            const written: string[] = [];
            const slowImpl = async (_file: string, data: string) => {
                await new Promise((r) => setTimeout(r, 10));
                written.push(data);
            };
            const writer = new CoalescedWriter(target, slowImpl);
            const first = writer.write("1"); // starts immediately
            const second = writer.write("2"); // parked
            const third = writer.write("3"); // supersedes 2
            await Promise.all([first, second, third]);
            expect(written).toEqual(["1", "3"]);
        });

        test("propagates write failures to awaiting callers", async () => {
            const failing = async () => {
                throw new Error("disk full");
            };
            const writer = new CoalescedWriter(target, failing);
            await expect(writer.write("x")).rejects.toThrow("disk full");
        });
    });

    describe("lockedAtomicWriteFile", () => {
        test("writes under the lock and cleans up the lockfile", async () => {
            await lockedAtomicWriteFile(target, '{"locked":true}');
            expect(await readFile(target, "utf-8")).toBe('{"locked":true}');
            await expect(stat(target + ".lock")).rejects.toThrow();
        });
    });
});
