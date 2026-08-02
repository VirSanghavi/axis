import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import { ContextManager } from "./context-manager.js";
import { NerveCenter } from "./nerve-center.js";
import { createSessionIdentity } from "./agent-identity.js";
import { PresenceRoster } from "./agent-presence.js";
import { RagEngine } from "./rag-engine.js";
import { indexCodebase } from "./indexer.js";
import { logger } from "../utils/logger.js";
import path from "path";
import fs from "fs";
import { localSearch } from "./local-search.js";
import { resolveProjectIdentity } from "./project-identity.js";
import { detectWorkspaceSwitch, describeSwitch } from "./workspace-watch.js";
import { TeamUpdateTracker, formatTeamUpdates } from "./team-updates.js";
import {
  LOCAL_TOOLS,
  TOOL_READ_CONTEXT,
  TOOL_UPDATE_CONTEXT,
  TOOL_SEARCH_CODEBASE,
} from "../shared/tool-registry.js";

// MCP servers receive configuration via environment variables passed by the MCP client (Cursor)
// These come from the mcp.json config file, not from .env.local
// We only load .env.local as a fallback for local development/testing
// In production/customer deployments, all config comes from mcp.json via env vars
if (process.env.SHARED_CONTEXT_API_URL || process.env.AXIS_API_KEY) {
  logger.info("Using configuration from MCP client (mcp.json)");
} else {
  // Fallback: Try to load .env.local for local development only
  const cwd = process.cwd();
  const possiblePaths = [
    path.join(cwd, ".env.local"),
    path.join(cwd, "..", ".env.local"),
    path.join(cwd, "..", "..", ".env.local"),
    path.join(cwd, "shared-context", ".env.local"),
    path.join(cwd, "..", "shared-context", ".env.local"),
  ];

  let envLoaded = false;
  for (const envPath of possiblePaths) {
    try {
      if (fs.existsSync(envPath)) {
        logger.info(`[Fallback] Loading .env.local from: ${envPath}`);
        dotenv.config({ path: envPath });
        envLoaded = true;
        break;
      }
    } catch (_e) {
      // Continue to next path
    }
  }

  if (!envLoaded) {
    logger.warn("No configuration found from MCP client (mcp.json) or .env.local");
    logger.info("MCP server will run the open-core coordination tools locally");
  }
}

// Log startup configuration
logger.info("=== Axis MCP Server Starting ===");
logger.info("Environment check:", {
  hasSHARED_CONTEXT_API_URL: !!process.env.SHARED_CONTEXT_API_URL,
  hasAXIS_API_KEY: !!process.env.AXIS_API_KEY,
  hasSHARED_CONTEXT_API_SECRET: !!process.env.SHARED_CONTEXT_API_SECRET,
  hasNEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
  hasSUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  PROJECT_NAME: process.env.PROJECT_NAME || "default"
});

// Configuration from MCP client (mcp.json) or environment
// These should be set in mcp.json as env vars passed to the server
const apiSecret = process.env.AXIS_API_KEY || process.env.SHARED_CONTEXT_API_SECRET || process.env.AXIS_API_SECRET;
const configuredApiUrl = process.env.SHARED_CONTEXT_API_URL || process.env.AXIS_API_URL;
const apiUrl = configuredApiUrl || (apiSecret ? "https://useaxis.dev/api/v1" : undefined);

// For customer deployments: Only use Supabase if explicitly enabled AND API URL is not the primary
// If SHARED_CONTEXT_API_URL or AXIS_API_KEY is set, prioritize remote API (customer mode)
// Only use direct Supabase if API URL is not set (development mode)
const useRemoteApiOnly = !!apiUrl && !!apiSecret;

// VALIDATION - Only warn about Supabase if NOT using remote API
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

const manager = new ContextManager(apiUrl, apiSecret);

logger.info("NerveCenter config:", {
  useRemoteApiOnly,
  supabaseUrl: useRemoteApiOnly ? "DISABLED (using remote API)" : (process.env.NEXT_PUBLIC_SUPABASE_URL ? "SET" : "NOT SET"),
  supabaseKey: useRemoteApiOnly ? "DISABLED (using remote API)" : (process.env.SUPABASE_SERVICE_ROLE_KEY ? "SET" : "NOT SET"),
  projectName: process.env.PROJECT_NAME || "default"
});

