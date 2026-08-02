# Axis: Parallel Agent Workflows & Orchestration

Axis is a high-performance orchestration layer that enables **Parallel Agent Workflows**. It allows multiple AI agents (Claude Code, Cursor, Antigravity, Windsurf) to coordinate on the same codebase simultaneously through distributed shared memory and atomic task management.

> ### Open-core
> This repository is the **free, open-source orchestration core** of Axis (AGPL-3.0): the MCP server, the `axis` CLI, the Python SDK, and the agent protocol — everything your agents use to coordinate.
>
> - **Free forever:** the orchestration layer — job board, file locking, shared notepad, sessions, project soul. It's just coordination state; it costs nothing to run.
> - **Paid (hosted):** the intelligence layer — hosted search (vector + full-text + trigram, fused and LLM-reranked), cited multi-hop `deep_search`, and incremental indexing — plus the managed backend, dashboard, and billing. The local server's `search_codebase` is ripgrep plus a keyword ranker (no index needed); a Pro key blends hosted results in when they arrive within budget. That lives at **[useaxis.dev](https://useaxis.dev)** (closed source) because it carries real embedding/LLM cost.
>
> **Quickest start:** sign up at [useaxis.dev](https://useaxis.dev), then point your MCP client at `https://useaxis.dev/api/mcp` and authenticate — no key to paste. See **[agent-instructions/mcp-setup.md](agent-instructions/mcp-setup.md)** for OAuth, API-key, and local-install options.

## Features

1.  **Parallel Agent Orchestration (PAO-1)**: Coordinate agent swarms with a shared Job Board and pessimistic File Locking.
2.  **Distributed Shared Memory**: Real-time synchronization of the "Live Notepad" across disparate agent processes.
3.  **Governance & Mirroring**: High-fidelity context mirroring to ensure all agents operate on "Ground Truth."
4.  **MCP Native**: Standardized toolset via the Model Context Protocol for seamless integration with any agent.

## Environment

Create a `.env.local` file for local development (see `.env.local.example`):

```
SHARED_CONTEXT_API_URL=http://localhost:3000
SHARED_CONTEXT_API_SECRET=your_shared_secret
OPENAI_API_KEY=your_openai_key
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

Do NOT set `PROJECT_NAME` unless you deliberately want to override detection:
it outranks repo detection, so a fixed value (like `default`) collapses every
repo on the machine onto one shared job board. Left unset, the project name is
derived from your repo (committed `.axis/axis.json` `"project"`, else the repo
folder name), so every clone of the same repo resolves the same board.

### Team coordination (shared boards)

Commit an org pin so every teammate's clone lands on the same board:

```json
// .axis/axis.json (at the repo root)
{ "project": "your-repo", "org": "<your org id from useaxis.dev/team>" }
```

Per-machine override: `AXIS_ORG_ID=<org id>`. Without an org, coordination
scopes to your personal workspace (solo behavior, unchanged). Watch and drive
the live board at `useaxis.dev/team/board`.

## Setup

1.  **Install Dependencies**:
    ```bash
    bun install
    ```

2.  **Initialize Context**:
    ```bash
    bun cli init
    ```

3.  **Start MCP Server**:
    To run the server locally for testing/connection:
    ```bash
    bun start:local
    ```
  This stdio server exposes the full Nerve Center toolset (job board, locks, notepad).
    Running from a checkout is for **contributing to Axis itself** — users connect
    to the hosted server instead (next paragraph).

    *Address for MCP Clients*: point your agent at the hosted MCP server — no
    install, no updates to manage:
    ```
    https://useaxis.dev/api/mcp
    ```
    Authenticate via OAuth or a Bearer API key; see
    [agent-instructions/mcp-setup.md](agent-instructions/mcp-setup.md).

    Axis derives project identity from the active repository. Supported agent
    hosts can provide `AXIS_WORKSPACE_ROOT`, `SUPERSET_WORKSPACE_PATH`, or
    `SUPERSET_ROOT_PATH`; these per-session values override a stale positional
    root in global MCP config so project souls, jobs, and locks cannot leak
    across repository switches. Set `AXIS_PROJECT_NAME` only when a project
    name must intentionally remain fixed across workspace changes.

Workspace switching is **automatic**: every tool call re-resolves the
workspace from the runtime hints and from any absolute file path in the
call's arguments. When either points at a different repository, the server
rebinds itself in-process and notes the switch in the tool response — no
restart, no stale "default" board. `switch_project` remains available for
explicit switches.

4.  **CLI Usage**:
    ```bash
    # Add an entry to activity.md
    bun cli add-context "Refactored the API to use Hono"
    ```

## Parallelism Philosophy

The key to Axis is the **Parallel Sprints**. You no longer have to manage a single agent sequentially; instead, you orchestrate a swarm.

1.  **Define the Objective**: Tell any agent (the "Manager"): "Build the Authentication System."
2.  **Autonomous Partitioning**: The agent decomposes the objective into jobs (API, UI, Tests) and posts them to the **Distributed Job Board**.
3.  **Horizontal Scaling**: You open Cursor, Claude Code, and Antigravity. They all instantly "claim" the next available job on the board.
4.  **Synchronized Execution**: While agents work in parallel, they stay in sync via the **Live Notepad**, ensuring that if one agent changes an API signature, the others adjust their code in real-time.

### Connecting Agents (MCP)
Point your IDE (Claude Desktop, Cursor, etc.) at the hosted MCP server:
```json
{
  "mcpServers": {
    "axis": {
      "url": "https://useaxis.dev/api/mcp"
    }
  }
}
```
Authenticate via OAuth (no key to manage) or a Bearer API key — see [agent-instructions/mcp-setup.md](agent-instructions/mcp-setup.md). New tools land server-side, so there is nothing to update on your machine.

### MCP Tooling
The server exposes these tools to agents (23 total in the current source).

**Coordination (free, open-core):**

- `get_project_soul` — load project context, goals, and conventions
- `update_project_soul` — write or refresh the project soul
- `post_job` — add a job to the distributed Job Board
- `list_jobs` — inspect status, priority, ownership, and dependencies
- `claim_job` — atomically claim a specific ticket
- `claim_next_job` — atomically claim the next available job
- `complete_job` — report a job outcome and release its file locks
- `cancel_job` — withdraw a posted job
- `propose_file_access` — pessimistically lock files before editing; pass `filePaths` to lock a multi-file batch in one call (all-or-nothing)
- `list_locks` — inspect active file ownership and intent
- `verify_file_lock` — confirm a locked file wasn't changed under you before overwriting (tamper check)
- `guarded_write` — enforced write: the server writes only if you hold the lock and the file is unchanged (rejects clobbers)
- `release_file_access` — release an owned lock early
- `list_agents` — see which agents are active or idle on the project (visible before jobs are posted)
- `switch_project` — rebind a live MCP session to another workspace without reconnecting
- `force_unlock` — admin override for stale locks from crashed agents
- `update_shared_context` — append to the Live Notepad. Coordination tool responses also carry an ambient "team activity" trailer: whatever *other* agents logged since your last call, so nobody has to remember to re-read the notepad. `agentId` is optional on every tool — it defaults to the session's unique identity.
- `finalize_session` — archive the session and clear all remaining locks

### Universal Session History

Axis records every Axis MCP tool call and result at the protocol boundary. This
works with any MCP client, including Cursor, Windsurf, GitHub Copilot,
Antigravity, Claude Code, Codex, Gemini CLI, Cline, Roo Code, Continue, Aider,
and clients Axis has never seen before. These events are always available in the
archived session even when the host does not expose its private chat transcript.

Full user/assistant chat is added when the host exposes a transcript. Codex and
Claude Code are detected automatically. Any other client can provide a JSON or
JSONL export using:

```json
{
  "env": {
    "AXIS_TRANSCRIPT_PATH": "/absolute/path/to/session.jsonl",
    "AXIS_TRANSCRIPT_FORMAT": "generic",
    "AXIS_AGENT_BASE": "github-copilot"
  }
}
```

The generic adapter accepts common `role`/`content`, `messages`, `tool_calls`,
`tool_call`, and `tool_result` shapes. Set `AXIS_TRANSCRIPT_FORMAT` to
`codex`, `claude`, or `generic`. MCP cannot access chat text a host keeps
private; in that case Axis still captures the complete Axis tool timeline.

> **Read-only lock hardening (opt-in).** Locks are advisory coordination by design.
> Set `AXIS_ENFORCE_LOCKS=1` to harden them: on grant the server `chmod`s the locked file read-only,
> so *any* process — including an agent that ignores Axis — gets `EACCES` on write.
> The holder writes through `guarded_write` (which briefly restores perms);
> `release`/`complete_job`/`finalize_session` restore the original mode. This changes
> editing ergonomics (you must write through Axis while a file is locked), so it's off
> by default. It stops cooperating tools and accidental clobbering; a process running as
> the same user can still `chmod` back, which no userspace server can prevent.

**Intelligence (hosted, paid):**

- `index_codebase` — build the searchable index for a project
- `index_file` — index a single file (reads from disk if content is omitted)
- `search_codebase` — hosted: vector + full-text + trigram retrieval, fused and LLM-reranked, with `related` files + `definitions` enrichment (locally this tool answers from ripgrep + keyword ranking)
- `search_docs` — search indexed documentation

**Account:**

- `get_subscription_status` — current plan and entitlements
- `get_usage_stats` — usage against plan limits

### Agent Integration Examples

**Claude Desktop (example flow)**

1. `claim_next_job` with your `agentId`.
2. If claimed, `propose_file_access` before edits.
3. After completing work, `complete_job` with outcome notes.
4. Use `update_shared_context` to summarize decisions.

**Cursor (example flow)**

1. `get_project_soul` to load context.
2. `claim_next_job` or `post_job` for new work.
3. `propose_file_access` before editing files.
4. `finalize_session` at the end of a sprint.

## Troubleshooting

- **Permissions**: Ensure `chmod +x src/local/mcp-server.ts` or that `bun` is in your PATH.
- **Directories**: On first run, the system will auto-create `history/` and `agent-instructions/`. Ensure write permissions.
- **Locking Issues**: If a file is permanently locked due to a crash, use the `force_unlock` tool via any agent or delete `history/nerve-center-state.json`.

## Architecture

- **Local MCP server (`src/local/mcp-server.ts`)**: The canonical stdio server, shipped as `@virsanghavi/axis-server`. Its tool surface is defined once in `src/shared/tool-registry.ts`.
- **Hosted MCP + API**: The paid surface lives in the `axis-frontend` repo — MCP at `https://useaxis.dev/api/mcp`, REST at `https://useaxis.dev/api/v1`.
- **Parallel Job Board**: Supabase-backed registry for atomic task distribution.
- **Distributed Memory**: Real-time vector-indexed persistence of agent decisions.

## Production & Deployment

### Supabase Setup
Run `supabase db reset` (Docker required) to build the database from the numbered
migrations in [supabase/migrations](supabase/migrations) — they are the source of truth.
[supabase/schema.sql](supabase/schema.sql) is a generated snapshot for reference only;
never apply it by hand. See [supabase/README.md](supabase/README.md) for the workflow.

### RAG API Examples

The RAG endpoints are served by the hosted API (`axis-frontend` repo, deployed at useaxis.dev).

**Embed content**

```bash
curl -X POST https://useaxis.dev/api/v1/embed \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AXIS_API_KEY" \
  -d '{
    "items": [
      {
        "content": "This repo uses Bun",
        "metadata": { "filename": "context.md", "source": "agent-instructions" }
      }
    ]
  }'
```

**Search content**

```bash
curl -X POST https://useaxis.dev/api/v1/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AXIS_API_KEY" \
  -d '{
    "query": "What runtime does this project use?",
    "limit": 5,
    "threshold": 0.5
  }'
```

### Testing
We maintain a suite of Unit and Load tests.
```bash
# Run Unit Tests
bun test

# Run Load/Concurrency Verification
bun tests/load-test.ts
```

### Security & Robustness
- **Rate Limiting**: Enforced by the hosted API (axis-frontend) in front of every /api/v1 route.
- **Persistence**: State is saved to `history/nerve-center-state.json` to survive restarts.
- **Concurrency**: `AsyncMutex` ensures atomic operations on the Job Board and File Locks.

## Feature Status

- **RAG / Smart Retrieval**: Implemented via `/embed` and `/search` in the API.
- **Job Board**: Implemented in the Nerve Center with optional Supabase persistence.
- **File Locking**: Implemented with stale-lock cleanup and admin force unlock.
