-- 0014_atomic_try_acquire_lock.sql
--
-- Make lock acquisition atomic.
--
-- Folded in from the unnumbered supabase/migration_atomic_locks_and_jobs.sql,
-- which was hand-applied to production project rtpjoqplyiedmravytbl on
-- 2026-02-07 and never given a migration number. CREATE OR REPLACE FUNCTION is
-- idempotent, so re-applying this to production is a no-op.
--
-- The version it replaces did SELECT-then-INSERT: two agents proposing the same
-- file within the same instant could both see no lock and both be told GRANTED.
-- INSERT ... ON CONFLICT collapses that into one statement, so exactly one
-- agent wins. claim_next_job needed no equivalent change; it was already
-- serialized by FOR UPDATE SKIP LOCKED.

create or replace function public.try_acquire_lock(
  p_project_id uuid,
  p_file_path text,
  p_agent_id text,
  p_intent text,
  p_user_prompt text,
  p_timeout_seconds integer default 1800
)
returns table (status text, owner_id text, intent text, updated_at timestamp with time zone)
language plpgsql
as $$
declare
    v_result record;
begin
    -- Step 1: Atomically clean stale lock for this specific file
    delete from public.locks
    where project_id = p_project_id
      and file_path = p_file_path
      and extract(epoch from (now() - locks.updated_at)) > p_timeout_seconds;

    -- Step 2: Atomic insert-or-conditional-update
    -- INSERT succeeds if no lock exists (new lock).
    -- ON CONFLICT fires if a lock already exists:
    --   - WHERE matches (same agent) -> UPDATE succeeds -> RETURNING produces a row -> GRANTED (refresh)
    --   - WHERE does not match (different agent) -> UPDATE is skipped -> RETURNING produces NO rows -> DENIED
    insert into public.locks (project_id, file_path, agent_id, intent, user_prompt, updated_at)
    values (p_project_id, p_file_path, p_agent_id, p_intent, p_user_prompt, now())
    on conflict (project_id, file_path) do update
    set intent = excluded.intent,
        user_prompt = excluded.user_prompt,
        updated_at = now()
    where public.locks.agent_id = p_agent_id  -- only the lock owner can refresh their own lock
    returning public.locks.agent_id, public.locks.intent, public.locks.updated_at
    into v_result;

    if v_result is not null then
        -- We either inserted a new lock or refreshed our own -> GRANTED
        return query select 'GRANTED'::text, v_result.agent_id::text, v_result.intent::text, v_result.updated_at;
    else
        -- Another agent holds the lock -> DENIED. Return the current owner's info.
        select l.agent_id, l.intent, l.updated_at into v_result
        from public.locks l
        where l.project_id = p_project_id and l.file_path = p_file_path;

        if v_result is not null then
            return query select 'DENIED'::text, v_result.agent_id::text, v_result.intent::text, v_result.updated_at;
        else
            -- Edge case: lock was deleted between our insert attempt and this select (very unlikely)
            -- Retry by inserting again
            insert into public.locks (project_id, file_path, agent_id, intent, user_prompt, updated_at)
            values (p_project_id, p_file_path, p_agent_id, p_intent, p_user_prompt, now())
            on conflict (project_id, file_path) do nothing;

            return query select 'GRANTED'::text, p_agent_id::text, p_intent::text, now();
        end if;
    end if;
end;
$$;

grant execute on function public.try_acquire_lock(uuid, text, text, text, text, integer)
  to service_role, authenticated, anon;