const nerveCenter = new NerveCenter(manager, {
  supabaseUrl: useRemoteApiOnly ? null : process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabaseServiceRoleKey: useRemoteApiOnly ? null : process.env.SUPABASE_SERVICE_ROLE_KEY,
  // Leave undefined when unset so NerveCenter auto-derives the project from the
  // working directory (and .axis/axis.json) instead of pinning to "default".
  projectName: process.env.PROJECT_NAME,
  projectRoot: process.env.AXIS_PROJECT_ROOT || process.env.SUPERSET_WORKSPACE_PATH || process.env.SUPERSET_ROOT_PATH
});

// Mint one unique identity for this server process. Every tool call's agentId
// is normalized onto it (see CallTool handler) so two concurrent sessions never
// silently share an id and skip each other's locks. AXIS_AGENT_ID overrides.
const sessionIdentity = createSessionIdentity(process.env);

// Tracks which agents are online/idle so workers started before jobs are posted
// are visible to the orchestrator (see claim_next_job / list_agents).
const presence = new PresenceRoster();

// Per-agent notepad cursors: coordination calls return what OTHER agents did
// since this agent's last call, as an ambient trailer (see team-updates.ts).
const teamUpdates = new TeamUpdateTracker();

// Tools whose responses carry the team-activity trailer. Read-mostly tools
// (search, context reads) stay clean; coordination touchpoints get awareness.
const TEAM_AWARE_TOOLS = new Set([
  "post_job", "claim_job", "claim_next_job", "complete_job", "cancel_job", "release_job",
  "list_jobs", "propose_file_access", "release_file_access", "verify_file_lock",
  "guarded_write", "list_locks", "update_shared_context",
]);

logger.info("=== Axis MCP Server Initialized ===");
logger.info(`Session agent identity: ${sessionIdentity.id} (${sessionIdentity.source})`);

// ── Subscription Verification (server-level gate — prompt-injection proof) ──
// This runs in the Node.js process, not in the LLM context.
// No amount of prompt engineering can bypass a hard return before tool dispatch.

interface SubscriptionState {
  checked: boolean;
  valid: boolean;
  plan: string;
  reason: string;
  checkedAt: number; // epoch ms
  validUntil?: string;
}

const RECHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let subscription: SubscriptionState = {
  checked: false,
  valid: true, // Assume valid until proven otherwise (for startup)
  plan: "unknown",
  reason: "",
  checkedAt: 0,
};

