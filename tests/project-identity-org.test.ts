import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { deriveOrgId, resolveProjectIdentity } from "../src/local/project-identity.js";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

// Org resolution is what lets two teammates' clones land on the SAME board:
// AXIS_ORG_ID env (per-machine override) → .axis/axis.json "org" (committed
// team agreement) → undefined (legacy personal-org behavior).

describe("deriveOrgId", () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), "axis-org-test-"));
        await mkdir(path.join(root, ".axis"), { recursive: true });
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("reads the committed org from .axis/axis.json", async () => {
        await writeFile(
            path.join(root, ".axis", "axis.json"),
            JSON.stringify({ project: "shared-context", org: "org-team-1" })
        );
        expect(deriveOrgId(root, {})).toBe("org-team-1");
    });

    it("accepts the orgId key spelling too", async () => {
        await writeFile(
            path.join(root, ".axis", "axis.json"),
            JSON.stringify({ orgId: "org-alt" })
        );
        expect(deriveOrgId(root, {})).toBe("org-alt");
    });

    it("AXIS_ORG_ID env overrides the committed org", async () => {
        await writeFile(
            path.join(root, ".axis", "axis.json"),
            JSON.stringify({ org: "org-from-file" })
        );
        expect(deriveOrgId(root, { AXIS_ORG_ID: "org-from-env" })).toBe("org-from-env");
    });

    it("returns undefined with no config (legacy personal-org behavior)", async () => {
        expect(deriveOrgId(root, {})).toBeUndefined();
    });

    it("tolerates a malformed axis.json", async () => {
        await writeFile(path.join(root, ".axis", "axis.json"), "{not json");
        expect(deriveOrgId(root, {})).toBeUndefined();
    });
});

describe("resolveProjectIdentity org integration", () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), "axis-org-ident-"));
        await mkdir(path.join(root, ".axis"), { recursive: true });
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("carries orgId on the identity when configured", async () => {
        await writeFile(
            path.join(root, ".axis", "axis.json"),
            JSON.stringify({ project: "myrepo", org: "org-9" })
        );
        const identity = resolveProjectIdentity(root, root, {});
        expect(identity.projectName).toBe("myrepo");
        expect(identity.orgId).toBe("org-9");
    });

    it("omits orgId entirely when not configured", async () => {
        await writeFile(path.join(root, ".axis", "axis.json"), JSON.stringify({ project: "solo" }));
        const identity = resolveProjectIdentity(root, root, {});
        expect(identity.orgId).toBeUndefined();
        expect("orgId" in identity).toBe(false);
    });
});
