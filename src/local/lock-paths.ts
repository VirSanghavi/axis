import fs from "fs/promises";
import { existsSync, realpathSync } from "fs";
import path from "path";

/** realpath, or the input unchanged when it cannot be resolved. Never throws. */
function realpathOrSelf(target: string): string {
    try {
        return realpathSync(target);
    } catch {
        return target;
    }
}

/**
 * Resolve symlinks as far down a path as the filesystem allows, then re-append
 * the segments that do not exist yet.
 *
 * A plain realpath is not enough: agents legitimately lock files they are about
 * to create, and realpath throws on a missing leaf. Walking up to the deepest
 * existing ancestor canonicalizes the real part while leaving the rest intact.
 *
 * This is what makes two names for one file produce one lock key. On macOS
 * `/var` is a symlink to `/private/var`, so without this an agent sending
 * `/var/repo/src/a.ts` and one sending `src/a.ts` generate different keys and
 * BOTH get GRANTED on the same physical file.
 */
export function canonicalizePath(absolute: string): string {
    const pending: string[] = [];
    let current = absolute;

    while (current && current !== path.dirname(current)) {
        if (existsSync(current)) {
            return path.join(realpathOrSelf(current), ...pending);
        }
        pending.unshift(path.basename(current));
        current = path.dirname(current);
    }

    return absolute;
}

/**
 * Lock path normalization + file-only validation.
 * Extracted verbatim from NerveCenter statics (audit #3) — pure functions
 * with no coordination state.
 */

/**
 * Normalize a lock path to be relative to the project root.
 * Strips the project root prefix (process.cwd()) so that absolute and relative
 * paths resolve to the same key. This ensures that:
 *   "/Users/vir/Projects/MyApp/src/api/route.ts" and "src/api/route.ts"
 * are treated as the same lock.
 */
export function normalizeLockPath(filePath: string, projectRoot?: string): string {
    const cwd = canonicalizePath(path.resolve(projectRoot ?? process.cwd())).replace(/\/+$/, "");

    // Canonicalize before comparing, so a symlinked route to a file and a direct
    // route to the same file collapse to one lock key instead of two.
    const trimmed = filePath.replace(/\/+$/, "");
    let normalized = trimmed
        ? canonicalizePath(path.resolve(cwd, trimmed)).replace(/\/+$/, "")
        : trimmed;

    // Strip project root prefix if present
    if (normalized.startsWith(cwd + "/")) {
        normalized = normalized.slice(cwd.length + 1);
    } else if (normalized === cwd) {
        normalized = "";
    }

    // Strip leading slashes for consistency
    normalized = normalized.replace(/^\/+/, "");

    // Collapse repo-name-prefixed relative paths: an agent whose shell cwd is
    // the repo's PARENT directory sends "<repoDir>/src/x.ts", which used to
    // coexist with "src/x.ts" as two distinct lock keys on the same file —
    // observed live as two agents holding GRANTED locks on one file. Strip the
    // leading repo-dir segment unless the literal path is (or could be) a real
    // file inside a same-named subdirectory of the repo.
    const rootBase = path.basename(cwd);
    if (rootBase && normalized.startsWith(rootBase + "/")) {
        const stripped = normalized.slice(rootBase.length + 1);
        const literalExists = existsSync(path.join(cwd, normalized));
        const strippedExists = existsSync(path.join(cwd, stripped));
        const innerDirExists = existsSync(path.join(cwd, rootBase));
        if (!literalExists && (strippedExists || !innerDirExists)) {
            normalized = stripped;
        }
    }
    return normalized;
}

/**
 * Extensionless basenames that are known FILES, not directories (lowercased).
 * Locking a not-yet-created Dockerfile/Makefile/LICENSE used to be rejected by
 * the no-extension heuristic below — the stat-based check only rescues files
 * that already exist. Keep in sync with the same list in
 * axis-frontend/frontend/lib/axis-services.ts (the hosted server never has a
 * filesystem to stat, so it relies on this list for every call).
 */