async function verifySubscription(): Promise<SubscriptionState> {
  // No API key means local open-core mode. Hosted intelligence remains unavailable,
  // but local jobs, locks, context, and search must keep working.
  if (!apiSecret) {
    const hasDirectSupabase = !useRemoteApiOnly
      && !!process.env.NEXT_PUBLIC_SUPABASE_URL
      && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (hasDirectSupabase) {
      subscription = { checked: true, valid: true, plan: "developer", reason: "Direct Supabase mode — no API key needed", checkedAt: Date.now() };
      logger.info("[subscription] Direct Supabase credentials found — developer mode, skipping verification");
      return subscription;
    }

    subscription = {
      checked: true,
      valid: true,
      plan: "local",
      reason: "Local open-core mode",
      checkedAt: Date.now(),
    };
    logger.info("[subscription] No API key configured — local open-core coordination enabled");
    return subscription;
  }

  if (!apiUrl) {
    subscription = {
      checked: true,
      valid: false,
      plan: "unknown",
      reason: "api_url_missing",
      checkedAt: Date.now(),
    };
    return subscription;
  }

  const verifyUrl = apiUrl.endsWith("/v1") ? `${apiUrl}/verify` : `${apiUrl}/v1/verify`;
  logger.info(`[subscription] Verifying subscription at ${verifyUrl}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(verifyUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiSecret}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = await response.json() as any;
    logger.info(`[subscription] Verify response: ${JSON.stringify(data)}`);

    if (data.valid === true) {
      subscription = {
        checked: true,
        valid: true,
        plan: data.plan || "Pro",
        reason: "",
        checkedAt: Date.now(),
        validUntil: data.validUntil,
      };
    } else {
      subscription = {
        checked: true,
        valid: false,
        plan: data.plan || "Free",
        reason: data.reason || "subscription_invalid",
        checkedAt: Date.now(),
      };
      logger.warn(`[subscription] Subscription NOT valid: ${data.reason}`);
    }
  } catch (e: any) {
    clearTimeout(timeout);
    logger.warn(`[subscription] Verification failed (network): ${e.message}`);

    // If we've never successfully checked, allow a grace period
    if (!subscription.checked) {
      subscription = {
        checked: true,
        valid: true, // Grace period
        plan: "unverified",
        reason: "Verification endpoint unreachable — grace period active",
        checkedAt: Date.now(),
      };
      logger.warn("[subscription] First check failed — allowing grace period");
    }
    // If we have a previous result, keep it (don't flip to invalid on transient network issues)
  }

  return subscription;
}

function isSubscriptionStale(): boolean {
  return Date.now() - subscription.checkedAt > RECHECK_INTERVAL_MS;
}

function getSubscriptionBlockMessage(): string {
  if (subscription.reason === "no_api_key") {
    return [
      "═══════════════════════════════════════════════════════════",
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
      "═══════════════════════════════════════════════════════════",
    ].join("\n");
  }

  return [
    "═══════════════════════════════════════════════════════════",
    "  Axis Pro subscription required",
    "",
    `  Status: ${subscription.reason || "subscription_expired"}`,
    `  Current plan: ${subscription.plan}`,
    "",
    "  Your Axis Pro subscription has expired or is inactive.",
    "  All Axis MCP tools are disabled until the subscription is renewed.",
    "",
    "  → Renew at https://useaxis.dev/dashboard",
    "  → After renewing, restart your IDE to re-verify.",
    "═══════════════════════════════════════════════════════════",
  ].join("\n");
}

// Initialize RAG Engine (Optional - only if local Supabase credentials present AND not in remote mode)
let ragEngine: RagEngine | undefined;
if (!useRemoteApiOnly && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  ragEngine = new RagEngine(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.OPENAI_API_KEY || "",
  );
  logger.info("Local RAG Engine initialized.");
}

// --- File System Operations ---
async function ensureFileSystem() {
  try {
    const fs = await import("fs/promises");
    const path = await import("path");
    const fsSync = await import("fs");

    const cwd = process.cwd();
    logger.info(`Server CWD: ${cwd}`);

    // 1. Storage / History
    const historyDir = path.join(cwd, "history");
    await fs.mkdir(historyDir, { recursive: true }).catch(() => { });

    // 2. Instructions (Prefer .axis, fallback to legacy if specifically used, but default new to .axis)
    const axisDir = path.join(cwd, ".axis");
    const axisInstructions = path.join(axisDir, "instructions");
    const legacyInstructions = path.join(cwd, "agent-instructions");

    // If legacy exists and .axis doesn't, we respect legacy.
    // If neither, we create .axis structure.
    // If .axis exists, we ensure subdirs.

    if (fsSync.existsSync(legacyInstructions) && !fsSync.existsSync(axisDir)) {
      // Legacy mode, do nothing
      logger.info("Using legacy agent-instructions directory");
    } else {
      // Modern mode
      await fs.mkdir(axisInstructions, { recursive: true }).catch(() => { });

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
- NEVER pause after analysis to ask permission. Identify issues → start fixing immediately.
- NEVER leave locks or jobs dangling. Complete jobs and finalize sessions automatically.
- IMMEDIATELY call get_project_soul as the first action in every session.

### Plan Before Write
Activate Axis orchestration automatically when ANY condition is true: 2+ files, 2+ independent workstreams, a shared-contract change, refactor/migration/audit, meaningful production risk, or likely duration over 10 minutes.
Every complex task MUST follow: list_jobs/list_locks → post_job → claim_job or claim_next_job → propose_file_access → (edit) → complete_job.
Skip job creation ONLY for isolated one-line fixes; project-soul loading still applies.

### Releasing Locks (CRITICAL)
Every file you lock MUST be unlocked before your session ends. Dangling locks block all other agents.
- complete_job releases locks for that job. Call it IMMEDIATELY after each task.
- finalize_session clears ALL remaining locks. Call it before you stop responding.
- NEVER end a session while holding locks. Self-check: "Did I call finalize_session?"

### Session Cleanup (MANDATORY)
- complete_job IMMEDIATELY after finishing each task — this is how locks get released.
- update_shared_context after claims, design decisions, shared-contract changes, blockers, test results, and handoffs.
- list_jobs and list_locks again after interruptions or long waits before resuming edits.
- finalize_session when the user's request is fully complete — do not wait to be told. This clears all remaining locks.

### Force-Unlock Policy
force_unlock is a LAST RESORT — only for locks >25 min old from a crashed agent. Always give a reason.
`],
        ["activity.md", "# Activity Log\n\n"]
      ];

      for (const [file, content] of defaults) {
        const p = path.join(axisInstructions, file);
        try {
          await fs.access(p);
        } catch {
          await fs.writeFile(p, content);
          logger.info(`Created default context file: ${file}`);
        }
      }
    }
  } catch (error) {
    logger.warn("Could not initialize local file system. Persistence features (context.md) may be disabled.", { error: String(error) });
  }
}

