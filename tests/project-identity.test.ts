import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
    deriveProjectName,
    findProjectRoot,
    resolveProjectIdentity
} from "../src/local/project-identity.js";

const tempDirs: string[] = [];

function project(name: string, axisName?: string) {
    const root = mkdtempSync(path.join(tmpdir(), `axis-${name}-`));
    tempDirs.push(root);
    mkdirSync(path.join(root, ".git"));
    if (axisName) {
        mkdirSync(path.join(root, ".axis"));
        writeFileSync(
            path.join(root, ".axis", "axis.json"),
            JSON.stringify({ project: axisName })
        );
    }
    return root;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("project identity", () => {
    test("finds the same project root from a nested directory", () => {
        const root = project("nested");
        const nested = path.join(root, "packages", "server");
        mkdirSync(nested, { recursive: true });
        expect(findProjectRoot(nested)).toBe(root);
    });

    test("prefers the project name in .axis/axis.json", () => {
        const root = project("configured", "Axis Team");
        expect(deriveProjectName(root)).toBe("Axis Team");
    });

    test("switches away from a stale globally configured project", () => {
        const ravioli = project("ravioli", "Ravioli");
        const axis = project("axis", "Axis");
        const identity = resolveProjectIdentity(ravioli, ravioli, {
            PROJECT_NAME: "Ravioli",
            SUPERSET_WORKSPACE_PATH: axis
        });

        expect(identity).toEqual({
            root: axis,
            projectName: "Axis",
            source: "runtime",
            ignoredConfiguredRoot: ravioli
        });
    });

    test("preserves legacy PROJECT_NAME when the workspace did not switch", () => {
        const root = project("legacy");
        const identity = resolveProjectIdentity(root, root, {
            PROJECT_NAME: "shared-team-project",
            SUPERSET_WORKSPACE_PATH: root
        });
        expect(identity.projectName).toBe("shared-team-project");
        expect(identity.ignoredConfiguredRoot).toBeUndefined();
    });

    test("AXIS_PROJECT_NAME remains an explicit override after a switch", () => {
        const oldRoot = project("old");
        const activeRoot = project("active");
        const identity = resolveProjectIdentity(oldRoot, oldRoot, {
            PROJECT_NAME: "stale",
            AXIS_PROJECT_NAME: "intentional-shared-project",
            AXIS_WORKSPACE_ROOT: activeRoot
        });
        expect(identity.root).toBe(activeRoot);
        expect(identity.projectName).toBe("intentional-shared-project");
    });
});
