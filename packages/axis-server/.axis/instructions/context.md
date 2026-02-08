# Axis — Project Context

## Overview
Axis is a distributed orchestration layer for parallel AI coding agents. It enables multiple agents (Cursor, Claude Code, Windsurf, Codex, Antigravity, etc.) to work on the same codebase simultaneously without collisions or context drift.

The core value proposition: **agents that coordinate like a team, not individuals who overwrite each other.**

## Architecture
- **Frontend**: Next.js 14 (App Router) deployed on Vercel. Tailwind CSS, Framer Motion. Auth via Supabase.
- **Backend**: Next.js API routes + Supabase (Postgres, RLS, RPC functions). Stripe for billing.
- **MCP Server**: `@virsanghavi/axis-server` — an npm package that exposes Axis tools via the Model Context Protocol. Runs locally in each agent's IDE.
- **State**: All shared state (locks, jobs, notepad, sessions, embeddings) lives in Supabase, scoped per project. The MCP server syncs local state with the remote API.
- **File structure**:
  - `shared-context/frontend/` — the web app (dashboard, billing, docs, auth)
  - `shared-context/packages/axis-server/` — the MCP server package
  - `shared-context/supabase/` — schema, migrations, RPC functions
  - `.axis/instructions/` — soul files read by all agents via MCP

## Core Features
1. **Job Board**: Agents post, claim, and complete tasks. Priority-based, dependency-aware. Prevents duplicate work.
2. **File Locking**: Atomic, per-file locks with 30-minute TTL. Agents call `propose_file_access` before editing. Prevents merge conflicts.
3. **Live Notepad**: Real-time shared memory. Agents log progress so others know what's happening. Cleared on `finalize_session`.
4. **Context Mirroring**: `get_project_soul` returns this file + conventions to ground agents in project reality.
5. **RAG Search**: `search_codebase` and `search_docs` for semantic search over indexed files and documentation.
6. **Session Management**: `finalize_session` archives the notepad, clears locks, resets for new work.
7. **Billing**: Stripe-based Pro tier ($25/mo) with API key management, usage tracking, and retention flow.

## Deployment
- Frontend: Vercel (auto-deploy from `shared-context/frontend/`)
- Database: Supabase (hosted Postgres)
- MCP Server: Published to npm, run locally via `npx @virsanghavi/axis-server`
