# Shared Context Layer for AI Coding Agents via MCP

A shared context server that allows different AI agents (Claude Code, Cursor, Windsurf) to share knowledge about project architecture, conventions, and recent activity.

## Features

1.  **Local Context Storage**: Markdown files in `./agent-instructions/` (`context.md`, `conventions.md`, `activity.md`).
2.  **MCP Server**: Exposes these files to any MCP-compatible agent.
3.  **Smart Retrieval (RAG)**: Vector search via hosted API.
4.  **Job Board + File Locks**: Multi-agent orchestration via MCP tools.

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
    
    *Address for MCP Clients*: Since it runs on stdio, you typically configure your agent (e.g., in `claude_desktop_config.json` or Cursor settings) to run:
    ```json
    {
      "mcpServers": {
        "shared-context": {
          "command": "bun",
          "args": ["run", "/path/to/shared-context/src/local/mcp-server.ts"]
        }
      }
    }
    ```

4.  **CLI Usage**:
    ```bash
    # Add an entry to activity.md
    bun cli add-context "Refactored the API to use Hono"
    ```

## Zero-Touch Philosophy

The key to this system is that **you (the human) should never manually edit the shared context**.

1.  **Just talk to your agents.**
2.  If you tell Claude: "Build a todo app", Claude will automatically:
    *   Create 3-4 jobs on the "Invisible Job Board".
    *   Start working on the first one.
3.  If you open Cursor and say "Help out", Cursor will:
    *   Automatically check the board.
    *   Claim the next open job.
    *   Start working without you explaining anything.

The "Notebook" manages itself.

### Local Integration (MCP)
Configure your IDE (Claude Desktop, Cursor, etc.) to point to the local server script:
```json
{
  "mcpServers": {
    "shared-context": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/shared-context/src/local/mcp-server.ts"]
    }
  }
}
```

## Troubleshooting

- **Permissions**: Ensure `chmod +x src/local/mcp-server.ts` or that `bun` is in your PATH.
- **Directories**: On first run, the system will auto-create `history/` and `agent-instructions/`. Ensure write permissions.
- **Locking Issues**: If a file is permanently locked due to a crash, use the `force_unlock` tool via any agent or delete `history/nerve-center-state.json`.

## Architecture

- **Active Orchestrator (`src/local/server.ts`)**: A single-process HTTP/SSE server that holds memorystate.
- **Job Board**: Supabase-backed task registry (falls back to local state when not configured).
- **RAG Memory**: Vector embeddings of all past decisions and prompts.

## Production & Deployment

### Docker
The server is fully containerized. To build and run:
```bash
docker-compose up --build
```
This starts the API on port 3000 and the `nerve-center` on port 3001.

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
