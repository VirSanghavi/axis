#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/tsup/assets/cjs_shims.js
var getImportMetaUrl = () => typeof document === "undefined" ? new URL(`file:${__filename}`).href : document.currentScript && document.currentScript.tagName.toUpperCase() === "SCRIPT" ? document.currentScript.src : new URL("main.js", document.baseURI).href;
var importMetaUrl = /* @__PURE__ */ getImportMetaUrl();

// bin/cli.ts
var import_commander = require("commander");
var import_chalk = __toESM(require("chalk"));
var import_child_process = require("child_process");
var import_path2 = __toESM(require("path"));
var import_url = require("url");
var import_fs2 = __toESM(require("fs"));

// ../../src/local/indexer.ts
var fs = __toESM(require("fs"), 1);
var path = __toESM(require("path"), 1);
var import_crypto = require("crypto");
var DEFAULT_IGNORE_DIRS = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  "venv",
  ".venv",
  "__pycache__",
  ".turbo",
  ".cache",
  "vendor",
  ".idea",
  ".vscode",
  "target",
  "bin",
  "obj",
  ".pytest_cache",
  ".mypy_cache"
]);
var BINARY_EXT = /* @__PURE__ */ new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "bmp",
  "tiff",
  "svg",
  "pdf",
  "zip",
  "gz",
  "tar",
  "tgz",
  "rar",
  "7z",
  "mp3",
  "mp4",
  "mov",
  "avi",
  "wav",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "wasm",
  "class",
  "jar",
  "pyc",
  "lock",
  "min.js",
  "min.css",
  "map",
  "ds_store"
]);
var SKIP_FILES = /* @__PURE__ */ new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "Cargo.lock",
  "composer.lock",
  ".DS_Store"
]);
var MAX_FILE_BYTES = 256 * 1024;
var UPLOAD_BATCH = 40;
function loadGitignore(root) {
  const file = path.join(root, ".gitignore");
  let patterns = [];
  try {
    patterns = fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  } catch {
  }
  const exts = patterns.filter((p) => p.startsWith("*.")).map((p) => p.slice(1));
  const names = new Set(patterns.filter((p) => !p.includes("/") && !p.startsWith("*")).map((p) => p.replace(/\/$/, "")));
  const prefixes = patterns.filter((p) => p.includes("/")).map((p) => p.replace(/^\//, "").replace(/\/$/, ""));
  return (rel) => {
    const base = path.basename(rel);
    if (names.has(base)) return true;
    if (exts.some((e) => rel.endsWith(e))) return true;
    if (prefixes.some((p) => rel === p || rel.startsWith(p + "/"))) return true;
    return false;
  };
}
function isBinaryPath(rel) {
  const lower = rel.toLowerCase();
  if (SKIP_FILES.has(path.basename(rel))) return true;
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (BINARY_EXT.has(ext)) return true;
  if (lower.endsWith(".min.js") || lower.endsWith(".min.css")) return true;
  return false;
}
function walk(root, ignored) {
  const out = [];
  const stack = ["."];
  while (stack.length) {
    const relDir = stack.pop();
    const absDir = path.join(root, relDir);
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = relDir === "." ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(e.name) || ignored(rel)) continue;
        stack.push(rel);
      } else if (e.isFile()) {
        if (isBinaryPath(rel) || ignored(rel)) continue;
        out.push(rel);
      }
    }
  }
  return out;
}
function indexEndpoint(apiUrl, suffix) {
  const base = apiUrl.endsWith("/v1") ? apiUrl : `${apiUrl}/v1`;
  return `${base}${suffix}`;
}
async function post(url, secret, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${url} \u2192 ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}
async function indexCodebase(apiUrl, apiSecret, projectName, rootDir, logger) {
  const ignored = loadGitignore(rootDir);
  const relPaths = walk(rootDir, ignored);
  logger.info(`Scanning ${relPaths.length} files in ${rootDir}`);
  const manifest = [];
  const contentByPath = /* @__PURE__ */ new Map();
  for (const rel of relPaths) {
    try {
      const stat = fs.statSync(path.join(rootDir, rel));
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = fs.readFileSync(path.join(rootDir, rel), "utf8");
      if (content.includes("\0")) continue;
      contentByPath.set(rel, content);
      manifest.push({ path: rel, hash: (0, import_crypto.createHash)("sha256").update(content, "utf8").digest("hex") });
    } catch {
    }
  }
  const plan = await post(indexEndpoint(apiUrl, "/index/plan"), apiSecret, { projectName, manifest });
  const toUpload = plan.toUpload || [];
  logger.info(`${manifest.length - toUpload.length} unchanged, ${toUpload.length} to upload, ${(plan.toDelete || []).length} to prune`);
  let uploaded = 0;
  let chunks = 0;
  for (let i = 0; i < toUpload.length; i += UPLOAD_BATCH) {
    const batch = toUpload.slice(i, i + UPLOAD_BATCH).map((p) => ({ path: p, content: contentByPath.get(p) || "" }));
    const r = await post(indexEndpoint(apiUrl, "/index"), apiSecret, { projectName, files: batch });
    uploaded += r.indexed || 0;
    chunks += r.totalChunks || 0;
    logger.info(`Indexed ${Math.min(i + UPLOAD_BATCH, toUpload.length)}/${toUpload.length}`);
  }
  const allPaths = manifest.map((m) => m.path);
  const pruneRes = await post(indexEndpoint(apiUrl, "/index"), apiSecret, { projectName, files: [], prune: true, allPaths });
  const pruned = (pruneRes.pruned || []).length;
  return { scanned: manifest.length, uploaded, unchanged: manifest.length - toUpload.length, pruned, chunks };
}

