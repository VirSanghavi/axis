import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
    buildIntegrityReport,
    compareFingerprint,
    hashContent,
    hashFileIfExists,
} from "../src/local/lock-integrity.js";

const tempDirs: string[] = [];
function tmp(): string {
    const d = mkdtempSync(path.join(tmpdir(), "axis-lock-"));
    tempDirs.push(d);
    return d;
}
afterEach(() => {
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("hashContent", () => {
    test("is stable and content-sensitive", () => {
        expect(hashContent("hello")).toBe(hashContent("hello"));
        expect(hashContent("hello")).not.toBe(hashContent("hello!"));
    });
    test("handles strings and buffers equivalently", () => {
        expect(hashContent(Buffer.from("abc"))).toBe(hashContent("abc"));
    });
});

describe("hashFileIfExists", () => {
    test("hashes an existing file", async () => {
        const dir = tmp();
        const f = path.join(dir, "a.ts");
        writeFileSync(f, "const x = 1;");
        expect(await hashFileIfExists(f)).toBe(hashContent("const x = 1;"));
    });
    test("returns undefined for a missing file", async () => {
        expect(await hashFileIfExists(path.join(tmp(), "nope.ts"))).toBeUndefined();
    });
});

describe("compareFingerprint", () => {
    test("unknown when no fingerprint was recorded", () => {
        expect(compareFingerprint(undefined, "a", false)).toBe("unknown");
    });
    test("unchanged when hashes match", () => {
        expect(compareFingerprint("a", "a", true)).toBe("unchanged");
        expect(compareFingerprint(undefined, undefined, true)).toBe("unchanged");
    });
    test("modified when hashes differ", () => {
        expect(compareFingerprint("a", "b", true)).toBe("modified");
    });
    test("created and deleted transitions", () => {
        expect(compareFingerprint(undefined, "b", true)).toBe("created");
        expect(compareFingerprint("a", undefined, true)).toBe("deleted");
    });
});

describe("buildIntegrityReport", () => {
    test("flags modified/deleted as tampered, others as safe", () => {
        expect(buildIntegrityReport("a", "b", true).tampered).toBe(true);
        expect(buildIntegrityReport("a", undefined, true).tampered).toBe(true);
        expect(buildIntegrityReport("a", "a", true).tampered).toBe(false);
        expect(buildIntegrityReport(undefined, "b", true).tampered).toBe(false); // created — holder's own new file
        expect(buildIntegrityReport(undefined, "a", false).tampered).toBe(false); // unknown — can't claim tamper
    });
    test("the ShopView scenario: locked, then changed by someone else", () => {
        const atLock = hashContent("class ShopView {}");
        const nowOnDisk = hashContent("class ShopView { /* rewritten */ }");
        const report = buildIntegrityReport(atLock, nowOnDisk, true);
        expect(report.verdict).toBe("modified");
        expect(report.tampered).toBe(true);
    });
});
