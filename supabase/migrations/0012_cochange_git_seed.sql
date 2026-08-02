-- Cold-start fix for co-change: seed the graph from git history.
--
-- cochange_neighbors previously read only lock_events, so a brand-new project
-- returned nothing until its agents had produced hours of lock activity. Files
-- that co-commit in git history are the same "worked on together" signal, just
-- weaker — so the indexer now uploads co-commit pairs into git_cochange, and
-- the RPC blends them under live lock evidence (git weight x0.3). Each row
-- also reports its source ('live' / 'git' / 'both') so callers can label the
-- graph as warming up vs. behavioral.

create table if not exists public.git_cochange (
  project_id uuid not null,
  file_a text not null,
  file_b text not null,
  weight double precision not null default 0,
  co_count integer not null default 0,
  last_seen timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  primary key (project_id, file_a, file_b)
);

comment on table public.git_cochange is
  'Git co-commit pairs uploaded at index time; cold-start seed for cochange_neighbors. Pairs stored normalized (file_a < file_b). Service-role only.';

create index if not exists git_cochange_lookup_b_idx
  on public.git_cochange (project_id, file_b);

alter table public.git_cochange enable row level security;

do $$
begin
  if to_regclass('public.projects') is not null then
    if not exists (
      select 1 from pg_constraint where conname = 'git_cochange_project_id_fkey'
    ) then
      execute 'alter table public.git_cochange
        add constraint git_cochange_project_id_fkey
        foreign key (project_id) references public.projects(id) on delete cascade';
    end if;
  end if;
end
$$;

-- Return type gains a `source` column, so the old signature must be dropped
-- (create or replace cannot change a return table).
drop function if exists public.cochange_neighbors(uuid, text[], int, int);

create function public.cochange_neighbors(
  p_project_id uuid,
  p_file_paths text[],
  p_window_minutes int default 120,
  p_limit int default 10
)
returns table (file_path text, weight float, co_count bigint, last_seen timestamptz, source text)
language sql stable
as $$
  with seeds as (
    select requesting_agent as agent, created_at as t
    from public.lock_events
    where project_id = p_project_id
      and file_path = any(p_file_paths)
      and event_type = 'GRANTED'
  ),
  live as (
    select le.file_path,
           sum(1.0 / (1 + extract(epoch from (now() - le.created_at)) / 86400.0))::float as weight,
           count(*)::bigint as co_count,
           max(le.created_at) as last_seen
    from public.lock_events le
    join seeds s
      on le.requesting_agent = s.agent
     and abs(extract(epoch from (le.created_at - s.t))) <= p_window_minutes * 60
    where le.project_id = p_project_id
      and le.event_type = 'GRANTED'
      and not (le.file_path = any(p_file_paths))
    group by le.file_path
  ),
  -- Pairs are stored normalized (file_a < file_b); read both directions.
  git as (
    select case when g.file_a = any(p_file_paths) then g.file_b else g.file_a end as file_path,
           (sum(g.weight) * 0.3)::float as weight,
           sum(g.co_count)::bigint as co_count,
           max(g.last_seen) as last_seen
    from public.git_cochange g
    where g.project_id = p_project_id
      and (g.file_a = any(p_file_paths) or g.file_b = any(p_file_paths))
      and not (g.file_a = any(p_file_paths) and g.file_b = any(p_file_paths))
    group by 1
  )
  select coalesce(l.file_path, g.file_path) as file_path,
         (coalesce(l.weight, 0) + coalesce(g.weight, 0))::float as weight,
         (coalesce(l.co_count, 0) + coalesce(g.co_count, 0))::bigint as co_count,
         greatest(coalesce(l.last_seen, 'epoch'::timestamptz), coalesce(g.last_seen, 'epoch'::timestamptz)) as last_seen,
         case
           when l.file_path is not null and g.file_path is not null then 'both'
           when l.file_path is not null then 'live'
           else 'git'
         end as source
  from live l
  full outer join git g on g.file_path = l.file_path
  order by weight desc
  limit p_limit;
$$;

grant execute on function public.cochange_neighbors(uuid, text[], int, int) to service_role, authenticated, anon;
