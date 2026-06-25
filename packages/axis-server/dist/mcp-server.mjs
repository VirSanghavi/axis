// ../../src/local/mcp-server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import dotenv2 from "dotenv";

// ../../src/local/context-manager.ts
import fs from "fs/promises";
import path from "path";
import { Mutex } from "async-mutex";

// ../../src/utils/logger.ts
var Logger = class {
  level = "info" /* INFO */;
  setLevel(level) {
    this.level = level;
  }
  log(level, message, meta) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    console.error(JSON.stringify({
      timestamp,
      level,
      message,
      ...meta
    }));
  }
  debug(message, meta) {
    if (this.level === "debug" /* DEBUG */) this.log("debug" /* DEBUG */, message, meta);
  }
  info(message, meta) {
    this.log("info" /* INFO */, message, meta);
  }
  warn(message, meta) {
    this.log("warn" /* WARN */, message, meta);
  }
  error(message, error, meta) {
    this.log("error" /* ERROR */, message, {
      ...meta,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : void 0
    });
  }
};
var logger = new Logger();

// ../../src/local/context-manager.ts
import * as fsSync from "fs";
function getEffectiveInstructionsDir() {
  const cwd = process.cwd();
  const axisDir = path.resolve(cwd, ".axis");
  const instructionsDir = path.resolve(axisDir, "instructions");
  const legacyDir = path.resolve(cwd, "agent-instructions");
  const sharedContextDir = path.resolve(cwd, "shared-context", "agent-instructions");
  try {
    if (fsSync.existsSync(instructionsDir)) {
      console.error(`[ContextManager] Using instructions dir: ${instructionsDir}`);
      return instructionsDir;
    }
  } catch {
  }
  try {
    if (fsSync.existsSync(legacyDir)) {
      console.error(`[ContextManager] Using legacy dir: ${legacyDir}`);
      return legacyDir;
    }
  } catch {
  }
  try {
    if (fsSync.existsSync(sharedContextDir)) {
      console.error(`[ContextManager] Using shared-context dir: ${sharedContextDir}`);
      return sharedContextDir;
    }
  } catch {
  }
  console.error(`[ContextManager] Fallback to legacy dir: ${legacyDir}`);
  return legacyDir;
}
var ContextManager = class {
  mutex;
  apiUrl;
  // Made public so NerveCenter can access it
  apiSecret;
  // Made public so NerveCenter can access it
  constructor(apiUrl2, apiSecret2) {
    this.mutex = new Mutex();
    this.apiUrl = apiUrl2;
    this.apiSecret = apiSecret2;
  }
  resolveFilePath(filename) {
    if (!filename || filename.includes("\0")) {
      throw new Error("Invalid filename");
    }
    const resolved = path.resolve(getEffectiveInstructionsDir(), filename);
    const effectiveDir = getEffectiveInstructionsDir();
    if (!resolved.startsWith(effectiveDir + path.sep)) {
      throw new Error("Invalid file path");
    }
    return resolved;
  }
  async listFiles() {
    try {
      const dir = getEffectiveInstructionsDir();
      try {
        await fs.access(dir);
      } catch {
        return [];
      }
      const files = await fs.readdir(dir);
      const docFiles = await this.listDocs();
      const instructionFiles = files.filter((f) => f.endsWith(".md")).map((f) => ({
        uri: `context://local/${f}`,
        name: f,
        mimeType: "text/markdown",
        description: `Shared context file: ${f}`
      }));
      return [...instructionFiles, ...docFiles];
    } catch (error) {
      console.error("Error listing resources:", error);
      return [];
    }
  }
  async listDocs() {
    const docsDir = path.resolve(process.cwd(), "docs");
    try {
      await fs.access(docsDir);
      const files = await fs.readdir(docsDir);
      return files.filter((f) => f.endsWith(".md")).map((f) => ({
        uri: `context://docs/${f}`,
        name: `Docs: ${f}`,
        mimeType: "text/markdown",
        description: `Documentation file: ${f}`
      }));
    } catch {
      return [];
    }
  }
  async readFile(filename) {
    if (filename.startsWith("docs/")) {
      const docName = filename.replace("docs/", "");
      const docPath = path.resolve(process.cwd(), "docs", docName);
      if (!docPath.startsWith(path.resolve(process.cwd(), "docs"))) {
        throw new Error("Invalid doc path");
      }
      return await fs.readFile(docPath, "utf-8");
    }
    const filePath = this.resolveFilePath(filename);
    return await fs.readFile(filePath, "utf-8");
  }
  async updateFile(filename, content, append = false) {
    const filePath = this.resolveFilePath(filename);
    return await this.mutex.runExclusive(async () => {
      if (append) {
        await fs.appendFile(filePath, "\n" + content);
      } else {
        await fs.writeFile(filePath, content);
      }
      return `Updated ${filename}`;
    });
  }
  async searchContext(query, projectName = "default") {
    if (!this.apiUrl) {
      throw new Error("SHARED_CONTEXT_API_URL not configured.");
    }
    const endpoint = this.apiUrl.endsWith("/v1") ? `${this.apiUrl}/search` : `${this.apiUrl}/v1/search`;
    const maxRetries = 3;
    const baseDelay = 1e3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15e3);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiSecret || ""}`
          },
          body: JSON.stringify({ query, projectName }),
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (!response.ok) {
          const text = await response.text();
          if (response.status >= 400 && response.status < 500) {
            throw new Error(`API Error ${response.status}: ${text}`);
          }
          if (attempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, attempt - 1);
            logger.warn(`[searchContext] 5xx error, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw new Error(`API Error ${response.status}: ${text}`);
        }
        const result = await response.json();
        if (result.results && Array.isArray(result.results)) {
          return result.results.map(
            (r) => `[Similarity: ${(r.similarity * 100).toFixed(1)}%] ${r.content}`
          ).join("\n\n---\n\n") || "No results found.";
        }
        throw new Error("No results format recognized.");
      } catch (e) {
        clearTimeout(timeout);
        if (e.message.startsWith("API Error 4")) throw e;
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1);
          logger.warn(`[searchContext] Network/timeout error, retrying in ${delay}ms (attempt ${attempt}/${maxRetries}): ${e.message}`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw e;
      }
    }
    throw new Error("searchContext: unexpected end of retry loop");
  }
  async embedContent(items, projectName = "default") {
    if (!this.apiUrl) {
      logger.warn("Skipping RAG embedding: SHARED_CONTEXT_API_URL not configured.");
      return;
    }
    const endpoint = this.apiUrl.endsWith("/v1") ? `${this.apiUrl}/embed` : `${this.apiUrl}/v1/embed`;
    const maxRetries = 3;
    const baseDelay = 1e3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15e3);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiSecret || ""}`
          },
          body: JSON.stringify({ items, projectName }),
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (!response.ok) {
          const text = await response.text();
          if (response.status >= 400 && response.status < 500) {
            throw new Error(`API Error ${response.status}: ${text}`);
          }
          if (attempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, attempt - 1);
            logger.warn(`[embedContent] 5xx error, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw new Error(`API Error ${response.status}: ${text}`);
        }
        return await response.json();
      } catch (e) {
        clearTimeout(timeout);
        if (e.message.startsWith("API Error 4")) throw e;
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1);
          logger.warn(`[embedContent] Network/timeout error, retrying in ${delay}ms (attempt ${attempt}/${maxRetries}): ${e.message}`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        logger.warn(`[embedContent] Failed after ${maxRetries} attempts: ${e.message}. Skipping embed.`);
        return;
      }
    }
  }
};

// ../../src/local/nerve-center.ts
import { Mutex as Mutex2 } from "async-mutex";
import { createClient } from "@supabase/supabase-js";
import fs6 from "fs/promises";
import { existsSync as existsSync2 } from "fs";
import path4 from "path";

// ../../src/local/project-identity.ts
import fs2 from "fs";
import path2 from "path";
function projectStateFilePath(root) {
  return path2.join(path2.resolve(root), "history", "nerve-center-state.json");
}
function findProjectRoot(start) {
  let current = path2.resolve(start);
  const filesystemRoot = path2.parse(current).root;
  while (true) {
    if (fs2.existsSync(path2.join(current, ".axis", "axis.json")) || fs2.existsSync(path2.join(current, ".git")) || fs2.existsSync(path2.join(current, "package.json"))) {
      return current;
    }
    if (current === filesystemRoot) return path2.resolve(start);
    current = path2.dirname(current);
  }
}
function existingDirectory(candidate) {
  if (!candidate) return void 0;
  const resolved = path2.resolve(candidate);
  try {
    return fs2.statSync(resolved).isDirectory() ? resolved : void 0;
  } catch {
    return void 0;
  }
}
function deriveProjectName(root) {
  try {
    const config = JSON.parse(
      fs2.readFileSync(path2.join(root, ".axis", "axis.json"), "utf8")
    );
    const configuredName = config.project ?? config.projectName;
    if (configuredName) return String(configuredName);
  } catch {
  }
  return path2.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}
function resolveProjectIdentity(configuredRoot, cwd, env = process.env) {
  const runtimeCandidate = existingDirectory(env.AXIS_WORKSPACE_ROOT) || existingDirectory(env.SUPERSET_WORKSPACE_PATH) || existingDirectory(env.SUPERSET_ROOT_PATH);
  const configuredCandidate = existingDirectory(configuredRoot);
  const runtimeRoot = runtimeCandidate ? findProjectRoot(runtimeCandidate) : void 0;
  const configuredProjectRoot = configuredCandidate ? findProjectRoot(configuredCandidate) : void 0;
  const root = runtimeRoot || configuredProjectRoot || findProjectRoot(cwd);
  const source = runtimeRoot ? "runtime" : configuredProjectRoot ? "configured" : "cwd";
  const switchedWorkspace = Boolean(
    runtimeRoot && configuredProjectRoot && path2.resolve(runtimeRoot) !== path2.resolve(configuredProjectRoot)
  );
  const projectName = env.AXIS_PROJECT_NAME || (!switchedWorkspace ? env.PROJECT_NAME : void 0) || deriveProjectName(root);
  return {
    root,
    projectName,
    source,
    ...switchedWorkspace ? { ignoredConfiguredRoot: configuredProjectRoot } : {}
  };
}

// ../../src/local/lock-integrity.ts
import { createHash } from "crypto";
import fs3 from "fs/promises";
function hashContent(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
async function hashFileIfExists(absolutePath) {
  try {
    const buf = await fs3.readFile(absolutePath);
    return hashContent(buf);
  } catch {
    return void 0;
  }
}
function compareFingerprint(lockedHash, currentHash, fingerprintRecorded) {
  if (!fingerprintRecorded) return "unknown";
  if (lockedHash === void 0 && currentHash === void 0) return "unchanged";
  if (lockedHash === void 0 && currentHash !== void 0) return "created";
  if (lockedHash !== void 0 && currentHash === void 0) return "deleted";
  return lockedHash === currentHash ? "unchanged" : "modified";
}
function buildIntegrityReport(lockedHash, currentHash, fingerprintRecorded) {
  const verdict = compareFingerprint(lockedHash, currentHash, fingerprintRecorded);
  return {
    verdict,
    tampered: verdict === "modified" || verdict === "deleted",
    lockedHash,
    currentHash
  };
}

// ../../src/local/job-hygiene.ts
var DEFAULT_JOB_STALE_MS = 30 * 60 * 1e3;
function isReclaimable(job, now, ttlMs = DEFAULT_JOB_STALE_MS) {
  return job.status === "in_progress" && now - job.updatedAt > ttlMs;
}
function findReclaimable(jobs, now, ttlMs = DEFAULT_JOB_STALE_MS) {
  return jobs.filter((j) => isReclaimable(j, now, ttlMs));
}

// ../../src/local/fs-guard.ts
import fs4 from "fs/promises";
var WRITE_BITS = 146;
function locksEnforced(env = process.env) {
  const v = (env.AXIS_ENFORCE_LOCKS || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
async function denyWrites(absolutePath) {
  try {
    const st = await fs4.stat(absolutePath);
    const mode = st.mode & 511;
    await fs4.chmod(absolutePath, mode & ~WRITE_BITS);
    return mode;
  } catch {
    return void 0;
  }
}
async function restoreWrites(absolutePath, originalMode) {
  try {
    await fs4.chmod(absolutePath, (originalMode ?? 420) & 511);
  } catch {
  }
}
async function withTempWrite(absolutePath, originalMode, fn) {
  await restoreWrites(absolutePath, originalMode);
  try {
    return await fn();
  } finally {
    await denyWrites(absolutePath);
  }
}

// ../../src/local/session-transcript.ts
import fs5 from "fs/promises";
import path3 from "path";
import os from "os";
var MAX_EVENTS = 2e3;
var MAX_EVENT_CHARS = 15e4;
var MAX_TOTAL_CHARS = 3e6;
function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => !!item && typeof item === "object").filter((item) => item.type === "input_text" || item.type === "output_text" || item.type === "text").map((item) => typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n");
}
function parseJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function isErrorOutput(output) {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return /tool call error|process exited with code [1-9]|"is_error"\s*:\s*true|error:/i.test(text || "");
}
function limitString(value) {
  if (/encrypted_content|base_instructions/i.test(value)) {
    return "[Axis redacted a tool output containing raw hidden agent instructions or reasoning.]";
  }
  if (value.length <= MAX_EVENT_CHARS) return value;
  return `${value.slice(0, MAX_EVENT_CHARS)}
... truncated by Axis`;
}
function limitValue(value) {
  if (typeof value === "string") return limitString(value);
  try {
    const serialized = JSON.stringify(value);
    const limited = limitString(serialized);
    return limited === serialized ? value : limited;
  } catch {
    return limitString(String(value));
  }
}
function normalizeTranscriptEvents(events) {
  const seen = /* @__PURE__ */ new Set();
  const compacted = [];
  let totalChars = 0;
  for (const event of events) {
    if (compacted.length >= MAX_EVENTS) break;
    const normalized = {
      ...event,
      content: event.content ? limitString(event.content) : void 0,
      arguments: event.arguments === void 0 ? void 0 : limitValue(event.arguments),
      output: event.output === void 0 ? void 0 : limitValue(event.output)
    };
    const signature = JSON.stringify([
      normalized.kind,
      normalized.role,
      normalized.timestamp,
      normalized.toolCallId,
      normalized.toolName,
      normalized.content,
      normalized.arguments,
      normalized.output
    ]);
    if (seen.has(signature)) continue;
    if (totalChars + signature.length > MAX_TOTAL_CHARS) break;
    seen.add(signature);
    totalChars += signature.length;
    compacted.push(normalized);
  }
  return compacted;
}
function parseCodexTranscript(raw) {
  const events = [];
  const toolNames = /* @__PURE__ */ new Map();
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "response_item" || !record.payload) continue;
    const payload = record.payload;
    const base = {
      timestamp: typeof record.timestamp === "string" ? record.timestamp : void 0,
      agent: "codex",
      provider: "openai"
    };
    if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
      const content = textContent(payload.content);
      if (!content || payload.role === "user" && /^<(environment_context|turn_aborted)>/.test(content.trim())) continue;
      events.push({
        id: `codex-message-${index}`,
        kind: "message",
        role: payload.role,
        content,
        ...base
      });
    } else if (payload.type === "function_call") {
      const callId = String(payload.call_id || `call-${index}`);
      const toolName = [payload.namespace, payload.name].filter(Boolean).join(".") || "tool";
      toolNames.set(callId, toolName);
      events.push({
        id: `codex-call-${callId}`,
        kind: "tool_call",
        role: "assistant",
        toolName,
        toolCallId: callId,
        arguments: parseJson(payload.arguments),
        ...base
      });
    } else if (payload.type === "function_call_output") {
      const callId = String(payload.call_id || `call-${index}`);
      const output = payload.output;
      events.push({
        id: `codex-result-${callId}`,
        kind: "tool_result",
        role: "tool",
        toolName: toolNames.get(callId) || "tool",
        toolCallId: callId,
        output,
        isError: isErrorOutput(output),
        ...base
      });
    }
  }
  return normalizeTranscriptEvents(events);
}
function parseClaudeTranscript(raw) {
  const events = [];
  const toolNames = /* @__PURE__ */ new Map();
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "user" && record.type !== "assistant") continue;
    const message = record.message;
    if (!message || message.role !== "user" && message.role !== "assistant") continue;
    const content = message.content;
    const base = {
      timestamp: typeof record.timestamp === "string" ? record.timestamp : void 0,
      agent: "claude-code",
      provider: "anthropic"
    };
    if (typeof content === "string") {
      if (content) {
        events.push({
          id: `claude-message-${index}`,
          kind: "message",
          role: message.role,
          content,
          ...base
        });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;
    const text = textContent(content);
    if (text) {
      events.push({
        id: `claude-message-${index}`,
        kind: "message",
        role: message.role,
        content: text,
        ...base
      });
    }
    for (const [contentIndex, item] of content.entries()) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "tool_use") {
        const callId = String(item.id || `call-${index}-${contentIndex}`);
        const toolName = String(item.name || "tool");
        toolNames.set(callId, toolName);
        events.push({
          id: `claude-call-${callId}`,
          kind: "tool_call",
          role: "assistant",
          toolName,
          toolCallId: callId,
          arguments: item.input,
          ...base
        });
      } else if (item.type === "tool_result") {
        const callId = String(item.tool_use_id || `call-${index}-${contentIndex}`);
        const output = textContent(item.content) || item.content;
        events.push({
          id: `claude-result-${callId}`,
          kind: "tool_result",
          role: "tool",
          toolName: toolNames.get(callId) || "tool",
          toolCallId: callId,
          output,
          isError: item.is_error === true || isErrorOutput(output),
          ...base
        });
      }
    }
  }
  return normalizeTranscriptEvents(events);
}
function genericMessage(record, index) {
  const message = record.message && typeof record.message === "object" ? record.message : record;
  const role = message.role;
  const timestamp = record.timestamp || record.created_at || record.createdAt;
  const agent = record.agent || record.agentId || record.client || "mcp-client";
  const provider = record.provider;
  const events = [];
  if (role === "user" || role === "assistant" || role === "system") {
    const content = textContent(message.content ?? message.text);
    if (content) {
      events.push({
        id: String(record.id || record.uuid || `generic-message-${index}`),
        kind: role === "system" ? "system" : "message",
        role,
        timestamp: typeof timestamp === "string" ? timestamp : void 0,
        agent: String(agent),
        provider: typeof provider === "string" ? provider : void 0,
        content
      });
    }
  }
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const [callIndex, rawCall] of calls.entries()) {
    const call = rawCall?.function || rawCall || {};
    const callId = String(rawCall?.id || call.id || `generic-call-${index}-${callIndex}`);
    events.push({
      id: `generic-call-${callId}`,
      kind: "tool_call",
      role: "assistant",
      timestamp: typeof timestamp === "string" ? timestamp : void 0,
      agent: String(agent),
      provider: typeof provider === "string" ? provider : void 0,
      toolName: String(call.name || "tool"),
      toolCallId: callId,
      arguments: parseJson(call.arguments ?? call.input)
    });
  }
  const type = record.type || message.type;
  if (type === "tool_call" || type === "function_call" || type === "tool_use") {
    const callId = String(record.call_id || record.tool_call_id || record.id || `generic-call-${index}`);
    events.push({
      id: `generic-call-${callId}`,
      kind: "tool_call",
      role: "assistant",
      timestamp: typeof timestamp === "string" ? timestamp : void 0,
      agent: String(agent),
      provider: typeof provider === "string" ? provider : void 0,
      toolName: String(record.toolName || record.tool_name || record.name || "tool"),
      toolCallId: callId,
      arguments: parseJson(record.arguments ?? record.input)
    });
  } else if (type === "tool_result" || type === "function_call_output" || role === "tool") {
    const callId = String(record.call_id || record.tool_call_id || record.tool_use_id || record.id || `generic-result-${index}`);
    const output = record.output ?? record.result ?? message.content ?? record.content;
    events.push({
      id: `generic-result-${callId}`,
      kind: "tool_result",
      role: "tool",
      timestamp: typeof timestamp === "string" ? timestamp : void 0,
      agent: String(agent),
      provider: typeof provider === "string" ? provider : void 0,
      toolName: String(record.toolName || record.tool_name || record.name || "tool"),
      toolCallId: callId,
      output,
      isError: record.isError === true || record.is_error === true || isErrorOutput(output)
    });
  }
  return events;
}
function parseGenericTranscript(raw) {
  let records = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) records = parsed;
    else if (parsed && typeof parsed === "object") {
      const root = parsed;
      const nested = root.messages || root.conversation || root.events || root.items;
      records = Array.isArray(nested) ? nested : [root];
    }
  } catch {
    records = raw.split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }
  return normalizeTranscriptEvents(records.flatMap(
    (record, index) => record && typeof record === "object" ? genericMessage(record, index) : []
  ));
}
function toolFingerprint(event) {
  const toolName = (event.toolName || "tool").split(".").pop()?.replace(/^_+/, "") || "tool";
  const detail = event.kind === "tool_call" ? event.arguments : event.output;
  let serialized;
  try {
    serialized = JSON.stringify(detail);
  } catch {
    serialized = String(detail);
  }
  return `${event.kind}:${toolName}:${serialized}`;
}
function mergeTranscriptEvents(nativeEvents, protocolEvents) {
  const nativeToolFingerprints = new Set(
    nativeEvents.filter((event) => event.kind === "tool_call" || event.kind === "tool_result").map(toolFingerprint)
  );
  const uniqueProtocol = protocolEvents.filter(
    (event) => !nativeToolFingerprints.has(toolFingerprint(event))
  );
  return normalizeTranscriptEvents([...nativeEvents, ...uniqueProtocol].sort((a, b) => {
    const aTime = a.timestamp ? Date.parse(a.timestamp) : Number.MAX_SAFE_INTEGER;
    const bTime = b.timestamp ? Date.parse(b.timestamp) : Number.MAX_SAFE_INTEGER;
    return aTime - bTime;
  }));
}
async function findFile(root, filename) {
  let entries;
  try {
    entries = await fs5.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = path3.join(root, entry.name);
    if (entry.isFile() && entry.name === filename) return candidate;
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, filename);
      if (nested) return nested;
    }
  }
  return null;
}
async function resolveTranscriptPath(env, homeDir) {
  if (env.AXIS_TRANSCRIPT_PATH) {
    const requestedFormat = env.AXIS_TRANSCRIPT_FORMAT?.trim().toLowerCase();
    const source = requestedFormat === "codex" || requestedFormat === "claude" || requestedFormat === "generic" ? requestedFormat : env.CODEX_THREAD_ID ? "codex" : env.CLAUDE_SESSION_ID ? "claude" : "generic";
    return { path: env.AXIS_TRANSCRIPT_PATH, source, threadId: env.CODEX_THREAD_ID || env.CLAUDE_SESSION_ID || null };
  }
  if (env.CODEX_THREAD_ID) {
    const filenameSuffix = `${env.CODEX_THREAD_ID}.jsonl`;
    const sessionsRoot = path3.join(homeDir, ".codex", "sessions");
    const match = await findFile(sessionsRoot, filenameSuffix);
    if (match) return { path: match, source: "codex", threadId: env.CODEX_THREAD_ID };
    const entries = await collectFiles(sessionsRoot);
    const rollout = entries.find((entry) => entry.endsWith(filenameSuffix));
    if (rollout) return { path: rollout, source: "codex", threadId: env.CODEX_THREAD_ID };
  }
  if (env.CODEX_TUI_SESSION_LOG_PATH) {
    return { path: env.CODEX_TUI_SESSION_LOG_PATH, source: "codex", threadId: env.CODEX_THREAD_ID || null };
  }
  const claudeSessionId = env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID;
  if (claudeSessionId) {
    const match = await findFile(path3.join(homeDir, ".claude", "projects"), `${claudeSessionId}.jsonl`);
    if (match) return { path: match, source: "claude", threadId: claudeSessionId };
  }
  return { path: null, source: "unknown", threadId: null };
}
async function collectFiles(root) {
  const files = [];
  let entries;
  try {
    entries = await fs5.readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const candidate = path3.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(candidate));
    else files.push(candidate);
  }
  return files;
}
async function collectSessionTranscript(env = process.env, homeDir = os.homedir()) {
  const resolved = await resolveTranscriptPath(env, homeDir);
  if (!resolved.path) {
    return {
      events: [],
      metadata: {
        source: "unknown",
        provider: null,
        agent: null,
        thread_id: resolved.threadId,
        transcript_path: null
      }
    };
  }
  try {
    const raw = await fs5.readFile(resolved.path, "utf8");
    const source = resolved.source === "unknown" ? raw.includes('"originator":"codex') ? "codex" : raw.includes('"message":{"model":"claude') ? "claude" : "generic" : resolved.source;
    return {
      events: source === "codex" ? parseCodexTranscript(raw) : source === "claude" ? parseClaudeTranscript(raw) : parseGenericTranscript(raw),
      metadata: {
        source,
        provider: source === "codex" ? "openai" : source === "claude" ? "anthropic" : env.AXIS_TRANSCRIPT_PROVIDER || null,
        agent: source === "codex" ? "codex" : source === "claude" ? "claude-code" : env.AXIS_AGENT_BASE || "mcp-client",
        thread_id: resolved.threadId,
        transcript_path: resolved.path
      }
    };
  } catch {
    return {
      events: [],
      metadata: {
        source: resolved.source,
        provider: resolved.source === "codex" ? "openai" : resolved.source === "claude" ? "anthropic" : env.AXIS_TRANSCRIPT_PROVIDER || null,
        agent: resolved.source === "codex" ? "codex" : resolved.source === "claude" ? "claude-code" : env.AXIS_AGENT_BASE || null,
        thread_id: resolved.threadId,
        transcript_path: resolved.path
      }
    };
  }
}
function transcriptTitle(events, fallback) {
  const firstUserMessage = events.find((event) => event.kind === "message" && event.role === "user")?.content;
  if (!firstUserMessage) return fallback;
  const firstLine = firstUserMessage.replace(/\s+/g, " ").trim();
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}

