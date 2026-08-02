import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { mineGitCochange } from "../src/local/indexer.js";

// Cold-start co-change seeding: files that co-commit are neighbors on day
// zero, before any lock_events exist. Mined against a real throwaway git repo.

let repo: string;

function git(...args: string[]) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function commit(files: Record<string, string>, message: string) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  git("add", "-A");
  git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", message, "--no-gpg-sign");
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "axis-cochange-"));
  git("init", "-q");
  // a.ts and b.ts co-change twice; c.ts rides along once; docs/readme.md is
  // filtered out by the keep() predicate below.
  commit({ "a.ts": "1", "b.ts": "1", "docs/readme.md": "1" }, "one");
  commit({ "a.ts": "2", "b.ts": "2" }, "two");
  commit({ "a.ts": "3", "c.ts": "1" }, "three");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("mineGitCochange", () => {
  test("pairs co-committed files, recency-weighted, keep-filtered", () => {
    const pairs = mineGitCochange(repo, (rel) => rel.endsWith(".ts"));
    const ab = pairs.find((p) => p.fileA === "a.ts" && p.fileB === "b.ts");
    const ac = pairs.find((p) => p.fileA === "a.ts" && p.fileB === "c.ts");

    expect(ab).toBeDefined();
    expect(ab!.coCount).toBe(2);
    expect(ac).toBeDefined();
    expect(ac!.coCount).toBe(1);
    // Two fresh co-commits must outweigh one.
    expect(ab!.weight).toBeGreaterThan(ac!.weight);
    // Filtered path never appears in any pair.
    expect(pairs.some((p) => p.fileA.endsWith(".md") || p.fileB.endsWith(".md"))).toBe(false);
    // Normalized ordering.
    for (const p of pairs) expect(p.fileA < p.fileB).toBe(true);
  });

  test("single-file and oversized commits contribute nothing", () => {
    commit({ "solo.ts": "1" }, "solo");
    const bulk: Record<string, string> = {};
    for (let i = 0; i < 25; i++) bulk[`bulk/f${i}.ts`] = "x";
    commit(bulk, "bulk import");

    const pairs = mineGitCochange(repo, (rel) => rel.endsWith(".ts"));
    expect(pairs.some((p) => p.fileA.startsWith("bulk/") || p.fileB.startsWith("bulk/"))).toBe(false);
    expect(pairs.some((p) => p.fileA === "solo.ts" || p.fileB === "solo.ts")).toBe(false);
  });

  test("non-repo directory yields an empty seed, not an error", () => {
    const plain = mkdtempSync(join(tmpdir(), "axis-plain-"));
    try {
      expect(mineGitCochange(plain, () => true)).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
