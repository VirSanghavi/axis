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
import { logger } from "../utils/logger.js";

// Load environment variables
dotenv.config({ path: ".env.local" });

// Configuration
const manager = new ContextManager(
  process.env.SHARED_CONTEXT_API_URL,
  process.env.SHARED_CONTEXT_API_SECRET
);
const nerveCenter = new NerveCenter(manager);

// --- File System Operations ---
const REQUIRED_DIRS = ["agent-instructions", "history"];
async function ensureFileSystem() {
  const fs = await import("fs/promises");
  const path = await import("path");

  for (const d of REQUIRED_DIRS) {
    const dirPath = path.join(process.cwd(), d);
    try {
      await fs.access(dirPath);
    } catch {
      logger.info("Creating required directory", { dir: d });
      await fs.mkdir(dirPath, { recursive: true });
      if (d === "agent-instructions") {
        await fs.writeFile(path.join(dirPath, "context.md"), "# Project Context\n\n");
        await fs.writeFile(path.join(dirPath, "conventions.md"), "# Coding Conventions\n\n");
        await fs.writeFile(path.join(dirPath, "activity.md"), "# Activity Log\n\n");
      }
    }
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
const SEARCH_CONTEXT_TOOL = "search_context";

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
          text: await nerveCenter.getLiveContext()
        }]
      };
    }
    const fileName = uri.replace("context://local/", "");
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
        description: "Read the shared context files (context.md, conventions.md, activity.md)",
        inputSchema: {
          type: "object",
          properties: {
             filename: { type: "string", description: "The name of the file to read (e.g., 'context.md')" }
          },
          required: ["filename"]
        },
      },
      {
        name: UPDATE_CONTEXT_TOOL,
        description: "Update a shared context file",
        inputSchema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "File to update" },
            content: { type: "string", description: "New content" },
            append: { type: "boolean", description: "Whether to append or overwrite (default: overwrite)" }
          },
          required: ["filename", "content"],
        },
      },
      {
        name: SEARCH_CONTEXT_TOOL,
        description: "Search shared context using RAG (Remote API)",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
          },
          required: ["query"],
        },
      },
      // --- Decision & Orchestration ---
      {
        name: "propose_file_access",
        description: "Request a lock on a file. Checks for conflicts with other agents.",
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
        description: "Write to the in-memory Live Notepad.",
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
        description: "End the session, archive the notepad, and clear locks.",
        inputSchema: { type: "object", properties: {}, required: [] }
      },
      {
        name: "get_project_soul",
        description: "Get high-level project goals and context.",
        inputSchema: { type: "object", properties: {}, required: [] }
      },
      // --- Job Board (Task Orchestration) ---
      {
        name: "post_job",
        description: "Post a new job/ticket. Supports priority and dependencies.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
            dependencies: { type: "array", items: { type: "string" } }
          },
          required: ["title", "description"]
        }
      },
      {
        name: "cancel_job",
        description: "Cancel a job that is no longer needed.",
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
        description: "Admin tool to forcibly remove a lock from a file.",
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
        description: "Auto-assign the next available 'todo' job to yourself.",
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
        description: "Mark your assigned job as done.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            jobId: { type: "string" },
            outcome: { type: "string" }
          },
          required: ["agentId", "jobId", "outcome"]
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

  if (name === SEARCH_CONTEXT_TOOL) {
     const query = String(args?.query);
     try {
       const formatted = await manager.searchContext(query);
       return { content: [{ type: "text", text: formatted }] };
     } catch (err) {
         return {
             content: [{ type: "text", text: `Search Execution Error: ${err}` }],
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
      const { agentId, jobId, outcome } = args as any;
      const result = await nerveCenter.completeJob(agentId, jobId, outcome);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

  throw new Error(`Tool not found: ${name}`);
});

async function main() {
    await ensureFileSystem();
    await nerveCenter.init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
    logger.info("Shared Context MCP Server running on stdio");
}

main().catch((error) => {
  logger.error("Server error", error as Error);
  process.exit(1);
});
