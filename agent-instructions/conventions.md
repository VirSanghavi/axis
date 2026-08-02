# Axis: Coding Conventions and Agent Norms

> **Canonical copy.** This is the single source of truth for agent conventions
> across both Axis repos. The copy at `axis-frontend/agent-instructions/` is a
> pointer stub. Edit this file, not that one.

## Language standards

- **TypeScript** for all app, server, and API code. Strict mode. No `any` unless
  genuinely unavoidable.
- **SQL** for Supabase migrations. Use `IF NOT EXISTS` / `IF EXISTS` so every
  migration is idempotent. Guard references to tables that were created outside
  the numbered chain with `to_regclass` checks, so a migration applies cleanly
  both to a database built from `0001` upward and to production as it exists.
- **HTML/CSS/JS** for standalone tools such as sandbox apps. Single file, no
  framework, no build step.
- No em dashes in user-facing copy or documentation. Use commas or periods.

## Styling (axis-frontend)

- Tailwind CSS exclusively. No custom CSS files except for animations.
- Dark theme: `bg-[#050505]`, `text-white`, `border-white/5`. Light panels:
  `bg-white/95`, `text-neutral-900`.
- Typography: `lowercase` on page wrappers, `font-mono` for technical content,
  `tracking-tight` by default.
- Minimal components, no component library. Custom components in `components/`.
- Mobile is not optional. Check a real narrow viewport: no overflow, no clipping,
  no horizontal scroll, tap targets large enough, layout reflowed deliberately.

## Code patterns

### Shared

- Scope every record by authenticated user, project, and org. Orgs are the unit
  of both collaboration and billing; do not add paths that bypass org scoping.
- Read boundaries are tolerant, write boundaries are strict. Match the real shape
  of external data rather than the assumed one, and never let one malformed
  element blank an entire collection.

### axis-frontend (`frontend/`)

- Authenticate API routes with `getSessionFromRequest`. Rate limit with
  `getClientIp` plus `rateLimit`.
- Use Supabase service clients for server-side persistence.
- Keep the hosted MCP endpoint (`app/api/mcp`) a **thin adapter** over
  `/api/v1`. Business logic belongs in the v1 routes, not in the adapter.
- Supabase queries use `.ilike('email', ...)` for case-insensitive email matching.
- Stripe customer IDs come from the database (`profiles.stripe_customer_id`).
  Never hardcode a customer ID.
- Every Stripe route self-heals "no such customer": look up by email, update the
  database, retry.
- CSV export routes must keep the formula-injection guard: prefix any cell
  starting with `=`, `+`, `-`, `@`, tab, or CR with a single quote.

### shared-context (`src/`)

- MCP tools are declared once, in `src/shared/tool-registry.ts`. Never add an
  inline tool definition in a server file.
- `src/local/server.ts` and `src/api/index.ts` are deprecated and awaiting
  deletion. Do not add to them.

## Verification

- **shared-context:** `bunx eslint . --max-warnings=0`, `bunx tsc --noEmit`,
  `bun test`, and `bun tests/load-test.ts`. That is exactly what CI runs.
- **axis-frontend** (from `frontend/`): `npm run lint`, `npx tsc --noEmit`,
  `npm test`, and `npm run build` before anything user-facing. That is exactly
  what CI runs, plus the build.
- The health endpoint at `/api/health` probes Supabase and Stripe and returns 503
  when either is failing.
- A feature is not done because the code exists. Trace it from defined, to wired,
  to observably effective. A function with zero call sites is a shippable gap
  that looks like a working feature.

---

## Agent behavioral norms (mandatory)

These norms apply to all AI coding agents. They are not suggestions; execute them
autonomously.

### Autonomous execution

- **NEVER** wait for the user to say "use Axis" or "post a job" or "lock the
  file." Just do it.
- **NEVER** pause after analysis to ask permission to proceed. Identify the
  issues, then start fixing them.
- **NEVER** leave locks or jobs dangling. Complete jobs and finalize sessions
  without being told.
- **IMMEDIATELY** call `get_project_soul` as the first action in any session.

### Plan before write

**No agent writes code unless it either owns a file lock or has explicitly
declined the job board for a scoped reason.**

Activate orchestration automatically when any of these is true: two or more
files, two or more independent workstreams, a shared API/schema/protocol change,
a refactor or migration or audit, meaningful production risk, or a likely
duration over ten minutes.

On complex tasks:

1. `list_jobs` and `list_locks` to synchronize with active work.
2. `post_job` to break the work into trackable jobs. Do this immediately, not
   after being asked.
3. `claim_job` for assigned work, otherwise `claim_next_job`.
4. `propose_file_access` to lock, with a **descriptive intent**.
5. `complete_job` to report the outcome when done. This releases the lock.

Skip jobs only for single-line fixes, typos, and config tweaks.

### Lock hygiene

- Give a descriptive `intent` when locking, not "editing file".
- Release locks immediately by completing jobs. Never hold a lock while doing
  unrelated work.
- Use `release_file_access` when a file is no longer needed but the job is still
  active.
- `force_unlock` is a **last resort**, only for locks older than about 25 minutes
  from a crashed agent. Always give a reason.
- If the user switches repositories in the same MCP session, call
  `switch_project` with the new project root instead of reconnecting the server.

### Releasing locks (critical, do not skip)

**Every file you lock must be unlocked before your session ends.** Dangling locks
block every other agent in the project.

- **Primary unlock method:** `complete_job`, which releases all locks for that job.
- **Session end:** `finalize_session`, which clears all remaining locks. Call it
  before you stop responding.
- **Self-check:** before finishing, ask "have I completed all jobs and called
  `finalize_session`?" If not, do it now.

### Session cleanup (mandatory)

- `complete_job` after every finished task. Do not accumulate incomplete jobs;
  this is how locks get released.
- `update_shared_context` after claims, design decisions, shared-contract
  changes, blockers, verification results, and handoffs.
- Refresh `list_jobs` and `list_locks` after interruptions or long waits before
  resuming edits.
- `finalize_session` when the user's request is fully complete. This is required,
  not optional, and it clears all remaining locks.
