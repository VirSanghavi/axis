/**
 * Regression: well-known extensionless files (Dockerfile, Makefile, LICENSE)
 * must be lockable even before they exist on disk. validateFileOnly stats
 * existing paths — the bug was in the heuristic fallback for files an agent
 * is ABOUT to create, which rejected anything without an extension as a
 * directory. The hosted server's copy of this fix lives in
 * axis-frontend/frontend/lib/axis-services.ts (looksLikeDirectoryLock).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { validateFileOnly } from "../src/local/lock-paths.js";

let dir: string;

async function makeRoot(): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), "axis-extless-"));
    return dir;
}

afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
});

describe("validateFileOnly — extensionless files", () => {
    test("not-yet-created well-known extensionless files are lockable", async () => {
        const root = await makeRoot();
        for (const file of ["Dockerfile", "Makefile", "LICENSE", "Procfile", "Jenkinsfile", "CODEOWNERS", "docker/Dockerfile"]) {
            const result = await validateFileOnly(file, root);
            expect(result.valid).toBe(true);
        }
    });

    test("existing extensionless files remain lockable (stat path)", async () => {
        const root = await makeRoot();
        await writeFile(path.join(root, "Makefile"), "all:\n");
        const result = await validateFileOnly("Makefile", root);
        expect(result.valid).toBe(true);
    });

    test("unknown extensionless segments are still rejected as directories", async () => {
        const root = await makeRoot();
        const result = await validateFileOnly("src/components", root);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("looks like a directory");
    });

    test("existing directories are still rejected, even with a well-known name", async () => {
        const root = await makeRoot();
        await mkdir(path.join(root, "build"), { recursive: true });
        const result = await validateFileOnly("build", root);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("is a directory");
    });
});
