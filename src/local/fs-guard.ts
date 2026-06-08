/**
 * Filesystem-level lock enforcement.
 *
 * Advisory locks can't stop a process that ignores Axis (e.g. an agent editing
 * with its own tools). But the Axis MCP server runs locally with filesystem
 * access, so it can make a locked file *physically* read-only: strip the write
 * bits on grant, and any process — Axis-aware or not — gets EACCES when it tries
 * to write. The lock holder writes through `guarded_write`, which briefly
 * restores permissions. Release restores the original mode.
 *
 * This is real prevention, not detection. It's opt-in (AXIS_ENFORCE_LOCKS),
 * because it changes editing ergonomics: while a file is locked you must write
 * through Axis, not your raw editor.
 *
 * Caveats (honest): a process running as the same user CAN chmod the file back,
 * so this stops cooperating-but-not-Axis-aware tools and accidental clobbering,
 * not a deliberate attacker on the same account. Combined with unique identity
 * (proper DENY) and tamper fingerprints (detection), it closes the realistic gap.
 */

import fs from "fs/promises";

const WRITE_BITS = 0o222;

/** Whether physical lock enforcement is enabled. Opt-in; default off. */
export function locksEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
    const v = (env.AXIS_ENFORCE_LOCKS || "").trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Strip write permission from a file. Returns the prior mode (so it can be
 * restored later), or undefined if the file is missing / chmod failed.
 */
export async function denyWrites(absolutePath: string): Promise<number | undefined> {
    try {
        const st = await fs.stat(absolutePath);
        const mode = st.mode & 0o777;
        await fs.chmod(absolutePath, mode & ~WRITE_BITS);
        return mode;
    } catch {
        return undefined;
    }
}

/** Restore a file's permissions to a prior mode (default 0o644). Best-effort. */
export async function restoreWrites(absolutePath: string, originalMode?: number): Promise<void> {
    try {
        await fs.chmod(absolutePath, (originalMode ?? 0o644) & 0o777);
    } catch {
        /* best-effort: file may be gone, or fs may not support chmod */
    }
}

/**
 * Run a write with permissions temporarily restored, then re-deny so the file
 * stays locked-on-disk afterward (the lock is still held). Returns fn's result.
 */
export async function withTempWrite<T>(
    absolutePath: string,
    originalMode: number | undefined,
    fn: () => Promise<T>
): Promise<T> {
    await restoreWrites(absolutePath, originalMode);
    try {
        return await fn();
    } finally {
        await denyWrites(absolutePath);
    }
}
