-- 0015_projects_name_owner_unique.sql
--
-- Scope project names to their owner.
--
-- Folded in from the unnumbered supabase/migration_fix_constraints.sql, which
-- was hand-applied to production project rtpjoqplyiedmravytbl on 2026-02-07 and
-- never given a migration number. Guarded so re-applying is a no-op.
--
-- projects started life with UNIQUE(name), which is global: the first user to
-- register a project called "api" made that name unavailable to everyone else.
-- The constraint belongs on (name, owner_id).
--
-- The commented-out api_usage.metadata column from the original ad-hoc file is
-- deliberately dropped rather than carried forward: it was never applied to
-- production and nothing reads it. Add it in a new migration if it is ever
-- wanted.

alter table public.projects drop constraint if exists projects_name_key;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.projects'::regclass
      and conname = 'projects_name_owner_unique'
  ) then
    alter table public.projects
      add constraint projects_name_owner_unique unique (name, owner_id);
  end if;
end
$$;
