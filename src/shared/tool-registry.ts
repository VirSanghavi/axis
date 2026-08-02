/**
 * Canonical Axis tool registry — the single source of truth for the MCP tool
 * surface (names, descriptions, JSON-Schema input contracts).
 *
 * ── Canonical servers (consolidation decision, audit #1) ──
 * • LOCAL (free/open-core): the stdio server, `src/local/mcp-server.ts`,
 *   bundled and shipped as `@virsanghavi/axis-server`. It consumes this
 *   registry verbatim.
 * • HOSTED (paid): the Streamable-HTTP adapter in
 *   `axis-frontend/app/api/mcp/route.ts`, a thin protocol wrapper over the
 *   /api/v1 routes. Cross-repo manifest agreement is asserted by the tool
 *   drift contract work (see the board job "Close the 12-tool drift").
 * • DEPRECATED: `src/local/server.ts` (Express/SSE) and `src/api/index.ts`
 *   (duplicate Hono API). Both are scheduled for deletion — do not add tools
 *   or routes to them.
 *
 * Adding or changing a tool? Edit it HERE, never inline in a server file.
 */

export interface AxisToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_READ_CONTEXT = "read_context";
export const TOOL_UPDATE_CONTEXT = "update_context";
export const TOOL_SEARCH_CODEBASE = "search_codebase";

export const LOCAL_TOOLS: AxisToolDefinition[] = [
      {
        name: TOOL_READ_CONTEXT,
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
        name: TOOL_UPDATE_CONTEXT,
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
        description: "**CRITICAL: REQUEST FILE LOCK** — call this before EVERY file edit, no exceptions.\n- Returns `GRANTED` if safe to proceed, `REQUIRES_ORCHESTRATION` if another agent holds the lock, or `REJECTED` if you tried to lock a directory.\n- **Lock individual files, not directories.** Directory locks block parallel work and are rejected.\n- Paths can be absolute or relative — they're normalized against the project root.\n- Required: `intent` (descriptive — 'Refactor auth to use JWT', NOT 'editing file') plus `filePath` or `filePaths`. `agentId` is optional (defaults to your session identity).\n- Editing several files? Pass `filePaths` to lock them in ONE call — all-or-nothing, so a partial batch never blocks others.\n- Locks expire after 30 minutes. Use `force_unlock` only as a last resort for crashed agents.\n- **Every lock MUST be released.** `complete_job` releases the locks for that job; `finalize_session` releases everything. Dangling locks block all other agents.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Optional — defaults to this session's unique identity." },
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
            agentId: { type: "string", description: "Optional — defaults to this session's unique identity." },
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
        description: "**TAMPER CHECK BEFORE WRITING**: Confirm a file you hold a lock on hasn't changed since the lock was granted.\n- Locks are advisory — another process can still edit the file. Call this right before overwriting to avoid clobbering concurrent changes.\n- Returns `OK` (unchanged), `CONFLICT` (modified/deleted — re-read before writing), `NO_LOCK`, or `UNKNOWN` (no fingerprint recorded).",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Optional — defaults to this session's unique identity." },
            filePath: { type: "string" }
          },
          required: ["filePath"]
        }
      },
      {
        name: "list_agents",
        description: "**WHO'S ONLINE**: List agents currently active or idle on this project.\n- Use to see your team before posting jobs — idle workers started early show up here, so you don't have to make the user wait for jobs before launching agents.\n- Returns each agent's status (active/idle), last activity, and last-seen time.",
        inputSchema: { type: "object", properties: {}, required: [] }
      },
      {
        name: "guarded_write",
        description: "**ENFORCED WRITE**: Write a file *through* your lock. The server writes only if you hold the lock AND the file is unchanged since you locked it — otherwise it returns NO_LOCK, DENIED (held by another agent), or CONFLICT (changed underneath you). Use this instead of a raw editor when you want Axis to actually *prevent* clobbering, not just detect it. Refreshes the lock's fingerprint on success.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Optional — defaults to this session's unique identity." },
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
            agentId: { type: "string", description: "Optional — defaults to this session's unique identity." },
            text: { type: "string" }
          },
          required: ["text"]
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
        name: "release_job",
        description: "**RELEASE TICKET**: Put an abandoned in_progress job back on the board without cancelling it.\n- Use when another agent claimed a job and went silent — the job returns to 'todo' so anyone can pick it up.\n- Guarded: refuses if the assigned agent still looks active; pass `force: true` to override deliberately.\n- Parity with the hosted release_job tool.",
        inputSchema: {
          type: "object",
          properties: {
            jobId: { type: "string" },
            force: { type: "boolean", description: "Release even if the assigned agent looks active. Default: false." },
            agentId: { type: "string", description: "Optional — defaults to this session's unique identity; recorded as the releaser." }
          },
          required: ["jobId"]
        }
      },
      {
        name: "get_shared_context",
        description: "**READ THE LIVE NOTEPAD**: Return the current shared notepad for this project — the team's short-term working memory (claims, decisions, blockers, handoffs).\n- Use to catch up on what other agents did without waiting for the ambient team-activity trailer.\n- Same shape as the hosted get_shared_context tool: { notepad, projectName }.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
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
            agentId: { type: "string", description: "Optional — defaults to this session's unique identity." }
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
            agentId: { type: "string", description: "Optional — defaults to this session's unique identity." },
            jobId: { type: "string" }
          },
          required: ["jobId"]
        }
      },
      {
        name: "complete_job",
        description: "**CLOSE TICKET**: Mark a job as done and release file locks.\n- Call this IMMEDIATELY after finishing each job — do not accumulate completed-but-unclosed jobs.\n- Requires `outcome` (what was done).\n- If you are not the assigned agent, you must provide the `completionKey`.\n- **This is the primary way to release file locks.** Leaving jobs open holds locks and blocks other agents.\n- REMINDER: After completing all jobs, you MUST also call `finalize_session` to clear any remaining locks.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Optional — defaults to this session's unique identity." },
            jobId: { type: "string" },
            outcome: { type: "string" },
            completionKey: { type: "string", description: "Optional key to authorize completion if not the assigned agent." }
          },
          required: ["jobId", "outcome"]
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

/** Every tool name the local stdio server exposes, in registry order. */
export const LOCAL_TOOL_NAMES: string[] = LOCAL_TOOLS.map((t) => t.name);
