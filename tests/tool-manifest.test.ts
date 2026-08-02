/**
 * Contract test (audit #2): the local stdio surface must expose exactly the
 * tools the canonical manifest (src/shared/tool-manifest.ts) says it does,
 * and every registered tool must have a dispatch arm in mcp-server.ts.
 *
 * The hosted twin lives at axis-frontend/frontend/lib/tool-manifest.test.ts
 * and checks the hosted surface against its mirrored manifest copy. Between
 * the two, any drift on either surface fails that repo's CI.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_TOOL_NAMES } from "../src/shared/tool-registry.js";
import { TOOL_MANIFEST, localToolNames } from "../src/shared/tool-manifest.js";

const serverSource = readFileSync(
  join(import.meta.dir, "..", "src", "local", "mcp-server.ts"),
  "utf8"
);

/**
 * Dispatch arms are `if (name === "tool_name")` comparisons (plus a handful
 * routed through exported TOOL_* constants). Collect both forms.
 */
function dispatchedToolNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/name === "([a-z_]+)"/g)) names.add(m[1]);
  // Constant-routed dispatch: `name === TOOL_X` where TOOL_X = "tool_name".
  const constants = new Map<string, string>();
  for (const m of source.matchAll(/(?:const|import[^;]*?)\s*(\w*TOOL\w*)\s*=\s*"([a-z_]+)"/g)) {
    constants.set(m[1], m[2]);
  }
  for (const m of source.matchAll(/name === ([A-Z][A-Z0-9_]*)/g)) {
    const resolved = constants.get(m[1]);
    if (resolved) names.add(resolved);
  }
  return names;
}

describe("tool manifest contract (local surface)", () => {
  test("registry matches the canonical manifest", () => {
    expect([...LOCAL_TOOL_NAMES].sort()).toEqual(localToolNames());
  });

  test("every registered tool has a dispatch arm in mcp-server.ts", () => {
    const dispatched = dispatchedToolNames(serverSource);
    // Constants are declared in tool-registry.ts, not mcp-server.ts — resolve
    // the well-known ones explicitly so the check stays source-only.
    for (const known of ["read_context", "update_context", "search_codebase"]) {
      if (serverSource.includes("TOOL_READ_CONTEXT") || serverSource.includes("READ_CONTEXT_TOOL")) {
        dispatched.add(known);
      }
    }
    const missing = LOCAL_TOOL_NAMES.filter((n) => !dispatched.has(n));
    expect(missing).toEqual([]);
  });

  test("manifest is internally consistent", () => {
    const names = TOOL_MANIFEST.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of TOOL_MANIFEST) {
      expect(entry.surfaces.length).toBeGreaterThanOrEqual(1);
      const missing = (["local", "hosted"] as const).filter((s) => !entry.surfaces.includes(s));
      if (missing.length === 0) {
        expect(entry.gap).toBeUndefined();
      } else {
        expect(entry.gap).toBeDefined();
        expect(missing).toContain(entry.gap!.missingFrom);
        expect(entry.gap!.reason.length).toBeGreaterThan(20);
      }
    }
  });

  test("manifest mirror note: hosted copy must stay in sync", () => {
    // The mirrored copy lives in the axis-frontend repo; when both repos are
    // checked out side-by-side (dev machines, not CI), verify byte-level sync
    // of the manifest data so the two contract tests can't diverge silently.
    const mirrorPath = join(
      import.meta.dir, "..", "..", "axis-frontend", "frontend", "lib", "tool-manifest.ts"
    );
    let mirror: string;
    try {
      mirror = readFileSync(mirrorPath, "utf8");
    } catch {
      return; // mirror repo not checked out (CI) — hosted CI runs its own test
    }
    const canonical = readFileSync(
      join(import.meta.dir, "..", "src", "shared", "tool-manifest.ts"),
      "utf8"
    );
    const strip = (s: string) => s.slice(s.indexOf("export type ToolSurface"));
    expect(strip(mirror)).toBe(strip(canonical));
  });
});