// ../../src/local/nerve-center.ts
var LOCK_TIMEOUT_DEFAULT = 30 * 60 * 1e3;
var CIRCUIT_FAILURE_THRESHOLD = 5;
var CIRCUIT_COOLDOWN_MS = 6e4;
var CircuitOpenError = class extends Error {
  constructor() {
    super("Circuit breaker open \u2014 remote API temporarily unavailable, falling back to local");
    this.name = "CircuitOpenError";
  }
};
var NerveCenter = class _NerveCenter {
  mutex;
  state;
  contextManager;
  stateFilePath;
  stateFilePathExplicit;
  projectRoot;
  lockTimeout;
  supabase;
  _projectId;
  // Renamed backing field
  projectName;
  projectNameExplicit;
  useSupabase;
  enforceLocks;
  protocolEvents = [];
  /** Files made read-only on disk while locked, keyed by normalized path → {prior mode, owner}. */
  enforcedPerms = /* @__PURE__ */ new Map();
  _circuitFailures = 0;
  _circuitOpenUntil = 0;
  async captureToolExecution(toolName, args, agent, execute) {
    const callId = `axis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    this.protocolEvents = normalizeTranscriptEvents([
      ...this.protocolEvents,
      {
        id: `${callId}-call`,
        kind: "tool_call",
        role: "assistant",
        timestamp: new Date(startedAt).toISOString(),
        agent,
        provider: "mcp",
        toolName,
        toolCallId: callId,
        arguments: args
      }
    ]);
    try {
      const result = await execute();
      if (toolName !== "finalize_session") {
        this.protocolEvents = normalizeTranscriptEvents([
          ...this.protocolEvents,
          {
            id: `${callId}-result`,
            kind: "tool_result",
            role: "tool",
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            agent,
            provider: "mcp",
            toolName,
            toolCallId: callId,
            output: result,
            isError: !!(result && typeof result === "object" && result.isError),
            durationMs: Date.now() - startedAt
          }
        ]);
      }
      return result;
    } catch (error) {
      if (toolName !== "finalize_session") {
        this.protocolEvents = normalizeTranscriptEvents([
          ...this.protocolEvents,
          {
            id: `${callId}-error`,
            kind: "tool_result",
            role: "tool",
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            agent,
            provider: "mcp",
            toolName,
            toolCallId: callId,
            output: error instanceof Error ? error.message : String(error),
            isError: true,
            durationMs: Date.now() - startedAt
          }
        ]);
      }
      throw error;
    }
  }
  /**
   * @param contextManager - Instance of ContextManager for legacy operations
   * @param options - Configuration options for state persistence and timeouts
   */
  constructor(contextManager, options = {}) {
    this.mutex = new Mutex2();
    this.contextManager = contextManager;
    this.enforceLocks = options.enforceLocks ?? locksEnforced();
    this.projectRoot = path4.resolve(options.projectRoot || process.cwd());
    this.stateFilePathExplicit = options.stateFilePath !== void 0;
    this.stateFilePath = options.stateFilePath || projectStateFilePath(this.projectRoot);
    this.lockTimeout = options.lockTimeout || LOCK_TIMEOUT_DEFAULT;
    const hasRemoteApi = !!this.contextManager.apiUrl;
    const supabaseUrl = options.supabaseUrl !== void 0 ? options.supabaseUrl : hasRemoteApi ? null : process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = options.supabaseServiceRoleKey !== void 0 ? options.supabaseServiceRoleKey : hasRemoteApi ? null : process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && supabaseKey) {
      this.supabase = createClient(supabaseUrl, supabaseKey);
      this.useSupabase = true;
      logger.info("NerveCenter: Using direct Supabase persistence.");
    } else if (this.contextManager.apiUrl) {
      this.supabase = void 0;
      this.useSupabase = false;
      logger.info(`NerveCenter: Using Remote API persistence (${this.contextManager.apiUrl})`);
    } else {
      this.supabase = void 0;
      this.useSupabase = false;
      logger.warn("NerveCenter: Running in local-only mode. Coordination restricted to this machine.");
    }
    const explicitProjectName = options.projectName || process.env.PROJECT_NAME;
    this.projectNameExplicit = !!explicitProjectName;
    if (explicitProjectName) {
      this.projectName = explicitProjectName;
    } else {
      this.projectName = "default";
    }
    this.state = {
      locks: {},
      jobs: {},
      liveNotepad: "Session Start: " + (/* @__PURE__ */ new Date()).toISOString() + "\n"
    };
  }
  get projectId() {
    return this._projectId;
  }
  get currentProjectName() {
    return this.projectName;
  }
  async init() {
    await this.loadState();
    if (!this.projectNameExplicit) {
      await this.detectProjectName(this.projectRoot);
    }
    if (this.useSupabase) {
      await this.ensureProjectId();
    }
    await this.syncRemoteProjectState();
  }
  /** The workspace this session is currently scoped to (see workspace-watch.ts). */
  get activeProjectRoot() {
    return this.projectRoot;
  }
  /** Current notepad content, for ambient team-update deltas (see team-updates.ts). */
  get notepadSnapshot() {
    return this.state.liveNotepad;
  }
  async switchProject(identity) {
    return await this.mutex.runExclusive(async () => {
      await this.saveState();
      this.projectRoot = path4.resolve(identity.root);
      process.chdir(this.projectRoot);
      if (!this.stateFilePathExplicit) {
        this.stateFilePath = projectStateFilePath(this.projectRoot);
      }
      this.projectName = identity.projectName || deriveProjectName(this.projectRoot);
      this.projectNameExplicit = Boolean(identity.projectName);
      this._projectId = void 0;
      this.state = _NerveCenter.createEmptyState();
      await this.loadState();
      if (this.useSupabase) {
        await this.ensureProjectId();
      }
      await this.syncRemoteProjectState();
      return {
        status: "SWITCHED",
        projectRoot: this.projectRoot,
        projectName: this.projectName,
        stateFilePath: this.stateFilePath
      };
    });
  }
  static createEmptyState() {
    return {
      locks: {},
      jobs: {},
      liveNotepad: "Session Start: " + (/* @__PURE__ */ new Date()).toISOString() + "\n"
    };
  }
  async syncRemoteProjectState() {
    if (!this.contextManager.apiUrl) return;
    try {
      const { liveNotepad, projectId } = await this.callCoordination(`sessions/sync?projectName=${this.projectName}`);
      if (projectId) {
        this._projectId = projectId;
        logger.info(`NerveCenter: Resolved projectId from cloud: ${this._projectId}`);
      }
      if (liveNotepad && (!this.state.liveNotepad || this.state.liveNotepad.startsWith("Session Start:"))) {
        this.state.liveNotepad = liveNotepad;
        logger.info(`NerveCenter: Recovered live notepad from cloud for project: ${this.projectName}`);
      }
    } catch (e) {
      logger.warn("Failed to sync project/notepad with Remote API. Using local/fallback.", e);
    }
  }
  async detectProjectName(startDir = this.projectRoot) {
    let projectRoot = startDir;
    let current = startDir;
    const filesystemRoot = path4.parse(current).root;
    while (current !== filesystemRoot) {
      if (existsSync2(path4.join(current, ".axis", "axis.json")) || existsSync2(path4.join(current, ".git")) || existsSync2(path4.join(current, "package.json"))) {
        projectRoot = current;
        break;
      }
      const parent = path4.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    try {
      const axisConfigPath = path4.join(projectRoot, ".axis", "axis.json");
      const configData = await fs6.readFile(axisConfigPath, "utf-8");
      const config = JSON.parse(configData);
      if (config.project) {
        this.projectName = String(config.project);
        logger.info(`Detected project name from .axis/axis.json: ${this.projectName}`);
        return;
      }
    } catch {
    }
    const derived = path4.basename(projectRoot).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    this.projectName = derived || "default";
    logger.info(`Derived project name '${this.projectName}' from ${projectRoot}`);
  }
  async ensureProjectId() {
    if (!this.supabase || this._projectId) return;
    const { data: project, error } = await this.supabase.from("projects").select("id").eq("name", this.projectName).maybeSingle();
    if (error) {
      logger.error("Failed to load project", error);
      return;
    }
    if (project?.id) {
      this._projectId = project.id;
      return;
    }
    const { data: created, error: createError } = await this.supabase.from("projects").insert({ name: this.projectName }).select("id").single();
    if (createError) {
      logger.error("Failed to create project", createError);
      return;
    }
    this._projectId = created.id;
  }
  async callCoordination(endpoint, method = "GET", body) {
    logger.info(`[callCoordination] Starting - endpoint: ${endpoint}, method: ${method}`);
    logger.info(`[callCoordination] apiUrl: ${this.contextManager.apiUrl}, apiSecret: ${this.contextManager.apiSecret ? "SET (" + this.contextManager.apiSecret.substring(0, 10) + "...)" : "NOT SET"}`);
    if (!this.contextManager.apiUrl) {
      logger.error("[callCoordination] Remote API not configured - apiUrl is:", this.contextManager.apiUrl);
      throw new Error("Remote API not configured");
    }
    if (this._circuitFailures >= CIRCUIT_FAILURE_THRESHOLD && Date.now() < this._circuitOpenUntil) {
      logger.warn(`[callCoordination] Circuit breaker OPEN \u2014 skipping remote call (resets at ${new Date(this._circuitOpenUntil).toISOString()})`);
      throw new CircuitOpenError();
    }
    if (this._circuitFailures >= CIRCUIT_FAILURE_THRESHOLD && Date.now() >= this._circuitOpenUntil) {
      logger.info("[callCoordination] Circuit breaker half-open \u2014 allowing probe request");
    }
    const url = this.contextManager.apiUrl.endsWith("/v1") ? `${this.contextManager.apiUrl}/${endpoint}` : `${this.contextManager.apiUrl}/v1/${endpoint}`;
    logger.info(`[callCoordination] Full URL: ${method} ${url}`);
    logger.info(`[callCoordination] Request body: ${body ? JSON.stringify({
      keys: Object.keys(body),
      projectName: this.projectName,
      transcriptEvents: Array.isArray(body.transcript) ? body.transcript.length : 0
    }) : "none"}`);
    const maxRetries = 3;
    const baseDelay = 1e3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1e4);
      try {
        const response = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.contextManager.apiSecret || ""}`
          },
          body: body ? JSON.stringify({ ...body, projectName: this.projectName }) : void 0,
          signal: controller.signal
        });
        clearTimeout(timeout);
        logger.info(`[callCoordination] Response status: ${response.status} ${response.statusText}`);
        if (!response.ok) {
          const text = await response.text();
          logger.error(`[callCoordination] API Error Response (${response.status}): ${text}`);
          if (response.status >= 400 && response.status < 500) {
            if (response.status === 401) {
              throw new Error(`Authentication failed (401): ${text}. Check if API key is valid and exists in api_keys table.`);
            }
            throw new Error(`API Error (${response.status}): ${text}`);
          }
          if (attempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, attempt - 1);
            logger.warn(`[callCoordination] 5xx error, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          this._circuitFailures++;
          if (this._circuitFailures >= CIRCUIT_FAILURE_THRESHOLD) {
            this._circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
            logger.error(`[callCoordination] Circuit breaker OPENED after ${this._circuitFailures} consecutive failures`);
          }
          throw new Error(`Server error (${response.status}): ${text}. Check Vercel logs for details.`);
        }
        if (this._circuitFailures > 0) {
          logger.info(`[callCoordination] Request succeeded, resetting circuit breaker (was at ${this._circuitFailures} failures)`);
          this._circuitFailures = 0;
          this._circuitOpenUntil = 0;
        }
        const jsonResult = await response.json();
        logger.info(`[callCoordination] Success - Response: ${JSON.stringify(jsonResult).substring(0, 200)}...`);
        return jsonResult;
      } catch (e) {
        clearTimeout(timeout);
        if (e instanceof CircuitOpenError) throw e;
        if (e.message.includes("Authentication failed") || e.message.includes("API Error (4")) {
          throw e;
        }
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1);
          logger.warn(`[callCoordination] Network/timeout error, retrying in ${delay}ms (attempt ${attempt}/${maxRetries}): ${e.message}`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        this._circuitFailures++;
        if (this._circuitFailures >= CIRCUIT_FAILURE_THRESHOLD) {
          this._circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
          logger.error(`[callCoordination] Circuit breaker OPENED after ${this._circuitFailures} consecutive failures`);
        }
        logger.error(`[callCoordination] Fetch failed after ${maxRetries} attempts: ${e.message}`, e);
        if (e.message.includes("401")) {
          throw new Error(`API Authentication Error: ${e.message}. Verify AXIS_API_KEY in MCP config matches a key in the api_keys table.`);
        }
        throw e;
      }
    }
    throw new Error("callCoordination: unexpected end of retry loop");
  }
  jobFromRecord(record) {
    return {
      id: record.id,
      title: record.title,
      description: record.description,
      priority: record.priority,
      status: record.status,
      assignedTo: record.assigned_to || void 0,
      dependencies: record.dependencies || void 0,
      completionKey: record.completion_key || void 0,
      createdAt: Date.parse(record.created_at),
      updatedAt: Date.parse(record.updated_at)
    };
  }
  // --- Data Access Layers (Hybrid: Supabase > Local) ---
  async listJobs() {
    if (this.useSupabase && this.supabase && this._projectId) {
      const { data, error } = await this.supabase.from("jobs").select("id,title,description,priority,status,assigned_to,dependencies,created_at,updated_at").eq("project_id", this._projectId);
      if (error || !data) {
        logger.error("Failed to load jobs from Supabase", error);
        return [];
      }
      return data.map((record) => this.jobFromRecord(record));
    }
    if (this.contextManager.apiUrl) {
      try {
        const url = `jobs?projectName=${this.projectName}`;
        const res = await this.callCoordination(url);
        return (res.jobs || []).map((record) => this.jobFromRecord(record));
      } catch (e) {
        logger.error("Failed to load jobs from API", e);
        return Object.values(this.state.jobs);
      }
    }
    return Object.values(this.state.jobs);
  }
  async listLocks() {
    logger.info(`[getLocks] Starting - projectName: ${this.projectName}`);
    logger.info(`[getLocks] Config - apiUrl: ${this.contextManager.apiUrl}, useSupabase: ${this.useSupabase}, hasSupabase: ${!!this.supabase}`);
    if (this.contextManager.apiUrl) {
      if (!this.useSupabase || !this.supabase) {
        try {
          logger.info(`[getLocks] Fetching locks from API for project: ${this.projectName}`);
          const res = await this.callCoordination(`locks?projectName=${this.projectName}`);
          logger.info(`[getLocks] API returned ${res.locks?.length || 0} locks`);
          return (res.locks || []).map((row) => ({
            agentId: row.agent_id,
            filePath: row.file_path,
            intent: row.intent,
            userPrompt: row.user_prompt,
            timestamp: Date.parse(row.updated_at || row.timestamp),
            contentHash: row.content_hash ?? void 0
          }));
        } catch (e) {
          logger.error(`[getLocks] Failed to fetch locks from API: ${e.message}`, e);
        }
      }
    }
    if (this.useSupabase && this.supabase && this._projectId) {
      try {
        await this.supabase.rpc("clean_stale_locks", {
          p_project_id: this._projectId,
          p_timeout_seconds: Math.floor(this.lockTimeout / 1e3)
        });
        const { data, error } = await this.supabase.from("locks").select("*").eq("project_id", this._projectId);
        if (error) throw error;
        return (data || []).map((row) => ({
          agentId: row.agent_id,
          filePath: row.file_path,
          intent: row.intent,
          userPrompt: row.user_prompt,
          timestamp: Date.parse(row.updated_at),
          contentHash: row.content_hash ?? void 0
        }));
      } catch (e) {
        logger.warn("Failed to fetch locks from DB", e);
      }
    }
    if (this.contextManager.apiUrl) {
      try {
        const res = await this.callCoordination(`locks?projectName=${this.projectName}`);
        return (res.locks || []).map((row) => ({
          agentId: row.agent_id,
          filePath: row.file_path,
          intent: row.intent,
          userPrompt: row.user_prompt,
          timestamp: Date.parse(row.updated_at || row.timestamp),
          contentHash: row.content_hash ?? void 0
        }));
      } catch (e) {
        logger.error("Failed to fetch locks from API in fallback", e);
      }
    }
    return Object.values(this.state.locks);
  }
  async getNotepad() {
    if (this.useSupabase && this.supabase && this._projectId) {
      const { data, error } = await this.supabase.from("projects").select("live_notepad").eq("id", this._projectId).single();
      if (!error && data) return data.live_notepad || "";
    }
    return this.state.liveNotepad;
  }
  async appendToNotepad(text) {
    this.state.liveNotepad += text;
    await this.saveState();
    if (this.useSupabase && this.supabase && this._projectId) {
      try {
        await this.supabase.rpc("append_to_project_notepad", {
          p_project_id: this._projectId,
          p_text: text
        });
      } catch (e) {
        logger.warn("Notepad RPC append failed", e);
      }
    }
    if (this.contextManager.apiUrl) {
      try {
        const res = await this.callCoordination("sessions/sync", "POST", {
          title: `Current Session: ${this.projectName}`,
          context: this.state.liveNotepad,
          metadata: { source: "mcp-server-live" }
        });
        if (res.projectId && !this._projectId) {
          this._projectId = res.projectId;
          logger.info(`NerveCenter: Captured projectId from sync API: ${this._projectId}`);
        }
      } catch (e) {
        logger.warn("Failed to sync notepad to remote API", e);
      }
    }
  }
  async saveState() {
    try {
      await fs6.mkdir(path4.dirname(this.stateFilePath), { recursive: true });
      await fs6.writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2));
    } catch (error) {
      logger.error("Failed to persist state", error);
    }
  }
  async loadState() {
    try {
      const data = await fs6.readFile(this.stateFilePath, "utf-8");
      const parsed = JSON.parse(data);
      this.state = {
        ..._NerveCenter.createEmptyState(),
        ...parsed,
        locks: parsed.locks || {},
        jobs: parsed.jobs || {},
        liveNotepad: parsed.liveNotepad || _NerveCenter.createEmptyState().liveNotepad
      };
      logger.info("State loaded from disk");
    } catch (_error) {
      this.state = _NerveCenter.createEmptyState();
    }
  }
  // --- Job Board Protocol (Active Orchestration) ---
  async postJob(title, description, priority = "medium", dependencies = []) {
    return await this.mutex.runExclusive(async () => {
      let id = `job-${Date.now()}-${Math.floor(Math.random() * 1e3)}`;
      const completionKey = Math.random().toString(36).substring(2, 10).toUpperCase();
      const now = Date.now();
      const localJob = {
        id,
        title,
        description,
        priority,
        dependencies,
        status: "todo",
        createdAt: now,
        updatedAt: now,
        completionKey
      };
      if (this.useSupabase && this.supabase && this._projectId) {
        const { data, error } = await this.supabase.from("jobs").insert({
          project_id: this._projectId,
          title,
          description,
          priority,
          status: "todo",
          dependencies,
          completion_key: completionKey
        }).select("id").single();
        if (data?.id) id = data.id;
        if (error) {
          logger.error("Failed to post job to Supabase", error);
          return { status: "ERROR", error: "Failed to persist job to Supabase" };
        }
      } else if (this.contextManager.apiUrl) {
        try {
          const data = await this.callCoordination("jobs", "POST", {
            action: "post",
            title,
            description,
            priority,
            dependencies,
            completion_key: completionKey
          });
          if (data?.id) id = data.id;
        } catch (e) {
          logger.error("Failed to post job to API", e);
          return { status: "ERROR", error: `Failed to persist job to remote API: ${e.message}` };
        }
      } else {
        localJob.id = id;
        this.state.jobs[id] = localJob;
      }
      const depText = dependencies.length ? ` (Depends on: ${dependencies.join(", ")})` : "";
      const logEntry = `
- [JOB POSTED] [${priority.toUpperCase()}] ${title} (ID: ${id})${depText}`;
      await this.appendToNotepad(logEntry);
      return { jobId: id, status: "POSTED", completionKey };
    });
  }
  async claimNextJob(agentId) {
    return await this.mutex.runExclusive(async () => {
      if (this.useSupabase && this.supabase && this._projectId) {
        const { data, error } = await this.supabase.rpc("claim_next_job", {
          p_project_id: this._projectId,
          p_agent_id: agentId
        });
        if (error) {
          logger.error("Failed to claim job via RPC", error);
        } else if (data && data.status === "CLAIMED") {
          const job2 = this.jobFromRecord(data.job);
          await this.appendToNotepad(`
- [JOB CLAIMED] Agent '${agentId}' picked up: ${job2.title}`);
          return { status: "CLAIMED", job: job2 };
        }
        return { status: "NO_JOBS_AVAILABLE", message: "Relax. No open tickets (or dependencies not met)." };
      }
      if (this.contextManager.apiUrl) {
        try {
          const data = await this.callCoordination("jobs", "POST", {
            action: "claim",
            agentId
          });
          if (data && data.status === "CLAIMED") {
            const job2 = this.jobFromRecord(data.job);
            await this.appendToNotepad(`
- [JOB CLAIMED] Agent '${agentId}' picked up: ${job2.title}`);
            return { status: "CLAIMED", job: job2 };
          }
          return { status: "NO_JOBS_AVAILABLE", message: "Relax. No open tickets (or dependencies not met)." };
        } catch (e) {
          logger.error("Failed to claim job via API", e);
          return { status: "NO_JOBS_AVAILABLE", message: `Claim failed: ${e.message}` };
        }
      }
      const priorities = ["critical", "high", "medium", "low"];
      const allJobs = Object.values(this.state.jobs);
      const reclaimable = findReclaimable(
        allJobs.map((job2) => ({ id: job2.id, status: job2.status, updatedAt: job2.updatedAt })),
        Date.now(),
        this.lockTimeout
      );
      for (const stale of reclaimable) {
        const job2 = this.state.jobs[stale.id];
        if (job2) {
          job2.status = "todo";
          job2.assignedTo = void 0;
          job2.updatedAt = Date.now();
          await this.appendToNotepad(`
- [JOB RECLAIMED] '${job2.title}' was abandoned in_progress; returned to the board.`);
        }
      }
      const jobsById = new Map(allJobs.map((job2) => [job2.id, job2]));
      const availableJobs = allJobs.filter((job2) => job2.status === "todo").filter((job2) => {
        if (!job2.dependencies || job2.dependencies.length === 0) return true;
        return job2.dependencies.every((depId) => jobsById.get(depId)?.status === "done");
      }).sort((a, b) => {
        const pA = priorities.indexOf(a.priority);
        const pB = priorities.indexOf(b.priority);
        if (pA !== pB) return pA - pB;
        return a.createdAt - b.createdAt;
      });
      if (availableJobs.length === 0) {
        return { status: "NO_JOBS_AVAILABLE", message: "Relax. No open tickets (or dependencies not met)." };
      }
      const job = availableJobs[0];
      job.status = "in_progress";
      job.assignedTo = agentId;
      job.updatedAt = Date.now();
      await this.appendToNotepad(`
- [JOB CLAIMED] Agent '${agentId}' picked up: ${job.title}`);
      return { status: "CLAIMED", job };
    });
  }
  async claimJob(agentId, jobId) {
    return await this.mutex.runExclusive(async () => {
      const jobs = await this.listJobs();
      const job = jobs.find((candidate) => candidate.id === jobId);
      if (!job) return { status: "NOT_FOUND", message: `Job '${jobId}' was not found.` };
      if (job.status !== "todo") {
        return { status: "NOT_AVAILABLE", message: `Job '${jobId}' is ${job.status}.` };
      }
      const jobsById = new Map(jobs.map((candidate) => [candidate.id, candidate]));
      const unmetDependencies = (job.dependencies || []).filter(
        (dependencyId) => jobsById.get(dependencyId)?.status !== "done"
      );
      if (unmetDependencies.length > 0) {
        return {
          status: "BLOCKED_BY_DEPENDENCIES",
          message: `Job '${jobId}' is blocked by: ${unmetDependencies.join(", ")}`,
          dependencies: unmetDependencies
        };
      }
      if (this.useSupabase && this.supabase && this._projectId) {
        const { data, error } = await this.supabase.from("jobs").update({
          status: "in_progress",
          assigned_to: agentId,
          updated_at: (/* @__PURE__ */ new Date()).toISOString()
        }).eq("project_id", this._projectId).eq("id", jobId).eq("status", "todo").select("id,title,description,priority,status,assigned_to,dependencies,completion_key,created_at,updated_at").maybeSingle();
        if (error) return { status: "ERROR", message: error.message };
        if (!data) return { status: "NOT_AVAILABLE", message: `Job '${jobId}' was claimed by another agent.` };
        const claimed = this.jobFromRecord(data);
        await this.appendToNotepad(`
- [JOB CLAIMED] Agent '${agentId}' picked up: ${claimed.title}`);
        return { status: "CLAIMED", job: claimed };
      }
      if (this.contextManager.apiUrl) {
        try {
          const data = await this.callCoordination("jobs", "POST", {
            // The hosted API treats "claim" as claim-NEXT and silently
            // ignores jobId — a specific claim must be "claim_by_id"
            // (claim_specific_job RPC). Sending "claim" here was the
            // live mis-claim bug: agents asked for one job and were
            // handed the head of the queue.
            action: "claim_by_id",
            jobId,
            agentId
          });
          if (data?.status !== "CLAIMED" || !data.job) {
            return data || { status: "NOT_AVAILABLE", message: `Job '${jobId}' could not be claimed.` };
          }
          const claimed = this.jobFromRecord(data.job);
          await this.appendToNotepad(`
- [JOB CLAIMED] Agent '${agentId}' picked up: ${claimed.title}`);
          return { status: "CLAIMED", job: claimed };
        } catch (e) {
          const jsonMatch = typeof e.message === "string" ? e.message.match(/\{.*\}/s) : null;
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.status) return parsed;
            } catch {
            }
          }
          return { status: "ERROR", message: `Claim failed: ${e.message}` };
        }
      }
      const localJob = this.state.jobs[jobId];
      if (!localJob || localJob.status !== "todo") {
        return { status: "NOT_AVAILABLE", message: `Job '${jobId}' is no longer available.` };
      }
      localJob.status = "in_progress";
      localJob.assignedTo = agentId;
      localJob.updatedAt = Date.now();
      await this.appendToNotepad(`
- [JOB CLAIMED] Agent '${agentId}' picked up: ${localJob.title}`);
      return { status: "CLAIMED", job: localJob };
    });
  }
  async cancelJob(jobId, reason) {
    return await this.mutex.runExclusive(async () => {
      if (this.useSupabase && this.supabase && this._projectId) {
        await this.supabase.from("jobs").update({ status: "cancelled", cancel_reason: reason, updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", jobId);
      } else if (this.contextManager.apiUrl) {
        try {
          await this.callCoordination("jobs", "POST", { action: "update", jobId, status: "cancelled", cancel_reason: reason });
        } catch (e) {
          logger.error("Failed to cancel job via API", e);
        }
      }
      if (this.state.jobs[jobId]) {
        this.state.jobs[jobId].status = "cancelled";
        this.state.jobs[jobId].updatedAt = Date.now();
        await this.saveState();
      }
      await this.appendToNotepad(`
- [JOB CANCELLED] ID: ${jobId}. Reason: ${reason}`);
      return "Job cancelled.";
    });
  }
  async completeJob(agentId, jobId, outcome, completionKey) {
    return await this.mutex.runExclusive(async () => {
      if (this.useSupabase && this.supabase) {
        const { data, error } = await this.supabase.from("jobs").select("id,title,assigned_to,completion_key").eq("id", jobId).single();
        if (error || !data) return { error: "Job not found" };
        const isOwner2 = data.assigned_to === agentId;
        const isKeyValid2 = completionKey && data.completion_key === completionKey;
        if (!isOwner2 && !isKeyValid2) {
          return { error: "You don't own this job and provided no valid key." };
        }
        const { error: updateError } = await this.supabase.from("jobs").update({ status: "done", updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", jobId);
        if (updateError) return { error: "Failed to complete job" };
        await this.supabase.from("locks").delete().eq("project_id", this._projectId).eq("agent_id", data.assigned_to);
        await this.restoreLocksForAgentOnDisk(data.assigned_to || agentId);
        await this.appendToNotepad(`
- [JOB DONE] Agent '${agentId}' finished: ${data.title}
  Outcome: ${outcome}`);
        return { status: "COMPLETED" };
      } else if (this.contextManager.apiUrl) {
        try {
          await this.callCoordination("jobs", "POST", {
            action: "update",
            jobId,
            status: "done",
            assigned_to: agentId,
            completion_key: completionKey
          });
          await this.restoreLocksForAgentOnDisk(agentId);
          await this.appendToNotepad(`
- [JOB DONE] Agent '${agentId}' finished: ${jobId}
  Outcome: ${outcome}`);
          return { status: "COMPLETED" };
        } catch (e) {
          logger.error("Failed to complete job via API", e);
        }
      }
      const job = this.state.jobs[jobId];
      if (!job) return { error: "Job not found" };
      const isOwner = job.assignedTo === agentId;
      const isKeyValid = completionKey && job.completionKey === completionKey;
      if (!isOwner && !isKeyValid) {
        return { error: "You don't own this job and provided no valid key." };
      }
      job.status = "done";
      job.updatedAt = Date.now();
      for (const [lockedPath, lock] of Object.entries(this.state.locks)) {
        if (lock.agentId === job.assignedTo) delete this.state.locks[lockedPath];
      }
      await this.restoreLocksForAgentOnDisk(job.assignedTo || agentId);
      await this.appendToNotepad(`
- [JOB DONE] Agent '${agentId}' finished: ${job.title}
  Outcome: ${outcome}`);
      return { status: "COMPLETED" };
    });
  }
  async releaseFileAccess(agentId, filePath) {
    return await this.mutex.runExclusive(async () => {
      const normalizedPath = _NerveCenter.normalizeLockPath(filePath);
      if (this.contextManager.apiUrl) {
        try {
          const result = await this.callCoordination("locks", "POST", {
            action: "unlock",
            filePath: normalizedPath,
            agentId
          });
          await this.restoreLockOnDisk(normalizedPath);
          await this.appendToNotepad(`
- [UNLOCK] ${agentId} released ${normalizedPath}`);
          return result?.status ? result : { status: "RELEASED", filePath: normalizedPath };
        } catch (e) {
          return { status: "ERROR", message: `Failed to release remote lock: ${e.message}` };
        }
      }
      if (this.useSupabase && this.supabase && this._projectId) {
        const { data, error } = await this.supabase.from("locks").delete().eq("project_id", this._projectId).eq("file_path", normalizedPath).eq("agent_id", agentId).select("file_path");
        if (error) return { status: "ERROR", message: error.message };
        if (!data || data.length === 0) {
          return { status: "NOT_OWNER", message: `No lock on '${normalizedPath}' is owned by '${agentId}'.` };
        }
        await this.restoreLockOnDisk(normalizedPath);
        await this.appendToNotepad(`
- [UNLOCK] ${agentId} released ${normalizedPath}`);
        return { status: "RELEASED", filePath: normalizedPath };
      }
      const lock = this.state.locks[normalizedPath];
      if (!lock) return { status: "NOT_FOUND", message: `No active lock for '${normalizedPath}'.` };
      if (lock.agentId !== agentId) {
        return {
          status: "NOT_OWNER",
          message: `Lock on '${normalizedPath}' belongs to '${lock.agentId}'.`
        };
      }
      delete this.state.locks[normalizedPath];
      await this.restoreLockOnDisk(normalizedPath);
      await this.appendToNotepad(`
- [UNLOCK] ${agentId} released ${normalizedPath}`);
      return { status: "RELEASED", filePath: normalizedPath };
    });
  }
  async forceUnlock(filePath, reason) {
    return await this.mutex.runExclusive(async () => {
      if (this.useSupabase && this.supabase && this._projectId) {
        await this.supabase.from("locks").delete().eq("project_id", this._projectId).eq("file_path", filePath);
      } else if (this.contextManager.apiUrl) {
        try {
          await this.callCoordination("locks", "POST", { action: "force_unlock", filePath, reason });
        } catch (e) {
          if (typeof e.message === "string" && e.message.includes("Invalid action")) {
            try {
              await this.callCoordination("locks", "POST", { action: "unlock", filePath, reason });
            } catch (legacyError) {
              logger.error("Failed to force unlock via API (legacy path)", legacyError);
            }
          } else {
            logger.error("Failed to force unlock via API", e);
          }
        }
      }
      if (this.state.locks[filePath]) {
        delete this.state.locks[filePath];
        await this.saveState();
      }
      await this.restoreLockOnDisk(_NerveCenter.normalizeLockPath(filePath));
      await this.logLockEvent("FORCE_UNLOCKED", filePath, "admin", void 0, reason);
      await this.appendToNotepad(`
- [FORCE UNLOCK] ${filePath} unlocked by admin. Reason: ${reason}`);
      return `File ${filePath} has been forcibly unlocked.`;
    });
  }
  async getCoreContext() {
    const jobs = await this.listJobs();
    const locks = await this.listLocks();
    const notepad = await this.getNotepad();
    const jobSummary = jobs.filter((j) => j.status !== "done" && j.status !== "cancelled").map((j) => `- [${j.status.toUpperCase()}] ${j.title} (ID: ${j.id}, Priority: ${j.priority}${j.assignedTo ? `, Assigned: ${j.assignedTo}` : ""})`).join("\n");
    const lockSummary = locks.map((l) => `- ${l.filePath} (Locked by: ${l.agentId}, Intent: ${l.intent})`).join("\n");
    return `# Active Session Context

## Job Board (Active Orchestration)
${jobSummary || "No active jobs."}

## Task Registry (Locks)
${lockSummary || "No active locks."}

## Live Notepad
${notepad}`;
  }
  // --- Lock Event Logging ---
  async logLockEvent(eventType, filePath, requestingAgent, blockingAgent, intent) {
    try {
      if (this.contextManager.apiUrl) {
        logger.info(`[logLockEvent] Logging ${eventType} event via API for ${filePath} (agent: ${requestingAgent}, blocker: ${blockingAgent || "none"})`);
        await this.callCoordination("lock-events", "POST", {
          eventType,
          filePath,
          requestingAgent,
          blockingAgent: blockingAgent || null,
          intent: intent || null
        });
        logger.info(`[logLockEvent] Successfully logged ${eventType} event`);
      } else if (this.useSupabase && this.supabase && this._projectId) {
        logger.info(`[logLockEvent] Logging ${eventType} event via Supabase for ${filePath}`);
        await this.supabase.from("lock_events").insert({
          project_id: this._projectId,
          event_type: eventType,
          file_path: filePath,
          requesting_agent: requestingAgent,
          blocking_agent: blockingAgent || null,
          intent: intent || null
        });
        logger.info(`[logLockEvent] Successfully logged ${eventType} event`);
      } else {
        logger.warn(`[logLockEvent] No persistence backend available \u2014 ${eventType} event for ${filePath} will not be recorded`);
      }
    } catch (e) {
      logger.error(`[logLockEvent] Failed to log ${eventType} event for ${filePath}: ${e.message}`);
    }
  }
  // --- Decision & Orchestration ---
  /**
   * Normalize a lock path to be relative to the project root.
   * Strips the project root prefix (process.cwd()) so that absolute and relative
   * paths resolve to the same key. This ensures that:
   *   "/Users/vir/Projects/MyApp/src/api/route.ts" and "src/api/route.ts"
   * are treated as the same lock.
   */
  static normalizeLockPath(filePath) {
    let normalized = filePath.replace(/\/+$/, "");
    const cwd = process.cwd().replace(/\/+$/, "");
    if (normalized.startsWith(cwd + "/")) {
      normalized = normalized.slice(cwd.length + 1);
    } else if (normalized === cwd) {
      normalized = "";
    }
    normalized = normalized.replace(/^\/+/, "");
    return normalized;
  }
  /**
   * Validate that a lock targets an individual file, not a directory.
   * Agents must lock specific files — directory locks are rejected because
   * they block all other agents from working on ANY file in that tree,
   * even for completely unrelated features.
   *
   * Detection strategy:
   * 1. If the path exists on disk, use fs.stat to check (handles extensionless files like Makefile)
   * 2. If the path doesn't exist, use file extension heuristic
   */
  static async validateFileOnly(filePath) {
    const normalized = _NerveCenter.normalizeLockPath(filePath);
    if (!normalized || normalized === "." || normalized === "/") {
      return { valid: false, reason: "Cannot lock the project root. Lock individual files instead." };
    }
    const projectRoot = path4.resolve(process.cwd());
    const absolutePath = path4.resolve(projectRoot, filePath);
    const relativePath = path4.relative(projectRoot, absolutePath);
    if (relativePath.startsWith("..") || path4.isAbsolute(relativePath)) {
      return { valid: false, reason: "Cannot lock files outside the project root." };
    }
    try {
      const stat = await fs6.stat(absolutePath);
      if (stat.isDirectory()) {
        return {
          valid: false,
          reason: `'${normalized}' is a directory. Lock individual files instead \u2014 directory locks block all agents from the entire tree, preventing parallel work on different features.`
        };
      }
      return { valid: true };
    } catch {
    }
    const lastSegment = normalized.split("/").filter(Boolean).pop() || "";
    if (!lastSegment.includes(".")) {
      return {
        valid: false,
        reason: `'${normalized}' looks like a directory (no file extension). Lock individual files instead \u2014 directory locks block all agents from the entire tree, preventing parallel work on different features.`
      };
    }
    return { valid: true };
  }
  /**
   * Find an existing lock that conflicts with the requested path (exact match).
   * Paths are normalized before comparison so absolute and relative paths
   * targeting the same file are correctly detected as conflicts.
   */
  findExactConflict(requestedPath, requestingAgent, locks) {
    const normalizedRequested = _NerveCenter.normalizeLockPath(requestedPath);
    for (const lock of locks) {
      if (lock.agentId === requestingAgent) continue;
      const isStale = Date.now() - lock.timestamp > this.lockTimeout;
      if (isStale) continue;
      const normalizedLock = _NerveCenter.normalizeLockPath(lock.filePath);
      if (normalizedRequested === normalizedLock) {
        return lock;
      }
    }
    return null;
  }
  /**
   * Build an actionable denial message: who holds the lock, why, and how to
   * recover. Vague "locked by another agent" errors leave agents stuck; this
   * tells them what to do next.
   */
  orchestrationMessage(normalizedPath, ownerId, intent) {
    const mins = Math.round(this.lockTimeout / 6e4);
    const owner = ownerId || "another agent";
    const why = intent ? ` for: "${intent}"` : "";
    return `File '${normalizedPath}' is locked by '${owner}'${why}. Pick a different file or job, or coordinate via update_shared_context. The lock auto-expires after ${mins} min; use force_unlock only if '${owner}' has crashed.`;
  }
  // --- Physical lock enforcement (opt-in via AXIS_ENFORCE_LOCKS) ---
  // Files are always local to the MCP server even in hosted persistence modes,
  // so chmod-based enforcement is tracked here independently of where lock
  // metadata is stored.
  /** Make a freshly-locked file read-only on disk so non-Axis writers get EACCES. */
  async enforceLockOnDisk(normalizedPath, agentId, filePath) {
    if (!this.enforceLocks) return;
    const mode = await denyWrites(path4.resolve(process.cwd(), filePath));
    this.enforcedPerms.set(normalizedPath, { mode, agentId });
  }
  /** Restore write permission for a single released path. */
  async restoreLockOnDisk(normalizedPath) {
    const entry = this.enforcedPerms.get(normalizedPath);
    if (!entry) return;
    await restoreWrites(path4.resolve(process.cwd(), normalizedPath), entry.mode);
    this.enforcedPerms.delete(normalizedPath);
  }
  /** Restore every file an agent had locked (or all, if agentId omitted). */
  async restoreLocksForAgentOnDisk(agentId) {
    for (const [p, entry] of [...this.enforcedPerms]) {
      if (!agentId || entry.agentId === agentId) {
        await restoreWrites(path4.resolve(process.cwd(), p), entry.mode);
        this.enforcedPerms.delete(p);
      }
    }
  }
  /**
   * Batch lock acquisition: one round-trip for a multi-file edit (field
   * report: the coordination-to-code ratio was too high when every file
   * cost a separate call). All-or-nothing — if any file is denied, locks
   * granted earlier in the batch are released so a partial set never
   * blocks another agent.
   *
   * Each underlying acquisition stays atomic; this wrapper must not take
   * the mutex itself (proposeFileAccess/releaseFileAccess already do).
   */
  async proposeFilesAccess(agentId, filePaths, intent, userPrompt) {
    const results = [];
    const granted = [];
    for (const filePath of filePaths) {
      const result = await this.proposeFileAccess(agentId, filePath, intent, userPrompt);
      results.push({ filePath, status: result.status, message: result.message });
      if (result.status === "GRANTED") {
        granted.push(filePath);
        continue;
      }
      for (const lockedPath of granted) {
        await this.releaseFileAccess(agentId, lockedPath);
      }
      return {
        status: result.status,
        message: `Batch lock failed on '${filePath}' \u2014 ${result.message ?? "denied"}. All-or-nothing: ${granted.length} lock(s) acquired earlier in this batch were released.`,
        failedOn: filePath,
        results
      };
    }
    return {
      status: "GRANTED",
      message: `Access granted for ${filePaths.length} file(s).`,
      results
    };
  }
  async proposeFileAccess(agentId, filePath, intent, userPrompt) {
    return await this.mutex.runExclusive(async () => {
      logger.info(`[proposeFileAccess] Starting - agentId: ${agentId}, filePath: ${filePath}`);
      const normalizedPath = _NerveCenter.normalizeLockPath(filePath);
      logger.info(`[proposeFileAccess] Normalized path: '${normalizedPath}' (from '${filePath}')`);
      const fileCheck = await _NerveCenter.validateFileOnly(filePath);
      if (!fileCheck.valid) {
        logger.warn(`[proposeFileAccess] REJECTED \u2014 not a file: ${fileCheck.reason}`);
        return {
          status: "REJECTED",
          message: fileCheck.reason
        };
      }
      if (this.contextManager.apiUrl) {
        try {
          const contentHash2 = await hashFileIfExists(path4.resolve(process.cwd(), filePath));
          const result = await this.callCoordination("locks", "POST", {
            action: "lock",
            filePath: normalizedPath,
            agentId,
            intent,
            userPrompt,
            contentHash: contentHash2
          });
          if (result.status === "DENIED") {
            logger.info(`[proposeFileAccess] DENIED by server: ${result.message}`);
            await this.logLockEvent("BLOCKED", normalizedPath, agentId, result.current_lock?.agent_id, intent);
            return {
              status: "REQUIRES_ORCHESTRATION",
              message: result.message || this.orchestrationMessage(normalizedPath, result.current_lock?.agent_id, result.current_lock?.intent),
              currentLock: result.current_lock
            };
          }
          if (result.status === "REJECTED") {
            logger.warn(`[proposeFileAccess] REJECTED by server: ${result.message}`);
            return {
              status: "REJECTED",
              message: result.message || `Lock rejected for '${normalizedPath}'. Lock an individual file (not a directory) inside the project root.`
            };
          }
          const echoedAgent = result.agent_id;
          if (echoedAgent && echoedAgent !== agentId) {
            logger.error(`[proposeFileAccess] Grant attribution mismatch: server echoed '${echoedAgent}', expected '${agentId}'`);
            return {
              status: "REQUIRES_ORCHESTRATION",
              message: `Lock grant attribution mismatch for '${normalizedPath}': server attributed the grant to '${echoedAgent}'. Re-sync (list_locks) and retry.`
            };
          }
          logger.info(`[proposeFileAccess] GRANTED by server`);
          await this.enforceLockOnDisk(normalizedPath, agentId, filePath);
          await this.logLockEvent("GRANTED", normalizedPath, agentId, void 0, intent);
          await this.appendToNotepad(`
- [LOCK] ${agentId} locked ${normalizedPath}
  Intent: ${intent}`);
          return { status: "GRANTED", message: `Access granted for ${normalizedPath}` };
        } catch (e) {
          if (e.message && e.message.includes("409")) {
            logger.info(`[proposeFileAccess] Lock conflict (409)`);
            let blockingAgent;
            try {
              const jsonMatch = e.message.match(/\{.*\}/s);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                blockingAgent = parsed.current_lock?.agent_id;
              }
            } catch {
            }
            await this.logLockEvent("BLOCKED", normalizedPath, agentId, blockingAgent, intent);
            return {
              status: "REQUIRES_ORCHESTRATION",
              message: this.orchestrationMessage(normalizedPath, blockingAgent)
            };
          }
          logger.error(`[proposeFileAccess] API lock failed: ${e.message}`, e);
          return { error: `Failed to acquire lock via API: ${e.message}` };
        }
      }
      if (this.useSupabase && this.supabase && this._projectId) {
        try {
          const { data, error } = await this.supabase.rpc("try_acquire_lock", {
            p_project_id: this._projectId,
            p_file_path: normalizedPath,
            p_agent_id: agentId,
            p_intent: intent,
            p_user_prompt: userPrompt,
            p_timeout_seconds: Math.floor(this.lockTimeout / 1e3)
          });
          if (error) throw error;
          const row = Array.isArray(data) ? data[0] : data;
          if (row && row.status === "DENIED") {
            await this.logLockEvent("BLOCKED", normalizedPath, agentId, row.owner_id, intent);
            return {
              status: "REQUIRES_ORCHESTRATION",
              message: this.orchestrationMessage(normalizedPath, row.owner_id, row.intent),
              currentLock: {
                agentId: row.owner_id,
                filePath: normalizedPath,
                intent: row.intent,
                timestamp: row.updated_at ? Date.parse(row.updated_at) : Date.now()
              }
            };
          }
          try {
            const contentHash2 = await hashFileIfExists(path4.resolve(process.cwd(), filePath));
            if (contentHash2) {
              await this.supabase.from("locks").update({ content_hash: contentHash2 }).eq("project_id", this._projectId).eq("file_path", normalizedPath).eq("agent_id", agentId);
            }
          } catch (hashErr) {
            logger.warn("[NerveCenter] Could not persist lock content_hash (migration 0009 applied?)", hashErr);
          }
          await this.enforceLockOnDisk(normalizedPath, agentId, filePath);
          await this.logLockEvent("GRANTED", normalizedPath, agentId, void 0, intent);
          await this.appendToNotepad(`
- [LOCK] ${agentId} locked ${normalizedPath}
  Intent: ${intent}`);
          return { status: "GRANTED", message: `Access granted for ${normalizedPath}` };
        } catch (e) {
          logger.warn("[NerveCenter] Lock RPC failed. Falling back to local.", e);
        }
      }
      const allLocks = Object.values(this.state.locks);
      const conflict = this.findExactConflict(filePath, agentId, allLocks);
      if (conflict) {
        await this.logLockEvent("BLOCKED", normalizedPath, agentId, conflict.agentId, intent);
        return {
          status: "REQUIRES_ORCHESTRATION",
          message: this.orchestrationMessage(normalizedPath, conflict.agentId, conflict.intent),
          currentLock: conflict
        };
      }
      const contentHash = await hashFileIfExists(path4.resolve(process.cwd(), filePath));
      this.state.locks[normalizedPath] = { agentId, filePath: normalizedPath, intent, userPrompt, timestamp: Date.now(), contentHash };
      await this.saveState();
      await this.enforceLockOnDisk(normalizedPath, agentId, filePath);
      await this.logLockEvent("GRANTED", normalizedPath, agentId, void 0, intent);
      await this.appendToNotepad(`
- [LOCK] ${agentId} locked ${normalizedPath}
  Intent: ${intent}`);
      return { status: "GRANTED", message: `Access granted for ${normalizedPath}` };
    });
  }
  /**
   * Tamper check for a held lock: compare the file's current content against
   * the fingerprint captured when the lock was granted. Lets a holder confirm
   * nobody rewrote the file out from under their (advisory) lock before they
   * overwrite it — the realistic defense against the "edited, then clobbered"
   * collision. Remote-backed locks without a stored hash return "unknown".
   */
  async verifyFileAccess(agentId, filePath) {
    return await this.mutex.runExclusive(async () => {
      const normalizedPath = _NerveCenter.normalizeLockPath(filePath);
      const lock = this.state.locks[normalizedPath] || (await this.listLocks()).find(
        (l) => _NerveCenter.normalizeLockPath(l.filePath) === normalizedPath
      );
      if (!lock) {
        return {
          status: "NO_LOCK",
          message: `No active lock for '${normalizedPath}'. Acquire one with propose_file_access first.`
        };
      }
      const currentHash = await hashFileIfExists(path4.resolve(process.cwd(), filePath));
      const report = buildIntegrityReport(lock.contentHash, currentHash, lock.contentHash !== void 0);
      const heldByOther = lock.agentId !== agentId;
      if (report.tampered) {
        return {
          status: "CONFLICT",
          verdict: report.verdict,
          heldBy: lock.agentId,
          message: `File '${normalizedPath}' was ${report.verdict} since the lock was granted${heldByOther ? ` (lock held by '${lock.agentId}')` : ""}. Re-read it before writing to avoid clobbering concurrent changes.`
        };
      }
      if (report.verdict === "unknown") {
        return {
          status: "UNKNOWN",
          heldBy: lock.agentId,
          message: `No fingerprint recorded for '${normalizedPath}' (remote-backed lock); integrity can't be verified.`
        };
      }
      return {
        status: "OK",
        verdict: report.verdict,
        heldBy: lock.agentId,
        message: `'${normalizedPath}' is unchanged since the lock was granted.`
      };
    });
  }
  /**
   * Write a file THROUGH the lock — the enforced (not just evident) path.
   * The server performs the write only if the caller holds the lock AND the
   * file hasn't changed since the lock was granted (optimistic concurrency),
   * then refreshes the fingerprint. Agents that route writes here cannot
   * clobber a file locked by someone else or overwrite concurrent changes —
   * real prevention, where verify_file_lock is only detection.
   */
  async guardedWrite(agentId, filePath, content) {
    return await this.mutex.runExclusive(async () => {
      const normalizedPath = _NerveCenter.normalizeLockPath(filePath);
      const fileCheck = await _NerveCenter.validateFileOnly(filePath);
      if (!fileCheck.valid) return { status: "REJECTED", message: fileCheck.reason };
      const lock = this.state.locks[normalizedPath] || (await this.listLocks()).find(
        (l) => _NerveCenter.normalizeLockPath(l.filePath) === normalizedPath
      );
      if (!lock) {
        return { status: "NO_LOCK", message: `Acquire a lock with propose_file_access before writing '${normalizedPath}'.` };
      }
      if (lock.agentId !== agentId) {
        return { status: "DENIED", message: this.orchestrationMessage(normalizedPath, lock.agentId, lock.intent) };
      }
      const absolutePath = path4.resolve(process.cwd(), filePath);
      const currentHash = await hashFileIfExists(absolutePath);
      if (lock.contentHash !== void 0 && currentHash !== void 0 && currentHash !== lock.contentHash) {
        return {
          status: "CONFLICT",
          message: `'${normalizedPath}' changed since you locked it. Re-read and re-lock before writing to avoid clobbering concurrent changes.`
        };
      }
      const doWrite = async () => {
        await fs6.mkdir(path4.dirname(absolutePath), { recursive: true });
        await fs6.writeFile(absolutePath, content);
      };
      const enforced = this.enforcedPerms.get(normalizedPath);
      if (this.enforceLocks && enforced) {
        await withTempWrite(absolutePath, enforced.mode, doWrite);
      } else {
        await doWrite();
      }
      if (this.state.locks[normalizedPath]) {
        this.state.locks[normalizedPath].contentHash = hashContent(content);
        this.state.locks[normalizedPath].timestamp = Date.now();
        await this.saveState();
      }
      await this.appendToNotepad(`
- [WRITE] ${agentId} wrote ${normalizedPath} (guarded)`);
      return { status: "WRITTEN", filePath: normalizedPath, bytes: Buffer.byteLength(content) };
    });
  }
  async updateSharedContext(text, agentId) {
    return await this.mutex.runExclusive(async () => {
      await this.appendToNotepad(`
- [${agentId}] ${text}`);
      return "Notepad updated.";
    });
  }
  async finalizeSession() {
    return await this.mutex.runExclusive(async () => {
      await this.restoreLocksForAgentOnDisk();
      const content = await this.getNotepad();
      const nativeTranscript = await collectSessionTranscript();
      const transcriptEvents = mergeTranscriptEvents(nativeTranscript.events, this.protocolEvents);
      const transcriptSource = nativeTranscript.metadata.source === "unknown" ? "mcp" : `${nativeTranscript.metadata.source}+mcp`;
      const sessionTitle = transcriptTitle(
        transcriptEvents,
        `Session ${(/* @__PURE__ */ new Date()).toLocaleDateString()}`
      );
      const transcriptMetadata = {
        source: transcriptSource,
        provider: nativeTranscript.metadata.provider || "mcp",
        agent: nativeTranscript.metadata.agent,
        thread_id: nativeTranscript.metadata.thread_id
      };
      const filename = `session-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.md`;
      const historyPath = path4.join(this.projectRoot, "history", filename);
      try {
        await fs6.mkdir(path4.dirname(historyPath), { recursive: true });
        await fs6.writeFile(historyPath, content);
      } catch (e) {
        logger.warn("Failed to write local session log", e);
      }
      if (this.useSupabase && this.supabase && this._projectId) {
        const { data: projectOwner } = await this.supabase.from("projects").select("owner_id").eq("id", this._projectId).single();
        await this.supabase.from("sessions").insert({
          project_id: this._projectId,
          user_id: projectOwner?.owner_id,
          title: sessionTitle,
          summary: content.substring(0, 500) + "...",
          metadata: {
            full_content: content,
            transcript: transcriptEvents,
            ...transcriptMetadata
          },
          completed_at: (/* @__PURE__ */ new Date()).toISOString()
        });
        await this.supabase.from("projects").update({ live_notepad: "Session Start: " + (/* @__PURE__ */ new Date()).toISOString() + "\n" }).eq("id", this._projectId);
        await this.supabase.from("jobs").delete().eq("project_id", this._projectId).in("status", ["done", "cancelled"]);
        await this.supabase.from("locks").delete().eq("project_id", this._projectId);
      } else if (this.contextManager.apiUrl) {
        try {
          await this.callCoordination("sessions/finalize", "POST", {
            content,
            title: sessionTitle,
            transcript: transcriptEvents,
            metadata: transcriptMetadata
          });
        } catch (e) {
          logger.error("Failed to finalize session via API", e);
        }
      }
      this.state.liveNotepad = "Session Start: " + (/* @__PURE__ */ new Date()).toISOString() + "\n";
      this.state.locks = {};
      this.state.jobs = Object.fromEntries(
        Object.entries(this.state.jobs).filter(([_, j]) => j.status !== "done" && j.status !== "cancelled")
      );
      this.protocolEvents = [];
      await this.saveState();
      return {
        status: "SESSION_FINALIZED",
        archivePath: historyPath,
        transcriptEvents: transcriptEvents.length,
        transcriptSource
      };
    });
  }
  async getProjectSoul() {
    let soul = "## Project Soul\n";
    let context = "";
    let couldNotRead = false;
    try {
      context = await this.contextManager.readFile("context.md");
      soul += `
### Context
${context}`;
      const conventions = await this.contextManager.readFile("conventions.md");
      soul += `
### Conventions
${conventions}`;
    } catch (_e) {
      couldNotRead = true;
      soul += "\n(Could not read local context files)";
    }
    const uninit = couldNotRead;
    const placeholder = !uninit && (/Describe your project|<!-- Describe|This project uses Axis/i.test(context) || context.trim().length < 450 && /# Project Context/i.test(context));
    if (uninit) {
      soul += `

### MANDATORY: This project has not been initialized for Axis
There is no \`.axis/instructions/\` directory yet, so the project soul, the IDE rule files (CLAUDE.md, AGENTS.md, .cursorrules, .windsurfrules), and the agent protocol have not been installed.

**Fastest path \u2014 one command:**
\`\`\`
npx @virsanghavi/axis-init
\`\`\`
This creates the \`.axis/\` directory, installs the rule files in the repo root, and seeds template soul files. Then call \`update_project_soul\` to fill in the project-specific content.

**Manual path** (if the user doesn't want the init CLI):
1. Use \`search_codebase\` to explore the repo and infer what this project is about.
2. Call \`update_project_soul\` with \`context\` (overview, architecture, features) and \`conventions\` (language standards, agent norms).
3. If the codebase is empty: ask the user what the project is, then call \`update_project_soul\`.

Do NOT proceed with other work until one of these paths runs. Working without a soul means every decision lacks project context.`;
    } else if (placeholder) {
      soul += `

### MANDATORY: Project soul is not yet filled
The \`.axis/\` directory exists but \`context.md\` still has placeholder/template content. Fill it before doing any other work.

**How to fill the project soul:**
1. Use \`search_codebase\` to explore the repo and infer what this project is about.
2. Call \`update_project_soul\` with \`context\` (project overview, architecture, core features, deployment) and \`conventions\` (language standards, styling, code patterns, agent norms).
3. If the codebase is empty or has nothing to search: ask the user what the project is about, then call \`update_project_soul\` with their answer.

Do NOT skip this. Do NOT proceed with other work until the soul is populated. Working without a filled soul means every decision you make lacks context.`;
    }
    return soul;
  }
  // --- Billing & Usage ---
  async getSubscriptionStatus(email) {
    logger.info(`[getSubscriptionStatus] Starting - email: ${email || "(API key identity)"}`);
    logger.info(`[getSubscriptionStatus] Config - apiUrl: ${this.contextManager.apiUrl}, apiSecret: ${this.contextManager.apiSecret ? "SET" : "NOT SET"}, useSupabase: ${this.useSupabase}`);
    if (this.contextManager.apiUrl) {
      try {
        const endpoint = email ? `usage?email=${encodeURIComponent(email)}` : "usage";
        logger.info(`[getSubscriptionStatus] Attempting API call to: ${endpoint}`);
        const result = await this.callCoordination(endpoint);
        logger.info(`[getSubscriptionStatus] API call successful: ${JSON.stringify(result).substring(0, 200)}`);
        return result;
      } catch (e) {
        logger.error(`[getSubscriptionStatus] API call failed: ${e.message}`, e);
        return { error: `API call failed: ${e.message}` };
      }
    } else {
      logger.warn("[getSubscriptionStatus] No API URL configured");
    }
    if (this.useSupabase && this.supabase && email) {
      const { data: profile, error } = await this.supabase.from("profiles").select("subscription_status, stripe_customer_id, current_period_end").ilike("email", email).single();
      if (error || !profile) {
        return { status: "unknown", message: "Profile not found." };
      }
      const isActive = profile.subscription_status === "pro" || profile.current_period_end && new Date(profile.current_period_end) > /* @__PURE__ */ new Date();
      return {
        email,
        plan: isActive ? "Pro" : "Free",
        status: profile.subscription_status || "free",
        validUntil: profile.current_period_end
      };
    }
    return { error: "Coordination not configured. API URL not set and Supabase not available." };
  }
  async getUsageStats(email) {
    logger.info(`[getUsageStats] Starting - email: ${email || "(API key identity)"}`);
    logger.info(`[getUsageStats] Config - apiUrl: ${this.contextManager.apiUrl}, apiSecret: ${this.contextManager.apiSecret ? "SET" : "NOT SET"}, useSupabase: ${this.useSupabase}`);
    if (this.contextManager.apiUrl) {
      try {
        const endpoint = email ? `usage?email=${encodeURIComponent(email)}` : "usage";
        logger.info(`[getUsageStats] Attempting API call to: ${endpoint}`);
        const result = await this.callCoordination(endpoint);
        logger.info(`[getUsageStats] API call successful: ${JSON.stringify(result).substring(0, 200)}`);
        return { email: email || result.email, usageCount: result.usageCount || 0 };
      } catch (e) {
        logger.error(`[getUsageStats] API call failed: ${e.message}`, e);
        return { error: `API call failed: ${e.message}` };
      }
    }
    if (this.useSupabase && this.supabase && email) {
      const { data: profile } = await this.supabase.from("profiles").select("usage_count").ilike("email", email).single();
      return { email, usageCount: profile?.usage_count || 0 };
    }
    return { error: "Coordination not configured. API URL not set and Supabase not available." };
  }
};

