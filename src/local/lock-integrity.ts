/**
 * Tamper-evident file locks.
 *
 * Axis locks are advisory: the MCP server cannot physically block an agent's
 * filesystem write, so a lock alone can't stop another process from rewriting a
 * file (the real-world "ShopView got rewritten under my GRANTED lock" failure).
 *
 * What we CAN do is make locks tamper-evident: record a content fingerprint when
 * the lock is granted, then let the holder verify before continuing whether the
 * file changed out from under them. Combined with unique per-session ids (which
 * turn silent same-id collisions into proper DENYs), this catches the dangerous
 * case — edit, then clobber — instead of failing silently.
 */

import { createHash } from "crypto";
import fs from "fs/promises";

/** Short, stable content fingerprint. 16 hex chars of sha256 is ample for collision detection here. */
export function hashContent(content: string | Buffer): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Hash a file's current contents, or undefined if it doesn't exist / can't be read. */
export async function hashFileIfExists(absolutePath: string): Promise<string | undefined> {
    try {
        const buf = await fs.readFile(absolutePath);
        return hashContent(buf);
    } catch {
        return undefined;
    }
}

export type IntegrityVerdict = "unchanged" | "modified" | "created" | "deleted" | "unknown";

/**
 * Compare the fingerprint captured at lock time against the file's current
 * fingerprint.
 *   - unchanged: same hash (or both absent)
 *   - modified:  both present but different
 *   - created:   absent at lock time, present now
 *   - deleted:   present at lock time, absent now
 *   - unknown:   no fingerprint was recorded at lock time
 */
export function compareFingerprint(
    lockedHash: string | undefined,
    currentHash: string | undefined,
    fingerprintRecorded: boolean
): IntegrityVerdict {
    if (!fingerprintRecorded) return "unknown";
    if (lockedHash === undefined && currentHash === undefined) return "unchanged";
    if (lockedHash === undefined && currentHash !== undefined) return "created";
    if (lockedHash !== undefined && currentHash === undefined) return "deleted";
    return lockedHash === currentHash ? "unchanged" : "modified";
}

export interface IntegrityReport {
    verdict: IntegrityVerdict;
    /** True when the file changed in a way the holder should reconcile before writing. */
    tampered: boolean;
    lockedHash?: string;
    currentHash?: string;
}

/** A verdict is "tampering" (re-read before writing) when content diverged or the file vanished. */
export function buildIntegrityReport(
    lockedHash: string | undefined,
    currentHash: string | undefined,
    fingerprintRecorded: boolean
): IntegrityReport {
    const verdict = compareFingerprint(lockedHash, currentHash, fingerprintRecorded);
    return {
        verdict,
        tampered: verdict === "modified" || verdict === "deleted",
        lockedHash,
        currentHash,
    };
}
