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
import { resolveProjectIdentity } from "./project-identity.js";

// Load environment variables
dotenv.config({ path: ".env.local" });

const manager = new ContextManager(
    process.env.SHARED_CONTEXT_API_URL,
    process.env.SHARED_CONTEXT_API_SECRET
);

const nerveCenter = new NerveCenter(manager, {
    projectRoot: process.env.AXIS_PROJECT_ROOT || process.env.SUPERSET_WORKSPACE_PATH || process.env.SUPERSET_ROOT_PATH,
    projectName: process.env.PROJECT_NAME
});

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

// Auth Middleware
import { createClient } from "@supabase/supabase-js";
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

app.use(async (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(" ")[1] || req.query.token as string;

    if (!token) {
        // Allow if SECRET matches (Service-to-Service)
        if (req.headers['x-api-key'] === process.env.SHARED_CONTEXT_API_SECRET) return next();
        return res.status(401).json({ error: "Unauthorized" });
    }

    if (!supabase) {
        // Fallback if no Supabase configured yet (dev mode)
        if (token === process.env.SHARED_CONTEXT_API_SECRET) return next();
        return res.status(500).json({ error: "Server Configuration Error" });
    }

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
        if (token === process.env.SHARED_CONTEXT_API_SECRET) return next();
        return res.status(401).json({ error: "Unauthorized" });
    }

    // Check subscription
    const { data: profile } = await supabase.from('profiles').select('subscription_status').eq('id', user.id).single();
    if (profile?.subscription_status !== 'active' && profile?.subscription_status !== 'pro') {
        return res.status(402).json({ error: "Payment Required" });
    }

    (req as any).user = user;
    next();
});


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
                    text: await nerveCenter.getCoreContext()
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
                    name: "release_file_access",
                    description: "Release a file lock owned by the calling agent.",
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
                    description: "List active file locks and their owners.",
                    inputSchema: { type: "object", properties: {}, required: [] }
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
                    description: "**MANDATORY FIRST CALL**: Returns the project soul — `context.md` (goals, architecture) and `conventions.md` (coding standards). If the soul is unfilled, you MUST populate it via `update_project_soul` before doing any other work.",
                    inputSchema: { type: "object", properties: {}, required: [] }
                },
                {
                    name: "update_project_soul",
                    description: "Update the project soul. Provide `context` (for context.md) and/or `conventions` (for conventions.md).",
                    inputSchema: {
                        type: "object",
                        properties: {
                            context: { type: "string", description: "Full content for context.md (project overview, architecture, core features)." },
                            conventions: { type: "string", description: "Full content for conventions.md (coding standards, agent norms)." }
                        },
                        required: []
                    }
                },
                {
                    name: "switch_project",
                    description: "Rebind the live MCP session to another workspace without reconnecting.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            projectRoot: { type: "string" },
                            projectName: { type: "string" }
                        },
                        required: []
                    }
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
                    name: "list_jobs",
                    description: "List current jobs on the shared board.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            includeCompleted: { type: "boolean" }
                        },
                        required: []
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
                    name: "claim_job",
                    description: "Atomically claim a specific available job by ID.",
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
                    description: "Mark your assigned job as done.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            agentId: { type: "string" },
                            jobId: { type: "string" },
                            outcome: { type: "string" },
                            completionKey: { type: "string" }
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
            if (name === "release_file_access") {
                const { agentId, filePath } = args as any;
                const result = await nerveCenter.releaseFileAccess(agentId, filePath);
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }
            if (name === "list_locks") {
                const locks = await nerveCenter.listLocks();
                return { content: [{ type: "text", text: JSON.stringify({ locks }, null, 2) }] };
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

            // Job Board
            if (name === "post_job") {
                const { title, description, priority, dependencies } = args as any;
                const result = await nerveCenter.postJob(title, description, priority, dependencies);
                return { content: [{ type: "text", text: JSON.stringify(result) }] };
            }
            if (name === "list_jobs") {
                const includeCompleted = Boolean(args?.includeCompleted);
                const jobs = await nerveCenter.listJobs();
                const visibleJobs = includeCompleted
                    ? jobs
                    : jobs.filter((job) => job.status !== "done" && job.status !== "cancelled");
                return { content: [{ type: "text", text: JSON.stringify({ jobs: visibleJobs }, null, 2) }] };
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

            // Legacy Tools
            if (name === "read_context") return { content: [{ type: "text", text: await manager.readFile(String(args?.filename)) }] };
            if (name === "search_context") return { content: [{ type: "text", text: await manager.searchContext(String(args?.query)) }] };

            throw new Error("Unknown tool");
        } catch (e) {
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
