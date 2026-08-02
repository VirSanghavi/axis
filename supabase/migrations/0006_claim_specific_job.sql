-- Atomically claim a SPECIFIC job by id (mirrors claim_next_job's FOR UPDATE
-- SKIP LOCKED guarantees). Rejects when dependencies aren't all 'done'.
-- Applied to project rtpjoqplyiedmravytbl on 2026-05-26.
create or replace function public.claim_specific_job(
  p_project_id uuid,
  p_job_id uuid,
  p_agent_id text
) returns jsonb
language plpgsql
as $$
declare
  v_job record;
  v_unmet jsonb;
begin
  select * into v_job
  from public.jobs
  where id = p_job_id and project_id = p_project_id
  for update skip locked;

  if not found then
    if exists (select 1 from public.jobs where id = p_job_id and project_id = p_project_id) then
      return jsonb_build_object('status', 'ALREADY_CLAIMED');
    else
      return jsonb_build_object('status', 'NOT_FOUND');
    end if;
  end if;

  if v_job.status <> 'todo' then
    return jsonb_build_object('status', 'ALREADY_CLAIMED', 'job', row_to_json(v_job));
  end if;

  select coalesce(jsonb_agg(dep_id), '[]'::jsonb) into v_unmet
  from jsonb_array_elements_text(coalesce(v_job.dependencies, '[]'::jsonb)) as dep_id
  left join public.jobs j on j.id::text = dep_id and j.project_id = p_project_id
  where j.status is distinct from 'done';

  if jsonb_array_length(v_unmet) > 0 then
    return jsonb_build_object('status', 'BLOCKED_BY_DEPENDENCIES', 'unmet', v_unmet);
  end if;

  update public.jobs
  set status = 'in_progress', assigned_to = p_agent_id, updated_at = now()
  where id = p_job_id
  returning * into v_job;

  return jsonb_build_object('status', 'CLAIMED', 'job', row_to_json(v_job));
end;
$$;

grant execute on function public.claim_specific_job(uuid, uuid, text) to service_role, authenticated, anon;
