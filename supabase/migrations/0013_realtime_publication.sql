-- 0013_realtime_publication.sql
-- Live board updates: broadcast a data-free "this went stale" signal whenever
-- coordination state changes, so /team/board can stop polling every 5s.
--
-- WHY BROADCAST-FROM-DATABASE AND NOT THE supabase_realtime PUBLICATION
-- (the filename is the reserved slot, not the mechanism)
--
-- Adding jobs/locks to the `supabase_realtime` publication would enable
-- postgres_changes, which re-checks RLS per row per subscriber before
-- delivering. The web app authenticates with its own session JWT (lib/auth),
-- NOT Supabase Auth, so a browser Supabase client is always `anon` with
-- auth.uid() = NULL. Every policy on jobs/locks/projects requires
-- `projects.owner_id = auth.uid()` (0003), so an anon subscriber would receive
-- exactly nothing — silently, with a healthy-looking SUBSCRIBED channel.
-- Publication membership would therefore add WAL and replication cost and
-- stream full row payloads, and still deliver zero events to the only client
-- that wants them. So this migration deliberately does NOT touch the
-- publication; it uses realtime.send(), which is not row-gated.
--
-- WHAT GOES ON THE WIRE
-- Only {"scope": "jobs" | "locks" | "notepad"}. No titles, paths, agent ids, or
-- prompts. The board uses a signal purely as an invalidation hint and refetches
-- through its authenticated API routes, so the public topic carries nothing
-- worth reading and grants nothing to anyone who forges a message.
--
-- WHY TRIGGERS AND NOT JUST THE API ROUTES
-- The Next.js routes already broadcast (lib/board-broadcast.ts), which covers
-- the board's own buttons and the hosted MCP server. But agents running the
-- LOCAL stdio server write directly to Postgres and never reach those routes —
-- and those are the writes a human is watching the board for. Only a database
-- trigger sees every writer. The overlap is harmless: the board debounces, so
-- two signals for one hosted write cost one refetch.

-- ============================================================
-- 1. Preflight: realtime.send() must exist
-- ============================================================
-- Shipped with Supabase Realtime's broadcast-from-database support. Fail loudly
-- here rather than installing triggers that silently swallow every signal.
DO $$
BEGIN
  IF to_regprocedure('realtime.send(jsonb, text, text, boolean)') IS NULL THEN
    RAISE EXCEPTION
      'realtime.send(jsonb, text, text, boolean) not found. This Supabase project predates broadcast-from-database; upgrade the Realtime extension before applying 0013.';
  END IF;
END
$$;

-- ============================================================
-- 2. The signal function
-- ============================================================
-- TG_ARGV[0] = scope label carried in the payload
-- TG_ARGV[1] = column on the changed row holding the project UUID
--              ('project_id' for jobs/locks, 'id' for projects)
CREATE OR REPLACE FUNCTION public.axis_broadcast_board_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row        jsonb;
  v_project_id text;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  v_project_id := v_row ->> TG_ARGV[1];

  IF v_project_id IS NOT NULL THEN
    PERFORM realtime.send(
      jsonb_build_object('scope', TG_ARGV[0]),
      'board',
      'axis-board:' || v_project_id,
      false  -- public topic: the browser has no Supabase JWT to authorize a
             -- private one, and the payload is deliberately data-free.
    );
  END IF;

  RETURN NULL;  -- AFTER trigger: return value is ignored.
EXCEPTION
  WHEN OTHERS THEN
    -- A Realtime outage must never fail an agent's lock or job write. Losing a
    -- signal only drops the board back to its polling fallback.
    RAISE WARNING 'axis_broadcast_board_change(%) failed: %', TG_ARGV[0], SQLERRM;
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.axis_broadcast_board_change() IS
  'Broadcasts a data-free board invalidation signal on axis-board:<project_id>. Never raises.';

-- ============================================================
-- 3. Triggers
-- ============================================================
DROP TRIGGER IF EXISTS axis_jobs_board_signal ON public.jobs;
CREATE TRIGGER axis_jobs_board_signal
  AFTER INSERT OR UPDATE OR DELETE ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.axis_broadcast_board_change('jobs', 'project_id');

DROP TRIGGER IF EXISTS axis_locks_board_signal ON public.locks;
CREATE TRIGGER axis_locks_board_signal
  AFTER INSERT OR UPDATE OR DELETE ON public.locks
  FOR EACH ROW
  EXECUTE FUNCTION public.axis_broadcast_board_change('locks', 'project_id');

-- The live notepad is a column on projects, so scope this to notepad edits
-- only; unrelated project churn must not wake every open board.
DROP TRIGGER IF EXISTS axis_notepad_board_signal ON public.projects;
CREATE TRIGGER axis_notepad_board_signal
  AFTER UPDATE ON public.projects
  FOR EACH ROW
  WHEN (OLD.live_notepad IS DISTINCT FROM NEW.live_notepad)
  EXECUTE FUNCTION public.axis_broadcast_board_change('notepad', 'id');

-- ============================================================
-- Rollback
-- ============================================================
-- DROP TRIGGER IF EXISTS axis_jobs_board_signal ON public.jobs;
-- DROP TRIGGER IF EXISTS axis_locks_board_signal ON public.locks;
-- DROP TRIGGER IF EXISTS axis_notepad_board_signal ON public.projects;
-- DROP FUNCTION IF EXISTS public.axis_broadcast_board_change();
