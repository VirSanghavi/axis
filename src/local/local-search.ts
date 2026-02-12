import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { logger } from "../utils/logger.js";

// ── Defaults ──

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", ".svelte-kit",
  "dist", "build", "out", ".output", "coverage",
  "__pycache__", ".pytest_cache", ".mypy_cache",
  ".venv", "venv", "env",
  ".turbo", ".cache", ".parcel-cache",
  ".axis", "history",
  ".DS_Store",
]);

const SKIP_EXTENSIONS = new Set([
  // Binary / media
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".mp3", ".mp4", ".wav", ".webm", ".ogg",
  ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".zip", ".tar", ".gz", ".br",
  // Compiled / generated
  ".pyc", ".pyo", ".so", ".dylib", ".dll", ".exe",
  ".class", ".jar", ".war",
  ".wasm",
  // Lock files (huge, not useful for search)
  ".lock",
]);

const SKIP_FILENAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "Cargo.lock", "Gemfile.lock", "poetry.lock",
  ".DS_Store", "Thumbs.db",
]);

// Only strip truly useless English words. Do NOT strip words that could be
// code identifiers (check, get, set, find, class, function, method, file, etc.)
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
  "they", "them", "their", "this", "that", "these", "those",
  "what", "which", "who", "whom", "where", "when", "how", "why",
  "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "up", "about", "into", "through", "during", "before", "after",
  "and", "but", "or", "nor", "not", "so", "if", "then",
  "all", "each", "every", "both", "few", "more", "most", "some", "any",
  "there", "here", "just", "also", "very", "really", "quite",
]);

const MAX_FILE_SIZE = 256 * 1024; // 256 KB
const MAX_RESULTS = 20;
const CONTEXT_LINES = 2;
const MAX_MATCHES_PER_FILE = 6;

// ── Query Parsing ──

function extractKeywords(query: string): string[] {
  const words = query
    .toLowerCase()
    .replace(/[^\w\s\-_.]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 2);

  const filtered = words.filter(w => !STOP_WORDS.has(w));

  // If stop-word filtering removed everything, fall back to all words >= 2 chars
  const result = filtered.length > 0
    ? filtered
    : words;

  // Deduplicate
  return [...new Set(result)];
}

// ── Project Root Detection ──

const PROJECT_ROOT_MARKERS = [
  ".git", ".axis", "package.json", "Cargo.toml", "go.mod",
  "pyproject.toml", "setup.py", "Gemfile", "pom.xml",
  "tsconfig.json", ".cursorrules", "AGENTS.md",
];

function detectProjectRoot(startDir: string): string {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  // Walk up: return FIRST directory with a project marker (nearest to startDir)
  while (current !== root) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        fsSync.accessSync(path.join(current, marker));
        return current;
      } catch {
        // Not here
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return startDir;
}

// ── File Walking ──

async function walkDir(dir: string, maxDepth: number = 12): Promise<string[]> {
  const results: string[] = [];

  async function recurse(current: string, depth: number) {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") {
        // Skip hidden files/dirs (except .env.example which can be useful)
        if (SKIP_DIRS.has(entry.name) || entry.isDirectory()) continue;
      }

      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await recurse(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (SKIP_FILENAMES.has(entry.name)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (SKIP_EXTENSIONS.has(ext)) continue;

        // Check file size
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > MAX_FILE_SIZE || stat.size === 0) continue;
        } catch {
          continue;
        }

        results.push(fullPath);
      }
    }
  }

  await recurse(dir, 0);
  return results;
}

// ── Search Engine ──

interface SearchMatch {
  filePath: string;
  relativePath: string;
  score: number;
  matchedKeywords: string[];
  regions: { lineNumber: number; lines: string }[];
}

