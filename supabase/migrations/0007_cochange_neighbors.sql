-- Behavioral co-change graph mined from real multi-agent activity.
-- Given seed file(s), find files the SAME agents locked within a time window of
-- locking a seed — i.e. files that actually get worked on together. Recency-
-- weighted. Applied to project rtpjoqplyiedmravytbl on 2026-05-26.
create or replace function public.cochange_neighbors(
  p_project_id uuid,
  p_file_paths text[],
  p_window_minutes int default 120,
  p_limit int default 10
)
returns table (file_path text, weight float, co_count bigint, last_seen timestamptz)
language sql stable
as $$
  with seeds as (
    select requesting_agent as agent, created_at as t
    from public.lock_events
    where project_id = p_project_id
      and file_path = any(p_file_paths)
      and event_type = 'GRANTED'
  )
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
  order by weight desc
  limit p_limit;
$$;

grant execute on function public.cochange_neighbors(uuid, text[], int, int) to service_role, authenticated, anon;
