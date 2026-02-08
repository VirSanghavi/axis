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
import { RagEngine } from "./rag-engine.js";
import { logger } from "../utils/logger.js";
import path from "path";
import fs from "fs";

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
    } catch (e) {
      // Continue to next path
    }
  }

  if (!envLoaded) {
    logger.warn("No configuration found from MCP client (mcp.json) or .env.local");
    logger.warn("MCP server will use default API URL: https://aicontext.vercel.app/api/v1");
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

// VALIDATION
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  logger.warn("Supabase credentials missing. RAG & Persistence disabled. Running in local/ephemeral mode.");
}

// Configuration from MCP client (mcp.json) or environment
// These should be set in mcp.json as env vars passed to the server
const apiUrl = process.env.SHARED_CONTEXT_API_URL || process.env.AXIS_API_URL || "https://aicontext.vercel.app/api/v1";
const apiSecret = process.env.AXIS_API_KEY || process.env.SHARED_CONTEXT_API_SECRET || process.env.AXIS_API_SECRET;

logger.info("ContextManager config:", {
  apiUrl,
  hasApiSecret: !!apiSecret,
  apiSecretPrefix: apiSecret ? apiSecret.substring(0, 10) + "..." : "NOT SET",
  source: (process.env.SHARED_CONTEXT_API_URL || process.env.AXIS_API_KEY) ? "MCP config (mcp.json)" : "default/fallback"
});

const manager = new ContextManager(apiUrl, apiSecret);

// For customer deployments: Only use Supabase if explicitly enabled AND API URL is not the primary
// If SHARED_CONTEXT_API_URL is set, prioritize remote API (customer mode)
// Only use direct Supabase if API URL is not set (development mode)
const useRemoteApiOnly = !!process.env.SHARED_CONTEXT_API_URL || !!process.env.AXIS_API_KEY;

logger.info("NerveCenter config:", {
  useRemoteApiOnly,
  supabaseUrl: useRemoteApiOnly ? "DISABLED (using remote API)" : (process.env.NEXT_PUBLIC_SUPABASE_URL ? "SET" : "NOT SET"),
  supabaseKey: useRemoteApiOnly ? "DISABLED (using remote API)" : (process.env.SUPABASE_SERVICE_ROLE_KEY ? "SET" : "NOT SET"),
  projectName: process.env.PROJECT_NAME || "default"
});

const nerveCenter = new NerveCenter(manager, {
  supabaseUrl: useRemoteApiOnly ? null : process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabaseServiceRoleKey: useRemoteApiOnly ? null : process.env.SUPABASE_SERVICE_ROLE_KEY,
  projectName: process.env.PROJECT_NAME || "default"
});

logger.info("=== Axis MCP Server Initialized ===");

// Initialize RAG Engine
// Initialize RAG Engine (Optional - only if local credentials present)
let ragEngine: RagEngine | undefined;
if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  ragEngine = new RagEngine(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.OPENAI_API_KEY || "",
  );
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
        ["context.md", "# Project Context\n\n"],
        ["conventions.md", "# Coding Conventions\n\n"],
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
    return {
      resources: [
        {
          uri: "mcp://context/current",
          name: "Live Session Context",
          mimeType: "text/markdown",
          description: "The realtime state of the Nerve Center (Notepad + Locks)"
        },
        ...(await manager.listFiles())
      ]
    };
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
  return {
    tools: [
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
        description: "**APPEND OR OVERWRITE** shared context files.\n- Use this to update the project's long-term memory (e.g., adding a new convention, updating the architectural goal).\n- For short-term updates (like 'I just fixed bug X'), use `update_shared_context` (Notepad) instead.\n- Supports `append: true` (default: false) to add to the end of a file.",
        inputSchema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "File to update (e.g. 'activity.md')" },
            content: { type: "string", description: "The new content to write or append." },
            append: { type: "boolean", description: "Whether to append to the end of the file (true) or overwrite it (false). Default: false." }
          },
          required: ["filename", "content"],
        },
      },
      {
        name: SEARCH_CONTEXT_TOOL,
        description: "**SEMANTIC SEARCH** for the codebase.\n- Uses vector similarity to find relevant code snippets or documentation.\n- Best for: 'Where is the auth logic?', 'How do I handle billing?', 'Find the class that manages locks'.\n- Note: This searches *indexed* content only. For exact string matches, use `grep` (if available) or `warpgrep`.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural language search query." },
          },
          required: ["query"],
        },
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
    ],
  };
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

  if (name === "index_file") {
    const filePath = String(args?.filePath);
    const content = String(args?.content);
    // Prefer remote embedding via API
    try {
      await manager.embedContent([{ content, metadata: { filePath } }], nerveCenter.currentProjectName);
      return { content: [{ type: "text", text: "Indexed via Remote API." }] };
    } catch (e) {
      // Fallback to local if available?
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
    } catch (e: any) {
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
  if (name === "post_job") {
    const { title, description, priority, dependencies } = args as any;
    const result = await nerveCenter.postJob(title, description, priority, dependencies);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Shared Context MCP Server running on stdio");
}

main().catch((error) => {
  logger.error("Server error", error as Error);
  process.exit(1);
});
