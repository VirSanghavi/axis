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

## Agent Behavioral Norms

### Plan Before Write — The Core Invariant

**No agent writes code unless it either owns a file lock OR has explicitly declined the job board for a scoped reason.**

On non-trivial tasks (2+ files, new features, refactors):
1. Break work into jobs → `post_job`
2. Claim before editing → `claim_next_job`
3. Lock before writing → `propose_file_access` with a **descriptive intent**
4. Complete when done → `complete_job` with outcome

Direct edits without a job are allowed only for:
- Single-line fixes, typos, config tweaks
- Clearly scoped changes the user asked for directly

### Force Unlock Policy

`force_unlock` is a **last resort, not a convenience tool.**

Rules:
1. **Never** call `force_unlock` on a file you didn't lock unless:
   - The lock has been held for >25 minutes (close to TTL expiry), AND
   - The locking agent is clearly not responding or has crashed
2. **Always** provide a specific reason (e.g. "Agent claude-code crashed 20 minutes ago, lock on auth.ts is blocking progress")
3. **Never** force-unlock to skip coordination. If another agent holds a lock, work on something else.
4. Prefer waiting for TTL expiry (30 min) over force-unlocking.

### Lock Hygiene
- Always provide descriptive `intent` when locking (e.g. "Refactor auth middleware to use JWT validation" — not "editing file")
- Release locks early by completing jobs when done
- Call `finalize_session` at end of session to clean up all locks

### Shared Memory
- Call `update_shared_context` after completing meaningful steps
- Log decisions, not just actions (e.g. "Chose JWT over session tokens because...")
- Other agents read the notepad in real-time — write for them
