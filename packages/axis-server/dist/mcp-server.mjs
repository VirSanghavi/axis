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
var NerveCenter = class {
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
  // --- Decision & Orchestration ---
  async proposeFileAccess(agentId, filePath, intent, userPrompt) {
    return await this.mutex.runExclusive(async () => {
      logger.info(`[proposeFileAccess] Starting - agentId: ${agentId}, filePath: ${filePath}`);
      if (this.contextManager.apiUrl) {
        try {
          const result = await this.callCoordination("locks", "POST", {
            action: "lock",
            filePath,
            agentId,
            intent,
            userPrompt
          });
          if (result.status === "DENIED") {
            logger.info(`[proposeFileAccess] DENIED by server: ${result.message}`);
            return {
              status: "REQUIRES_ORCHESTRATION",
              message: result.message || `File '${filePath}' is locked by another agent`,
              currentLock: result.current_lock
            };
          }
          logger.info(`[proposeFileAccess] GRANTED by server`);
          await this.appendToNotepad(`
- [LOCK] ${agentId} locked ${filePath}
  Intent: ${intent}`);
          return { status: "GRANTED", message: `Access granted for ${filePath}` };
        } catch (e) {
          if (e.message && e.message.includes("409")) {
            logger.info(`[proposeFileAccess] Lock conflict (409)`);
            return {
              status: "REQUIRES_ORCHESTRATION",
              message: `File '${filePath}' is locked by another agent`
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
            p_file_path: filePath,
            p_agent_id: agentId,
            p_intent: intent,
            p_user_prompt: userPrompt,
            p_timeout_seconds: Math.floor(this.lockTimeout / 1e3)
          });
          if (error) throw error;
          const row = Array.isArray(data) ? data[0] : data;
          if (row && row.status === "DENIED") {
            return {
              status: "REQUIRES_ORCHESTRATION",
              message: `Conflict: File '${filePath}' is locked by '${row.owner_id}'`,
              currentLock: {
                agentId: row.owner_id,
                filePath,
                intent: row.intent,
                timestamp: row.updated_at ? Date.parse(row.updated_at) : Date.now()
              }
            };
          }
          await this.appendToNotepad(`
- [LOCK] ${agentId} locked ${filePath}
  Intent: ${intent}`);
          return { status: "GRANTED", message: `Access granted for ${filePath}` };
        } catch (e) {
          logger.warn("[NerveCenter] Lock RPC failed. Falling back to local.", e);
        }
      }
      const existing = Object.values(this.state.locks).find((l) => l.filePath === filePath);
      if (existing) {
        const isStale = Date.now() - existing.timestamp > this.lockTimeout;
        if (!isStale && existing.agentId !== agentId) {
          return {
            status: "REQUIRES_ORCHESTRATION",
            message: `Conflict: File '${filePath}' is currently locked by '${existing.agentId}'`,
            currentLock: existing
          };
        }
      }
      this.state.locks[filePath] = { agentId, filePath, intent, userPrompt, timestamp: Date.now() };
      await this.saveState();
      await this.appendToNotepad(`
- [LOCK] ${agentId} locked ${filePath}
  Intent: ${intent}`);
      return { status: "GRANTED", message: `Access granted for ${filePath}` };
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
    try {
      const context = await this.contextManager.readFile("context.md");
      soul += `
### Context
${context}`;
      const conventions = await this.contextManager.readFile("conventions.md");
      soul += `
### Conventions
${conventions}`;
    } catch (_e) {
      soul += "\n(Could not read local context files)";
    }
    return soul;
  }
  // --- Billing & Usage ---
  async getSubscriptionStatus(email) {
    logger.info(`[getSubscriptionStatus] Starting - email: ${email}`);
    logger.info(`[getSubscriptionStatus] Config - apiUrl: ${this.contextManager.apiUrl}, apiSecret: ${this.contextManager.apiSecret ? "SET" : "NOT SET"}, useSupabase: ${this.useSupabase}`);
    if (this.contextManager.apiUrl) {
      try {
        logger.info(`[getSubscriptionStatus] Attempting API call to: usage?email=${encodeURIComponent(email)}`);
        const result = await this.callCoordination(`usage?email=${encodeURIComponent(email)}`);
        logger.info(`[getSubscriptionStatus] API call successful: ${JSON.stringify(result).substring(0, 200)}`);
        return result;
      } catch (e) {
        logger.error(`[getSubscriptionStatus] API call failed: ${e.message}`, e);
        return { error: `API call failed: ${e.message}` };
      }
    } else {
      logger.warn("[getSubscriptionStatus] No API URL configured");
    }
    if (this.useSupabase && this.supabase) {
      const { data: profile, error } = await this.supabase.from("profiles").select("subscription_status, stripe_customer_id, current_period_end").eq("email", email).single();
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
    logger.info(`[getUsageStats] Starting - email: ${email}`);
    logger.info(`[getUsageStats] Config - apiUrl: ${this.contextManager.apiUrl}, apiSecret: ${this.contextManager.apiSecret ? "SET" : "NOT SET"}, useSupabase: ${this.useSupabase}`);
    if (this.contextManager.apiUrl) {
      try {
        logger.info(`[getUsageStats] Attempting API call to: usage?email=${encodeURIComponent(email)}`);
        const result = await this.callCoordination(`usage?email=${encodeURIComponent(email)}`);
        logger.info(`[getUsageStats] API call successful: ${JSON.stringify(result).substring(0, 200)}`);
        return { email, usageCount: result.usageCount || 0 };
      } catch (e) {
        logger.error(`[getUsageStats] API call failed: ${e.message}`, e);
        return { error: `API call failed: ${e.message}` };
      }
    }
    if (this.useSupabase && this.supabase) {
      const { data: profile } = await this.supabase.from("profiles").select("usage_count").eq("email", email).single();
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
import path3 from "path";
import fs3 from "fs";
if (process.env.SHARED_CONTEXT_API_URL || process.env.AXIS_API_KEY) {
  logger.info("Using configuration from MCP client (mcp.json)");
} else {
  const cwd = process.cwd();
  const possiblePaths = [
    path3.join(cwd, ".env.local"),
    path3.join(cwd, "..", ".env.local"),
    path3.join(cwd, "..", "..", ".env.local"),
    path3.join(cwd, "shared-context", ".env.local"),
    path3.join(cwd, "..", "shared-context", ".env.local")
  ];
  let envLoaded = false;
  for (const envPath of possiblePaths) {
    try {
      if (fs3.existsSync(envPath)) {
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
    const fs4 = await import("fs/promises");
    const path4 = await import("path");
    const fsSync2 = await import("fs");
    const cwd = process.cwd();
    logger.info(`Server CWD: ${cwd}`);
    const historyDir = path4.join(cwd, "history");
    await fs4.mkdir(historyDir, { recursive: true }).catch(() => {
    });
    const axisDir = path4.join(cwd, ".axis");
    const axisInstructions = path4.join(axisDir, "instructions");
    const legacyInstructions = path4.join(cwd, "agent-instructions");
    if (fsSync2.existsSync(legacyInstructions) && !fsSync2.existsSync(axisDir)) {
      logger.info("Using legacy agent-instructions directory");
    } else {
      await fs4.mkdir(axisInstructions, { recursive: true }).catch(() => {
      });
      const defaults = [
        ["context.md", `# Project Context

## Overview
<!-- Describe your project's core value proposition and goals here -->
<!-- This file is read by all agents via get_project_soul and read_context -->

## Architecture
<!-- High-level design patterns and stack choices -->

## Core Features
<!-- List your main capabilities -->
`],
        ["conventions.md", `# Coding Conventions & Agent Norms

## Language Standards
<!-- Your TypeScript, Python, etc. guidelines go here -->

## Styling
<!-- CSS/Tailwind rules -->

## Testing
<!-- Test framework and strategy -->

---

## Agent Behavioral Norms

These norms apply to **all** AI coding agents working on this project.

### Plan Before Write — The Core Invariant

**No agent writes code unless it either owns a file lock OR has explicitly declined the job board for a scoped reason.**

On non-trivial tasks (2+ files, new features, refactors):
1. Break work into jobs → \`post_job\`
2. Claim before editing → \`claim_next_job\`
3. Lock before writing → \`propose_file_access\` with a **descriptive intent**
4. Complete when done → \`complete_job\` with outcome

Direct edits without a job are allowed only for single-line fixes, typos, config tweaks, or clearly scoped user requests.

### Force Unlock Policy

\`force_unlock\` is a **last resort, not a convenience tool.**
- Only use when a lock is >25 minutes old AND the locking agent is clearly crashed.
- Always provide a specific reason. Never force-unlock to skip coordination.
- Prefer waiting for TTL expiry (30 min) over force-unlocking.

### Lock Hygiene
- Always provide descriptive \`intent\` when locking.
- Release locks early by completing jobs.
- Call \`finalize_session\` at end of session to clean up.

### Shared Memory
- Call \`update_shared_context\` after meaningful steps.
- Log decisions, not just actions. Other agents read the notepad in real-time.
`],
        ["activity.md", "# Activity Log\n\n## Session History\n<!-- Agents log major actions and decisions here via update_shared_context -->\n"]
      ];
      for (const [file, content] of defaults) {
        const p = path4.join(axisInstructions, file);
        try {
          await fs4.access(p);
        } catch {
          await fs4.writeFile(p, content);
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
      description: "**SEMANTIC SEARCH** for the codebase.\n- Uses vector similarity to find relevant code snippets or documentation.\n- Best for: 'Where is the auth logic?', 'How do I handle billing?', 'Find the class that manages locks'.\n- Note: This searches *indexed* content only. For exact string matches, use `grep` (if available) or `warpgrep`.",
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
      description: "**BILLING CHECK**: specific to the Axis business logic.\n- Returns the user's subscription tier (Pro vs Free), Stripe customer ID, and current period end.\n- Critical for gating features behind paywalls.\n- Returns 'Profile not found' if the user doesn't exist in the database.",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string", description: "User email to check." }
        },
        required: ["email"]
      }
    },
    {
      name: "get_usage_stats",
      description: "**API USAGE**: Returns a user's token usage and request counts.\n- Useful for debugging rate limits or explaining quota usage to users.",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string", description: "User email to check." }
        },
        required: ["email"]
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
      description: "**CRITICAL: REQUEST FILE LOCK**.\n- **MUST** be called *before* editing any file to prevent conflicts with other agents.\n- Checks if another agent currently holds a lock.\n- Returns `GRANTED` if safe to proceed, or `REQUIRES_ORCHESTRATION` if someone else is editing.\n- Usage: Provide your `agentId` (e.g., 'cursor-agent'), `filePath` (absolute), and `intent` (what you are doing).\n- Note: Locks expire after 30 minutes. Use `force_unlock` only if you are certain a lock is stale and blocking progress.",
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
      description: "**END OF SESSION HOUSEKEEPING**.\n- Archives the current Live Notepad to a permanent session log.\n- Clears all active locks and completed jobs.\n- Resets the Live Notepad for the next session.\n- Call this when the user says 'we are done' or 'start fresh'.",
      inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
      name: "get_project_soul",
      description: "**HIGH-LEVEL INTENT**: Returns the 'Soul' of the project.\n- Combines `context.md`, `conventions.md`, and other core directives into a single prompt.\n- Use this at the *start* of a conversation to ground yourself in the project's reality.",
      inputSchema: { type: "object", properties: {}, required: [] }
    },
    // --- Job Board (Task Orchestration) ---
    {
      name: "post_job",
      description: "**CREATE TICKET**: Post a new task to the Job Board.\n- Use this when you identify work that needs to be done but *cannot* be done right now (e.g., refactoring, new feature).\n- Supports `dependencies` (list of other Job IDs that must be done first).\n- Priority: low, medium, high, critical.",
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
      description: "**AUTO-ASSIGNMENT**: Ask the Job Board for the next most important task.\n- Respects priority (Critical > High > ...) and dependencies (won't assign a job if its deps aren't done).\n- Returns the Job object if successful, or 'NO_JOBS_AVAILABLE'.\n- Use this when you are idle and looking for work.",
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
      description: "**CLOSE TICKET**: Mark a job as done.\n- Requires `outcome` (what was done).\n- If you are not the assigned agent, you must provide the `completionKey`.",
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
    try {
      const results = await manager.searchContext(query, nerveCenter.currentProjectName);
      return { content: [{ type: "text", text: results }] };
    } catch (e) {
      if (ragEngine) {
        const results = await ragEngine.search(query);
        return { content: [{ type: "text", text: results.join("\n---\n") }] };
      }
      return { content: [{ type: "text", text: `Search failed: ${e}` }], isError: true };
    }
  }
  if (name === "get_subscription_status") {
    const email = String(args?.email);
    logger.info(`[get_subscription_status] Called with email: ${email}`);
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
    const email = String(args?.email);
    logger.info(`[get_usage_stats] Called with email: ${email}`);
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