// ../../src/local/project-identity.ts
var import_fs = __toESM(require("fs"), 1);
var import_path = __toESM(require("path"), 1);
function findProjectRoot(start) {
  let current = import_path.default.resolve(start);
  const filesystemRoot = import_path.default.parse(current).root;
  while (true) {
    if (import_fs.default.existsSync(import_path.default.join(current, ".axis", "axis.json")) || import_fs.default.existsSync(import_path.default.join(current, ".git")) || import_fs.default.existsSync(import_path.default.join(current, "package.json"))) {
      return current;
    }
    if (current === filesystemRoot) return import_path.default.resolve(start);
    current = import_path.default.dirname(current);
  }
}
function existingDirectory(candidate) {
  if (!candidate) return void 0;
  const resolved = import_path.default.resolve(candidate);
  try {
    return import_fs.default.statSync(resolved).isDirectory() ? resolved : void 0;
  } catch {
    return void 0;
  }
}
function deriveProjectName(root) {
  try {
    const config = JSON.parse(
      import_fs.default.readFileSync(import_path.default.join(root, ".axis", "axis.json"), "utf8")
    );
    const configuredName = config.project ?? config.projectName;
    if (configuredName) return String(configuredName);
  } catch {
  }
  return import_path.default.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}
function resolveProjectIdentity(configuredRoot, cwd, env = process.env) {
  const runtimeCandidate = existingDirectory(env.AXIS_WORKSPACE_ROOT) || existingDirectory(env.SUPERSET_WORKSPACE_PATH) || existingDirectory(env.SUPERSET_ROOT_PATH);
  const configuredCandidate = existingDirectory(configuredRoot);
  const runtimeRoot = runtimeCandidate ? findProjectRoot(runtimeCandidate) : void 0;
  const configuredProjectRoot = configuredCandidate ? findProjectRoot(configuredCandidate) : void 0;
  const root = runtimeRoot || configuredProjectRoot || findProjectRoot(cwd);
  const source = runtimeRoot ? "runtime" : configuredProjectRoot ? "configured" : "cwd";
  const switchedWorkspace = Boolean(
    runtimeRoot && configuredProjectRoot && import_path.default.resolve(runtimeRoot) !== import_path.default.resolve(configuredProjectRoot)
  );
  const projectName = env.AXIS_PROJECT_NAME || (!switchedWorkspace ? env.PROJECT_NAME : void 0) || deriveProjectName(root);
  return {
    root,
    projectName,
    source,
    ...switchedWorkspace ? { ignoredConfiguredRoot: configuredProjectRoot } : {}
  };
}

