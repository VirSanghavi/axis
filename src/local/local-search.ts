import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
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
  "show", "look", "locate", "using", "used", "need", "want",
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

  // If stop-word filtering removed everything, fall back to all words >= 3 chars
  const result = filtered.length > 0
    ? filtered
    : words.filter(w => w.length >= 3);

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
  let current = startDir;
  const root = path.parse(current).root;

  // Walk up looking for project markers
  while (current !== root) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        fsSync.accessSync(path.join(current, marker));
        return current; // Found a project root marker
      } catch {
        // Not here, keep going
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break; // Reached filesystem root
    current = parent;
  }

  // No marker found — fall back to original directory
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

  // ── Relevance gate: require minimum keyword coverage ──
  // With 3+ keywords, require at least 40% keyword match (rounds up).
  // This prevents files matching only one generic word (e.g. "handler")
  // from appearing in results for "authentication login route handler".
  const coverage = matchedKeywords.length / keywords.length;
  if (keywords.length >= 3 && coverage < 0.4) return null;
  if (keywords.length === 2 && matchedKeywords.length < 1) return null;

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

// ── Public API ──

export interface LocalSearchResult {
  query: string;
  keywords: string[];
  totalFilesScanned: number;
  matches: SearchMatch[];
}

export async function localSearch(query: string, rootDir?: string): Promise<string> {
  const rawCwd = rootDir || process.cwd();
  const cwd = detectProjectRoot(rawCwd);
  const keywords = extractKeywords(query);

  if (cwd !== rawCwd) {
    logger.info(`[localSearch] Detected project root: ${cwd} (CWD was: ${rawCwd})`);
  }

  if (keywords.length === 0) {
    return "Could not extract meaningful search terms from the query. Try being more specific (e.g. 'authentication middleware' instead of 'how does it work').";
  }

  logger.info(`[localSearch] Query: "${query}" → Keywords: [${keywords.join(", ")}] in ${cwd}`);

  const files = await walkDir(cwd);
  logger.info(`[localSearch] Scanning ${files.length} files`);

  // Search all files in parallel (batched to avoid fd exhaustion)
  const BATCH_SIZE = 50;
  const allMatches: SearchMatch[] = [];

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(f => searchFile(f, cwd, keywords))
    );
    for (const r of results) {
      if (r) allMatches.push(r);
    }
  }

  // Sort by score descending
  allMatches.sort((a, b) => b.score - a.score);

  const topMatches = allMatches.slice(0, MAX_RESULTS);

  if (topMatches.length === 0) {
    return `No matches found for: "${query}" (searched ${files.length} files for keywords: ${keywords.join(", ")}).\nTry different terms or check if the code exists in this project.`;
  }

  // Format output
  let output = `Found ${allMatches.length} matching file${allMatches.length === 1 ? "" : "s"} (showing top ${topMatches.length}, searched ${files.length} files)\n`;
  output += `Keywords: ${keywords.join(", ")}\n`;
  output += "═".repeat(60) + "\n\n";

  for (const match of topMatches) {
    output += `📄 ${match.relativePath}\n`;
    output += `   Keywords matched: ${match.matchedKeywords.join(", ")} | Score: ${match.score.toFixed(1)}\n`;

    if (match.regions.length > 0) {
      output += "   ─────\n";
      for (const region of match.regions) {
        output += region.lines.split("\n").map(l => `   ${l}`).join("\n") + "\n";
        if (region !== match.regions[match.regions.length - 1]) {
          output += "   ...\n";
        }
      }
    }
    output += "\n";
  }

  return output;
}
