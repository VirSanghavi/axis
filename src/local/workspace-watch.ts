/**
 * Dynamic workspace switching.
 *
 * Field report: a long-lived MCP session kept serving the project it booted
 * with — after the client moved to another repo the server stayed scoped to
 * the old board ("default", full of stale jobs from past projects) until a
 * process restart, and agents had to know to call `switch_project` by hand.
 *
 * This module makes the rebind automatic. On every tool call the server
 * re-resolves the workspace from:
 *   1. per-session runtime hints (AXIS_WORKSPACE_ROOT, SUPERSET_WORKSPACE_PATH,
 *      SUPERSET_ROOT_PATH) — hosts update these when the user changes
 *      workspaces without reconnecting; and
 *   2. any absolute file path in the call's arguments that lives in a
 *      *disjoint* project root (not an ancestor or descendant of the active
 *      one, so monorepo subpackages never trigger a false switch).
 *
 * If either points somewhere new, the server switches itself and tells the
 * agent it did — no restart, no manual switch_project, no cross-project
 * leakage of locks, jobs, or notepad entries.
 */
import fs from "fs";
import path from "path";
import { deriveProjectName, findProjectRoot } from "./project-identity.js";

/** Argument keys that can carry a workspace-revealing path. */
const PATH_ARG_KEYS = ["filePath", "filePaths"] as const;

export interface WorkspaceSwitch {
    root: string;
    projectName: string;
    /** What triggered the switch — surfaced in the response trailer and logs. */
    reason: "runtime-hint" | "file-path";
    trigger: string;
}

function existingDirectory(candidate?: string): string | undefined {
    if (!candidate) return undefined;
    const resolved = path.resolve(candidate);
    try {
        return fs.statSync(resolved).isDirectory() ? resolved : undefined;
    } catch {
        return undefined;
    }
}

/** Pull absolute path candidates out of a tool call's arguments. */
function pathArguments(args: unknown): string[] {
    if (!args || typeof args !== "object") return [];
    const record = args as Record<string, unknown>;
    const out: string[] = [];
    for (const key of PATH_ARG_KEYS) {
        const value = record[key];
        if (typeof value === "string") out.push(value);
        if (Array.isArray(value)) {
            for (const item of value) if (typeof item === "string") out.push(item);
        }
    }
    return out.filter((p) => path.isAbsolute(p));
}

/** True when neither root contains the other (a genuinely different repo). */
function disjointRoots(a: string, b: string): boolean {
    const ra = path.resolve(a);
    const rb = path.resolve(b);
    return ra !== rb && !ra.startsWith(rb + path.sep) && !rb.startsWith(ra + path.sep);
}

/**
 * Decide whether this tool call reveals that the session has moved to a
 * different workspace. Pure given (currentRoot, args, env) — no switching
 * side effects; the caller performs the actual `switchProject`.
 */
export function detectWorkspaceSwitch(
    currentRoot: string,
    args: unknown,
    env: NodeJS.ProcessEnv = process.env
): WorkspaceSwitch | null {
    const active = path.resolve(currentRoot);

    // 1. Runtime hints are authoritative when present: hosts set them
    //    per-session, so when they agree with the active root we are done.
    const hint = env.AXIS_WORKSPACE_ROOT || env.SUPERSET_WORKSPACE_PATH || env.SUPERSET_ROOT_PATH;
    const hintDir = existingDirectory(hint);
    if (hintDir) {
        const hintRoot = path.resolve(findProjectRoot(hintDir));
        if (hintRoot !== active) {
            return {
                root: hintRoot,
                projectName: deriveProjectName(hintRoot),
                reason: "runtime-hint",
                trigger: hint as string,
            };
        }
        return null;
    }

    // 2. An absolute path argument living in a disjoint project root.
    for (const candidate of pathArguments(args)) {
        const dir = existingDirectory(candidate) ?? existingDirectory(path.dirname(candidate));
        if (!dir) continue;
        const candidateRoot = path.resolve(findProjectRoot(dir));
        if (disjointRoots(candidateRoot, active)) {
            return {
                root: candidateRoot,
                projectName: deriveProjectName(candidateRoot),
                reason: "file-path",
                trigger: candidate,
            };
        }
    }

    return null;
}

/** Human-readable trailer appended to the tool response after an auto-switch. */
export function describeSwitch(s: WorkspaceSwitch): string {
    return [
        `⚠ Workspace switched automatically: now scoped to project "${s.projectName}" at ${s.root}.`,
        `Trigger: ${s.reason} (${s.trigger}).`,
        `Locks, jobs, and the notepad now refer to this project.`,
    ].join(" ");
}