// ../../src/local/agent-identity.ts
function detectHostBase(env) {
  if (env.CURSOR_TRACE_ID || env.CURSOR_SESSION_ID) return "cursor";
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SSE_PORT) return "claude-code";
  if (env.CODEX_MANAGED_BY_NPM || env.CODEX_SANDBOX) return "codex";
  if (env.WINDSURF_SESSION_ID || env.WINDSURF_SESSION) return "windsurf";
  if (env.GITHUB_COPILOT || env.COPILOT_AGENT_SESSION || env.COPILOT_MCP_SESSION) return "github-copilot";
  if (env.ANTIGRAVITY_AGENT || env.ANTIGRAVITY_SESSION_ID) return "antigravity";
  if (env.GEMINI_CLI || env.GEMINI_SESSION_ID) return "gemini";
  if (env.CLINE_TASK_ID) return "cline";
  if (env.ROO_CODE || env.ROO_TASK_ID) return "roo-code";
  if (env.CONTINUE_GLOBAL_DIR || env.CONTINUE_SESSION_ID) return "continue";
  if (env.AIDER_MODEL || env.AIDER_SESSION_ID) return "aider";
  return void 0;
}
function normalizeBase(raw) {
  const cleaned = (raw || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[-_.]+|[-_.]+$/g, "");
  return /[a-z0-9]/.test(cleaned) ? cleaned : "agent";
}
function defaultSessionSuffix(env = process.env) {
  const override = env.AXIS_AGENT_SUFFIX?.trim();
  if (override) return normalizeBase(override);
  const pid = typeof process !== "undefined" && process.pid ? process.pid : 0;
  const salt = Math.random().toString(36).slice(2, 6);
  return `${pid.toString(36)}${salt}`;
}
function resolveAgentId(requestedId, env, token) {
  const explicit = env.AXIS_AGENT_ID?.trim();
  if (explicit) return explicit;
  const requestedBase = normalizeBase(requestedId);
  if (requestedBase === token || requestedBase.endsWith(`-${token}`)) {
    return requestedBase;
  }
  const base = requestedBase !== "agent" ? requestedBase : detectHostBase(env) || normalizeBase(env.AXIS_AGENT_BASE);
  return `${base}-${token}`;
}
function createSessionIdentity(env = process.env) {
  const token = defaultSessionSuffix(env);
  const explicit = env.AXIS_AGENT_ID?.trim();
  const base = explicit || detectHostBase(env) || normalizeBase(env.AXIS_AGENT_BASE);
  const resolve = (incoming) => resolveAgentId(incoming, env, token);
  return {
    id: resolve(),
    base,
    source: explicit ? "explicit" : "derived",
    resolve
  };
}

