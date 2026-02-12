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
import fs2 from "fs/promises";
import path2 from "path";
var STATE_FILE = process.env.NERVE_CENTER_STATE_FILE || path2.join(process.cwd(), "history", "nerve-center-state.json");
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
  lockTimeout;
  supabase;
  _projectId;
  // Renamed backing field
  projectName;
  useSupabase;
  _circuitFailures = 0;
  _circuitOpenUntil = 0;
  /**
   * @param contextManager - Instance of ContextManager for legacy operations
   * @param options - Configuration options for state persistence and timeouts
   */
  constructor(contextManager, options = {}) {
    this.mutex = new Mutex2();
    this.contextManager = contextManager;
    this.stateFilePath = options.stateFilePath || STATE_FILE;
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
    if (this.projectName === "default" && (this.useSupabase || !this.contextManager.apiUrl)) {
      await this.detectProjectName();
    }
    if (this.useSupabase) {
      await this.ensureProjectId();
    }
    if (this.contextManager.apiUrl) {
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
  }
  async detectProjectName() {
    try {
      const axisConfigPath = path2.join(process.cwd(), ".axis", "axis.json");
      const configData = await fs2.readFile(axisConfigPath, "utf-8");
      const config = JSON.parse(configData);
      if (config.project) {
        this.projectName = config.project;
        logger.info(`Detected project name from .axis/axis.json: ${this.projectName}`);
        console.error(`[NerveCenter] Loaded project name '${this.projectName}' from ${axisConfigPath}`);
      } else {
        console.error(`[NerveCenter] .axis/axis.json found but no 'project' field.`);
      }
    } catch (e) {
      console.error(`[NerveCenter] Could not load .axis/axis.json at ${path2.join(process.cwd(), ".axis", "axis.json")}: ${e}`);
    }
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
    logger.info(`[callCoordination] Request body: ${body ? JSON.stringify({ ...body, projectName: this.projectName }) : "none"}`);
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
  async getLocks() {
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
            timestamp: Date.parse(row.updated_at || row.timestamp)
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
          timestamp: Date.parse(row.updated_at)
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
          timestamp: Date.parse(row.updated_at || row.timestamp)
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
      await fs2.mkdir(path2.dirname(this.stateFilePath), { recursive: true });
      await fs2.writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2));
    } catch (error) {
      logger.error("Failed to persist state", error);
    }
  }
  async loadState() {
    try {
      const data = await fs2.readFile(this.stateFilePath, "utf-8");
      this.state = JSON.parse(data);
      logger.info("State loaded from disk");
    } catch (_error) {
    }
  }
  // --- Job Board Protocol (Active Orchestration) ---
  async postJob(title, description, priority = "medium", dependencies = []) {
    return await this.mutex.runExclusive(async () => {
      let id = `job-${Date.now()}-${Math.floor(Math.random() * 1e3)}`;
      const completionKey = Math.random().toString(36).substring(2, 10).toUpperCase();
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
        if (error) logger.error("Failed to post job to Supabase", error);
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
        }
      }
      if (!this.useSupabase && !this.contextManager.apiUrl) {
        this.state.jobs[id] = {
          id,
          title,
          description,
          priority,
          dependencies,
          status: "todo",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          completionKey
        };
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
      await this.appendToNotepad(`
- [JOB DONE] Agent '${agentId}' finished: ${job.title}
  Outcome: ${outcome}`);
      return { status: "COMPLETED" };
    });
  }
  async forceUnlock(filePath, reason) {
    return await this.mutex.runExclusive(async () => {
      if (this.useSupabase && this.supabase && this._projectId) {
        await this.supabase.from("locks").delete().eq("project_id", this._projectId).eq("file_path", filePath);
      } else if (this.contextManager.apiUrl) {
        try {
          await this.callCoordination("locks", "POST", { action: "unlock", filePath, reason });
        } catch (e) {
          logger.error("Failed to force unlock via API", e);
        }
      }
      if (this.state.locks[filePath]) {
        delete this.state.locks[filePath];
        await this.saveState();
      }
      await this.logLockEvent("FORCE_UNLOCKED", filePath, "admin", void 0, reason);
      await this.appendToNotepad(`
- [FORCE UNLOCK] ${filePath} unlocked by admin. Reason: ${reason}`);
      return `File ${filePath} has been forcibly unlocked.`;
    });
  }
  async getCoreContext() {
    const jobs = await this.listJobs();
    const locks = await this.getLocks();
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
    const absolutePath = path2.isAbsolute(filePath) ? filePath : path2.join(process.cwd(), filePath);
    try {
      const stat = await fs2.stat(absolutePath);
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
          const result = await this.callCoordination("locks", "POST", {
            action: "lock",
            filePath: normalizedPath,
            agentId,
            intent,
            userPrompt
          });
          if (result.status === "DENIED") {
            logger.info(`[proposeFileAccess] DENIED by server: ${result.message}`);
            await this.logLockEvent("BLOCKED", normalizedPath, agentId, result.current_lock?.agent_id, intent);
            return {
              status: "REQUIRES_ORCHESTRATION",
              message: result.message || `File '${normalizedPath}' is locked by another agent`,
              currentLock: result.current_lock
            };
          }
          if (result.status === "REJECTED") {
            logger.warn(`[proposeFileAccess] REJECTED by server: ${result.message}`);
            return { status: "REJECTED", message: result.message };
          }
          logger.info(`[proposeFileAccess] GRANTED by server`);
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
              message: `File '${normalizedPath}' is locked by another agent`
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
              message: `Conflict: File '${normalizedPath}' is locked by '${row.owner_id}'`,
              currentLock: {
                agentId: row.owner_id,
                filePath: normalizedPath,
                intent: row.intent,
                timestamp: row.updated_at ? Date.parse(row.updated_at) : Date.now()
              }
            };
          }
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
          message: `Conflict: File '${normalizedPath}' is locked by '${conflict.agentId}'`,
          currentLock: conflict
        };
      }
      this.state.locks[normalizedPath] = { agentId, filePath: normalizedPath, intent, userPrompt, timestamp: Date.now() };
      await this.saveState();
      await this.logLockEvent("GRANTED", normalizedPath, agentId, void 0, intent);
      await this.appendToNotepad(`
- [LOCK] ${agentId} locked ${normalizedPath}
  Intent: ${intent}`);
      return { status: "GRANTED", message: `Access granted for ${normalizedPath}` };
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
      const content = await this.getNotepad();
      const filename = `session-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.md`;
      const historyPath = path2.join(process.cwd(), "history", filename);
      try {
        await fs2.mkdir(path2.dirname(historyPath), { recursive: true });
        await fs2.writeFile(historyPath, content);
      } catch (e) {
        logger.warn("Failed to write local session log", e);
      }
      if (this.useSupabase && this.supabase && this._projectId) {
        await this.supabase.from("sessions").insert({
          project_id: this._projectId,
          title: `Session ${(/* @__PURE__ */ new Date()).toLocaleDateString()}`,
          summary: content.substring(0, 500) + "...",
          metadata: { full_content: content }
        });
        await this.supabase.from("projects").update({ live_notepad: "Session Start: " + (/* @__PURE__ */ new Date()).toISOString() + "\n" }).eq("id", this._projectId);
        await this.supabase.from("jobs").delete().eq("project_id", this._projectId).in("status", ["done", "cancelled"]);
        await this.supabase.from("locks").delete().eq("project_id", this._projectId);
      } else if (this.contextManager.apiUrl) {
        try {
          await this.callCoordination("sessions/finalize", "POST", { content });
        } catch (e) {
          logger.error("Failed to finalize session via API", e);
        }
      }
      this.state.liveNotepad = "Session Start: " + (/* @__PURE__ */ new Date()).toISOString() + "\n";
      this.state.locks = {};
      this.state.jobs = Object.fromEntries(
        Object.entries(this.state.jobs).filter(([_, j]) => j.status !== "done" && j.status !== "cancelled")
      );
      await this.saveState();
      return {
        status: "SESSION_FINALIZED",
        archivePath: historyPath
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
    const unfilled = couldNotRead || /Describe your project|<!-- Describe|This project uses Axis/i.test(context) || context.trim().length < 450 && /# Project Context/i.test(context);
    if (unfilled) {
      soul += `

### MANDATORY: Project soul is not yet filled
You MUST fill the project soul before doing any other work. Do not proceed with other tasks until it is filled.
- If the codebase has content to search: use \`search_codebase\` to explore, then \`read_context\` and \`update_context\` to populate \`context.md\` and \`conventions.md\`.
- If there is nothing in the directory to search through: you MUST ask the user what the project is about, then update the soul files with their answer.
This requirement is mandatory; ignoring it means working without context.`;
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

// ../../src/local/mcp-server.ts
import path4 from "path";
import fs4 from "fs";

// ../../src/local/local-search.ts
import fs3 from "fs/promises";
import fsSync2 from "fs";
import path3 from "path";
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
  let current = path3.resolve(startDir);
  const root = path3.parse(current).root;
  while (current !== root) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        fsSync2.accessSync(path3.join(current, marker));
        return current;
      } catch {
      }
    }
    const parent = path3.dirname(current);
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
      entries = await fs3.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") {
        if (SKIP_DIRS.has(entry.name) || entry.isDirectory()) continue;
      }
      const fullPath = path3.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await recurse(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (SKIP_FILENAMES.has(entry.name)) continue;
        const ext = path3.extname(entry.name).toLowerCase();
        if (SKIP_EXTENSIONS.has(ext)) continue;
        try {
          const stat = await fs3.stat(fullPath);
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
    content = await fs3.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const contentLower = content.toLowerCase();
  const relativePath = path3.relative(rootDir, filePath);
  const matchedKeywords = keywords.filter((kw) => contentLower.includes(kw));
  if (matchedKeywords.length === 0) return null;
  const coverage = matchedKeywords.length / keywords.length;
  if (coverage < 0.2) return null;
  const lines = content.split("\n");
  let score = coverage * coverage * matchedKeywords.length;
  const relLower = relativePath.toLowerCase();
  let pathMatches = 0;
  for (const kw of keywords) {
    if (relLower.includes(kw)) {
      score += 3;
      pathMatches++;
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
      const relPath = path3.relative(cwd, file);
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

// ../../src/local/mcp-server.ts
if (process.env.SHARED_CONTEXT_API_URL || process.env.AXIS_API_KEY) {
  logger.info("Using configuration from MCP client (mcp.json)");
} else {
  const cwd = process.cwd();
  const possiblePaths = [
    path4.join(cwd, ".env.local"),
    path4.join(cwd, "..", ".env.local"),
    path4.join(cwd, "..", "..", ".env.local"),
    path4.join(cwd, "shared-context", ".env.local"),
    path4.join(cwd, "..", "shared-context", ".env.local")
  ];
  let envLoaded = false;
  for (const envPath of possiblePaths) {
    try {
      if (fs4.existsSync(envPath)) {
        logger.info(`[Fallback] Loading .env.local from: ${envPath}`);
        dotenv2.config({ path: envPath });
        envLoaded = true;
        break;
      }
    } catch (e) {
    }
  }
  if (!envLoaded) {
    logger.warn("No configuration found from MCP client (mcp.json) or .env.local");
    logger.warn("MCP server will use default API URL: https://useaxis.dev/api/v1");
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
var apiUrl = process.env.SHARED_CONTEXT_API_URL || process.env.AXIS_API_URL || "https://useaxis.dev/api/v1";
var apiSecret = process.env.AXIS_API_KEY || process.env.SHARED_CONTEXT_API_SECRET || process.env.AXIS_API_SECRET;
var useRemoteApiOnly = !!process.env.SHARED_CONTEXT_API_URL || !!process.env.AXIS_API_KEY;
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
  projectName: process.env.PROJECT_NAME || "default"
});
logger.info("=== Axis MCP Server Initialized ===");
var RECHECK_INTERVAL_MS = 30 * 60 * 1e3;
var GRACE_PERIOD_MS = 5 * 60 * 1e3;
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
      valid: false,
      plan: "none",
      reason: "no_api_key",
      checkedAt: Date.now()
    };
    logger.error("[subscription] No API key configured. Axis requires an API key from https://useaxis.dev/dashboard");
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
    const fs5 = await import("fs/promises");
    const path5 = await import("path");
    const fsSync3 = await import("fs");
    const cwd = process.cwd();
    logger.info(`Server CWD: ${cwd}`);
    const historyDir = path5.join(cwd, "history");
    await fs5.mkdir(historyDir, { recursive: true }).catch(() => {
    });
    const axisDir = path5.join(cwd, ".axis");
    const axisInstructions = path5.join(axisDir, "instructions");
    const legacyInstructions = path5.join(cwd, "agent-instructions");
    if (fsSync3.existsSync(legacyInstructions) && !fsSync3.existsSync(axisDir)) {
      logger.info("Using legacy agent-instructions directory");
    } else {
      await fs5.mkdir(axisInstructions, { recursive: true }).catch(() => {
      });
      const defaults = [
        ["context.md", `# Project Context

## Overview
<!-- Describe your project's goals and what it does. If this file is still just placeholders, agents MUST fill it: use search_codebase to infer content from the repo, or if there is nothing to search, ask the user what the project is about, then update via update_context. Do not proceed with other work until the soul is filled. -->

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
Every non-trivial task MUST follow: post_job \u2192 claim_next_job \u2192 propose_file_access \u2192 (edit) \u2192 complete_job.
Skip ONLY for single-line typo fixes.

### Releasing Locks (CRITICAL)
Every file you lock MUST be unlocked before your session ends. Dangling locks block all other agents.
- complete_job releases locks for that job. Call it IMMEDIATELY after each task.
- finalize_session clears ALL remaining locks. Call it before you stop responding.
- NEVER end a session while holding locks. Self-check: "Did I call finalize_session?"

### Session Cleanup (MANDATORY)
- complete_job IMMEDIATELY after finishing each task \u2014 this is how locks get released.
- update_shared_context after meaningful steps.
- finalize_session when the user's request is fully complete \u2014 do not wait to be told. This clears all remaining locks.

### Force-Unlock Policy
force_unlock is a LAST RESORT \u2014 only for locks >25 min old from a crashed agent. Always give a reason.
`],
        ["activity.md", "# Activity Log\n\n"]
      ];
      for (const [file, content] of defaults) {
        const p = path5.join(axisInstructions, file);
        try {
          await fs5.access(p);
        } catch {
          await fs5.writeFile(p, content);
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
      description: "**APPEND OR OVERWRITE** shared context files.\n- Use this to update the project's long-term memory (e.g., adding a new convention, updating the architectural goal).\n- For short-term updates (like 'I just fixed bug X'), use `update_shared_context` (Notepad) instead.\n- Supports `append: true` (default: false) to add to the end of a file.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "File to update (e.g. 'activity.md')" },
          content: { type: "string", description: "The new content to write or append." },
          append: { type: "boolean", description: "Whether to append to the end of the file (true) or overwrite it (false). Default: false." }
        },
        required: ["filename", "content"]
      }
    },
    {
      name: SEARCH_CONTEXT_TOOL,
      description: "**CODEBASE SEARCH** \u2014 search the entire project by natural language or keywords.\n- Scans all source files on disk. Always returns results if matching code exists \u2014 no setup required.\n- Best for: 'Where is the auth logic?', 'How do I handle billing?', 'Find the database connection code'.\n- Also checks the RAG vector index if available, but the local filesystem search always works.\n- Use this INSTEAD of grep/ripgrep to stay within the Axis workflow. This tool searches file contents directly.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query." }
        },
        required: ["query"]
      }
    },
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
      description: "**CRITICAL: REQUEST FILE LOCK** \u2014 call this before EVERY file edit, no exceptions.\n- Checks if another agent currently holds a lock on the same file.\n- Returns `GRANTED` if safe to proceed, `REQUIRES_ORCHESTRATION` if another agent has the file locked, or `REJECTED` if you tried to lock a directory.\n- **File-only locks**: You MUST lock individual files, not directories. Directory locks are rejected because they block all agents from the entire tree, preventing parallel work on different features. Lock each file you edit separately.\n- Paths are normalized relative to the project root, so absolute and relative paths are treated equivalently.\n- Usage: Provide your `agentId` (e.g., 'cursor-agent'), `filePath` (absolute or relative to a specific file), and `intent` (descriptive \u2014 e.g. 'Refactor auth to use JWT', NOT 'editing file').\n- Locks expire after 30 minutes. Use `force_unlock` only as a last resort for crashed agents.\n- **IMPORTANT**: Every lock you acquire MUST be released. Call `complete_job` when done with each task, and `finalize_session` before ending your session. Dangling locks block all other agents.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          filePath: { type: "string" },
          intent: { type: "string" },
          userPrompt: { type: "string", description: "The full prompt provided by the user that initiated this action." }
        },
        required: ["agentId", "filePath", "intent", "userPrompt"]
      }
    },
    {
      name: "update_shared_context",
      description: "**LIVE NOTEPAD**: The project's short-term working memory.\n- **ALWAYS** call this after completing a significant step (e.g., 'Fixed bug in auth.ts', 'Ran tests, all passed').\n- This content is visible to *all* other agents immediately.\n- Think of this as a team chat or 'standup' update.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          text: { type: "string" }
        },
        required: ["agentId", "text"]
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
      description: "**MANDATORY FIRST CALL**: Returns the project's goals, architecture, conventions, and active state.\n- Combines `context.md`, `conventions.md`, and other core directives into a single prompt.\n- You MUST call this as your FIRST action in every new session or task \u2014 before reading files, before responding to the user, before anything else.\n- If the project soul is not yet filled, you MUST fill it before any other work: use search_codebase then update_context, or if there is nothing to search, you MUST ask the user what the project is about and then update the soul files. Do not proceed with other tasks until the soul is filled.\n- Skipping this call means you are working without context and will make wrong decisions.",
      inputSchema: { type: "object", properties: {}, required: [] }
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
          agentId: { type: "string" }
        },
        required: ["agentId"]
      }
    },
    {
      name: "complete_job",
      description: "**CLOSE TICKET**: Mark a job as done and release file locks.\n- Call this IMMEDIATELY after finishing each job \u2014 do not accumulate completed-but-unclosed jobs.\n- Requires `outcome` (what was done).\n- If you are not the assigned agent, you must provide the `completionKey`.\n- **This is the primary way to release file locks.** Leaving jobs open holds locks and blocks other agents.\n- REMINDER: After completing all jobs, you MUST also call `finalize_session` to clear any remaining locks.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          jobId: { type: "string" },
          outcome: { type: "string" },
          completionKey: { type: "string", description: "Optional key to authorize completion if not the assigned agent." }
        },
        required: ["agentId", "jobId", "outcome"]
      }
    },
    {
      name: "index_file",
      description: "**UPDATE SEARCH INDEX**: Add a file's content to the RAG vector database.\n- Call this *immediately* after creating a new file or significantly refactoring an existing one.\n- Ensures future `search_codebase` calls return up-to-date results.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          content: { type: "string" }
        },
        required: ["filePath", "content"]
      }
    }
  ];
  logger.info(`[ListTools] Returning ${tools.length} tools to MCP client`);
  return { tools };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  logger.info("Tool call", { name });
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
  if (name === "index_file") {
    const filePath = String(args?.filePath);
    const content = String(args?.content);
    try {
      await manager.embedContent([{ content, metadata: { filePath } }], nerveCenter.currentProjectName);
      return { content: [{ type: "text", text: "Indexed via Remote API." }] };
    } catch (e) {
      if (ragEngine) {
        const success = await ragEngine.indexContent(filePath, content);
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
      const result = await nerveCenter.getSubscriptionStatus(email);
      logger.info(`[get_subscription_status] Result: ${JSON.stringify(result).substring(0, 200)}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      logger.error(`[get_subscription_status] Exception: ${e.message}`, e);
      return { content: [{ type: "text", text: JSON.stringify({ error: e.message }, null, 2) }], isError: true };
    }
  }
  if (name === "get_usage_stats") {
    const email = args?.email ? String(args.email) : void 0;
    logger.info(`[get_usage_stats] Called with email: ${email || "(using API key identity)"}`);
    try {
      const result = await nerveCenter.getUsageStats(email);
      logger.info(`[get_usage_stats] Result: ${JSON.stringify(result).substring(0, 200)}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
    const { agentId, filePath, intent, userPrompt } = args;
    const result = await nerveCenter.proposeFileAccess(agentId, filePath, intent, userPrompt);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (name === "update_shared_context") {
    const { agentId, text } = args;
    const result = await nerveCenter.updateSharedContext(text, agentId);
    return { content: [{ type: "text", text: result }] };
  }
  if (name === "finalize_session") {
    const result = await nerveCenter.finalizeSession();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (name === "get_project_soul") {
    const result = await nerveCenter.getProjectSoul();
    return { content: [{ type: "text", text: result }] };
  }
  if (name === "post_job") {
    const { title, description, priority, dependencies } = args;
    const result = await nerveCenter.postJob(title, description, priority, dependencies);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
  if (name === "cancel_job") {
    const { jobId, reason } = args;
    const result = await nerveCenter.cancelJob(jobId, reason);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
  if (name === "force_unlock") {
    const { filePath, reason } = args;
    const result = await nerveCenter.forceUnlock(filePath, reason);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
  if (name === "claim_next_job") {
    const { agentId } = args;
    const result = await nerveCenter.claimNextJob(agentId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (name === "complete_job") {
    const { agentId, jobId, outcome, completionKey } = args;
    const result = await nerveCenter.completeJob(agentId, jobId, outcome, completionKey);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
  throw new Error(`Tool not found: ${name}`);
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
  setInterval(async () => {
    try {
      await verifySubscription();
      logger.info(`[subscription] Periodic re-check: valid=${subscription.valid}, plan=${subscription.plan}`);
    } catch (e) {
      logger.warn(`[subscription] Periodic re-check failed: ${e}`);
    }
  }, RECHECK_INTERVAL_MS);
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
