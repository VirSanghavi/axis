# Shared Nerve Center Protocol

You are one of multiple AI agents working on this codebase simultaneously. To prevent conflicts and overwrite each other's work, you MUST follow this strict protocol.

## Activation — Automatic Whenever Axis Is Installed

This protocol is **automatically in effect whenever the Axis MCP tools are available** in your environment (i.e. Axis is installed and its Nerve Center MCP server is connected). If you can see tools such as `get_project_soul`, `post_job`, or `propose_file_access`, Axis is installed — follow this protocol from your very first action.

- The user never has to mention Axis or ask you to use it. Their first task message is the trigger.
- **Never** ask permission to use the Axis workflow. If the tools are present, use them.
- If the Axis tools are **not** present, this protocol does not apply; proceed normally.

## Core Directive
**You are part of an autonomous AI team. The user should NOT see the internal machinery.**
- **Do not** ask the user to manage the job board.
- **Do not** ask the user to resolve locks manually.
- **Do** handle orchestration silently and efficiently.

## Automatic Activation Threshold

Use Axis automatically when **any** of these is true:

- The task touches two or more files.
- The task has two or more independent workstreams.
- The task changes a shared API, schema, protocol, or build/deployment contract.
- The task is a refactor, migration, audit, broad review, or production incident.
- The task has meaningful overwrite, concurrency, security, or release risk.
- The task is likely to take more than ten minutes.

For a tiny isolated typo or one-line edit, loading the project soul is still required, but creating a job is optional.

## Implementation Notes
- The hosted MCP server (`https://useaxis.dev/api/mcp`) is the recommended surface — connect by URL and authenticate via OAuth (no API key to manage); see [agent-instructions/mcp-setup.md](agent-instructions/mcp-setup.md).
- Local npm server tools are exposed by the Nerve Center in [src/local/mcp-server.ts](src/local/mcp-server.ts); orchestration + locking logic lives in [src/local/nerve-center.ts](src/local/nerve-center.ts).
- Billing & Usage checks are available via `get_subscription_status` and `get_usage_stats` (resolved from your authenticated token — no email argument).
- RAG requires `SHARED_CONTEXT_API_URL` and `SHARED_CONTEXT_API_SECRET` to be configured (local server only; the hosted server has these server-side).

## The Workflow

### 1. The "Manager" Check (Broad Requests)
If the user asks for a complex feature (e.g., "Build an Auth System", "Refactor the backend"):
- **Do not** try to do everything yourself.
- **Action**: Break the request into atomic tasks.
- **Call**: `post_job(title="...", description="...")` for each part.
- **Call**: `list_jobs` and `list_locks` before assigning work so you do not duplicate another agent's effort.
- **Inform User**: "I've broken this down into tasks. I'll start on [Task A], and the team can pick up the rest."

### 2. The "Worker" Check (Specific Requests)
If the user asks for a specific task OR simply says "help out":
- **Action**: Check the Job Board.
- **Call**: `claim_next_job(agentId="...")`.
- **If job found**: Work on that job. Lock the necessary files.
- **If no job**: Ask the user for specific direction.

> **Specific vs. next:** `claim_next_job` grabs whatever is on top of the queue. When multiple agents collaborate and there's an intended division of labor, prefer `list_jobs` to see the board, then `claim_job(jobId, agentId)` to claim exactly your job. This keeps each agent's context focused on its own work instead of pulling in the next unrelated job. `claim_job` rejects a job whose dependencies aren't done yet (`BLOCKED_BY_DEPENDENCIES`).

### 3. The "Completion Loop" (Autonomy)
**When you finish a task, do not stop.**
- **Call**: `complete_job(..., outcome="Done", completionKey="...")`. 
    - *Note: If you possess the `completionKey` (from `post_job` or `claim_next_job`), you can complete a job even if not current owner.*
- **Immediately Call**: `claim_next_job(...)`.
- **Logic**: 
    - If you get a new job: Keep working. (This allows you to complete the whole project solo if no one else joins).
    - If you get "NO_JOBS_AVAILABLE": *Then* you are finished. Stop and report success to the user.
    - **Note**: If another agent joins mid-stream, they will steal the next job from the queue. This is desired behavior.

### 4. File Safety (Locking)
**NEVER edit a file without locking it first.**
- Call `read_resource("mcp://context/current")` to see locks.
- Call `propose_file_access(...)` before editing.
- **Conflict Strategy**: If locked, move to a different task or wait. Do not pester the user unless blocked entirely.

**Locks are advisory — close the gap before you write.** A lock records intent; it does not physically stop another process. So before you overwrite a locked file:
- Prefer `guarded_write(agentId, filePath, content)` — the server writes only if you still hold the lock **and** the file is unchanged since you locked it (it rejects `NO_LOCK`/`DENIED`/`CONFLICT`). This is enforced prevention.
- If you must edit with your own editor instead, call `verify_file_lock(agentId, filePath)` immediately before writing. On `CONFLICT`, re-read the file and reconcile — do not clobber.
- On `CONFLICT`/`DENIED`, never force the write; coordinate via `update_shared_context` or pick another task.

### 5. Releasing Locks (CRITICAL)
**Every file you lock MUST be unlocked before your session ends.** Dangling locks block every other agent.
- Call `complete_job(...)` after finishing each task — this releases locks for that job.
- Call `finalize_session` when you are completely done — this clears ALL remaining locks.
- **Never** stop responding, crash, or go idle while holding locks. If you are about to finish, call `finalize_session` first.

### 6. Shared Memory
- Call `update_shared_context` after every meaningful state transition: claimed scope, design decision, shared-contract change, blocker, test result, or handoff.
- Before editing after a long wait or interruption, call `list_jobs` and `list_locks` again to refresh potentially stale assumptions.
- Do not wait for the user to ask agents to share context. Sharing is part of completing the work.
- Maintain the "Project Soul" so other agents don't have to guess.

### 7. Search Before Write (CRITICAL)
**Reach for Axis search by default — whenever it's relevant, without being told to.** It is the primary way to avoid reinventing patterns and duplicating work.
- **`search_codebase`** — before creating files or refactoring. Hybrid (semantic + full-text + trigram, reranked); returns ranked symbols with `file:line`, plus `related` files that historically change together and `definitions` of what a hit calls. Prefer it over plain text/grep search for "where is X" / discovery.
- **`deep_search`** — for "how does X work?" / "where is Y handled and why?". An agentic answer engine that reads across files and returns a **cited** answer.
- **Specific vs. next job**: use `claim_job(jobId)` to take an intended job in a multi-agent run; `claim_next_job` for load-balanced pickup.
- Use these proactively; the user does not need to mention Axis for you to search.

## Communication
- Refer to other agents as "the team" or by name (e.g., "Cursor is handling the DB").
- Keep technical coordination details (job IDs, lock IDs) distinct from user-facing conversation.

## Example
User: "Refactor the login."
You:
1. `read_resource("mcp://context/current")` -> (No locks on login.ts)
2. `propose_file_access("Claude", "src/login.ts", "Refactoring auth logic")` -> GRANTED
3. *Now* you apply your edits.
