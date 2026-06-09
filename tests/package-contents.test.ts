import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import axisServerPackage from "../packages/axis-server/package.json";
import rootPackage from "../package.json";

const repoRoot = path.resolve(import.meta.dir, "..");

describe("@virsanghavi/axis-server package contents", () => {
    test("publishes only runtime artifacts and public documentation", () => {
        expect(axisServerPackage.files).toEqual(["dist", "README.md"]);
        expect(axisServerPackage.files).not.toContain(".axis");
        expect(axisServerPackage.files).not.toContain(".axis-server.log");
        expect(axisServerPackage.files).not.toContain("bin");
    });

    test("published main entrypoint exists after build", () => {
        expect(axisServerPackage.main).toBe("dist/index.js");
        expect(
            existsSync(path.join(repoRoot, "packages/axis-server", axisServerPackage.main))
        ).toBe(true);
    });
});

describe("workspace publish safety", () => {
    test("the workspace root is private and cannot publish the whole repo", () => {
        // Root has no version/bin/main/files; it is a dev workspace, not a
        // distributable. Marking it private prevents `npm publish` from ever
        // shipping src/, tests/, scripts/, and local state.
        expect((rootPackage as { private?: boolean }).private).toBe(true);
    });
});

describe("Axis runtime state is not committed", () => {
    const generatedArtifacts = [
        "packages/axis-server/.axis-server.log",
        "packages/axis-server/.axis/instructions/activity.md",
        "packages/axis-server/.axis/instructions/context.md",
        "packages/axis-server/.axis/instructions/conventions.md",
    ];

    test("auto-generated server state is git-ignored", () => {
        for (const file of generatedArtifacts) {
            const ignored = execFileSync(
                "git",
                ["check-ignore", file],
                { cwd: repoRoot, encoding: "utf8" }
            ).trim();
            expect(ignored).toBe(file);
        }
    });

    test("no .axis-server.log or generated instructions are tracked", () => {
        const tracked = execFileSync(
            "git",
            ["ls-files"],
            { cwd: repoRoot, encoding: "utf8" }
        );
        expect(tracked).not.toMatch(/\.axis-server\.log/);
        expect(tracked).not.toMatch(/\.axis\/instructions\//);
    });

    test(".gitignore keeps .axis/axis.json config trackable", () => {
        const gitignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
        // We ignore generated instructions, not the whole .axis/ dir, so project
        // config (axis.json) can still be committed.
        expect(gitignore).not.toMatch(/^\.axis\/?$/m);
        expect(gitignore).toContain(".axis/instructions/");
    });
});
