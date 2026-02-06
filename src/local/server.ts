import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import dotenv from "dotenv";
import { ContextManager } from "./context-manager.js";
import { NerveCenter } from "./nerve-center.js";
import { logger } from "../utils/logger.js";

// Load environment variables
dotenv.config({ path: ".env.local" });

const manager = new ContextManager(
    process.env.SHARED_CONTEXT_API_URL, 
    process.env.SHARED_CONTEXT_API_SECRET
);

const nerveCenter = new NerveCenter(manager);

// --- File System Operations (Checklist #9) ---
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
                 // Create default files
                 await fs.writeFile(path.join(dirPath, "context.md"), "# Project Context\n\n");
                 await fs.writeFile(path.join(dirPath, "conventions.md"), "# Coding Conventions\n\n");
                 await fs.writeFile(path.join(dirPath, "activity.md"), "# Activity Log\n\n");
             }
        }
    }
}

// Initialize state
(async () => {
    try {
        await ensureFileSystem();
        await nerveCenter.init();
        logger.info("NerveCenter initialized successfully.");
    } catch (err) {
        logger.error("Failed to init NerveCenter", err as Error);
    }
})();

const app = express();
const port = 3001;

// Map sessionId -> { server, transport }
const sessions = new Map();

app.get("/sse", async (req, res) => {
    logger.info("New connection");
    
    // 1. Create a new transport for this specific connection
    const transport = new SSEServerTransport("/message", res);
    
    // 2. Create a new Server instance for this session (stateless logic, shared manager)
    const server = new Server(
        { name: "shared-context", version: "1.0.0" }, 
        { capabilities: { resources: {}, tools: {} } }
    );

    // 3. Register Resources
    server.setRequestHandler(ListResourcesRequestSchema, async () => { 
        return {
            resources: [
                {
                    uri: "mcp://context/current",
                    name: "Live Session Context",
                    mimeType: "text/markdown",
                    description: "The realtime state of the Nerve Center (Notepad + Locks)"
                },
                // Include existing files too
                ...(await manager.listFiles())
            ]
        };
    });
    
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
        if (req.params.uri === "mcp://context/current") {
            return {
                contents: [{
                    uri: req.params.uri,
                    mimeType: "text/markdown",
                    text: await nerveCenter.getLiveContext()
                }]
            };
        }
        // Fallback to file system
        const f = req.params.uri.replace("context://local/", ""); 
        return { contents: [{ uri: req.params.uri, mimeType: "text/markdown", text: await manager.readFile(f) }] };
    });

    // 4. Register Tools
    server.setRequestHandler(ListToolsRequestSchema, async () => { 
        return {
            tools: [
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
              },
              // --- Legacy/Direct Support ---
              { name: "read_context", description: "Read context", inputSchema: { type: "object", properties: { filename: { type: "string" } }, required: ["filename"] } },
              { name: "search_context", description: "Search context", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }
            ]
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: args } = req.params;
        try {
            // Nerve Center Tools
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

            // Job Board
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

            // Legacy Tools
            if (name === "read_context") return { content: [{ type: "text", text: await manager.readFile(String(args?.filename)) }] };
            if (name === "search_context") return { content: [{ type: "text", text: await manager.searchContext(String(args?.query)) }] };
            
            throw new Error("Unknown tool");
        } catch(e) {
             return { content: [{ type: "text", text: `Error: ${e}` }], isError: true };
        }
    });

    // 5. Start the transport
    await server.connect(transport);
    
    // 5. Store session
    const sessionId = transport.sessionId; // SDK generates this
    sessions.set(sessionId, { server, transport });
    
    // Clean up on close
    res.on("close", () => {
        logger.info("Session closed", { sessionId });
        sessions.delete(sessionId);
    });
});

app.post("/message", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const session = sessions.get(sessionId);
    
    if (!session) {
        res.status(404).send("Session not found");
        return;
    }
    
    await session.transport.handlePostMessage(req, res);
});

app.listen(port, () => {
    logger.info("Orchestrator Server running", { url: `http://localhost:${port}/sse` });
});
