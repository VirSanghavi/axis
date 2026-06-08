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
import { RagEngine } from "./rag-engine.js";
import { indexCodebase } from "./indexer.js";
import { logger } from "../utils/logger.js";
import path from "path";
import fs from "fs";
import { localSearch } from "./local-search.js";
import { resolveProjectIdentity } from "./project-identity.js";

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

// Tools
const READ_CONTEXT_TOOL = "read_context";
const UPDATE_CONTEXT_TOOL = "update_context";
const SEARCH_CONTEXT_TOOL = "search_codebase"; // Renamed for clarity

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
        },
      },
      {
        name: UPDATE_CONTEXT_TOOL,
        description: "**APPEND OR OVERWRITE** any shared context file.\n- To update the project soul (context.md / conventions.md), prefer `update_project_soul` instead — it handles both files in one call.\n- Use this tool for other context files (e.g., `activity.md`) or when you need to append to a file.\n- For short-term updates (like 'I just fixed bug X'), use `update_shared_context` (Notepad) instead.\n- Supports `append: true` (default: false) to add to the end of a file.",
        inputSchema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "File to update (e.g. 'activity.md'). For soul files, prefer update_project_soul instead." },
            content: { type: "string", description: "The new content to write or append." },
            append: { type: "boolean", description: "Whether to append to the end of the file (true) or overwrite it (false). Default: false." }
          },
          required: ["filename", "content"],
        },
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
        description: "**CODE INTELLIGENCE SEARCH** — does what plain grep can't: returns ranked `file:line` hits PLUS `related` files that historically co-change with each hit, PLUS `definitions` of what the top result calls.\n- Use for 'where is X', 'how is Y done', anything before refactoring, and any time you need to know what code is structurally connected to a match (not just textually present).\n- Hybrid: semantic + full-text + trigram, reranked. Falls back to instant local search offline.\n- For pure literal-string lookups (a specific token or filename), grep is fine — this tool's edge is the related/definitions enrichment.",
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
        description: "**INDEX THE REPO FOR SEARCH**: Walk the project, content-hash every file, and sync changed files into the searchable index so `search_codebase`/`deep_search` work and stay fresh.\n- Incremental: unchanged files are skipped (no re-embedding), deleted files are pruned. Safe and cheap to run often.\n- Run this once to set up search on a new project, and after large changes (e.g. a git pull) to refresh. Single-file edits are picked up by `index_file`.\n- Respects .gitignore and skips binaries/large files. Takes no arguments — it indexes the current project root.",
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
        description: "**CRITICAL: REQUEST FILE LOCK** — call this before EVERY file edit, no exceptions.\n- Returns `GRANTED` if safe to proceed, `REQUIRES_ORCHESTRATION` if another agent holds the lock, or `REJECTED` if you tried to lock a directory.\n- **Lock individual files, not directories.** Directory locks block parallel work and are rejected.\n- Paths can be absolute or relative — they're normalized against the project root.\n- Required: `agentId` (e.g. 'cursor-agent'), `filePath`, and `intent` (descriptive — 'Refactor auth to use JWT', NOT 'editing file').\n- Locks expire after 30 minutes. Use `force_unlock` only as a last resort for crashed agents.\n- **Every lock MUST be released.** `complete_job` releases the locks for that job; `finalize_session` releases everything. Dangling locks block all other agents.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            filePath: { type: "string" },
            intent: { type: "string" },
            userPrompt: { type: "string", description: "Optional. The user prompt that triggered this lock, for audit trails. Server captures it best-effort if omitted." }
          },
          required: ["agentId", "filePath", "intent"]
        }
      },
      {
        name: "release_file_access",
        description: "**RELEASE YOUR LOCK**: Release one file lock as soon as you no longer need it.\n- Use this before a job is complete when another agent can safely continue on the file.\n- Only the owning agent can release the lock; use `force_unlock` only for a crashed agent.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            filePath: { type: "string" }
          },
          required: ["agentId", "filePath"]
        }
      },
      {
        name: "list_locks",
        description: "**INSPECT ACTIVE LOCKS**: Return current file locks, owners, intents, and timestamps.\n- Call before planning overlapping work or when a lock conflict needs coordination.",
        inputSchema: { type: "object", properties: {}, required: [] }
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
        description: "**MANDATORY SESSION CLEANUP** — call this automatically when the user's request is fully complete.\n- Archives the current Live Notepad to a permanent session log.\n- **Clears ALL active file locks** and completed jobs. This is your safety net to ensure no dangling locks.\n- Resets the Live Notepad for the next session.\n- Do NOT wait for the user to say 'we are done.' When all tasks are finished, call this yourself.\n- **CRITICAL**: You MUST call this before ending ANY session. Failing to do so leaves file locks that block all other agents.",
        inputSchema: { type: "object", properties: {}, required: [] }
      },
      {
        name: "get_project_soul",
        description: "**MANDATORY FIRST CALL**: Returns the project's goals, architecture, conventions, and active state.\n- Combines `context.md` (project goals/architecture) and `conventions.md` (coding standards/norms) into a single prompt.\n- You MUST call this as your FIRST action in every new session or task — before reading files, before responding to the user, before anything else.\n- If the project soul is not yet filled (you'll see a 'MANDATORY: Project soul is not yet filled' message), you MUST fill it before any other work:\n  1. Use `search_codebase` to explore the repo and infer project details.\n  2. Call `update_project_soul` with `context` and/or `conventions` params to populate the soul in one call.\n  3. If there is nothing to search, ask the user what the project is about, then call `update_project_soul`.\n- Skipping this call means you are working without context and will make wrong decisions.",
        inputSchema: { type: "object", properties: {}, required: [] }
      },
      {
        name: "update_project_soul",
        description: "**UPDATE THE PROJECT SOUL** — write project context and/or conventions in a single call.\n- The project soul consists of `context.md` (goals, architecture, core features) and `conventions.md` (coding standards, agent norms).\n- Provide `context` to update `context.md`, `conventions` to update `conventions.md`, or both.\n- Use this when `get_project_soul` says the soul is unfilled, or whenever you need to update long-term project knowledge.\n- This replaces the file contents entirely (not append). For appending, use `update_context` instead.",
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
            agentId: { type: "string" }
          },
          required: ["agentId"]
        }
      },
      {
        name: "claim_job",
        description: "**CLAIM A SPECIFIC TICKET**: Atomically claim a known job by ID.\n- Prefer this over `claim_next_job` when work has been intentionally assigned or agents have disjoint scopes.\n- Rejects completed, already claimed, or dependency-blocked jobs.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            jobId: { type: "string" }
          },
          required: ["agentId", "jobId"]
        }
      },
      {
        name: "complete_job",
        description: "**CLOSE TICKET**: Mark a job as done and release file locks.\n- Call this IMMEDIATELY after finishing each job — do not accumulate completed-but-unclosed jobs.\n- Requires `outcome` (what was done).\n- If you are not the assigned agent, you must provide the `completionKey`.\n- **This is the primary way to release file locks.** Leaving jobs open holds locks and blocks other agents.\n- REMINDER: After completing all jobs, you MUST also call `finalize_session` to clear any remaining locks.",
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
        description: "**UPDATE SEARCH INDEX**: Add or refresh a single file in the RAG vector database.\n- Call this immediately after creating a new file or significantly refactoring an existing one — keeps `search_codebase` results fresh.\n- Only `filePath` is required. If you omit `content`, the server reads the file from disk itself — preferred, since it avoids round-tripping large file bodies through the tool call.\n- Pass `content` explicitly only when indexing material that doesn't live on disk (e.g. in-memory generated source).",
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

  // Normalize the caller's agentId onto this session's unique identity so
  // locks/jobs/notepad attribution can never collide across concurrent
  // sessions that send the same generic id (e.g. "claude-code").
  if (args && typeof (args as Record<string, unknown>).agentId === "string") {
    (args as Record<string, unknown>).agentId = sessionIdentity.resolve(
      (args as Record<string, unknown>).agentId as string
    );
  }

  logger.info("Tool call", { name });
  recordToolCall(name, args);

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
    const { agentId, filePath, intent, userPrompt } = args as any;
    const result = await nerveCenter.proposeFileAccess(agentId, filePath, intent, userPrompt);
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
                    projectName: projectName || identity.projectName
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
  if (name === "force_unlock") {
    const { filePath, reason } = args as any;
    const result = await nerveCenter.forceUnlock(filePath, reason);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
  if (name === "claim_next_job") {
    const { agentId } = args as any;
    const result = await nerveCenter.claimNextJob(agentId);
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

  throw new Error(`Tool not found: ${name}`);
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