const KNOWN_EXTENSIONLESS_FILES = new Set([
    // Build / task runners
    "makefile", "gnumakefile", "justfile", "rakefile", "buildfile", "buck", "tiltfile", "earthfile",
    // Containers / infra
    "dockerfile", "containerfile", "vagrantfile", "procfile", "caddyfile", "jenkinsfile", "kptfile",
    // Language package managers
    "gemfile", "guardfile", "brewfile", "podfile", "cartfile", "pipfile", "fastfile", "appfile", "matchfile", "snapfile",
    // Project meta / legal
    "license", "licence", "copying", "copyright", "notice", "patents", "authors", "contributors", "maintainers",
    "codeowners", "owners", "readme", "changelog", "changes", "news", "todo", "version", "cname",
]);

/**
 * Extensionless names that are files ONLY in their conventional uppercase
 * spelling (Bazel BUILD/WORKSPACE, GNU INSTALL). Lowercase "build" etc. is far
 * more often a directory, so these are matched case-sensitively.
 */
const KNOWN_EXTENSIONLESS_FILES_EXACT = new Set(["BUILD", "WORKSPACE", "INSTALL"]);

/**
 * Validate that a lock targets an individual file, not a directory.
 * Agents must lock specific files — directory locks are rejected because
 * they block all other agents from working on ANY file in that tree,
 * even for completely unrelated features.
 *
 * Detection strategy:
 * 1. If the path exists on disk, use fs.stat to check (handles extensionless files like Makefile)
 * 2. If the path doesn't exist, use file extension heuristic
 */
export async function validateFileOnly(
    filePath: string,
    projectRoot?: string
): Promise<{ valid: boolean; reason?: string }> {
    const normalized = normalizeLockPath(filePath, projectRoot);

    // Reject empty / root paths
    if (!normalized || normalized === "." || normalized === "/") {
        return { valid: false, reason: "Cannot lock the project root. Lock individual files instead." };
    }

    // Canonicalize both sides. Comparing a symlinked path against a resolved root
    // literally reports a file inside the repo as outside it, refusing every lock.
    const root = canonicalizePath(path.resolve(projectRoot ?? process.cwd()));
    const absolutePath = canonicalizePath(path.resolve(root, filePath));
    const relativePath = path.relative(root, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return { valid: false, reason: "Cannot lock files outside the project root." };
    }

    // Try filesystem check first (handles extensionless files like Makefile, Dockerfile, LICENSE)
    try {
        const stat = await fs.stat(absolutePath);
        if (stat.isDirectory()) {
            return {
                valid: false,
                reason: `'${normalized}' is a directory. Lock individual files instead — directory locks block all agents from the entire tree, preventing parallel work on different features.`
            };
        }
        // It's a file (even without an extension) — allow it
        return { valid: true };
    } catch {
        // Path doesn't exist on disk — fall through to heuristic
    }

    // Heuristic: if the last segment has no file extension, it's likely a
    // directory — unless it is a well-known extensionless file an agent is
    // about to create (an existing one is already allowed by the stat above).
    const lastSegment = normalized.split("/").filter(Boolean).pop() || "";
    if (!lastSegment.includes(".") && !KNOWN_EXTENSIONLESS_FILES.has(lastSegment.toLowerCase()) && !KNOWN_EXTENSIONLESS_FILES_EXACT.has(lastSegment)) {
        return {
            valid: false,
            reason: `'${normalized}' looks like a directory (no file extension). Lock individual files instead — directory locks block all agents from the entire tree, preventing parallel work on different features.`
        };
    }

    return { valid: true };
}

/**
 * Build an actionable denial message: who holds the lock, why, and how to
 * recover. Vague "locked by another agent" errors leave agents stuck; this
 * tells them what to do next.
 */
export function orchestrationMessage(lockTimeoutMs: number, normalizedPath: string, ownerId?: string, intent?: string): string {
    const mins = Math.round(lockTimeoutMs / 60000);
    const owner = ownerId || "another agent";
    const why = intent ? ` for: "${intent}"` : "";
    return `File '${normalizedPath}' is locked by '${owner}'${why}. `
        + `Pick a different file or job, or coordinate via update_shared_context. `
        + `The lock auto-expires after ${mins} min; use force_unlock only if '${owner}' has crashed.`;
}