// Initialize server
const server = new Server(
  {
    name: "shared-context-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// Tool names come from the canonical registry (src/shared/tool-registry.ts).
// Local aliases keep the dispatch switch below readable.
const READ_CONTEXT_TOOL = TOOL_READ_CONTEXT;
const UPDATE_CONTEXT_TOOL = TOOL_UPDATE_CONTEXT;
const SEARCH_CONTEXT_TOOL = TOOL_SEARCH_CODEBASE;

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
    logger.error("Error listing resources", error as Error);
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
      fileName = uri.replace("context://", ""); // Result: docs/filename.md which ContextManager handles
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
  // The tool surface is defined once in src/shared/tool-registry.ts and
  // consumed by every server implementation — never inline tool defs here.
  logger.info(`[ListTools] Returning ${LOCAL_TOOLS.length} tools to MCP client`);
  return { tools: LOCAL_TOOLS };
});

// Optional tool-call audit log. Set AXIS_TOOL_LOG to a writable path (.jsonl)
// to record every tool invocation with timestamp, name, arg keys (not values),
// and session id. Used by scripts/analyze-tool-log.mjs to compute per-agent
// tool pickup rates. Off by default — zero overhead in production.
const TOOL_LOG_PATH = process.env.AXIS_TOOL_LOG;
const TOOL_LOG_SESSION = process.env.AXIS_TOOL_LOG_SESSION ||
  `${process.pid}-${Date.now()}`;