async function searchFile(
  filePath: string,
  rootDir: string,
  keywords: string[],
): Promise<SearchMatch | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const contentLower = content.toLowerCase();
  const relativePath = path.relative(rootDir, filePath);

  // Quick check: does the file contain ANY keyword?
  const matchedKeywords = keywords.filter(kw => contentLower.includes(kw));
  if (matchedKeywords.length === 0) return null;

  // ── Relevance gate: require at least one keyword match ──
  // WarpGrep-style: prefer recall over precision; let the agent filter.
  const coverage = matchedKeywords.length / keywords.length;
  if (coverage < 0.2) return null; // Need at least 1 of 5, or 1 of 3, etc.

  const lines = content.split("\n");

  // ── Scoring: reward coverage, not just raw match count ──
  // Base score = coverage² × matchCount — strongly rewards matching more keywords
  let score = coverage * coverage * matchedKeywords.length;

  // Bonus for keyword in filename/path (these files are almost always relevant)
  const relLower = relativePath.toLowerCase();
  let pathMatches = 0;
  for (const kw of keywords) {
    if (relLower.includes(kw)) {
      score += 3;
      pathMatches++;
    }
  }

  // Find matching line regions
  const matchingLineIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    if (matchedKeywords.some(kw => lineLower.includes(kw))) {
      matchingLineIndices.push(i);
    }
  }

  // ── Proximity bonus: keywords appearing near each other are more relevant ──
  // Check if multiple keywords appear within a 10-line window
  let proximityBonus = 0;
  for (let i = 0; i < matchingLineIndices.length; i++) {
    const windowStart = matchingLineIndices[i];
    const windowEnd = windowStart + 10;
    const keywordsInWindow = new Set<string>();
    for (let j = i; j < matchingLineIndices.length && matchingLineIndices[j] <= windowEnd; j++) {
      const lineLower = lines[matchingLineIndices[j]].toLowerCase();
      for (const kw of matchedKeywords) {
        if (lineLower.includes(kw)) keywordsInWindow.add(kw);
      }
    }
    if (keywordsInWindow.size >= 2) {
      proximityBonus = Math.max(proximityBonus, keywordsInWindow.size * 1.5);
    }
  }
  score += proximityBonus;

  // Density bonus (capped)
  score += Math.min(matchingLineIndices.length, 20) * 0.1;

  // Collapse nearby lines into regions with context
  const regions: { lineNumber: number; lines: string }[] = [];
  let lastEnd = -1;

  for (const idx of matchingLineIndices) {
    if (regions.length >= MAX_MATCHES_PER_FILE) break;

    const start = Math.max(0, idx - CONTEXT_LINES);
    const end = Math.min(lines.length - 1, idx + CONTEXT_LINES);

    // Skip if overlapping with previous region
    if (start <= lastEnd) continue;

    const regionLines = lines.slice(start, end + 1)
      .map((line, i) => {
        const lineNum = start + i + 1;
        const marker = (start + i === idx) ? ">" : " ";
        return `${marker} ${lineNum.toString().padStart(4)}| ${line}`;
      })
      .join("\n");

    regions.push({ lineNumber: idx + 1, lines: regionLines });
    lastEnd = end;
  }

  return { filePath, relativePath, score, matchedKeywords, regions };
}

// ── WarpGrep-style: Ripgrep-based parallel search ──

interface RipgrepHit {
  file: string;
  line: number;
  content: string;
  pattern: string;
}

function runRipgrep(pattern: string, cwd: string): RipgrepHit[] {
  const p = (pattern || "").trim();
  if (!p || p.length > 200) return [];
  const result = spawnSync("rg", [
    "--line-number",
    "--no-heading",
    "--color", "never",
    "--max-count", "3",  // Max 3 matches per file per pattern
    "-C", "1",           // 1 line context
    "--ignore-case",
    "--max-filesize", "256K",
    "-F", p,             // Fixed string (literal) — no regex escaping needed
    ".",
  ], {
    cwd,
    encoding: "utf-8",
    timeout: 8000,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error || result.status !== 0) {
    return [];
  }

  const hits: RipgrepHit[] = [];
  const lines = (result.stdout || "").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(.+?):(\d+):(.+)$/);
    if (match) {
      const [, file, lineNum, content] = match;
      const relPath = path.relative(cwd, file);
      hits.push({
        file: relPath,
        line: parseInt(lineNum!, 10),
        content: content!.trim(),
        pattern: p,
      });
    }
  }
  return hits;
}

function ripgrepAvailable(): boolean {
  const r = spawnSync("rg", ["--version"], { encoding: "utf-8" });
  return !r.error && r.status === 0;
}