// ../../src/local/agent-presence.ts
var DEFAULT_PRESENCE_TTL_MS = 5 * 60 * 1e3;
var PresenceRoster = class {
  agents = /* @__PURE__ */ new Map();
  /** Record activity from an agent. Idempotent per call; updates lastSeenAt. */
  seen(agentId, now, status = "active", activity) {
    const existing = this.agents.get(agentId);
    const presence2 = existing ? { ...existing, status, lastSeenAt: now, lastActivity: activity ?? existing.lastActivity } : { agentId, status, firstSeenAt: now, lastSeenAt: now, lastActivity: activity };
    this.agents.set(agentId, presence2);
    return presence2;
  }
  /** Agents seen within the TTL window, most-recently-active first. */
  list(now, ttlMs = DEFAULT_PRESENCE_TTL_MS) {
    return [...this.agents.values()].filter((a) => now - a.lastSeenAt <= ttlMs).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }
  /** Count online agents, optionally filtered by status. */
  count(now, ttlMs = DEFAULT_PRESENCE_TTL_MS, status) {
    return this.list(now, ttlMs).filter((a) => !status || a.status === status).length;
  }
  /** Drop agents that have been silent past the TTL. Returns removed ids. */
  prune(now, ttlMs = DEFAULT_PRESENCE_TTL_MS) {
    const removed = [];
    for (const [id, a] of this.agents) {
      if (now - a.lastSeenAt > ttlMs) {
        this.agents.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }
  /** Test/inspection helper. */
  size() {
    return this.agents.size;
  }
};

// ../../src/local/rag-engine.ts
import { createClient as createClient2 } from "@supabase/supabase-js";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
var RagEngine = class {
  supabase;
  openai;
  projectId;
  constructor(supabaseUrl, supabaseKey, openaiKey, projectId) {
    this.supabase = createClient2(supabaseUrl, supabaseKey);
    this.openai = new OpenAI({ apiKey: openaiKey });
    this.projectId = projectId;
  }
  setProjectId(id) {
    this.projectId = id;
  }
  async indexContent(filePath, content) {
    if (!this.projectId) {
      logger.error("RAG: Project ID missing.");
      return false;
    }
    try {
      const resp = await this.openai.embeddings.create({
        model: "text-embedding-3-small",
        input: content.substring(0, 8e3)
        // simplistic chunking
      });
      const embedding = resp.data[0].embedding;
      await this.supabase.from("embeddings").delete().eq("project_id", this.projectId).contains("metadata", { filePath });
      const { error } = await this.supabase.from("embeddings").insert({
        project_id: this.projectId,
        content,
        embedding,
        metadata: { filePath }
      });
      if (error) {
        logger.error("RAG Insert Error:", error);
        return false;
      }
      logger.info(`Indexed ${filePath}`);
      return true;
    } catch (e) {
      logger.error("RAG Error:", e);
      return false;
    }
  }
  async search(query, limit = 5) {
    if (!this.projectId) return [];
    try {
      const resp = await this.openai.embeddings.create({
        model: "text-embedding-3-small",
        input: query
      });
      const embedding = resp.data[0].embedding;
      const { data, error } = await this.supabase.rpc("match_embeddings", {
        query_embedding: embedding,
        match_threshold: 0.1,
        match_count: limit,
        p_project_id: this.projectId
      });
      if (error || !data) {
        logger.error("RAG Search DB Error:", error);
        return [];
      }
      return data.map((d) => d.content);
    } catch (e) {
      logger.error("RAG Search Fail:", e);
      return [];
    }
  }
};

// ../../src/local/indexer.ts
import * as fs7 from "fs";
import * as path5 from "path";
import { createHash as createHash2 } from "crypto";
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
  const file = path5.join(root, ".gitignore");
  let patterns = [];
  try {
    patterns = fs7.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  } catch {
  }
  const exts = patterns.filter((p) => p.startsWith("*.")).map((p) => p.slice(1));
  const names = new Set(patterns.filter((p) => !p.includes("/") && !p.startsWith("*")).map((p) => p.replace(/\/$/, "")));
  const prefixes = patterns.filter((p) => p.includes("/")).map((p) => p.replace(/^\//, "").replace(/\/$/, ""));
  return (rel) => {
    const base = path5.basename(rel);
    if (names.has(base)) return true;
    if (exts.some((e) => rel.endsWith(e))) return true;
    if (prefixes.some((p) => rel === p || rel.startsWith(p + "/"))) return true;
    return false;
  };
}
function isBinaryPath(rel) {
  const lower = rel.toLowerCase();
  if (SKIP_FILES.has(path5.basename(rel))) return true;
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
    const absDir = path5.join(root, relDir);
    let entries;
    try {
      entries = fs7.readdirSync(absDir, { withFileTypes: true });
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
function indexEndpoint(apiUrl2, suffix) {
  const base = apiUrl2.endsWith("/v1") ? apiUrl2 : `${apiUrl2}/v1`;
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
async function indexCodebase(apiUrl2, apiSecret2, projectName, rootDir, logger2) {
  const ignored = loadGitignore(rootDir);
  const relPaths = walk(rootDir, ignored);
  logger2.info(`Scanning ${relPaths.length} files in ${rootDir}`);
  const manifest = [];
  const contentByPath = /* @__PURE__ */ new Map();
  for (const rel of relPaths) {
    try {
      const stat = fs7.statSync(path5.join(rootDir, rel));
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = fs7.readFileSync(path5.join(rootDir, rel), "utf8");
      if (content.includes("\0")) continue;
      contentByPath.set(rel, content);
      manifest.push({ path: rel, hash: createHash2("sha256").update(content, "utf8").digest("hex") });
    } catch {
    }
  }
  const plan = await post(indexEndpoint(apiUrl2, "/index/plan"), apiSecret2, { projectName, manifest });
  const toUpload = plan.toUpload || [];
  logger2.info(`${manifest.length - toUpload.length} unchanged, ${toUpload.length} to upload, ${(plan.toDelete || []).length} to prune`);
  let uploaded = 0;
  let chunks = 0;
  for (let i = 0; i < toUpload.length; i += UPLOAD_BATCH) {
    const batch = toUpload.slice(i, i + UPLOAD_BATCH).map((p) => ({ path: p, content: contentByPath.get(p) || "" }));
    const r = await post(indexEndpoint(apiUrl2, "/index"), apiSecret2, { projectName, files: batch });
    uploaded += r.indexed || 0;
    chunks += r.totalChunks || 0;
    logger2.info(`Indexed ${Math.min(i + UPLOAD_BATCH, toUpload.length)}/${toUpload.length}`);
  }
  const allPaths = manifest.map((m) => m.path);
  const pruneRes = await post(indexEndpoint(apiUrl2, "/index"), apiSecret2, { projectName, files: [], prune: true, allPaths });
  const pruned = (pruneRes.pruned || []).length;
  return { scanned: manifest.length, uploaded, unchanged: manifest.length - toUpload.length, pruned, chunks };
}

// ../../src/local/mcp-server.ts
import path8 from "path";
import fs10 from "fs";

// ../../src/local/local-search.ts
import fs8 from "fs/promises";
import fsSync2 from "fs";
import path6 from "path";
import { spawnSync } from "child_process";
var SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "dist",
  "build",
  "out",
  ".output",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  "env",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".axis",
  "history",
  ".DS_Store"
]);
var SKIP_EXTENSIONS = /* @__PURE__ */ new Set([
  // Binary / media
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".mp3",
  ".mp4",
  ".wav",
  ".webm",
  ".ogg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".br",
  // Compiled / generated
  ".pyc",
  ".pyo",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".class",
  ".jar",
  ".war",
  ".wasm",
  // Lock files (huge, not useful for search)
  ".lock"
]);
var SKIP_FILENAMES = /* @__PURE__ */ new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  ".DS_Store",
  "Thumbs.db"
]);
var STOP_WORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "it",
  "they",
  "them",
  "their",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "where",
  "when",
  "how",
  "why",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "up",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "if",
  "then",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "some",
  "any",
  "there",
  "here",
  "just",
  "also",
  "very",
  "really",
  "quite"
]);
var MAX_FILE_SIZE = 256 * 1024;
var MAX_RESULTS = 20;
var CONTEXT_LINES = 2;
var MAX_MATCHES_PER_FILE = 6;
function extractKeywords(query) {
  const words = query.toLowerCase().replace(/[^\w\s\-_.]/g, " ").split(/\s+/).filter((w) => w.length >= 2);
  const filtered = words.filter((w) => !STOP_WORDS.has(w));
  const result = filtered.length > 0 ? filtered : words;
  return [...new Set(result)];
}
var PROJECT_ROOT_MARKERS = [
  ".git",
  ".axis",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "Gemfile",
  "pom.xml",
  "tsconfig.json",
  ".cursorrules",
  "AGENTS.md"
];
function detectProjectRoot(startDir) {
  let current = path6.resolve(startDir);
  const root = path6.parse(current).root;
  while (current !== root) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        fsSync2.accessSync(path6.join(current, marker));
        return current;
      } catch {
      }
    }
    const parent = path6.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return startDir;
}
async function walkDir(dir, maxDepth = 12) {
  const results = [];
  async function recurse(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs8.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") {
        if (SKIP_DIRS.has(entry.name) || entry.isDirectory()) continue;
      }
      const fullPath = path6.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await recurse(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (SKIP_FILENAMES.has(entry.name)) continue;
        const ext = path6.extname(entry.name).toLowerCase();
        if (SKIP_EXTENSIONS.has(ext)) continue;
        try {
          const stat = await fs8.stat(fullPath);
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
async function searchFile(filePath, rootDir, keywords) {
  let content;
  try {
    content = await fs8.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const contentLower = content.toLowerCase();
  const relativePath = path6.relative(rootDir, filePath);
  const matchedKeywords = keywords.filter((kw) => contentLower.includes(kw));
  if (matchedKeywords.length === 0) return null;
  const coverage = matchedKeywords.length / keywords.length;
  if (coverage < 0.2) return null;
  const lines = content.split("\n");
  let score = coverage * coverage * matchedKeywords.length;
  const relLower = relativePath.toLowerCase();
  for (const kw of keywords) {
    if (relLower.includes(kw)) {
      score += 3;
    }
  }
  const matchingLineIndices = [];
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    if (matchedKeywords.some((kw) => lineLower.includes(kw))) {
      matchingLineIndices.push(i);
    }
  }
  let proximityBonus = 0;
  for (let i = 0; i < matchingLineIndices.length; i++) {
    const windowStart = matchingLineIndices[i];
    const windowEnd = windowStart + 10;
    const keywordsInWindow = /* @__PURE__ */ new Set();
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
  score += Math.min(matchingLineIndices.length, 20) * 0.1;
  const regions = [];
  let lastEnd = -1;
  for (const idx of matchingLineIndices) {
    if (regions.length >= MAX_MATCHES_PER_FILE) break;
    const start = Math.max(0, idx - CONTEXT_LINES);
    const end = Math.min(lines.length - 1, idx + CONTEXT_LINES);
    if (start <= lastEnd) continue;
    const regionLines = lines.slice(start, end + 1).map((line, i) => {
      const lineNum = start + i + 1;
      const marker = start + i === idx ? ">" : " ";
      return `${marker} ${lineNum.toString().padStart(4)}| ${line}`;
    }).join("\n");
    regions.push({ lineNumber: idx + 1, lines: regionLines });
    lastEnd = end;
  }
  return { filePath, relativePath, score, matchedKeywords, regions };
}
function runRipgrep(pattern, cwd) {
  const p = (pattern || "").trim();
  if (!p || p.length > 200) return [];
  const result = spawnSync("rg", [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    "3",
    // Max 3 matches per file per pattern
    "-C",
    "1",
    // 1 line context
    "--ignore-case",
    "--max-filesize",
    "256K",
    "-F",
    p,
    // Fixed string (literal) — no regex escaping needed
    "."
  ], {
    cwd,
    encoding: "utf-8",
    timeout: 8e3,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    return [];
  }
  const hits = [];
  const lines = (result.stdout || "").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(.+?):(\d+):(.+)$/);
    if (match) {
      const [, file, lineNum, content] = match;
      const relPath = path6.relative(cwd, file);
      hits.push({
        file: relPath,
        line: parseInt(lineNum, 10),
        content: content.trim(),
        pattern: p
      });
    }
  }
  return hits;
}
function ripgrepAvailable() {
  const r = spawnSync("rg", ["--version"], { encoding: "utf-8" });
  return !r.error && r.status === 0;
}
async function warpgrepSearch(query, cwd) {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) {
    const tokens = query.replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length >= 2);
    if (tokens.length === 0) return "";
    keywords.push(tokens[0]);
  }
  const allHits = [];
  const seen = /* @__PURE__ */ new Set();
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
  const byFile = /* @__PURE__ */ new Map();
  for (const h of allHits) {
    const list = byFile.get(h.file) || [];
    if (list.length < MAX_MATCHES_PER_FILE) list.push(h);
    byFile.set(h.file, list);
  }
  const lines = [];
  lines.push(`Found ${allHits.length} match(es) via ripgrep (keywords: ${keywords.join(", ")})
`);
  lines.push("\u2550".repeat(60) + "\n");
  const sortedFiles = [...byFile.keys()].sort();
  for (const relPath of sortedFiles.slice(0, MAX_RESULTS)) {
    const hits = byFile.get(relPath);
    lines.push(`${relPath}
`);
    for (const h of hits) {
      lines.push(`   ${h.line.toString().padStart(4)}| ${h.content}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
async function localSearch(query, rootDir) {
  const q = typeof query === "string" ? query.trim() : "";
  const rawCwd = rootDir || process.cwd();
  const cwd = detectProjectRoot(rawCwd);
  const keywords = extractKeywords(q);
  if (cwd !== rawCwd) {
    logger.info(`[localSearch] Detected project root: ${cwd} (CWD was: ${rawCwd})`);
  }
  const hasTerms = keywords.length > 0 || q.replace(/[^\w\s]/g, " ").split(/\s+/).some((w) => w.length >= 2);
  if (!hasTerms) {
    return "Could not extract meaningful search terms from the query. Try being more specific (e.g. 'authentication middleware' instead of 'how does it work').";
  }
  logger.info(`[localSearch] Query: "${q}" \u2192 Keywords: [${keywords.join(", ")}] in ${cwd}`);
  const useRipgrep = ripgrepAvailable();
  const [rgResults, keyResults] = await Promise.all([
    useRipgrep ? warpgrepSearch(q, cwd) : Promise.resolve(""),
    (async () => {
      const kws2 = keywords.length > 0 ? keywords : q.replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length >= 2).slice(0, 5);
      if (kws2.length === 0) return "";
      const files = await walkDir(cwd);
      logger.info(`[localSearch] Scanning ${files.length} files (keyword search)`);
      const BATCH_SIZE = 50;
      const allMatches = [];
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map((f) => searchFile(f, cwd, kws2)));
        for (const r of results) {
          if (r) allMatches.push(r);
        }
      }
      allMatches.sort((a, b) => b.score - a.score);
      const topMatches = allMatches.slice(0, MAX_RESULTS);
      if (topMatches.length === 0) return "";
      let out = `Found ${allMatches.length} matching file${allMatches.length === 1 ? "" : "s"} (showing top ${topMatches.length}, searched ${files.length} files)
`;
      out += `Keywords: ${kws2.join(", ")}
`;
      out += "\u2550".repeat(60) + "\n\n";
      for (const match of topMatches) {
        out += `${match.relativePath}
`;
        out += `   Keywords matched: ${match.matchedKeywords.join(", ")} | Score: ${match.score.toFixed(1)}
`;
        if (match.regions.length > 0) {
          out += "   \u2500\u2500\u2500\u2500\u2500\n";
          for (const region of match.regions) {
            out += region.lines.split("\n").map((l) => `   ${l}`).join("\n") + "\n";
            if (region !== match.regions[match.regions.length - 1]) out += "   ...\n";
          }
        }
        out += "\n";
      }
      return out;
    })()
  ]);
  const rgHasResults = rgResults && !rgResults.startsWith("Found 0");
  const keyHasResults = keyResults && keyResults.length > 50;
  if (rgHasResults && keyHasResults) {
    return rgResults + "\n\n--- Also from keyword search ---\n\n" + keyResults;
  }
  if (rgHasResults) return rgResults;
  if (keyHasResults) return keyResults;
  const kws = keywords.length > 0 ? keywords : q.replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length >= 2).slice(0, 5);
  if (kws.length >= 3) {
    const fallbackKws = kws.slice(0, 2);
    const files = await walkDir(cwd);
    const fallbackMatches = [];
    for (let i = 0; i < files.length; i += 50) {
      const batch = files.slice(i, i + 50);
      const results = await Promise.all(batch.map((f) => searchFile(f, cwd, fallbackKws)));
      for (const r of results) {
        if (r) fallbackMatches.push(r);
      }
    }
    if (fallbackMatches.length > 0) {
      fallbackMatches.sort((a, b) => b.score - a.score);
      const top = fallbackMatches.slice(0, MAX_RESULTS);
      let out = `Found ${fallbackMatches.length} matching file${fallbackMatches.length === 1 ? "" : "s"} (fallback: fewer keywords, showing top ${top.length})
`;
      out += `Keywords: ${fallbackKws.join(", ")} (original: ${kws.join(", ")})
`;
      out += "\u2550".repeat(60) + "\n\n";
      for (const match of top) {
        out += `\u{1F4C4} ${match.relativePath}
`;
        out += `   Keywords matched: ${match.matchedKeywords.join(", ")} | Score: ${match.score.toFixed(1)}
`;
        if (match.regions.length > 0) {
          out += "   \u2500\u2500\u2500\u2500\u2500\n";
          for (const region of match.regions) {
            out += region.lines.split("\n").map((l) => `   ${l}`).join("\n") + "\n";
            if (region !== match.regions[match.regions.length - 1]) out += "   ...\n";
          }
        }
        out += "\n";
      }
      return out;
    }
  }
  return `No matches found for: "${q}" (searched for: ${kws.join(", ") || "query terms"}).
Try different terms or check if the code exists in this project.`;
}

// ../../src/local/workspace-watch.ts
import fs9 from "fs";
import path7 from "path";
var PATH_ARG_KEYS = ["filePath", "filePaths"];
function existingDirectory2(candidate) {
  if (!candidate) return void 0;
  const resolved = path7.resolve(candidate);
  try {
    return fs9.statSync(resolved).isDirectory() ? resolved : void 0;
  } catch {
    return void 0;
  }
}
function pathArguments(args) {
  if (!args || typeof args !== "object") return [];
  const record = args;
  const out = [];
  for (const key of PATH_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string") out.push(value);
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") out.push(item);
    }
  }
  return out.filter((p) => path7.isAbsolute(p));
}
function disjointRoots(a, b) {
  const ra = path7.resolve(a);
  const rb = path7.resolve(b);
  return ra !== rb && !ra.startsWith(rb + path7.sep) && !rb.startsWith(ra + path7.sep);
}
function detectWorkspaceSwitch(currentRoot, args, env = process.env) {
  const active = path7.resolve(currentRoot);
  const hint = env.AXIS_WORKSPACE_ROOT || env.SUPERSET_WORKSPACE_PATH || env.SUPERSET_ROOT_PATH;
  const hintDir = existingDirectory2(hint);
  if (hintDir) {
    const hintRoot = path7.resolve(findProjectRoot(hintDir));
    if (hintRoot !== active) {
      return {
        root: hintRoot,
        projectName: deriveProjectName(hintRoot),
        reason: "runtime-hint",
        trigger: hint
      };
    }
    return null;
  }
  for (const candidate of pathArguments(args)) {
    const dir = existingDirectory2(candidate) ?? existingDirectory2(path7.dirname(candidate));
    if (!dir) continue;
    const candidateRoot = path7.resolve(findProjectRoot(dir));
    if (disjointRoots(candidateRoot, active)) {
      return {
        root: candidateRoot,
        projectName: deriveProjectName(candidateRoot),
        reason: "file-path",
        trigger: candidate
      };
    }
  }
  return null;
}
function describeSwitch(s) {
  return [
    `\u26A0 Workspace switched automatically: now scoped to project "${s.projectName}" at ${s.root}.`,
    `Trigger: ${s.reason} (${s.trigger}).`,
    `Locks, jobs, and the notepad now refer to this project.`
  ].join(" ");
}

// ../../src/local/team-updates.ts
var MAX_TRAILER_CHARS = 1500;
var TeamUpdateTracker = class {
  /** agentId → notepad length already delivered to that agent. */
  cursors = /* @__PURE__ */ new Map();
  /**
   * Return notepad content appended by other agents since `agentId`'s last
   * drain, or null when there is nothing new for them.
   *
   * The first call only establishes the cursor and returns null — a freshly
   * joined agent should not be greeted with the whole session history.
   */
  drain(agentId, notepad) {
    const last = this.cursors.get(agentId);
    this.cursors.set(agentId, notepad.length);
    if (last === void 0) return null;
    if (notepad.length <= last) return null;
    const foreign = [];
    let skippingOwnEntry = false;
    for (const line of notepad.slice(last).split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const isEntryHead = !line.startsWith(" ") && !line.startsWith("	");
      if (isEntryHead) skippingOwnEntry = trimmed.includes(agentId);
      if (!skippingOwnEntry) foreign.push(line);
    }
    if (foreign.length === 0) return null;
    return clipTail(foreign.join("\n"));
  }
  /** Forget all cursors (project switch / session finalize). */
  reset() {
    this.cursors.clear();
  }
};
function clipTail(text) {
  if (text.length <= MAX_TRAILER_CHARS) return text;
  const tail = text.slice(-MAX_TRAILER_CHARS);
  const firstNewline = tail.indexOf("\n");
  return "\u2026 (earlier updates truncated)\n" + (firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail);
}
function formatTeamUpdates(delta) {
  return `\u{1F4E2} Team activity since your last call:
${delta}`;
}

// ../../src/local/mcp-server.ts
if (process.env.SHARED_CONTEXT_API_URL || process.env.AXIS_API_KEY) {
  logger.info("Using configuration from MCP client (mcp.json)");
} else {
  const cwd = process.cwd();
  const possiblePaths = [
    path8.join(cwd, ".env.local"),
    path8.join(cwd, "..", ".env.local"),
    path8.join(cwd, "..", "..", ".env.local"),
    path8.join(cwd, "shared-context", ".env.local"),
    path8.join(cwd, "..", "shared-context", ".env.local")
  ];
  let envLoaded = false;
  for (const envPath of possiblePaths) {
    try {
      if (fs10.existsSync(envPath)) {
        logger.info(`[Fallback] Loading .env.local from: ${envPath}`);
        dotenv2.config({ path: envPath });
        envLoaded = true;
        break;
      }
    } catch (_e) {
    }
  }
  if (!envLoaded) {
    logger.warn("No configuration found from MCP client (mcp.json) or .env.local");
    logger.info("MCP server will run the open-core coordination tools locally");
  }
}
logger.info("=== Axis MCP Server Starting ===");
logger.info("Environment check:", {
  hasSHARED_CONTEXT_API_URL: !!process.env.SHARED_CONTEXT_API_URL,
  hasAXIS_API_KEY: !!process.env.AXIS_API_KEY,
  hasSHARED_CONTEXT_API_SECRET: !!process.env.SHARED_CONTEXT_API_SECRET,
  hasNEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
  hasSUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  PROJECT_NAME: process.env.PROJECT_NAME || "default"
});
var apiSecret = process.env.AXIS_API_KEY || process.env.SHARED_CONTEXT_API_SECRET || process.env.AXIS_API_SECRET;
var configuredApiUrl = process.env.SHARED_CONTEXT_API_URL || process.env.AXIS_API_URL;
var apiUrl = configuredApiUrl || (apiSecret ? "https://useaxis.dev/api/v1" : void 0);
var useRemoteApiOnly = !!apiUrl && !!apiSecret;
if (useRemoteApiOnly) {
  logger.info("Running in REMOTE API mode - Supabase credentials not needed locally.");
  logger.info(`Remote API: ${apiUrl}`);
  logger.info(`API Key: ${apiSecret ? apiSecret.substring(0, 15) + "..." : "NOT SET"}`);
} else if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  logger.warn("No remote API configured and Supabase credentials missing. Running in local/ephemeral mode.");
} else {
  logger.info("Running in DIRECT SUPABASE mode (development).");
}
logger.info("ContextManager config:", {
  apiUrl,
  hasApiSecret: !!apiSecret,
  source: useRemoteApiOnly ? "MCP config (mcp.json)" : "default/fallback"
});
var manager = new ContextManager(apiUrl, apiSecret);
logger.info("NerveCenter config:", {
  useRemoteApiOnly,
  supabaseUrl: useRemoteApiOnly ? "DISABLED (using remote API)" : process.env.NEXT_PUBLIC_SUPABASE_URL ? "SET" : "NOT SET",
  supabaseKey: useRemoteApiOnly ? "DISABLED (using remote API)" : process.env.SUPABASE_SERVICE_ROLE_KEY ? "SET" : "NOT SET",
  projectName: process.env.PROJECT_NAME || "default"
});
var nerveCenter = new NerveCenter(manager, {
  supabaseUrl: useRemoteApiOnly ? null : process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabaseServiceRoleKey: useRemoteApiOnly ? null : process.env.SUPABASE_SERVICE_ROLE_KEY,
  // Leave undefined when unset so NerveCenter auto-derives the project from the
  // working directory (and .axis/axis.json) instead of pinning to "default".
  projectName: process.env.PROJECT_NAME,
  projectRoot: process.env.AXIS_PROJECT_ROOT || process.env.SUPERSET_WORKSPACE_PATH || process.env.SUPERSET_ROOT_PATH
});
var sessionIdentity = createSessionIdentity(process.env);
var presence = new PresenceRoster();
var teamUpdates = new TeamUpdateTracker();
var TEAM_AWARE_TOOLS = /* @__PURE__ */ new Set([
  "post_job",
  "claim_job",
  "claim_next_job",
  "complete_job",
  "cancel_job",
  "list_jobs",
  "propose_file_access",
  "release_file_access",
  "verify_file_lock",
  "guarded_write",
  "list_locks",
  "update_shared_context"
]);
logger.info("=== Axis MCP Server Initialized ===");
logger.info(`Session agent identity: ${sessionIdentity.id} (${sessionIdentity.source})`);
var RECHECK_INTERVAL_MS = 30 * 60 * 1e3;
var subscription = {
  checked: false,
  valid: true,
  // Assume valid until proven otherwise (for startup)
  plan: "unknown",
  reason: "",
  checkedAt: 0
};
async function verifySubscription() {
  if (!apiSecret) {
    const hasDirectSupabase = !useRemoteApiOnly && !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (hasDirectSupabase) {
      subscription = { checked: true, valid: true, plan: "developer", reason: "Direct Supabase mode \u2014 no API key needed", checkedAt: Date.now() };
      logger.info("[subscription] Direct Supabase credentials found \u2014 developer mode, skipping verification");
      return subscription;
    }
    subscription = {
      checked: true,
      valid: true,
      plan: "local",
      reason: "Local open-core mode",
      checkedAt: Date.now()
    };
    logger.info("[subscription] No API key configured \u2014 local open-core coordination enabled");
    return subscription;
  }
  if (!apiUrl) {
    subscription = {
      checked: true,
      valid: false,
      plan: "unknown",
      reason: "api_url_missing",
      checkedAt: Date.now()
    };
    return subscription;
  }
  const verifyUrl = apiUrl.endsWith("/v1") ? `${apiUrl}/verify` : `${apiUrl}/v1/verify`;
  logger.info(`[subscription] Verifying subscription at ${verifyUrl}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1e4);
  try {
    const response = await fetch(verifyUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiSecret}`
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await response.json();
    logger.info(`[subscription] Verify response: ${JSON.stringify(data)}`);
    if (data.valid === true) {
      subscription = {
        checked: true,
        valid: true,
        plan: data.plan || "Pro",
        reason: "",
        checkedAt: Date.now(),
        validUntil: data.validUntil
      };
    } else {
      subscription = {
        checked: true,
        valid: false,
        plan: data.plan || "Free",
        reason: data.reason || "subscription_invalid",
        checkedAt: Date.now()
      };
      logger.warn(`[subscription] Subscription NOT valid: ${data.reason}`);
    }
  } catch (e) {
    clearTimeout(timeout);
    logger.warn(`[subscription] Verification failed (network): ${e.message}`);
    if (!subscription.checked) {
      subscription = {
        checked: true,
        valid: true,
        // Grace period
        plan: "unverified",
        reason: "Verification endpoint unreachable \u2014 grace period active",
        checkedAt: Date.now()
      };
      logger.warn("[subscription] First check failed \u2014 allowing grace period");
    }
  }
  return subscription;
}
function isSubscriptionStale() {
  return Date.now() - subscription.checkedAt > RECHECK_INTERVAL_MS;
}
function getSubscriptionBlockMessage() {
  if (subscription.reason === "no_api_key") {
    return [
      "\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
      "  Axis API key required",
      "",
      "  No API key found. Axis requires an active subscription",
      "  and a valid API key to operate.",
      "",
      "  1. Sign up or log in at https://useaxis.dev",
      "  2. Subscribe to Axis Pro",
      "  3. Generate an API key from the dashboard",
      "  4. Add AXIS_API_KEY to your mcp.json configuration",
      "  5. Restart your IDE",
      "\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550"
    ].join("\n");
  }
  return [
    "\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
    "  Axis Pro subscription required",
    "",
    `  Status: ${subscription.reason || "subscription_expired"}`,
    `  Current plan: ${subscription.plan}`,
    "",
    "  Your Axis Pro subscription has expired or is inactive.",
    "  All Axis MCP tools are disabled until the subscription is renewed.",
    "",
    "  \u2192 Renew at https://useaxis.dev/dashboard",
    "  \u2192 After renewing, restart your IDE to re-verify.",
    "\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550"
  ].join("\n");
}
var ragEngine;
if (!useRemoteApiOnly && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  ragEngine = new RagEngine(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.OPENAI_API_KEY || ""
  );
  logger.info("Local RAG Engine initialized.");
}
async function ensureFileSystem() {
  try {
    const fs11 = await import("fs/promises");
    const path9 = await import("path");
    const fsSync3 = await import("fs");
    const cwd = process.cwd();
    logger.info(`Server CWD: ${cwd}`);
    const historyDir = path9.join(cwd, "history");
    await fs11.mkdir(historyDir, { recursive: true }).catch(() => {
    });
    const axisDir = path9.join(cwd, ".axis");
    const axisInstructions = path9.join(axisDir, "instructions");
    const legacyInstructions = path9.join(cwd, "agent-instructions");
    if (fsSync3.existsSync(legacyInstructions) && !fsSync3.existsSync(axisDir)) {
      logger.info("Using legacy agent-instructions directory");
    } else {
      await fs11.mkdir(axisInstructions, { recursive: true }).catch(() => {
      });
      const defaults = [
        ["context.md", `# Project Context

## Overview
<!-- THIS FILE IS PART OF THE PROJECT SOUL. If it still contains placeholders, agents MUST fill it before doing any other work.
How to fill: use search_codebase to explore the repo, then call update_project_soul(context: "...your content...") to replace this placeholder.
If the repo is empty: ask the user what the project is about, then call update_project_soul with their answer.
Do not proceed with other tasks until this file has real content. -->

## Architecture
<!-- Stack, high-level design, and key systems -->

## Core Features
<!-- List main capabilities of this project -->
`],
        ["conventions.md", `# Coding Conventions

## Language & Style
<!-- Your language, framework, and styling guidelines -->

## Agent Behavioral Norms (MANDATORY)

### Autonomous Execution
Agents MUST execute the full Axis workflow without being told:
- NEVER wait for the user to say "use Axis" or "post a job." Just do it.
- NEVER pause after analysis to ask permission. Identify issues \u2192 start fixing immediately.
- NEVER leave locks or jobs dangling. Complete jobs and finalize sessions automatically.
- IMMEDIATELY call get_project_soul as the first action in every session.

### Plan Before Write
Activate Axis orchestration automatically when ANY condition is true: 2+ files, 2+ independent workstreams, a shared-contract change, refactor/migration/audit, meaningful production risk, or likely duration over 10 minutes.
Every complex task MUST follow: list_jobs/list_locks \u2192 post_job \u2192 claim_job or claim_next_job \u2192 propose_file_access \u2192 (edit) \u2192 complete_job.
Skip job creation ONLY for isolated one-line fixes; project-soul loading still applies.

### Releasing Locks (CRITICAL)
Every file you lock MUST be unlocked before your session ends. Dangling locks block all other agents.
- complete_job releases locks for that job. Call it IMMEDIATELY after each task.
- finalize_session clears ALL remaining locks. Call it before you stop responding.
- NEVER end a session while holding locks. Self-check: "Did I call finalize_session?"

### Session Cleanup (MANDATORY)
- complete_job IMMEDIATELY after finishing each task \u2014 this is how locks get released.
- update_shared_context after claims, design decisions, shared-contract changes, blockers, test results, and handoffs.
- list_jobs and list_locks again after interruptions or long waits before resuming edits.
- finalize_session when the user's request is fully complete \u2014 do not wait to be told. This clears all remaining locks.

### Force-Unlock Policy
force_unlock is a LAST RESORT \u2014 only for locks >25 min old from a crashed agent. Always give a reason.
`],
        ["activity.md", "# Activity Log\n\n"]
      ];
      for (const [file, content] of defaults) {
        const p = path9.join(axisInstructions, file);
        try {
          await fs11.access(p);
        } catch {
          await fs11.writeFile(p, content);
          logger.info(`Created default context file: ${file}`);
        }
      }
    }
  } catch (error) {
    logger.warn("Could not initialize local file system. Persistence features (context.md) may be disabled.", { error: String(error) });
  }
}
var server = new Server(
  {
    name: "shared-context-server",
    version: "1.0.0"
  },
  {
    capabilities: {
      resources: {},
      tools: {}
    }
  }
);
var READ_CONTEXT_TOOL = "read_context";
var UPDATE_CONTEXT_TOOL = "update_context";
var SEARCH_CONTEXT_TOOL = "search_codebase";
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    const files = await manager.listFiles();
    const resources = [
      {
        uri: "mcp://context/current",
        name: "Live Session Context",
        mimeType: "text/markdown",
        description: "The realtime state of the Nerve Center (Notepad + Locks)"
      },
      ...files
    ];
    logger.info(`[ListResources] Returning ${resources.length} resources to MCP client`);
    return { resources };
  } catch (error) {
    logger.error("Error listing resources", error);
    return { resources: [] };
  }
});
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  try {
    if (uri === "mcp://context/current") {
      return {
        contents: [{
          uri,
          mimeType: "text/markdown",
          text: await nerveCenter.getCoreContext()
        }]
      };
    }
    let fileName = uri;
    if (uri.startsWith("context://local/")) {
      fileName = uri.replace("context://local/", "");
    } else if (uri.startsWith("context://docs/")) {
      fileName = uri.replace("context://", "");
    }
    const content = await manager.readFile(fileName);
    return {
      contents: [{
        uri,
        mimeType: "text/markdown",
        text: content
      }]
    };
  } catch (_error) {
    throw new Error(`Resource not found: ${uri}`);
  }
});
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    {
      name: READ_CONTEXT_TOOL,
      description: "**READ THIS FIRST** to understand the project's architecture, coding conventions, and active state.\n- Returns the content of core context files like `context.md` (Project Goals), `conventions.md` (Style Guide), or `activity.md`.\n- Usage: Call with `filename='context.md'` effectively.\n- Note: If you need the *current* runtime state (active locks, jobs), use the distinct resource `mcp://context/current` instead.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "The name of the file to read (e.g., 'context.md', 'conventions.md')" }
        },
        required: ["filename"]
      }
    },
    {
      name: UPDATE_CONTEXT_TOOL,
      description: "**APPEND OR OVERWRITE** any shared context file.\n- To update the project soul (context.md / conventions.md), prefer `update_project_soul` instead \u2014 it handles both files in one call.\n- Use this tool for other context files (e.g., `activity.md`) or when you need to append to a file.\n- For short-term updates (like 'I just fixed bug X'), use `update_shared_context` (Notepad) instead.\n- Supports `append: true` (default: false) to add to the end of a file.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "File to update (e.g. 'activity.md'). For soul files, prefer update_project_soul instead." },
          content: { type: "string", description: "The new content to write or append." },
          append: { type: "boolean", description: "Whether to append to the end of the file (true) or overwrite it (false). Default: false." }
        },
        required: ["filename", "content"]
      }
    },
    // NOTE: search_codebase is defined further below with the updated
    // "CODE INTELLIGENCE SEARCH" description. The older entry that used the
    // SEARCH_CONTEXT_TOOL constant lived here and had the same `name`, which
    // caused MCP clients to dedupe and lose a tool slot (16 visible instead
    // of 17). Removed; the dispatch handler at the bottom still references
    // SEARCH_CONTEXT_TOOL since the constant resolves to the same string.
    // --- Billing & Usage ---
    {
      name: "get_subscription_status",
      description: "**BILLING CHECK**: Returns the user's subscription tier (Pro vs Free), Stripe customer ID, and current period end.\n- If no email is provided, returns the subscription status of the current API key owner.\n- Critical for gating features behind paywalls.",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string", description: "Optional. User email to check. If omitted, checks the subscription of the current API key owner." }
        }
      }
    },
    {
      name: "get_usage_stats",
      description: "**API USAGE**: Returns token usage and request counts.\n- If no email is provided, returns usage for the current API key owner.\n- Useful for debugging rate limits or explaining quota usage to users.",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string", description: "Optional. User email to check. If omitted, checks usage of the current API key owner." }
        }
      }
    },
    {
      name: "search_codebase",
      description: "**CODE INTELLIGENCE SEARCH** \u2014 does what plain grep can't: returns ranked `file:line` hits PLUS `related` files that historically co-change with each hit, PLUS `definitions` of what the top result calls.\n- Use for 'where is X', 'how is Y done', anything before refactoring, and any time you need to know what code is structurally connected to a match (not just textually present).\n- Hybrid: semantic + full-text + trigram, reranked. Falls back to instant local search offline.\n- For pure literal-string lookups (a specific token or filename), grep is fine \u2014 this tool's edge is the related/definitions enrichment.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language question or code query (symbol, behavior, or 'where is X done')." }
        },
        required: ["query"]
      }
    },
    {
      name: "index_codebase",
      description: "**INDEX THE REPO FOR SEARCH**: Walk the project, content-hash every file, and sync changed files into the searchable index so `search_codebase`/`deep_search` work and stay fresh.\n- Incremental: unchanged files are skipped (no re-embedding), deleted files are pruned. Safe and cheap to run often.\n- Run this once to set up search on a new project, and after large changes (e.g. a git pull) to refresh. Single-file edits are picked up by `index_file`.\n- Respects .gitignore and skips binaries/large files. Takes no arguments \u2014 it indexes the current project root.",
      inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
      name: "search_docs",
      description: "**DOCUMENTATION SEARCH**: Searches the official Axis documentation (if indexed).\n- Use this when you need info on *how* to use Axis features, not just codebase structure.\n- Falls back to local RAG search if the remote API is unavailable.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query." }
        },
        required: ["query"]
      }
    },
    // --- Decision & Orchestration ---
    {
      name: "propose_file_access",
      description: "**CRITICAL: REQUEST FILE LOCK** \u2014 call this before EVERY file edit, no exceptions.\n- Returns `GRANTED` if safe to proceed, `REQUIRES_ORCHESTRATION` if another agent holds the lock, or `REJECTED` if you tried to lock a directory.\n- **Lock individual files, not directories.** Directory locks block parallel work and are rejected.\n- Paths can be absolute or relative \u2014 they're normalized against the project root.\n- Required: `intent` (descriptive \u2014 'Refactor auth to use JWT', NOT 'editing file') plus `filePath` or `filePaths`. `agentId` is optional (defaults to your session identity).\n- Editing several files? Pass `filePaths` to lock them in ONE call \u2014 all-or-nothing, so a partial batch never blocks others.\n- Locks expire after 30 minutes. Use `force_unlock` only as a last resort for crashed agents.\n- **Every lock MUST be released.** `complete_job` releases the locks for that job; `finalize_session` releases everything. Dangling locks block all other agents.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Optional \u2014 defaults to this session's unique identity." },
          filePath: { type: "string", description: "One file to lock. Use `filePaths` instead for a multi-file batch." },
          filePaths: { type: "array", items: { type: "string" }, description: "Lock several files in one call (all-or-nothing: on any denial, locks granted earlier in the batch are released)." },
          intent: { type: "string" },
          userPrompt: { type: "string", description: "Optional. The user prompt that triggered this lock, for audit trails. Server captures it best-effort if omitted." }
        },
        required: ["intent"]
      }
    },
    {
      name: "release_file_access",
      description: "**RELEASE YOUR LOCK**: Release one file lock as soon as you no longer need it.\n- Use this before a job is complete when another agent can safely continue on the file.\n- Only the owning agent can release the lock; use `force_unlock` only for a crashed agent.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Optional \u2014 defaults to this session's unique identity." },
          filePath: { type: "string" }
        },
        required: ["filePath"]
      }
    },
    {
      name: "list_locks",
      description: "**INSPECT ACTIVE LOCKS**: Return current file locks, owners, intents, and timestamps.\n- Call before planning overlapping work or when a lock conflict needs coordination.",
      inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
      name: "verify_file_lock",
      description: "**TAMPER CHECK BEFORE WRITING**: Confirm a file you hold a lock on hasn't changed since the lock was granted.\n- Locks are advisory \u2014 another process can still edit the file. Call this right before overwriting to avoid clobbering concurrent changes.\n- Returns `OK` (unchanged), `CONFLICT` (modified/deleted \u2014 re-read before writing), `NO_LOCK`, or `UNKNOWN` (no fingerprint recorded).",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Optional \u2014 defaults to this session's unique identity." },
          filePath: { type: "string" }
        },
        required: ["filePath"]
      }
    },
    {
      name: "list_agents",
      description: "**WHO'S ONLINE**: List agents currently active or idle on this project.\n- Use to see your team before posting jobs \u2014 idle workers started early show up here, so you don't have to make the user wait for jobs before launching agents.\n- Returns each agent's status (active/idle), last activity, and last-seen time.",
      inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
      name: "guarded_write",
      description: "**ENFORCED WRITE**: Write a file *through* your lock. The server writes only if you hold the lock AND the file is unchanged since you locked it \u2014 otherwise it returns NO_LOCK, DENIED (held by another agent), or CONFLICT (changed underneath you). Use this instead of a raw editor when you want Axis to actually *prevent* clobbering, not just detect it. Refreshes the lock's fingerprint on success.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Optional \u2014 defaults to this session's unique identity." },
          filePath: { type: "string" },
          content: { type: "string", description: "Full new file contents." }
        },
        required: ["filePath", "content"]
      }
    },
    {
      name: "update_shared_context",
      description: "**LIVE NOTEPAD**: The project's short-term working memory.\n- **ALWAYS** call this after completing a significant step (e.g., 'Fixed bug in auth.ts', 'Ran tests, all passed').\n- This content is visible to *all* other agents immediately.\n- Think of this as a team chat or 'standup' update.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Optional \u2014 defaults to this session's unique identity." },
          text: { type: "string" }
        },
        required: ["text"]
      }
    },
    // --- Permanent Memory ---
    {
      name: "finalize_session",
      description: "**MANDATORY SESSION CLEANUP** \u2014 call this automatically when the user's request is fully complete.\n- Archives the current Live Notepad to a permanent session log.\n- **Clears ALL active file locks** and completed jobs. This is your safety net to ensure no dangling locks.\n- Resets the Live Notepad for the next session.\n- Do NOT wait for the user to say 'we are done.' When all tasks are finished, call this yourself.\n- **CRITICAL**: You MUST call this before ending ANY session. Failing to do so leaves file locks that block all other agents.",
      inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
      name: "get_project_soul",
      description: "**MANDATORY FIRST CALL**: Returns the project's goals, architecture, conventions, and active state.\n- Combines `context.md` (project goals/architecture) and `conventions.md` (coding standards/norms) into a single prompt.\n- You MUST call this as your FIRST action in every new session or task \u2014 before reading files, before responding to the user, before anything else.\n- If the project soul is not yet filled (you'll see a 'MANDATORY: Project soul is not yet filled' message), you MUST fill it before any other work:\n  1. Use `search_codebase` to explore the repo and infer project details.\n  2. Call `update_project_soul` with `context` and/or `conventions` params to populate the soul in one call.\n  3. If there is nothing to search, ask the user what the project is about, then call `update_project_soul`.\n- Skipping this call means you are working without context and will make wrong decisions.",
      inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
      name: "update_project_soul",
      description: "**UPDATE THE PROJECT SOUL** \u2014 write project context and/or conventions in a single call.\n- The project soul consists of `context.md` (goals, architecture, core features) and `conventions.md` (coding standards, agent norms).\n- Provide `context` to update `context.md`, `conventions` to update `conventions.md`, or both.\n- Use this when `get_project_soul` says the soul is unfilled, or whenever you need to update long-term project knowledge.\n- This replaces the file contents entirely (not append). For appending, use `update_context` instead.",
      inputSchema: {
        type: "object",
        properties: {
          context: { type: "string", description: "Full content for context.md (project overview, architecture, core features, deployment). Omit to leave unchanged." },
          conventions: { type: "string", description: "Full content for conventions.md (language standards, styling, code patterns, agent norms). Omit to leave unchanged." }
        },
        required: []
      }
    },
    {
      name: "switch_project",
      description: "**SWITCH PROJECT**: Rebind the live MCP session to another workspace without reconnecting.\n- Use this when you move from one repository to another inside the same client session.\n- If `projectRoot` is omitted, the server re-detects from the current runtime hints.",
      inputSchema: {
        type: "object",
        properties: {
          projectRoot: { type: "string", description: "Absolute path to the target repository root." },
          projectName: { type: "string", description: "Optional explicit project name override." }
        },
        required: []
      }
    },
    // --- Job Board (Task Orchestration) ---
    {
      name: "post_job",
      description: "**CREATE TICKET**: Post a new task to the Job Board.\n- Call this IMMEDIATELY when you receive a non-trivial task (2+ files, new features, refactors). Do not wait to be asked.\n- Break work into trackable jobs BEFORE you start coding.\n- Supports `dependencies` (list of other Job IDs that must be done first).\n- Priority: low, medium, high, critical.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
          dependencies: { type: "array", items: { type: "string" }, description: "Array of Job IDs that must be completed before this job can be claimed." }
        },
        required: ["title", "description"]
      }
    },
    {
      name: "list_jobs",
      description: "**INSPECT THE JOB BOARD**: Return all current jobs with status, priority, owner, dependencies, and timestamps.\n- Use before dividing work across agents or when you need to claim a specific ticket.",
      inputSchema: {
        type: "object",
        properties: {
          includeCompleted: {
            type: "boolean",
            description: "Include done and cancelled jobs. Default: false."
          }
        },
        required: []
      }
    },
    {
      name: "cancel_job",
      description: "**KILL TICKET**: Cancel a job that is no longer needed.\n- Requires `jobId` and a `reason`.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string" },
          reason: { type: "string" }
        },
        required: ["jobId", "reason"]
      }
    },
    {
      name: "force_unlock",
      description: "**ADMIN OVERRIDE**: Break a file lock.\n- **WARNING**: Only use this if a lock is clearly stale or the locking agent has crashed.\n- Will forcibly remove the lock from the database.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          reason: { type: "string" }
        },
        required: ["filePath", "reason"]
      }
    },
    {
      name: "claim_next_job",
      description: "**CLAIM WORK**: Claim the next job from the Job Board before starting it.\n- You MUST claim a job before editing files for that job.\n- Respects priority (Critical > High > ...) and dependencies (won't assign a job if its deps aren't done).\n- Returns the Job object if successful, or 'NO_JOBS_AVAILABLE'.\n- Call this immediately after posting jobs, and again after completing each job to pick up the next one.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Optional \u2014 defaults to this session's unique identity." }
        },
        required: []
      }
    },
    {
      name: "claim_job",
      description: "**CLAIM A SPECIFIC TICKET**: Atomically claim a known job by ID.\n- Prefer this over `claim_next_job` when work has been intentionally assigned or agents have disjoint scopes.\n- Rejects completed, already claimed, or dependency-blocked jobs.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Optional \u2014 defaults to this session's unique identity." },
          jobId: { type: "string" }
        },
        required: ["jobId"]
      }
    },
    {
      name: "complete_job",
      description: "**CLOSE TICKET**: Mark a job as done and release file locks.\n- Call this IMMEDIATELY after finishing each job \u2014 do not accumulate completed-but-unclosed jobs.\n- Requires `outcome` (what was done).\n- If you are not the assigned agent, you must provide the `completionKey`.\n- **This is the primary way to release file locks.** Leaving jobs open holds locks and blocks other agents.\n- REMINDER: After completing all jobs, you MUST also call `finalize_session` to clear any remaining locks.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Optional \u2014 defaults to this session's unique identity." },
          jobId: { type: "string" },
          outcome: { type: "string" },
          completionKey: { type: "string", description: "Optional key to authorize completion if not the assigned agent." }
        },
        required: ["jobId", "outcome"]
      }
    },
    {
      name: "index_file",
      description: "**UPDATE SEARCH INDEX**: Add or refresh a single file in the RAG vector database.\n- Call this immediately after creating a new file or significantly refactoring an existing one \u2014 keeps `search_codebase` results fresh.\n- Only `filePath` is required. If you omit `content`, the server reads the file from disk itself \u2014 preferred, since it avoids round-tripping large file bodies through the tool call.\n- Pass `content` explicitly only when indexing material that doesn't live on disk (e.g. in-memory generated source).",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or project-relative path." },
          content: { type: "string", description: "Optional. Omit to have the server read filePath from disk." }
        },
        required: ["filePath"]
      }
    }
  ];
  logger.info(`[ListTools] Returning ${tools.length} tools to MCP client`);
  return { tools };
});
var TOOL_LOG_PATH = process.env.AXIS_TOOL_LOG;
var TOOL_LOG_SESSION = process.env.AXIS_TOOL_LOG_SESSION || `${process.pid}-${Date.now()}`;
function recordToolCall(name, args) {
  if (!TOOL_LOG_PATH) return;
  try {
    const entry = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      session: TOOL_LOG_SESSION,
      tool: name,
      // Arg keys only, never values (privacy + log size).
      argKeys: args && typeof args === "object" ? Object.keys(args) : []
    };
    fs10.appendFileSync(TOOL_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {
  }
}
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  let captureAgent = sessionIdentity.id;
  if (args && typeof args === "object") {
    const provided = args.agentId;
    const resolvedId = sessionIdentity.resolve(
      typeof provided === "string" && provided.trim() ? provided : sessionIdentity.id
    );
    args.agentId = resolvedId;
    captureAgent = resolvedId;
    presence.seen(resolvedId, Date.now(), "active", name);
  }
  logger.info("Tool call", { name });
  recordToolCall(name, args);
  let workspaceNote;
  if (name !== "switch_project") {
    try {
      const detected = detectWorkspaceSwitch(nerveCenter.activeProjectRoot, args, process.env);
      if (detected) {
        await nerveCenter.switchProject({ root: detected.root, projectName: detected.projectName });
        teamUpdates.reset();
        workspaceNote = describeSwitch(detected);
        logger.info("Auto workspace switch", detected);
      }
    } catch (e) {
      logger.warn(`Workspace auto-switch check failed: ${e}`);
    }
  }
  const result = await nerveCenter.captureToolExecution(name, args, captureAgent, async () => {
    if (process.env.AXIS_SKIP_SUBSCRIPTION_CHECK === "1") {
    } else {
      if (isSubscriptionStale()) {
        await verifySubscription();
      }
      if (!subscription.valid) {
        logger.warn(`[subscription] Blocking tool call "${name}" \u2014 subscription invalid`);
        return {
          content: [{ type: "text", text: getSubscriptionBlockMessage() }],
          isError: true
        };
      }
    }
    if (name === READ_CONTEXT_TOOL) {
      const filename = String(args?.filename);
      try {
        const data = await manager.readFile(filename);
        return {
          content: [{ type: "text", text: data }]
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error reading file: ${err}` }],
          isError: true
        };
      }
    }
    if (name === UPDATE_CONTEXT_TOOL) {
      const filename = String(args?.filename);
      const content = String(args?.content);
      const append = Boolean(args?.append);
      try {
        await manager.updateFile(filename, content, append);
        return {
          content: [{ type: "text", text: `Updated ${filename}` }]
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error updating file: ${err}` }],
          isError: true
        };
      }
    }
    if (name === "index_codebase") {
      if (!manager.apiUrl || !manager.apiSecret) {
        return { content: [{ type: "text", text: "Indexing requires AXIS_API_KEY (and the hosted API). Not configured." }], isError: true };
      }
      try {
        const summary = await indexCodebase(
          manager.apiUrl,
          manager.apiSecret,
          nerveCenter.currentProjectName,
          process.cwd(),
          { info: (m) => logger.info(`[index_codebase] ${m}`) }
        );
        return {
          content: [{
            type: "text",
            text: `Indexed project "${nerveCenter.currentProjectName}". ${summary.uploaded} file(s) updated (${summary.chunks} chunks), ${summary.unchanged} unchanged, ${summary.pruned} pruned. search_codebase and deep_search are now up to date.`
          }]
        };
      } catch (e) {
        return { content: [{ type: "text", text: `index_codebase failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
    if (name === "index_file") {
      const filePath = String(args?.filePath);
      let content;
      if (args?.content !== void 0 && args?.content !== null) {
        content = String(args.content);
      } else {
        try {
          const projectRoot = path8.resolve(process.cwd());
          const rebased = path8.isAbsolute(filePath) ? path8.join(projectRoot, filePath.replace(/^\/+/, "")) : path8.resolve(projectRoot, filePath);
          const resolved = await fs10.promises.realpath(rebased).catch(() => rebased);
          const rel = path8.relative(projectRoot, resolved);
          if (rel.startsWith("..") || path8.isAbsolute(rel)) {
            return {
              content: [{ type: "text", text: `index_file: refusing to read ${filePath} \u2014 outside project root` }],
              isError: true
            };
          }
          const SENSITIVE = [
            /(^|\/)\.env(\.|$)/,
            // .env, .env.local, .env.production…
            /(^|\/)\.git(\/|$)/,
            /(^|\/)\.ssh(\/|$)/,
            /(^|\/)\.npmrc$/,
            /(^|\/)\.pypirc$/,
            /(^|\/)id_(rsa|ed25519|ecdsa)/,
            /(^|\/)credentials(\.|$)/,
            /(^|\/)secrets(\.|$)/
          ];
          if (SENSITIVE.some((rx) => rx.test(rel))) {
            return {
              content: [{ type: "text", text: `index_file: refusing to index ${rel} \u2014 matches sensitive-file pattern` }],
              isError: true
            };
          }
          const stat = await fs10.promises.stat(resolved);
          const MAX_BYTES = 1024 * 1024;
          if (stat.size > MAX_BYTES) {
            return {
              content: [{ type: "text", text: `index_file: ${rel} is ${stat.size} bytes, exceeds ${MAX_BYTES} byte cap \u2014 pass content explicitly if you really want to index this` }],
              isError: true
            };
          }
          content = await fs10.promises.readFile(resolved, "utf-8");
        } catch (e) {
          return {
            content: [{
              type: "text",
              text: `index_file: no content provided and could not read ${filePath} from disk: ${e instanceof Error ? e.message : String(e)}`
            }],
            isError: true
          };
        }
      }
      const metaPath = path8.isAbsolute(filePath) ? path8.basename(filePath) : filePath;
      try {
        await manager.embedContent([{ content, metadata: { filePath: metaPath } }], nerveCenter.currentProjectName);
        return { content: [{ type: "text", text: "Indexed via Remote API." }] };
      } catch (e) {
        if (ragEngine) {
          const success = await ragEngine.indexContent(metaPath, content);
          return { content: [{ type: "text", text: success ? "Indexed locally." : "Local index failed." }] };
        }
        return { content: [{ type: "text", text: `Indexing failed: ${e}` }], isError: true };
      }
    }
    if (name === SEARCH_CONTEXT_TOOL) {
      const query = String(args?.query);
      logger.info(`[search_codebase] Query: "${query}"`);
      let localResults = "";
      try {
        localResults = await localSearch(query);
        logger.info(`[search_codebase] Local search completed: ${localResults.length} chars`);
      } catch (e) {
        logger.warn(`[search_codebase] Local search error: ${e}`);
        localResults = "";
      }
      let ragResults = null;
      const RAG_TIMEOUT_MS = 3e3;
      try {
        const ragPromise = (async () => {
          try {
            const remote = await manager.searchContext(query, nerveCenter.currentProjectName);
            if (remote && !remote.includes("No results found") && remote.trim().length > 20) {
              return remote;
            }
          } catch {
          }
          if (ragEngine) {
            try {
              const results = await ragEngine.search(query);
              if (results.length > 0) return results.join("\n---\n");
            } catch {
            }
          }
          return null;
        })();
        ragResults = await Promise.race([
          ragPromise,
          new Promise((resolve) => setTimeout(() => resolve(null), RAG_TIMEOUT_MS))
        ]);
        if (ragResults) {
          logger.info(`[search_codebase] RAG returned results (${ragResults.length} chars)`);
        }
      } catch {
      }
      const hasLocal = localResults && !localResults.startsWith("No matches found") && !localResults.startsWith("Could not extract");
      if (!hasLocal && !ragResults) {
        return { content: [{ type: "text", text: localResults || "No results found for this query." }] };
      }
      const parts = [];
      if (hasLocal) parts.push(localResults);
      if (ragResults) parts.push("## Indexed Results (RAG)\n\n" + ragResults);
      return { content: [{ type: "text", text: parts.join("\n\n---\n\n") }] };
    }
    if (name === "get_subscription_status") {
      const email = args?.email ? String(args.email) : void 0;
      logger.info(`[get_subscription_status] Called with email: ${email || "(using API key identity)"}`);
      try {
        const result2 = await nerveCenter.getSubscriptionStatus(email);
        logger.info(`[get_subscription_status] Result: ${JSON.stringify(result2).substring(0, 200)}`);
        return { content: [{ type: "text", text: JSON.stringify(result2, null, 2) }] };
      } catch (e) {
        logger.error(`[get_subscription_status] Exception: ${e.message}`, e);
        return { content: [{ type: "text", text: JSON.stringify({ error: e.message }, null, 2) }], isError: true };
      }
    }
    if (name === "get_usage_stats") {
      const email = args?.email ? String(args.email) : void 0;
      logger.info(`[get_usage_stats] Called with email: ${email || "(using API key identity)"}`);
      try {
        const result2 = await nerveCenter.getUsageStats(email);
        logger.info(`[get_usage_stats] Result: ${JSON.stringify(result2).substring(0, 200)}`);
        return { content: [{ type: "text", text: JSON.stringify(result2, null, 2) }] };
      } catch (e) {
        logger.error(`[get_usage_stats] Exception: ${e.message}`, e);
        return { content: [{ type: "text", text: JSON.stringify({ error: e.message }, null, 2) }], isError: true };
      }
    }
    if (name === "search_docs") {
      const query = String(args?.query);
      try {
        const formatted = await manager.searchContext(query, nerveCenter.currentProjectName);
        return { content: [{ type: "text", text: formatted }] };
      } catch (err) {
        if (ragEngine) {
          const results = await ragEngine.search(query);
          return { content: [{ type: "text", text: results.join("\n---\n") }] };
        }
        return {
          content: [{ type: "text", text: `Search Error: ${err}` }],
          isError: true
        };
      }
    }
    if (name === "propose_file_access") {
      const { agentId, filePath, filePaths, intent, userPrompt } = args;
      const batch = Array.isArray(filePaths) ? filePaths.filter((p) => typeof p === "string") : [];
      if (batch.length === 0 && typeof filePath !== "string") {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "REJECTED", message: "Provide `filePath` (one file) or `filePaths` (a batch of files)." }) }],
          isError: true
        };
      }
      const result2 = batch.length > 0 ? await nerveCenter.proposeFilesAccess(agentId, batch, intent, userPrompt) : await nerveCenter.proposeFileAccess(agentId, filePath, intent, userPrompt);
      return { content: [{ type: "text", text: JSON.stringify(result2, null, 2) }] };
    }
    if (name === "release_file_access") {
      const { agentId, filePath } = args;
      const result2 = await nerveCenter.releaseFileAccess(agentId, filePath);
      return { content: [{ type: "text", text: JSON.stringify(result2, null, 2) }] };
    }
    if (name === "list_locks") {
      const result2 = await nerveCenter.listLocks();
      return { content: [{ type: "text", text: JSON.stringify({ locks: result2 }, null, 2) }] };
    }
    if (name === "update_shared_context") {
      const { agentId, text } = args;
      const result2 = await nerveCenter.updateSharedContext(text, agentId);
      return { content: [{ type: "text", text: result2 }] };
    }
    if (name === "finalize_session") {
      const result2 = await nerveCenter.finalizeSession();
      return { content: [{ type: "text", text: JSON.stringify(result2, null, 2) }] };
    }
    if (name === "get_project_soul") {
      const result2 = await nerveCenter.getProjectSoul();
      return { content: [{ type: "text", text: result2 }] };
    }
    if (name === "update_project_soul") {
      const { context, conventions } = args;
      const updated = [];
      if (context) {
        await manager.updateFile("context.md", context, false);
        updated.push("context.md");
      }
      if (conventions) {
        await manager.updateFile("conventions.md", conventions, false);
        updated.push("conventions.md");
      }
      if (updated.length === 0) {
        return { content: [{ type: "text", text: "No changes \u2014 provide `context` and/or `conventions` parameters." }] };
      }
      return { content: [{ type: "text", text: `Project soul updated: ${updated.join(", ")}` }] };
    }
    if (name === "switch_project") {
      const { projectRoot, projectName } = args;
      const identity = resolveProjectIdentity(projectRoot, process.cwd(), process.env);
      const result2 = await nerveCenter.switchProject({
        root: identity.root,
        projectName: projectName || identity.projectName
      });
      return { content: [{ type: "text", text: JSON.stringify(result2, null, 2) }] };
    }
    if (name === "post_job") {
      const { title, description, priority, dependencies } = args;
      const result2 = await nerveCenter.postJob(title, description, priority, dependencies);
      return { content: [{ type: "text", text: JSON.stringify(result2) }] };
    }
    if (name === "list_jobs") {
      const includeCompleted = Boolean(args?.includeCompleted);
      const jobs = await nerveCenter.listJobs();
      const result2 = includeCompleted ? jobs : jobs.filter((job) => job.status !== "done" && job.status !== "cancelled");
      return { content: [{ type: "text", text: JSON.stringify({ jobs: result2 }, null, 2) }] };
    }
    if (name === "cancel_job") {
      const { jobId, reason } = args;
      const result2 = await nerveCenter.cancelJob(jobId, reason);
      return { content: [{ type: "text", text: JSON.stringify(result2) }] };
    }
    if (name === "force_unlock") {
      const { filePath, reason } = args;
      const result2 = await nerveCenter.forceUnlock(filePath, reason);
      return { content: [{ type: "text", text: JSON.stringify(result2) }] };
    }
    if (name === "claim_next_job") {
      const { agentId } = args;
      const result2 = await nerveCenter.claimNextJob(agentId);
      if (result2 && result2.status === "NO_JOBS_AVAILABLE") {
        presence.seen(agentId, Date.now(), "idle", "waiting for work");
        const roster = presence.list(Date.now());
        return { content: [{ type: "text", text: JSON.stringify({
          status: "WAITING",
          message: "No jobs on the board yet. You're registered as idle \u2014 the orchestrator can see you (list_agents) and you'll pick up work as soon as it's posted. Call claim_next_job again shortly.",
          agentsOnline: roster.length,
          idle: roster.filter((a) => a.status === "idle").length,
          roster
        }, null, 2) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result2, null, 2) }] };
    }
    if (name === "claim_job") {
      const { agentId, jobId } = args;
      const result2 = await nerveCenter.claimJob(agentId, jobId);
      return { content: [{ type: "text", text: JSON.stringify(result2, null, 2) }] };
    }
    if (name === "complete_job") {
      const { agentId, jobId, outcome, completionKey } = args;
      const result2 = await nerveCenter.completeJob(agentId, jobId, outcome, completionKey);
      return { content: [{ type: "text", text: JSON.stringify(result2) }] };
    }
    if (name === "verify_file_lock") {
      const { agentId, filePath } = args;
      const result2 = await nerveCenter.verifyFileAccess(agentId, filePath);
      return { content: [{ type: "text", text: JSON.stringify(result2, null, 2) }] };
    }
    if (name === "guarded_write") {
      const { agentId, filePath, content } = args;
      const result2 = await nerveCenter.guardedWrite(agentId, filePath, content);
      return { content: [{ type: "text", text: JSON.stringify(result2, null, 2) }] };
    }
    if (name === "list_agents") {
      const roster = presence.list(Date.now());
      return { content: [{ type: "text", text: JSON.stringify({
        agentsOnline: roster.length,
        active: roster.filter((a) => a.status === "active").length,
        idle: roster.filter((a) => a.status === "idle").length,
        agents: roster
      }, null, 2) }] };
    }
    throw new Error(`Tool not found: ${name}`);
  });
  if (workspaceNote && result && Array.isArray(result.content)) {
    result.content.push({ type: "text", text: workspaceNote });
  }
  if (name === "switch_project" || name === "finalize_session") {
    teamUpdates.reset();
  } else if (TEAM_AWARE_TOOLS.has(name) && result && Array.isArray(result.content)) {
    try {
      const delta = teamUpdates.drain(captureAgent, nerveCenter.notepadSnapshot);
      if (delta) {
        result.content.push({ type: "text", text: formatTeamUpdates(delta) });
      }
    } catch (e) {
      logger.warn(`Team-update drain failed: ${e}`);
    }
  }
  return result;
});
async function main() {
  await ensureFileSystem();
  await nerveCenter.init();
  if (nerveCenter.projectId && ragEngine) {
    ragEngine.setProjectId(nerveCenter.projectId);
    logger.info(`Local RAG Engine linked to Project ID: ${nerveCenter.projectId}`);
  }
  await verifySubscription();
  if (!subscription.valid) {
    logger.error("[subscription] Subscription invalid at startup \u2014 all tools will be blocked");
    logger.error(`[subscription] Reason: ${subscription.reason} | Plan: ${subscription.plan}`);
  } else {
    logger.info(`[subscription] Subscription verified: ${subscription.plan} (valid until: ${subscription.validUntil || "N/A"})`);
  }
  if (apiSecret) {
    const subscriptionTimer = setInterval(async () => {
      try {
        await verifySubscription();
        logger.info(`[subscription] Periodic re-check: valid=${subscription.valid}, plan=${subscription.plan}`);
      } catch (e) {
        logger.warn(`[subscription] Periodic re-check failed: ${e}`);
      }
    }, RECHECK_INTERVAL_MS);
    subscriptionTimer.unref();
  }
  logger.info("MCP server ready - all tools and resources registered");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Shared Context MCP Server running on stdio");
  logger.info("Server is now accepting tool calls from MCP clients");
}
main().catch((error) => {
  logger.error("Server error", error);
  process.exit(1);
});
