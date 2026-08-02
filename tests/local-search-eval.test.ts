/**
 * Golden end-to-end evaluation of the free-tier local search (audit #10).
 *
 * Unlike the hosted harness (axis-frontend lib/search-eval/, which replays
 * frozen pools through the rerank boosts), this runs the REAL localSearch
 * against the REAL repo checkout: golden queries agents actually issue, each
 * with the file a maintainer judges to be the right answer. Scored with MRR
 * over the ranked file list parsed from the tool's output; gated with
 * conservative floors so ranking regressions fail CI while wording tweaks
 * to the output format don't.
 *
 * Tuning guide: axis-frontend/docs/search-ranking-eval.md.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { localSearch } from "../src/local/local-search.js";

const REPO_ROOT = join(import.meta.dir, "..");

interface GoldenQuery {
  query: string;
  /** Repo-relative file that answers the query (judged, not aspirational). */
  expect: string;
}

const GOLDEN: GoldenQuery[] = [
  { query: "claimNextJob", expect: "src/local/nerve-center.ts" },
  { query: "TeamUpdateTracker drain", expect: "src/local/team-updates.ts" },
  { query: "hashContent lock fingerprint", expect: "src/local/lock-integrity.ts" },
  { query: "findReclaimable stale job", expect: "src/local/job-hygiene.ts" },
  { query: "deriveProjectName project identity", expect: "src/local/project-identity.ts" },
  { query: "PresenceRoster idle agents", expect: "src/local/agent-presence.ts" },
];

/**
 * Ranked repo-relative paths from localSearch's formatted output, in
 * presentation order across both result sections (ripgrep + keyword legs).
 * A path counts once, at its first appearance.
 */
export function parseRankedPaths(output: string): string[] {
  const seen = new Set<string>();
  const ranked: string[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/^📄\s*/, "").trim();
    // Path-shaped, on its own line, optionally with a :line suffix.
    const m = line.match(/^([\w.-]+(?:\/[\w.-]+)+\.\w{1,10})(?::\d+)?$/);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      ranked.push(m[1]);
    }
  }
  return ranked;
}

describe("local search golden eval (regression gate)", () => {
  test(
    "golden queries rank their judged answer; mean MRR holds the floor",
    async () => {
      const perQuery: { query: string; rank: number; mrr: number }[] = [];
      for (const g of GOLDEN) {
        const out = await localSearch(g.query, REPO_ROOT);
        const ranked = parseRankedPaths(out);
        const idx = ranked.findIndex((p) => p === g.expect || p.endsWith(`/${g.expect}`));
        perQuery.push({ query: g.query, rank: idx, mrr: idx >= 0 ? 1 / (idx + 1) : 0 });
      }

      const failures = perQuery.filter((r) => r.rank < 0);
      expect(
        failures.map((f) => f.query),
        `judged answer missing entirely from results`
      ).toEqual([]);

      // Every judged answer inside the top 3 of its result list.
      for (const r of perQuery) {
        expect(r.rank, `"${r.query}" ranked its answer at position ${r.rank + 1}`).toBeLessThan(3);
      }

      const meanMrr = perQuery.reduce((a, r) => a + r.mrr, 0) / perQuery.length;
      // History: the gate's original baseline was mean MRR 0.371 (ranks
      // 7,2,2,3,2,4) — the keyword scorer ranked the matching *test file*
      // above the implementation for every identifier query. Fixed by the
      // definition boost + test-file demotion + relevance-ordered ripgrep leg
      // in src/local/local-search.ts (board job cc269365): measured mean MRR
      // 0.889, worst rank 3. The floor sits under the measured value so
      // environment noise (ripgrep presence, file churn) doesn't flap the
      // gate, while a ranking regression that re-buries implementations
      // under tests fails loudly. Tuning guide:
      // axis-frontend/docs/search-ranking-eval.md.
      expect(meanMrr).toBeGreaterThanOrEqual(0.7);
    },
    30000
  );
});
