import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { detectWorkspaceSwitch, describeSwitch } from "../src/local/workspace-watch.js";

const tempDirs: string[] = [];

/** Create a fake repo (has package.json, so findProjectRoot treats it as a root). */
function makeRepo(name: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), `axis-ws-${name}-`));
    writeFileSync(path.join(dir, "package.json"), "{}");
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("detectWorkspaceSwitch — runtime hints", () => {
    test("switches when the hint points at a different repo", () => {
        const active = makeRepo("active");
        const other = makeRepo("other");
        const result = detectWorkspaceSwitch(active, {}, { AXIS_WORKSPACE_ROOT: other });
        expect(result?.reason).toBe("runtime-hint");
        expect(result?.root).toBe(path.resolve(other));
    });

    test("no switch when the hint matches the active root", () => {
        const active = makeRepo("active");
        expect(detectWorkspaceSwitch(active, {}, { AXIS_WORKSPACE_ROOT: active })).toBeNull();
    });

    test("a matching hint is authoritative — path args elsewhere are ignored", () => {
        const active = makeRepo("active");
        const other = makeRepo("other");
        const args = { filePath: path.join(other, "x.ts") };
        expect(detectWorkspaceSwitch(active, args, { AXIS_WORKSPACE_ROOT: active })).toBeNull();
    });

    test("nonexistent hint directory is ignored", () => {
        const active = makeRepo("active");
        const env = { AXIS_WORKSPACE_ROOT: path.join(active, "does-not-exist") };
        expect(detectWorkspaceSwitch(active, {}, env)).toBeNull();
    });
});

describe("detectWorkspaceSwitch — path arguments", () => {
    test("switches on an absolute filePath in a disjoint repo", () => {
        const active = makeRepo("active");
        const other = makeRepo("other");
        const file = path.join(other, "src.ts");
        writeFileSync(file, "x");
        const result = detectWorkspaceSwitch(active, { filePath: file }, {});
        expect(result?.reason).toBe("file-path");
        expect(result?.root).toBe(path.resolve(other));
    });

    test("a not-yet-created file still switches via its parent directory", () => {
        const active = makeRepo("active");
        const other = makeRepo("other");
        const result = detectWorkspaceSwitch(active, { filePath: path.join(other, "new.ts") }, {});
        expect(result?.root).toBe(path.resolve(other));
    });

    test("filePaths arrays are inspected too", () => {
        const active = makeRepo("active");
        const other = makeRepo("other");
        const result = detectWorkspaceSwitch(
            active,
            { filePaths: [path.join(active, "a.ts"), path.join(other, "b.ts")] },
            {}
        );
        expect(result?.root).toBe(path.resolve(other));
    });

    test("no switch for files inside the active root", () => {
        const active = makeRepo("active");
        expect(detectWorkspaceSwitch(active, { filePath: path.join(active, "a.ts") }, {})).toBeNull();
    });

    test("monorepo subpackages never trigger a false switch (descendant root)", () => {
        const active = makeRepo("active");
        const sub = path.join(active, "packages", "child");
        mkdirSync(sub, { recursive: true });
        writeFileSync(path.join(sub, "package.json"), "{}"); // its own project marker
        const file = path.join(sub, "index.ts");
        writeFileSync(file, "x");
        expect(detectWorkspaceSwitch(active, { filePath: file }, {})).toBeNull();
    });

    test("relative paths carry no workspace signal", () => {
        const active = makeRepo("active");
        expect(detectWorkspaceSwitch(active, { filePath: "src/a.ts" }, {})).toBeNull();
    });

    test("non-path args are ignored", () => {
        const active = makeRepo("active");
        expect(detectWorkspaceSwitch(active, { query: "/etc/passwd style strings in other keys" }, {})).toBeNull();
        expect(detectWorkspaceSwitch(active, null, {})).toBeNull();
    });
});

describe("describeSwitch", () => {
    test("mentions the project, root, and trigger", () => {
        const msg = describeSwitch({ root: "/r", projectName: "p", reason: "runtime-hint", trigger: "/r" });
        expect(msg).toContain('"p"');
        expect(msg).toContain("/r");
        expect(msg).toContain("runtime-hint");
    });
});