// bin/cli.ts
var __filename2 = (0, import_url.fileURLToPath)(importMetaUrl);
var __dirname = import_path2.default.dirname(__filename2);
import_commander.program.name("axis-server").description("Start the Axis Shared Context MCP Server").version("1.0.0");
import_commander.program.argument("[root]", "Project root directory (optional)").action((root) => {
  console.error(import_chalk.default.bold.blue("Axis MCP Server Starting..."));
  const identity = resolveProjectIdentity(root, process.cwd());
  if (root && !import_fs2.default.existsSync(import_path2.default.resolve(root)) && identity.source !== "runtime") {
    console.error(import_chalk.default.red(`Error: Project root not found: ${import_path2.default.resolve(root)}`));
    process.exit(1);
  }
  if (identity.ignoredConfiguredRoot) {
    console.error(import_chalk.default.yellow(
      `Active workspace changed to ${identity.root}; ignoring stale configured root ${identity.ignoredConfiguredRoot}.`
    ));
  }
  console.error(import_chalk.default.blue(`Project: ${identity.projectName} (${identity.root})`));
  process.chdir(identity.root);
  const serverScript = import_path2.default.resolve(__dirname, "../dist/mcp-server.mjs");
  if (!import_fs2.default.existsSync(serverScript)) {
    console.error(import_chalk.default.red("Error: Server script not found."));
    console.error(import_chalk.default.yellow(`Expected at: ${serverScript}`));
    console.error(import_chalk.default.gray("Did you run 'npm run build'?"));
    process.exit(1);
  }
  console.error(import_chalk.default.gray(`Launching server context...`));
  const args = [serverScript, ...process.argv.slice(2)];
  const proc = (0, import_child_process.spawn)("node", args, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: {
      ...process.env,
      PROJECT_NAME: identity.projectName,
      AXIS_PROJECT_ROOT: identity.root,
      FORCE_COLOR: "1"
    }
  });
  proc.on("close", (code) => {
    if (code !== 0) {
      console.error(import_chalk.default.red(`Server process exited with code ${code}`));
    } else {
      console.error(import_chalk.default.green("Server stopped gracefully."));
    }
  });
  process.on("SIGINT", () => {
    proc.kill("SIGINT");
  });
  process.on("SIGTERM", () => {
    proc.kill("SIGTERM");
  });
});
import_commander.program.command("index").description("Index the codebase for search_codebase / deep_search (incremental, content-hashed)").argument("[root]", "Project root to index (default: auto-detected repo root)").option("-p, --project <name>", "Project name (default: auto-detected)").action(async (root, opts) => {
  const apiKey = process.env.AXIS_API_KEY;
  if (!apiKey) {
    console.error(import_chalk.default.red("AXIS_API_KEY is required. Set it in your environment."));
    process.exit(1);
  }
  const apiUrl = process.env.SHARED_CONTEXT_API_URL || "https://useaxis.dev/api/v1";
  const rootDir = findProjectRoot(import_path2.default.resolve(root || process.cwd()));
  const projectName = opts.project || deriveProjectName(rootDir);
  console.error(import_chalk.default.bold.blue(`Indexing "${projectName}"`) + import_chalk.default.gray(` (${rootDir})`));
  try {
    const summary = await indexCodebase(apiUrl, apiKey, projectName, rootDir, {
      info: (m) => console.error(import_chalk.default.gray(`  ${m}`))
    });
    console.error(
      import_chalk.default.green("\u2713 done \u2014 ") + `${summary.uploaded} updated (${summary.chunks} chunks), ${summary.unchanged} unchanged, ${summary.pruned} pruned`
    );
  } catch (e) {
    console.error(import_chalk.default.red(`Index failed: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
});
import_commander.program.parse();
