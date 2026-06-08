import fs from "fs";
import path from "path";

export interface ProjectIdentity {
    root: string;
    projectName: string;
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

export function deriveProjectName(root: string): string {
    try {
        const config = JSON.parse(
            fs.readFileSync(path.join(root, ".axis", "axis.json"), "utf8")
        );
        const configuredName = config.project ?? config.projectName;
        if (configuredName) return String(configuredName);
    } catch {
        // A missing or invalid config falls back to the repository directory.
    }

    return path.basename(root)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "default";
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

    return {
        root,
        projectName,
        source,
        ...(switchedWorkspace ? { ignoredConfiguredRoot: configuredProjectRoot } : {})
    };
}
