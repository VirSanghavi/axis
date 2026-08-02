import fs from "fs";
import path from "path";

export interface ProjectIdentity {
    root: string;
    projectName: string;
    /**
     * Org the project coordinates under. When set, every remote call carries
     * X-Axis-Org so all members of that org resolve the SAME board for this
     * project name. Unset → the server's legacy behavior (the API scopes to
     * the caller's personal org), which keeps solo users unchanged.
     */
    orgId?: string;
    source: "runtime" | "configured" | "cwd";
    ignoredConfiguredRoot?: string;
}

export function projectStateFilePath(root: string): string {
    return path.join(path.resolve(root), "history", "nerve-center-state.json");
}

export function findProjectRoot(start: string): string {
    let current = path.resolve(start);
    const filesystemRoot = path.parse(current).root;

    while (true) {
        if (
            fs.existsSync(path.join(current, ".axis", "axis.json")) ||
            fs.existsSync(path.join(current, ".git")) ||
            fs.existsSync(path.join(current, "package.json"))
        ) {
            return current;
        }
        if (current === filesystemRoot) return path.resolve(start);
        current = path.dirname(current);
    }
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

function readAxisConfig(root: string): Record<string, unknown> {
    try {
        return JSON.parse(
            fs.readFileSync(path.join(root, ".axis", "axis.json"), "utf8")
        );
    } catch {
        // A missing or invalid config falls back to derived values.
        return {};
    }
}

export function deriveProjectName(root: string): string {
    const config = readAxisConfig(root);
    const configuredName = config.project ?? config.projectName;
    if (configuredName) return String(configuredName);

    return path.basename(root)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "default";
}

/**
 * The org this repo coordinates under. Committing `"org": "<org id>"` in
 * .axis/axis.json is the one-file way a team makes every clone, on every
 * machine and account, share a single job board / lock table / notepad.
 * Env AXIS_ORG_ID wins for per-machine overrides.
 */
export function deriveOrgId(root: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (env.AXIS_ORG_ID) return String(env.AXIS_ORG_ID);
    const config = readAxisConfig(root);
    const configured = config.org ?? config.orgId;
    return configured ? String(configured) : undefined;
}

export function resolveProjectIdentity(
    configuredRoot: string | undefined,
    cwd: string,
    env: NodeJS.ProcessEnv = process.env
): ProjectIdentity {
    const runtimeCandidate =
        existingDirectory(env.AXIS_WORKSPACE_ROOT) ||
        existingDirectory(env.SUPERSET_WORKSPACE_PATH) ||
        existingDirectory(env.SUPERSET_ROOT_PATH);
    const configuredCandidate = existingDirectory(configuredRoot);
    const runtimeRoot = runtimeCandidate ? findProjectRoot(runtimeCandidate) : undefined;
    const configuredProjectRoot = configuredCandidate
        ? findProjectRoot(configuredCandidate)
        : undefined;

    const root = runtimeRoot || configuredProjectRoot || findProjectRoot(cwd);
    const source = runtimeRoot ? "runtime" : configuredProjectRoot ? "configured" : "cwd";
    const switchedWorkspace = Boolean(
        runtimeRoot &&
        configuredProjectRoot &&
        path.resolve(runtimeRoot) !== path.resolve(configuredProjectRoot)
    );
    const projectName =
        env.AXIS_PROJECT_NAME ||
        (!switchedWorkspace ? env.PROJECT_NAME : undefined) ||
        deriveProjectName(root);

    const orgId = deriveOrgId(root, env);

    return {
        root,
        projectName,
        ...(orgId ? { orgId } : {}),
        source,
        ...(switchedWorkspace ? { ignoredConfiguredRoot: configuredProjectRoot } : {})
    };
}