async function warpgrepSearch(query: string, cwd: string): Promise<string> {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) {
    // Fallback: use first 2+ char token as pattern
    const tokens = query.replace(/[^\w\s]/g, " ").split(/\s+/).filter(w => w.length >= 2);
    if (tokens.length === 0) return "";
    keywords.push(tokens[0]!);
  }

  // Run ripgrep in parallel for each keyword (WarpGrep-style: parallel multi-pattern)
  const allHits: RipgrepHit[] = [];
  const seen = new Set<string>();

  for (const kw of keywords.slice(0, 5)) {
    const hits = runRipgrep(kw, cwd);
    for (const h of hits) {
      const key = `${h.file}:${h.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        allHits.push(h);
      }
    }
  }

  if (allHits.length === 0) return "";

  // Group by file, limit per file
  const byFile = new Map<string, RipgrepHit[]>();
  for (const h of allHits) {
    const list = byFile.get(h.file) || [];
    if (list.length < MAX_MATCHES_PER_FILE) list.push(h);
    byFile.set(h.file, list);
  }

  // Format: file:line:content (WarpGrep-style snippet return)
  const lines: string[] = [];
  lines.push(`Found ${allHits.length} match(es) via ripgrep (keywords: ${keywords.join(", ")})\n`);
  lines.push("═".repeat(60) + "\n");

  const sortedFiles = [...byFile.keys()].sort();
  for (const relPath of sortedFiles.slice(0, MAX_RESULTS)) {
    const hits = byFile.get(relPath)!;
    lines.push(`${relPath}\n`);
    for (const h of hits) {
      lines.push(`   ${h.line.toString().padStart(4)}| ${h.content}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Public API ──

export interface LocalSearchResult {
  query: string;
  keywords: string[];
  totalFilesScanned: number;
  matches: SearchMatch[];
}

export async function localSearch(query: string, rootDir?: string): Promise<string> {
  const q = typeof query === "string" ? query.trim() : "";
  const rawCwd = rootDir || process.cwd();
  const cwd = detectProjectRoot(rawCwd);
  const keywords = extractKeywords(q);

  if (cwd !== rawCwd) {
    logger.info(`[localSearch] Detected project root: ${cwd} (CWD was: ${rawCwd})`);
  }

  // WarpGrep-style: require at least one searchable term
  const hasTerms = keywords.length > 0 ||
    q.replace(/[^\w\s]/g, " ").split(/\s+/).some(w => w.length >= 2);
  if (!hasTerms) {
    return "Could not extract meaningful search terms from the query. Try being more specific (e.g. 'authentication middleware' instead of 'how does it work').";
  }

  logger.info(`[localSearch] Query: "${q}" → Keywords: [${keywords.join(", ")}] in ${cwd}`);

  // WarpGrep-style: run ripgrep + keyword search in parallel
  const useRipgrep = ripgrepAvailable();
  const [rgResults, keyResults] = await Promise.all([
    useRipgrep ? warpgrepSearch(q, cwd) : Promise.resolve(""),
    (async () => {
      const kws = keywords.length > 0 ? keywords : q.replace(/[^\w\s]/g, " ").split(/\s+/).filter(w => w.length >= 2).slice(0, 5);
      if (kws.length === 0) return "";
      const files = await walkDir(cwd);
      logger.info(`[localSearch] Scanning ${files.length} files (keyword search)`);
      const BATCH_SIZE = 50;
      const allMatches: SearchMatch[] = [];
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(f => searchFile(f, cwd, kws)));
        for (const r of results) {
          if (r) allMatches.push(r);
        }
      }
      allMatches.sort((a, b) => b.score - a.score);
      const topMatches = allMatches.slice(0, MAX_RESULTS);
      if (topMatches.length === 0) return "";
      let out = `Found ${allMatches.length} matching file${allMatches.length === 1 ? "" : "s"} (showing top ${topMatches.length}, searched ${files.length} files)\n`;
      out += `Keywords: ${kws.join(", ")}\n`;
      out += "═".repeat(60) + "\n\n";
      for (const match of topMatches) {
        out += `${match.relativePath}\n`;
        out += `   Keywords matched: ${match.matchedKeywords.join(", ")} | Score: ${match.score.toFixed(1)}\n`;
        if (match.regions.length > 0) {
          out += "   ─────\n";
          for (const region of match.regions) {
            out += region.lines.split("\n").map(l => `   ${l}`).join("\n") + "\n";
            if (region !== match.regions[match.regions.length - 1]) out += "   ...\n";
          }
        }
        out += "\n";
      }
      return out;
    })(),
  ]);

  // Prefer ripgrep if it found results; otherwise keyword; merge if both have unique value
  const rgHasResults = rgResults && !rgResults.startsWith("Found 0");
  const keyHasResults = keyResults && keyResults.length > 50;

  if (rgHasResults && keyHasResults) {
    return rgResults + "\n\n--- Also from keyword search ---\n\n" + keyResults;
  }
  if (rgHasResults) return rgResults;
  if (keyHasResults) return keyResults;

  // Fallback: when 3+ keywords yield nothing, retry with fewer (WarpGrep-style refinement)
  const kws = keywords.length > 0 ? keywords : q.replace(/[^\w\s]/g, " ").split(/\s+/).filter(w => w.length >= 2).slice(0, 5);
  if (kws.length >= 3) {
    const fallbackKws = kws.slice(0, 2);
    const files = await walkDir(cwd);
    const fallbackMatches: SearchMatch[] = [];
    for (let i = 0; i < files.length; i += 50) {
      const batch = files.slice(i, i + 50);
      const results = await Promise.all(batch.map(f => searchFile(f, cwd, fallbackKws)));
      for (const r of results) {
        if (r) fallbackMatches.push(r);
      }
    }
    if (fallbackMatches.length > 0) {
      fallbackMatches.sort((a, b) => b.score - a.score);
      const top = fallbackMatches.slice(0, MAX_RESULTS);
      let out = `Found ${fallbackMatches.length} matching file${fallbackMatches.length === 1 ? "" : "s"} (fallback: fewer keywords, showing top ${top.length})\n`;
      out += `Keywords: ${fallbackKws.join(", ")} (original: ${kws.join(", ")})\n`;
      out += "═".repeat(60) + "\n\n";
      for (const match of top) {
        out += `📄 ${match.relativePath}\n`;
        out += `   Keywords matched: ${match.matchedKeywords.join(", ")} | Score: ${match.score.toFixed(1)}\n`;
        if (match.regions.length > 0) {
          out += "   ─────\n";
          for (const region of match.regions) {
            out += region.lines.split("\n").map(l => `   ${l}`).join("\n") + "\n";
            if (region !== match.regions[match.regions.length - 1]) out += "   ...\n";
          }
        }
        out += "\n";
      }
      return out;
    }
  }

  return `No matches found for: "${q}" (searched for: ${kws.join(", ") || "query terms"}).\nTry different terms or check if the code exists in this project.`;
}
