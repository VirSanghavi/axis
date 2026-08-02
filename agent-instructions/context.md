# Axis: Project Context

> **Canonical copy.** This is the single source of truth for agent instructions
> across both Axis repos. The copies at `Axis/agent-instructions/` and
> `axis-frontend/agent-instructions/` are pointer stubs. Edit this file, not those.

## Overview

Axis is a distributed orchestration layer for parallel AI coding agents. It lets
multiple agents (Cursor, Claude Code, Windsurf, Codex, Antigravity, and others)
work on the same codebase simultaneously without collisions or context drift.

The core value proposition: **agents that coordinate like a team, not individuals
who overwrite each other.**

## The two repos

Axis is two git repositories sitting side by side. The parent directory that
contains them is **not** a git repo; never run git from it.

### `shared-context/`: public, AGPL-3.0 (`github.com/VirSanghavi/axis`)

The open-source orchestration core.

- `src/shared/tool-registry.ts` is the canonical MCP tool surface: names,
  descriptions, and JSON-Schema contracts. Both servers consume it. Add or change
  a tool here and nowhere else.
- `src/local/mcp-server.ts` is the local stdio MCP server, shipped as the
  `@virsanghavi/axis-server` npm package.
- `src/local/nerve-center.ts` and its siblings hold orchestration, locking, the
  job board, state persistence, the coordination HTTP client, and identity
  resolution.
- `packages/axis-server/`, `packages/axis-init/`, `packages/python-sdk/` are the
  published artifacts.
- `supabase/migrations/` holds numbered SQL migrations.
- `agent-instructions/` is this directory.
- `src/local/server.ts` and `src/api/index.ts` are **deprecated**: an old
  Express/SSE server and a duplicate Hono API. They warn on startup and are
  scheduled for deletion. Do not extend them.

### `axis-frontend/`: private (`github.com/VirSanghavi/axis-frontend`)

The product at useaxis.dev. All application code lives under `frontend/`.

- Next.js App Router (Next 16, React 19), TypeScript, Tailwind CSS v4, Framer
  Motion. Auth and persistence via Supabase. Billing via Stripe.
- `frontend/app/api/mcp/` is the **hosted** MCP endpoint, a Streamable-HTTP
  JSON-RPC adapter. This is the surface users connect to. Keep it a thin adapter
  over `/api/v1`.
- `frontend/app/api/v1/` is the REST API that both the local server and the
  hosted adapter call. Session APIs live under `frontend/app/api/v1/sessions`;
  the session detail UI is `/s/[id]`.
- `frontend/app/team/` holds the org surfaces: members, usage, audit, settings,
  API keys, and the live coordination board at `/team/board`.
- Deployed on Vercel with the project root directory set to `frontend/`.

Shared state (locks, jobs, notepad, sessions, embeddings) lives in Supabase,
scoped per project and per org. The local server syncs with the hosted API and
falls back to a local JSON state file when that API is unreachable.

## Core features

1. **Job Board.** Agents post, claim, and complete tasks. Priority-based and
   dependency-aware. Prevents duplicate work.
2. **File Locking.** Atomic per-file locks. Agents call `propose_file_access`
   before editing. Optionally enforced physically via `AXIS_ENFORCE_LOCKS=1`,
   which chmods locked files read-only so even non-Axis tools cannot write them.
3. **Live Notepad.** Real-time shared memory. Agents log progress so others know
   what is happening. Cleared on `finalize_session`.
4. **Project Soul.** `get_project_soul` returns this file plus `conventions.md`
   to ground agents in project reality.
5. **Code Search.** `search_codebase` and `search_docs` over the indexed codebase
   and documentation. See "Search tool usage" below.
6. **Session History.** Every Axis tool call and result is captured at the
   protocol boundary, for any MCP client. `finalize_session` archives the
   session, clears remaining locks, and resets for new work.
7. **Billing.** Per-seat Stripe billing at $20 per seat per month, scoped to the
   org. Orchestration is free forever; only the hosted intelligence layer
   (`search_codebase`, `deep_search`, indexing) is paid.

## Search tool usage (critical for agents)

**Use `search_codebase` before writing new code.** It is the primary way to avoid
reinventing patterns and duplicating work.

### When to call it

- **Before creating new files**, to find similar implementations, for example
  "authentication middleware", "user model", "API route handler".
- **Before refactoring**, to find every usage of a pattern or module.
- **When debugging**, to locate where a feature is implemented or configured.
- **When orienting**, to understand how the codebase structures a domain, for
  example "how does billing work?" or "where are Stripe webhooks handled?".

### How to query

- Use natural language: "Where is JWT validation done?", "How does the job board
  claim work?", "API key validation logic".
- Prefer specific queries over generic ones: "Stripe webhook handler" beats
  "payments".
- Combine domain and action: "authentication flow", "file lock expiry",
  "subscription check".
- For a pure literal-string lookup (one specific token or filename), grep is
  fine. This tool's edge is the `related` files and `definitions` enrichment.

### Complementary tools

- `search_docs` for Axis feature docs and indexed documentation.
- `index_file` after creating or significantly changing a file, so future
  searches find it.

### Workflow

1. **Orient.** `get_project_soul`, then `search_codebase` for your task domain.
2. **Fill the soul if needed.** If `get_project_soul` reports it unfilled, call
   `update_project_soul` with `context` and/or `conventions`.
3. **Plan.** Search before designing; do not write code that already exists.
4. **Index.** After creating or refactoring files, call `index_file` so the next
   agent can find them.

## Deployment, releases, and secrets

See **[OPERATIONS.md](../OPERATIONS.md)** in the `shared-context` repo root. It is
the operational source of truth: Vercel deploy and rollback, Supabase migrations,
the npm and PyPI release path, environment variable layout, local development,
and incident response. Do not restate its contents here; duplicated facts drift.
