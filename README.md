# Axis: Parallel Agent Workflows & Orchestration

Axis is a high-performance orchestration layer that enables **Parallel Agent Workflows**. It allows multiple AI agents (Claude Code, Cursor, Antigravity, Windsurf) to coordinate on the same codebase simultaneously through distributed shared memory and atomic task management.

> ### Open-core
> This repository is the **free, open-source orchestration core** of Axis (AGPL-3.0): the MCP server, the `axis` CLI, the Python SDK, and the agent protocol — everything your agents use to coordinate.
>
> - **Free forever:** the orchestration layer — job board, file locking, shared notepad, sessions, project soul. It's just coordination state; it costs nothing to run.
> - **Paid (hosted):** the intelligence layer — hybrid code search, agentic `deep_search`, and incremental indexing — plus the managed backend, dashboard, and billing. That lives at **[useaxis.dev](https://useaxis.dev)** (closed source) because it carries real embedding/LLM cost.
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
PROJECT_NAME=default
```

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
    
    *Address for MCP Clients*: Since it runs on stdio, configure your agent (e.g., in `claude_desktop_config.json` or Cursor settings) to launch the published wrapper — no local checkout required:
    ```json
    {
      "mcpServers": {
        "axis": {
          "command": "npx",
          "args": ["-y", "@virsanghavi/axis-server"]
        }
      }
    }
    ```

    Axis derives project identity from the active repository. Supported agent
    hosts can provide `AXIS_WORKSPACE_ROOT`, `SUPERSET_WORKSPACE_PATH`, or
    `SUPERSET_ROOT_PATH`; these per-session values override a stale positional
    root in global MCP config so project souls, jobs, and locks cannot leak
    across repository switches. Set `AXIS_PROJECT_NAME` only when a project
    name must intentionally remain fixed across workspace changes.

If you switch repositories inside the same MCP session, call `switch_project`
with the new workspace root instead of reconnecting. It reloads the active
project state in-process.

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

### Local Integration (MCP)
Configure your IDE (Claude Desktop, Cursor, etc.) to launch the published wrapper over stdio:
```json
{
  "mcpServers": {
    "axis": {
      "command": "npx",
      "args": ["-y", "@virsanghavi/axis-server"]
    }
  }
}
```
For the **hosted** backend (recommended for teams), point at `https://useaxis.dev/api/mcp` with a Bearer key instead — see [agent-instructions/mcp-setup.md](agent-instructions/mcp-setup.md).

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
- `propose_file_access` — pessimistically lock files before editing
- `list_locks` — inspect active file ownership and intent
- `verify_file_lock` — confirm a locked file wasn't changed under you before overwriting (tamper check)
- `guarded_write` — enforced write: the server writes only if you hold the lock and the file is unchanged (rejects clobbers)
- `release_file_access` — release an owned lock early
- `list_agents` — see which agents are active or idle on the project (visible before jobs are posted)
- `switch_project` — rebind a live MCP session to another workspace without reconnecting
- `force_unlock` — admin override for stale locks from crashed agents
- `update_shared_context` — append to the Live Notepad
- `finalize_session` — archive the session and clear all remaining locks

> **Physical lock enforcement (opt-in).** Set `AXIS_ENFORCE_LOCKS=1` to make locks
> mandatory, not advisory: on grant the server `chmod`s the locked file read-only,
> so *any* process — including an agent that ignores Axis — gets `EACCES` on write.
> The holder writes through `guarded_write` (which briefly restores perms);
> `release`/`complete_job`/`finalize_session` restore the original mode. This changes
> editing ergonomics (you must write through Axis while a file is locked), so it's off
> by default. It stops cooperating tools and accidental clobbering; a process running as
> the same user can still `chmod` back, which no userspace server can prevent.

**Intelligence (hosted, paid):**

- `index_codebase` — build the searchable index for a project
- `index_file` — index a single file (reads from disk if content is omitted)
- `search_codebase` — hybrid code search with `related` files + `definitions` enrichment
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

- **Active Orchestrator (`src/local/server.ts`)**: A high-concurrency MCP server that manages distributed state.
- **Parallel Job Board**: Supabase-backed registry for atomic task distribution.
- **Distributed Memory**: Real-time vector-indexed persistence of agent decisions.

## Production & Deployment

### Docker
The system is fully containerized for cloud orchestration.
```bash
docker-compose up --build
```
This starts the Parallel Control Plane on port 3001 and the Context API on port 3000.

### Supabase Setup
Apply the schema in [supabase/schema.sql](supabase/schema.sql) to your Supabase project.
It creates the `projects`, `embeddings`, and `jobs` tables plus the `match_embeddings` RPC.

### RAG API Examples

**Embed content**

```bash
curl -X POST http://localhost:3000/embed \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SHARED_CONTEXT_API_SECRET" \
  -d '{
    "items": [
      {
        "content": "This repo uses Bun and Hono",
        "metadata": { "filename": "context.md", "source": "agent-instructions" }
      }
    ]
  }'
```

**Search content**

```bash
curl -X POST http://localhost:3000/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SHARED_CONTEXT_API_SECRET" \
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
- **Rate Limiting**: In-memory rate limiter protects endpoints.
- **Persistence**: State is saved to `history/nerve-center-state.json` to survive restarts.
- **Concurrency**: `AsyncMutex` ensures atomic operations on the Job Board and File Locks.

## Feature Status

- **RAG / Smart Retrieval**: Implemented via `/embed` and `/search` in the API.
- **Job Board**: Implemented in the Nerve Center with optional Supabase persistence.
- **File Locking**: Implemented with stale-lock cleanup and admin force unlock.
