# Axis — Coding Conventions & Agent Norms

## Language Standards
- **TypeScript** for all frontend and API code. Strict mode. No `any` unless absolutely necessary.
- **SQL** for Supabase migrations. Use `IF NOT EXISTS` / `IF EXISTS` for idempotency.
- **HTML/CSS/JS** for standalone tools (e.g. sandbox apps). Single-file, no frameworks, no build step.

## Styling
- Tailwind CSS exclusively. No custom CSS files unless for animations.
- Dark theme: `bg-[#050505]`, `text-white`, `border-white/5`. Light panels: `bg-white/95`, `text-neutral-900`.
- Typography: `lowercase` class on page wrappers. `font-mono` for technical content. `tracking-tight` default.
- Components: Minimal, no component library. Custom components in `components/`.

## Testing
- Manual testing via browser and MCP tool calls.
- Health endpoint at `/api/health` checks Supabase and Stripe connectivity.

## Code Patterns
- API routes use `getSessionFromRequest` for auth, `getClientIp` + `rateLimit` for rate limiting.
- Supabase queries use `.ilike('email', ...)` for case-insensitive email matching.
- Stripe customer IDs come from DB (`profiles.stripe_customer_id`). Never hardcode customer IDs.
- All Stripe routes have "no such customer" self-healing: look up by email, update DB, retry.

---

## Agent Behavioral Norms (MANDATORY)

These norms apply to all AI coding agents. They are not optional or suggestive — execute them autonomously.

### Autonomous Execution

- **NEVER** wait for the user to say "use Axis" or "post a job" or "lock the file." Just do it.
- **NEVER** pause after analysis to ask permission to proceed. Identify issues → start fixing immediately.
- **NEVER** leave locks or jobs dangling. Complete jobs and finalize sessions without being told.
- **IMMEDIATELY** call `get_project_soul` as the first action in any session.

### Plan Before Write

**No agent writes code unless it either owns a file lock OR has explicitly declined the job board for a scoped reason.**

On non-trivial tasks (2+ files, new features, refactors):
1. `post_job` — break into trackable jobs (do this IMMEDIATELY, not after being asked)
2. `claim_next_job` — claim before starting
3. `propose_file_access` — lock with a **descriptive intent**
4. `complete_job` — report outcome when done (this releases the lock)

Skip jobs ONLY for: single-line fixes, typos, config tweaks.

### Lock Hygiene
- Descriptive `intent` when locking (not "editing file").
- Release locks IMMEDIATELY by completing jobs. Never hold a lock while doing unrelated work.
- `force_unlock` is a **last resort** — only for locks >25 min old from a crashed agent. Always give a reason.

### Releasing Locks (CRITICAL — do not skip)
**Every file you lock MUST be unlocked before your session ends.** Dangling locks block every other agent in the project.
- **Primary unlock method**: `complete_job` — releases all locks for that job.
- **Session end**: `finalize_session` — clears ALL remaining locks. Call this before you stop responding.
- **Self-check**: Before finishing, verify: "Have I completed all jobs and called `finalize_session`?" If not, do it now.

### Session Cleanup (MANDATORY)
- `complete_job` after EVERY finished task — do not accumulate incomplete jobs. **This is how locks get released.**
- `update_shared_context` after meaningful steps — log decisions, not just actions.
- `finalize_session` when the user's request is fully complete — this is required, not optional. **This clears all remaining locks.**
