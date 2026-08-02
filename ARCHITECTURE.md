# Axis Architecture

*Last updated: 2026-08-02 (audit #3 decomposition). If you change the module
layout or a persistence path, update this file in the same PR.*

Axis is a multi-agent coordination layer for AI coding agents: a shared job
board, advisory file locks, a live notepad, and code intelligence, exposed to
agents over MCP. The system spans **two repos**:

| Repo | Role |
|---|---|
| `shared-context` (this repo) | The local MCP server shipped to customers (`@virsanghavi/axis-server`), the init CLI (`@virsanghavi/axis-init`), the Python SDK (`virsanghavi-axis`), and the Supabase schema |
| `axis-frontend` | The hosted product at useaxis.dev: Next.js app with marketing site, team board UI, Stripe billing, OAuth, admin, the hosted `/api/v1` coordination API, and a hosted MCP endpoint at `/api/mcp` |

## The local MCP server (`src/local/`)

Agents run `axis-server` as a stdio MCP server. `mcp-server.ts` defines the
tool surface (get_project_soul, post_job, claim_next_job, propose_file_access,
complete_job, finalize_session, search_codebase, …) and delegates to
**NerveCenter**.

### NerveCenter and its modules

`nerve-center.ts` is a **facade**. It owns identity/org/project scoping,
bootstrap (`init`, `switchProject`), the live notepad, session finalization,
and billing passthrough — and delegates everything else to focused modules
(extracted in audit #3 from what was a 1,968-line god class):

| Module | Responsibility |
|---|---|
| `coordination-types.ts` | Shared types (`FileLock`, `Job`, `JobRecord`, state, options), `jobFromRecord`, `createEmptyState`, and `CoordinationContext` — the typed slice of ContextManager the layer depends on (formerly `any`) |
| `coordination-client.ts` | `CoordinationClient`: HTTP client for the hosted `/api/v1` coordination API. Retry with exponential backoff; circuit breaker (5 consecutive 5xx/network failures → open 60s → fail fast with `CircuitOpenError` so callers use local fallbacks) |
| `job-board.ts` | `JobBoard`: post / claim-next / claim-by-id / cancel / complete across all three persistence tiers; local tier also reclaims abandoned in_progress jobs |
| `lock-registry.ts` | `LockRegistry`: propose / batch-propose (all-or-nothing) / release / force-unlock / verify (tamper check) / guarded-write (optimistic concurrency), plus lock-event audit logging |
| `lock-paths.ts` | Pure helpers: lock path normalization, file-only validation (directory locks rejected), actionable denial messages |
| `enforced-perms.ts` | `EnforcedPerms`: opt-in physical enforcement (`AXIS_ENFORCE_LOCKS`) — chmod locked files read-only, restore on release/complete/finalize. Advisory by design: any same-user process can revert it |
| `state-store.ts` | `StateStore`: JSON-file persistence for the local fallback tier (owns the state object so reloads can't leave stale aliases) |
| `protocol-transcript.ts` | `ProtocolTranscript`: buffers MCP tool calls/results; merged into the archived transcript at finalize |
| `core-services.ts` | `CoreServices`: the accessor interface (shared mutex, store, coordination client, supabase handle, project identity) NerveCenter exposes to JobBoard/LockRegistry. Accessors, not captured values — identity changes on `switch_project` |

Supporting modules that predate the split:

- `context-manager.ts` — reads/writes the project soul (`.axis/instructions/`),
  search/embed passthrough to the hosted API
- `project-identity.ts` / `agent-identity.ts` / `agent-presence.ts` — project
  root + org detection (`.axis/axis.json`), per-session unique agent ids,
  in-process presence roster
- `workspace-watch.ts` — auto-rescopes coordination when the client's cwd moves
  to a different repo
- `team-updates.ts` — piggybacks "what teammates did since your last call" onto
  tool results
- `session-transcript.ts` — collects the host agent's native transcript at
  finalize
- `local-search.ts` / `rag-engine.ts` / `indexer.ts` — local search fallback and
  hosted RAG bridge (see audit #21 for the honest local-vs-hosted capability gap)
- `lock-integrity.ts` — content fingerprinting for tamper detection
- `fs-guard.ts` — chmod primitives used by `EnforcedPerms`
- `job-hygiene.ts` — stale in_progress job reclaim policy
- `tool-manifest.ts` (in progress, audit #2) — canonical tool manifest shared
  by local and hosted surfaces

## Persistence tiers (the "hybrid" model)

Every JobBoard/LockRegistry operation resolves through the first available
tier:

1. **Hosted API** (customer mode): `SHARED_CONTEXT_API_URL` +
   `AXIS_API_KEY` set → `CoordinationClient` calls `/api/v1/{jobs,locks,...}`
   with `X-Axis-Org` pinning coordination to the shared org board. Atomicity
   lives server-side (Supabase RPCs `try_acquire_lock`, `claim_next_job`,
   `claim_specific_job`).
2. **Direct Supabase** (dev mode): `NEXT_PUBLIC_SUPABASE_URL` +
   `SUPABASE_SERVICE_ROLE_KEY` set → same RPCs called directly.
3. **Local JSON file** (free/offline mode): `history/nerve-center-state.json`
   via `StateStore`, guarded by a per-process mutex only. Known limits tracked
   as audit #5 (no cross-process safety; full-file serialize per mutation).

Org scoping matters: without an org id (env `AXIS_ORG_ID` or `.axis/axis.json`
`"org"`), the hosted API resolves every call to the caller's *personal* org and
teammates silently get disjoint boards.

## Hosted surfaces (`axis-frontend`)

- `/api/v1/*` — the coordination + intelligence REST API (jobs, locks,
  lock-events, sessions, agents, search, deep-search, embed, usage, projects).
  Auth via `api_keys` bearer tokens; org via `X-Axis-Org`.
- `/api/mcp` — hosted MCP endpoint (currently hand-rolled JSON-RPC; audit #1
  consolidation in progress). Known tool drift vs the local server is audit #2.
- `/team` — live team board UI (jobs/locks/presence/context; 5s polling today,
  Supabase Realtime migration is audit #17).
- Stripe billing (`/api/stripe`), OAuth (`/api/oauth`), admin, marketing pages.

## Data model (Supabase)

Numbered migrations in `supabase/migrations/` (0001–0010): projects, jobs,
locks (+ `content_hash` for tamper detection), lock_events, sessions,
api_keys, profiles/orgs/billing, embeddings with full-text + trigram indexes,
hybrid-search and atomic job/lock RPCs, OAuth org binding, MCP session events.
Migration consolidation (ad-hoc SQL files, stale schema snapshots) is audit #6,
in progress.

## Other servers in this repo

- `src/local/server.ts` — abandoned Express/SSE server, and
  `src/api/index.ts` — duplicate Hono API. Both slated for
  deprecation/removal under audits #1/#12 (in progress). New code must target
  the stdio server (`mcp-server.ts`) or the hosted app only.

## Release path

Three artifacts publish from this repo: `@virsanghavi/axis-server`,
`@virsanghavi/axis-init` (npm), and `virsanghavi-axis` (PyPI). Publish
credentials live in the macOS keychain (service `axis-release`), never in web
app env files — see `docs/RELEASING.md` for retrieval, publish, and rotation.
CI publish automation is audit #25.

## Testing

`bun test` runs the suite in `tests/` (nerve-center core + advanced, locks,
batch locks, enforcement, integrity, jobs, identity, presence, transcript,
team updates, workspace watch, tool manifest). Tests inject structural mocks
for `CoordinationContext` — keep that interface all-optional. CI
(`.github/workflows/ci.yml`) is being extended to the full suite + eslint +
`tsc --noEmit` (audit #8, in progress).