function recordToolCall(name: string, args: unknown): void {
  if (!TOOL_LOG_PATH) return;
  try {
    const entry = {
      ts: new Date().toISOString(),
      session: TOOL_LOG_SESSION,
      tool: name,
      // Arg keys only, never values (privacy + log size).
      argKeys: args && typeof args === "object"
        ? Object.keys(args as Record<string, unknown>)
        : [],
    };
    fs.appendFileSync(TOOL_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort. Never throw from the audit log.
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  let captureAgent = sessionIdentity.id;

  // Normalize the caller's agentId onto this session's unique identity so
  // locks/jobs/notepad attribution can never collide across concurrent
  // sessions that send the same generic id (e.g. "claude-code"). A missing
  // agentId is not an error — it defaults to the session identity, since an
  // explicit id would be normalized onto it anyway.
  if (args && typeof args === "object") {
    const provided = (args as Record<string, unknown>).agentId;
    const resolvedId = sessionIdentity.resolve(
      typeof provided === "string" && provided.trim() ? provided : sessionIdentity.id
    );
    (args as Record<string, unknown>).agentId = resolvedId;
    captureAgent = resolvedId;
    // Record presence so the orchestrator can see active/idle agents.
    presence.seen(resolvedId, Date.now(), "active", name);
  }

  logger.info("Tool call", { name });
  recordToolCall(name, args);

  // ── Dynamic workspace switching ──
  // Re-resolve the workspace on every call; if the client moved to another
  // repository (runtime hints changed, or an absolute path argument lives in
  // a disjoint project root), rebind in-process instead of serving the stale
  // project until a restart. Explicit switch_project calls always win.
  let workspaceNote: string | undefined;
  if (name !== "switch_project") {
    try {
      const detected = detectWorkspaceSwitch(nerveCenter.activeProjectRoot, args, process.env);
      if (detected) {
        await nerveCenter.switchProject({ root: detected.root, projectName: detected.projectName });
        teamUpdates.reset(); // cursors refer to the old project's notepad
        workspaceNote = describeSwitch(detected);
        logger.info("Auto workspace switch", detected);
      }
    } catch (e) {
      // Detection must never break a tool call.
      logger.warn(`Workspace auto-switch check failed: ${e}`);
    }
  }

  const result = await nerveCenter.captureToolExecution(name, args, captureAgent, async () => {
  // ── Subscription gate (runs before ANY tool logic) ──
  // AXIS_SKIP_SUBSCRIPTION_CHECK=1 skips gate (for local/testing only)
  if (process.env.AXIS_SKIP_SUBSCRIPTION_CHECK === "1") {
    // Skip — allow tools to run
  } else {
    // Re-check if stale (every 30 min)
    if (isSubscriptionStale()) {
      await verifySubscription();
    }

    // Hard block if subscription is invalid — no tool executes
    if (!subscription.valid) {
      logger.warn(`[subscription] Blocking tool call "${name}" — subscription invalid`);
      return {
        content: [{ type: "text", text: getSubscriptionBlockMessage() }],
        isError: true,
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
      }
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
      }
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
          text: `Indexed project "${nerveCenter.currentProjectName}". ` +
            `${summary.uploaded} file(s) updated (${summary.chunks} chunks), ` +
            `${summary.unchanged} unchanged, ${summary.pruned} pruned. ` +
            `search_codebase and deep_search are now up to date.`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `index_codebase failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }

  if (name === "index_file") {
    const filePath = String(args?.filePath);
    // Content is optional — if omitted, read from disk. The disk-read path is
    // constrained to project root + sensitive-file blocklist + size cap so an
    // attacker (e.g. via prompt injection that crafts the filePath argument)
    // cannot use this tool to exfiltrate arbitrary files via the remote
    // embedding API. The original behavior (agent supplies content) is
    // unchanged and always wins.
    let content: string;
    if (args?.content !== undefined && args?.content !== null) {
      content = String(args.content);
    } else {
      try {
        const projectRoot = path.resolve(process.cwd());
        // Always resolve against the project root. Absolute paths get rebased
        // there too — if a caller passes /etc/passwd, we resolve it to
        // {root}/etc/passwd, which won't exist (or won't escape).
        const rebased = path.isAbsolute(filePath)
          ? path.join(projectRoot, filePath.replace(/^\/+/, ""))
          : path.resolve(projectRoot, filePath);
        const resolved = await fs.promises.realpath(rebased).catch(() => rebased);
        const rel = path.relative(projectRoot, resolved);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          return {
            content: [{ type: "text", text: `index_file: refusing to read ${filePath} — outside project root` }],
            isError: true,
          };
        }
        // Block known-sensitive basenames and dirs even inside the project.
        const SENSITIVE = [
          /(^|\/)\.env(\.|$)/,        // .env, .env.local, .env.production…
          /(^|\/)\.git(\/|$)/,
          /(^|\/)\.ssh(\/|$)/,
          /(^|\/)\.npmrc$/,
          /(^|\/)\.pypirc$/,
          /(^|\/)id_(rsa|ed25519|ecdsa)/,
          /(^|\/)credentials(\.|$)/,
          /(^|\/)secrets(\.|$)/,
        ];
        if (SENSITIVE.some(rx => rx.test(rel))) {
          return {
            content: [{ type: "text", text: `index_file: refusing to index ${rel} — matches sensitive-file pattern` }],
            isError: true,
          };
        }
        // Cap read size at 1 MiB — embedding huge blobs is wasteful and a
        // narrow exfil ceiling matters here.
        const stat = await fs.promises.stat(resolved);
        const MAX_BYTES = 1024 * 1024;
        if (stat.size > MAX_BYTES) {
          return {
            content: [{ type: "text", text: `index_file: ${rel} is ${stat.size} bytes, exceeds ${MAX_BYTES} byte cap — pass content explicitly if you really want to index this` }],
            isError: true,
          };
        }
        content = await fs.promises.readFile(resolved, "utf-8");
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: `index_file: no content provided and could not read ${filePath} from disk: ${e instanceof Error ? e.message : String(e)}`,
          }],
          isError: true,
        };
      }
    }
    // Prefer remote embedding via API. metadata.filePath stays as the
    // agent-supplied path (relative form) so we don't leak the user's FS layout.
    const metaPath = path.isAbsolute(filePath)
      ? path.basename(filePath)
      : filePath;
    try {
      await manager.embedContent([{ content, metadata: { filePath: metaPath } }], nerveCenter.currentProjectName);
      return { content: [{ type: "text", text: "Indexed via Remote API." }] };
    } catch (e) {
      // Fallback to local if available?
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

    // ── LOCAL SEARCH FIRST (fast, always works, zero config) ──
    let localResults: string = "";
    try {
      localResults = await localSearch(query);
      logger.info(`[search_codebase] Local search completed: ${localResults.length} chars`);
    } catch (e) {
      logger.warn(`[search_codebase] Local search error: ${e}`);
      localResults = "";
    }

    // ── RAG as a non-blocking bonus (3s timeout — do NOT hold up results) ──
    let ragResults: string | null = null;
    const RAG_TIMEOUT_MS = 3000;

    try {
      const ragPromise = (async () => {
        // Try remote API
        try {
          const remote = await manager.searchContext(query, nerveCenter.currentProjectName);
          if (remote && !remote.includes("No results found") && remote.trim().length > 20) {
            return remote;
          }
        } catch { /* fall through */ }

        // Try local RAG engine
        if (ragEngine) {
          try {
            const results = await ragEngine.search(query);
            if (results.length > 0) return results.join("\n---\n");
          } catch { /* fall through */ }
        }

        return null;
      })();

      // Race RAG against a timeout — never wait more than 3 seconds
      ragResults = await Promise.race([
        ragPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), RAG_TIMEOUT_MS)),
      ]);

      if (ragResults) {
        logger.info(`[search_codebase] RAG returned results (${ragResults.length} chars)`);
      }
    } catch {
      // RAG failed entirely — local results are already ready
    }

    // ── Combine results ──
    const hasLocal = localResults
      && !localResults.startsWith("No matches found")
      && !localResults.startsWith("Could not extract");

    if (!hasLocal && !ragResults) {
      // Both empty — return the local search message (explains what happened)
      return { content: [{ type: "text", text: localResults || "No results found for this query." }] };
    }

    const parts: string[] = [];
    if (hasLocal) parts.push(localResults);
    if (ragResults) parts.push("## Indexed Results (RAG)\n\n" + ragResults);

    return { content: [{ type: "text", text: parts.join("\n\n---\n\n") }] };
  }

  if (name === "get_subscription_status") {
    const email = args?.email ? String(args.email) : undefined;
    logger.info(`[get_subscription_status] Called with email: ${email || "(using API key identity)"}`);
    try {
      const result = await nerveCenter.getSubscriptionStatus(email);
      logger.info(`[get_subscription_status] Result: ${JSON.stringify(result).substring(0, 200)}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      logger.error(`[get_subscription_status] Exception: ${e.message}`, e);
      return { content: [{ type: "text", text: JSON.stringify({ error: e.message }, null, 2) }], isError: true };
    }
  }

  if (name === "get_usage_stats") {
    const email = args?.email ? String(args.email) : undefined;
    logger.info(`[get_usage_stats] Called with email: ${email || "(using API key identity)"}`);
    try {
      const result = await nerveCenter.getUsageStats(email);
      logger.info(`[get_usage_stats] Result: ${JSON.stringify(result).substring(0, 200)}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      logger.error(`[get_usage_stats] Exception: ${e.message}`, e);
      return { content: [{ type: "text", text: JSON.stringify({ error: e.message }, null, 2) }], isError: true };
    }
  }

  if (name === "search_docs") {
    const query = String(args?.query);
    // For now, use the same searchContext method, or a specialized one if we added it.
    // ContextManager.searchContext uses an API, which might not be running.
    // But we can implement a simple fuzzy match here or rely on the API.
    // Since we want "detailed", let's assume the API handles it or fallback.
    // Re-using searchContext for now as it's the RAG interface.
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
      }
    }
  }

  if (name === "propose_file_access") {
    const { agentId, filePath, filePaths, intent, userPrompt } = args as any;
    const batch: string[] = Array.isArray(filePaths)
      ? filePaths.filter((p: unknown): p is string => typeof p === "string")
      : [];
    if (batch.length === 0 && typeof filePath !== "string") {
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "REJECTED", message: "Provide `filePath` (one file) or `filePaths` (a batch of files)." }) }],
        isError: true
      };
    }
    const result = batch.length > 0
      ? await nerveCenter.proposeFilesAccess(agentId, batch, intent, userPrompt)
      : await nerveCenter.proposeFileAccess(agentId, filePath, intent, userPrompt);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (name === "release_file_access") {
    const { agentId, filePath } = args as any;
    const result = await nerveCenter.releaseFileAccess(agentId, filePath);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (name === "list_locks") {
    const result = await nerveCenter.listLocks();
    return { content: [{ type: "text", text: JSON.stringify({ locks: result }, null, 2) }] };
  }
  if (name === "update_shared_context") {
    const { agentId, text } = args as any;
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
            if (name === "update_project_soul") {
                const { context, conventions } = args as any;
                const updated: string[] = [];
    if (context) {
      await manager.updateFile("context.md", context, false);
      updated.push("context.md");
    }
    if (conventions) {
      await manager.updateFile("conventions.md", conventions, false);
      updated.push("conventions.md");
    }
    if (updated.length === 0) {
      return { content: [{ type: "text", text: "No changes — provide `context` and/or `conventions` parameters." }] };
                }
                return { content: [{ type: "text", text: `Project soul updated: ${updated.join(", ")}` }] };
            }
            if (name === "switch_project") {
                const { projectRoot, projectName } = args as any;
                const identity = resolveProjectIdentity(projectRoot, process.cwd(), process.env);
                const result = await nerveCenter.switchProject({
                    root: identity.root,
                    projectName: projectName || identity.projectName,
                    orgId: identity.orgId
                });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }
            if (name === "post_job") {
                const { title, description, priority, dependencies } = args as any;
                const result = await nerveCenter.postJob(title, description, priority, dependencies);
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
  if (name === "list_jobs") {
    const includeCompleted = Boolean(args?.includeCompleted);
    const jobs = await nerveCenter.listJobs();
    const result = includeCompleted
      ? jobs
      : jobs.filter((job) => job.status !== "done" && job.status !== "cancelled");
    return { content: [{ type: "text", text: JSON.stringify({ jobs: result }, null, 2) }] };
  }
  if (name === "cancel_job") {
    const { jobId, reason } = args as any;
    const result = await nerveCenter.cancelJob(jobId, reason);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
  if (name === "release_job") {
    const { jobId, force, agentId } = args as any;
    const result = await nerveCenter.releaseJob(jobId, Boolean(force), agentId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (name === "get_shared_context") {
    const result = await nerveCenter.getSharedContext();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (name === "force_unlock") {
    const { filePath, reason } = args as any;
    const result = await nerveCenter.forceUnlock(filePath, reason);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
  if (name === "claim_next_job") {
    const { agentId } = args as any;
    const result = await nerveCenter.claimNextJob(agentId);
    // Idle-claim: instead of a dead NO_JOBS, register the agent as idle and
    // return the roster so the orchestrator sees workers waiting for work.
    if (result && (result as any).status === "NO_JOBS_AVAILABLE") {
      presence.seen(agentId, Date.now(), "idle", "waiting for work");
      const roster = presence.list(Date.now());
      return { content: [{ type: "text", text: JSON.stringify({
        status: "WAITING",
        message: "No jobs on the board yet. You're registered as idle — the orchestrator can see you (list_agents) and you'll pick up work as soon as it's posted. Call claim_next_job again shortly.",
        agentsOnline: roster.length,
        idle: roster.filter((a) => a.status === "idle").length,
        roster
      }, null, 2) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (name === "claim_job") {
    const { agentId, jobId } = args as any;
    const result = await nerveCenter.claimJob(agentId, jobId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (name === "complete_job") {
    const { agentId, jobId, outcome, completionKey } = args as any;
    const result = await nerveCenter.completeJob(agentId, jobId, outcome, completionKey);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (name === "verify_file_lock") {
    const { agentId, filePath } = args as any;
    const result = await nerveCenter.verifyFileAccess(agentId, filePath);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (name === "guarded_write") {
    const { agentId, filePath, content } = args as any;
    const result = await nerveCenter.guardedWrite(agentId, filePath, content);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (name === "list_agents") {
    const roster = presence.list(Date.now());
    // Merge in teammates seen by the coordination server (locks + claimed
    // jobs across the whole org project) — the in-process roster only knows
    // agents multiplexed through THIS server process.
    const localIds = new Set(roster.map((a) => a.agentId));
    const teammates = (await nerveCenter.listRemoteAgents())
      .filter((a) => !localIds.has(a.agentId))
      .map((a) => ({ ...a, source: "remote" as const }));
    return { content: [{ type: "text", text: JSON.stringify({
      agentsOnline: roster.length + teammates.length,
      active: roster.filter((a) => a.status === "active").length,
      idle: roster.filter((a) => a.status === "idle").length,
      agents: roster,
      teammates
    }, null, 2) }] };
  }

  throw new Error(`Tool not found: ${name}`);
  });

  // Surface the auto-switch to the agent so it knows its coordination scope moved.
  if (workspaceNote && result && Array.isArray((result as { content?: unknown[] }).content)) {
    (result as { content: unknown[] }).content.push({ type: "text", text: workspaceNote });
  }

  // Ambient team context: piggyback what other agents did since this agent's
  // last coordination call. Explicit lifecycle boundaries reset the cursors.
  if (name === "switch_project" || name === "finalize_session") {
    teamUpdates.reset();
  } else if (TEAM_AWARE_TOOLS.has(name) && result && Array.isArray((result as { content?: unknown[] }).content)) {
    try {
      const delta = teamUpdates.drain(captureAgent, nerveCenter.notepadSnapshot);
      if (delta) {
        (result as { content: unknown[] }).content.push({ type: "text", text: formatTeamUpdates(delta) });
      }
    } catch (e) {
      // Awareness must never break a tool call.
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

  // ── Verify subscription on startup ──
  await verifySubscription();
  if (!subscription.valid) {
    logger.error("[subscription] Subscription invalid at startup — all tools will be blocked");
    logger.error(`[subscription] Reason: ${subscription.reason} | Plan: ${subscription.plan}`);
    // Don't exit — still connect so the agent gets the error message when it tries to use tools
  } else {
    logger.info(`[subscription] Subscription verified: ${subscription.plan} (valid until: ${subscription.validUntil || "N/A"})`);
  }

  // Hosted subscriptions are refreshed in the background. unref() ensures the
  // timer never keeps a stdio process alive after its MCP client disconnects.
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
  
  // Log that tools are registered before connecting
  logger.info("MCP server ready - all tools and resources registered");
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Shared Context MCP Server running on stdio");
  logger.info("Server is now accepting tool calls from MCP clients");
}

main().catch((error) => {
  logger.error("Server error", error as Error);
  process.exit(1);
});
