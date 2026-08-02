-- 0000_baseline_schema.sql
--
-- Baseline: the core schema every later migration assumes.
--
-- History: migrations 0001 and 0002 only ever created `profiles` and
-- `api_keys`. Everything else (projects, jobs, locks, embeddings, sessions,
-- ...) was created by hand in the Supabase SQL editor from the ad-hoc
-- `schema*.sql` snapshots that used to live in this directory, so migrations
-- 0003..0010 referenced tables that no migration had ever created and the
-- chain could not rebuild the database from empty.
--
-- This file closes that gap. It reproduces production project
-- rtpjoqplyiedmravytbl as captured by `supabase db dump` on 2026-02-07,
-- which is the state migration 0003 was written against. Later migrations
-- carry the schema forward from here.
--
-- Fully idempotent (IF NOT EXISTS / CREATE OR REPLACE / DO $$ guards): the
-- objects below already exist in production, so re-applying is a no-op there.
-- It numbers 0000 rather than renumbering the existing chain because 0001..0010
-- are already applied to production and must keep their identity.

-- ============================================================
-- 1. Extensions
-- ============================================================
create extension if not exists vector;

-- ============================================================
-- 2. Tables
-- ============================================================

-- Profiles: user accounts and billing state. Mirrors auth.users 1:1.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id),
  email text,
  full_name text,
  subscription_status text default 'free',
  stripe_customer_id text,
  current_period_end timestamp with time zone,
  usage_count integer default 0,
  has_seen_retention boolean default false,
  updated_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

-- Projects: the coordination unit. `unique(name)` is production's original
-- constraint; migration 0012 replaces it with unique(name, owner_id).
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  owner_id uuid references public.profiles(id) on delete cascade,
  live_notepad text default (('Session Start: ' || (timezone('utc'::text, now()))::text) || '\n'),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- API keys. Note: production has no UNIQUE constraint on key_hash, only a
-- plain btree index. The retired schema.sql claimed `unique` here; production
-- is the source of truth, so this matches production.
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  key_hash text not null,
  name text not null,
  is_active boolean default true,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

create table if not exists public.api_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  api_key_id uuid references public.api_keys(id) on delete set null,
  endpoint text not null,
  method text not null default 'GET',
  status_code integer,
  response_time_ms integer,
  tokens_used integer default 0,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

-- Embeddings: RAG corpus. Migration 0004 adds the generated `fts` column.
create table if not exists public.embeddings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  content text not null,
  embedding vector(1536),
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Jobs: the agent job board.
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  description text not null,
  priority text not null check (priority in ('low', 'medium', 'high', 'critical')),
  status text not null check (status in ('todo', 'in_progress', 'done', 'cancelled')),
  assigned_to text,
  dependencies jsonb default '[]'::jsonb,
  cancel_reason text,
  completion_key text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Locks: file-level concurrency control. Migration 0009 adds content_hash.
create table if not exists public.locks (
  file_path text not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  agent_id text not null,
  intent text,
  user_prompt text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  primary key (project_id, file_path)
);

-- Lock events: conflict/telemetry trail. Read by cochange_neighbors (0007).
create table if not exists public.lock_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  event_type text not null check (event_type in ('BLOCKED', 'GRANTED', 'FORCE_UNLOCKED', 'RELEASED')),
  file_path text not null,
  requesting_agent text not null,
  blocking_agent text,
  intent text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Sessions: multi-agent collaboration history.
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  summary text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  completed_at timestamp with time zone
);

create table if not exists public.governance_rules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  rule_type text not null,
  rule_body text not null,
  target text,
  is_active boolean default true,
  created_by uuid references public.profiles(id),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  email text,
  message text not null,
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  subject text not null,
  message text not null,
  user_id uuid references auth.users(id) on delete set null,
  status text default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table if not exists public.activity_feed (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  type text not null,
  target text,
  status text default 'success'::text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now()
);

create table if not exists public.logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  type text not null,
  target text,
  status text default 'success'::text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now()
);

-- ============================================================
-- 3. Indexes
-- ============================================================
create index if not exists activity_feed_created_at_idx on public.activity_feed (created_at desc);
create index if not exists activity_feed_user_id_idx on public.activity_feed (user_id);
create index if not exists api_keys_key_hash_idx on public.api_keys (key_hash);
create index if not exists idx_api_keys_key_hash on public.api_keys (key_hash);
create index if not exists idx_api_keys_user_id on public.api_keys (user_id);
create index if not exists idx_api_usage_key on public.api_usage (api_key_id);
create index if not exists idx_api_usage_user_created on public.api_usage (user_id, created_at desc);
create index if not exists embeddings_project_id_idx on public.embeddings (project_id);
create index if not exists embeddings_metadata_gin_idx on public.embeddings using gin (metadata);
create index if not exists embeddings_embedding_idx on public.embeddings using hnsw (embedding vector_cosine_ops);
create index if not exists jobs_project_id_idx on public.jobs (project_id);
create index if not exists jobs_status_idx on public.jobs (status);
create index if not exists locks_project_id_idx on public.locks (project_id);
create index if not exists lock_events_project_id_idx on public.lock_events (project_id);
create index if not exists lock_events_created_at_idx on public.lock_events (created_at desc);
create index if not exists lock_events_event_type_idx on public.lock_events (event_type);

-- ============================================================
-- 4. Functions
--
-- try_acquire_lock is deliberately absent: production's original version had a
-- check-then-insert race. Migration 0011 defines the atomic replacement, which
-- is the only version a rebuilt database should ever have.
-- ============================================================

create or replace function public.match_embeddings(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  p_project_id uuid
)
returns table (id uuid, content text, similarity float, metadata jsonb)
language plpgsql
as $$
begin
  return query
  select
    embeddings.id,
    embeddings.content,
    1 - (embeddings.embedding <=> query_embedding) as similarity,
    embeddings.metadata
  from public.embeddings
  where 1 - (embeddings.embedding <=> query_embedding) > match_threshold
    and project_id = p_project_id
  order by embeddings.embedding <=> query_embedding
  limit match_count;
end;
$$;

create or replace function public.clean_stale_locks(p_project_id uuid, p_timeout_seconds int)
returns void
language plpgsql
as $$
begin
  delete from public.locks
  where project_id = p_project_id
    and extract(epoch from (now() - updated_at)) > p_timeout_seconds;
end;
$$;

create or replace function public.append_to_project_notepad(p_project_id uuid, p_text text)
returns void
language plpgsql
as $$
begin
  update public.projects
  set live_notepad = coalesce(live_notepad, '') || p_text
  where id = p_project_id;
end;
$$;

create or replace function public.get_daily_usage(p_user_id uuid, p_days int)
returns table (day text, request_count bigint, total_tokens bigint)
language plpgsql
security definer
as $$
begin
  return query
  select
    to_char(created_at, 'YYYY-MM-DD') as day,
    count(*) as request_count,
    sum(coalesce(tokens_used, 0)) as total_tokens
  from public.api_usage
  where user_id = p_user_id
    and created_at > now() - (p_days || ' days')::interval
  group by 1
  order by 1;
end;
$$;

create or replace function public.get_lock_event_stats(p_project_id uuid, p_days int default 7)
returns table (event_type text, event_count bigint, day text)
language plpgsql
security definer
as $$
begin
  return query
  select
    le.event_type,
    count(*) as event_count,
    to_char(le.created_at, 'YYYY-MM-DD') as day
  from public.lock_events le
  where le.project_id = p_project_id
    and le.created_at > now() - (p_days || ' days')::interval
  group by le.event_type, to_char(le.created_at, 'YYYY-MM-DD')
  order by day;
end;
$$;

-- Claims the highest-priority unblocked job. FOR UPDATE SKIP LOCKED makes
-- concurrent claims by racing agents safe.
create or replace function public.claim_next_job(p_project_id uuid, p_agent_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_job_record record;
begin
  with next_job as (
    select id
    from public.jobs
    where project_id = p_project_id
      and status = 'todo'
      and (
        dependencies is null
        or dependencies = '[]'::jsonb
        or not exists (
          select 1
          from jsonb_array_elements_text(dependencies) as dep_id
          join public.jobs j on j.id::text = dep_id
          where j.project_id = p_project_id and j.status != 'done'
        )
      )
    order by
      case priority
        when 'critical' then 1
        when 'high' then 2
        when 'medium' then 3
        when 'low' then 4
        else 5
      end asc,
      created_at asc
    for update skip locked
    limit 1
  )
  update public.jobs
  set status = 'in_progress',
      assigned_to = p_agent_id,
      updated_at = now()
  from next_job
  where public.jobs.id = next_job.id
  returning public.jobs.* into v_job_record;

  if v_job_record.id is not null then
    return jsonb_build_object('status', 'CLAIMED', 'job', row_to_json(v_job_record));
  else
    return jsonb_build_object('status', 'NO_JOBS_AVAILABLE');
  end if;
end;
$$;

-- ============================================================
-- 5. Row level security
--
-- Every table is RLS-on. The server talks to Postgres with the service_role
-- key, which bypasses RLS; these policies scope what a user's own JWT can
-- reach. locks / sessions / governance_rules get their policies in 0003.
-- ============================================================
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.api_keys enable row level security;
alter table public.api_usage enable row level security;
alter table public.embeddings enable row level security;
alter table public.jobs enable row level security;
alter table public.locks enable row level security;
alter table public.lock_events enable row level security;
alter table public.feedback enable row level security;
alter table public.support_requests enable row level security;
alter table public.activity_feed enable row level security;
alter table public.logs enable row level security;

-- Policy names below are the ones production carries that no other migration
-- creates. 0001 and 0002 create the trailing-period variants on profiles and
-- api_keys; production accumulated both sets, and they are reproduced as-is so
-- a rebuilt database matches production's effective access rules.
do $$
begin
  -- profiles
  drop policy if exists "Owner access" on public.profiles;
  create policy "Owner access" on public.profiles using (auth.uid() = id);
  drop policy if exists "Users can view own profile" on public.profiles;
  create policy "Users can view own profile" on public.profiles for select using (auth.uid() = id);
  drop policy if exists "Users can update own profile" on public.profiles;
  create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);

  -- api_keys
  drop policy if exists "Owner access" on public.api_keys;
  create policy "Owner access" on public.api_keys using (auth.uid() = user_id);
  drop policy if exists "Users can view own api keys" on public.api_keys;
  create policy "Users can view own api keys" on public.api_keys for select using (auth.uid() = user_id);
  drop policy if exists "Users can create own api keys" on public.api_keys;
  create policy "Users can create own api keys" on public.api_keys for insert with check (auth.uid() = user_id);
  drop policy if exists "Users can delete own api keys" on public.api_keys;
  create policy "Users can delete own api keys" on public.api_keys for delete using (auth.uid() = user_id);

  -- api_usage
  drop policy if exists "Owner access" on public.api_usage;
  create policy "Owner access" on public.api_usage using (auth.uid() = user_id);
  drop policy if exists "Users can view own usage" on public.api_usage;
  create policy "Users can view own usage" on public.api_usage for select using (auth.uid() = user_id);
  drop policy if exists "Users can insert own usage" on public.api_usage;
  create policy "Users can insert own usage" on public.api_usage for insert with check (auth.uid() = user_id);
  drop policy if exists "Service role can insert usage" on public.api_usage;
  create policy "Service role can insert usage" on public.api_usage for insert with check (true);

  -- projects
  drop policy if exists "Owner access" on public.projects;
  create policy "Owner access" on public.projects using (auth.uid() = owner_id);
  drop policy if exists "Users can view own projects" on public.projects;
  create policy "Users can view own projects" on public.projects for select using (auth.uid() = owner_id);
  drop policy if exists "Users can create own projects" on public.projects;
  create policy "Users can create own projects" on public.projects for insert with check (auth.uid() = owner_id);
  drop policy if exists "Users can delete own projects" on public.projects;
  create policy "Users can delete own projects" on public.projects for delete using (auth.uid() = owner_id);

  -- embeddings
  drop policy if exists "Users can view project embeddings" on public.embeddings;
  create policy "Users can view project embeddings" on public.embeddings for select using (
    exists (select 1 from public.projects where id = embeddings.project_id and owner_id = auth.uid())
  );
  drop policy if exists "Users can manage project embeddings" on public.embeddings;
  create policy "Users can manage project embeddings" on public.embeddings using (
    exists (select 1 from public.projects where id = embeddings.project_id and owner_id = auth.uid())
  );

  -- jobs
  drop policy if exists "Users can view project jobs" on public.jobs;
  create policy "Users can view project jobs" on public.jobs for select using (
    exists (select 1 from public.projects where id = jobs.project_id and owner_id = auth.uid())
  );
  drop policy if exists "Users can manage project jobs" on public.jobs;
  create policy "Users can manage project jobs" on public.jobs using (
    exists (select 1 from public.projects where id = jobs.project_id and owner_id = auth.uid())
  );

  -- feedback / support: anyone may file, nobody may read back.
  drop policy if exists "Public insert" on public.feedback;
  create policy "Public insert" on public.feedback for insert with check (true);
  drop policy if exists "Allow internal feedback insertion" on public.feedback;
  create policy "Allow internal feedback insertion" on public.feedback for insert with check (true);
  drop policy if exists "Public insert" on public.support_requests;
  create policy "Public insert" on public.support_requests for insert with check (true);
  drop policy if exists "Allow internal support insertion" on public.support_requests;
  create policy "Allow internal support insertion" on public.support_requests for insert with check (true);

  -- activity_feed / logs
  drop policy if exists "Users can view their own activity" on public.activity_feed;
  create policy "Users can view their own activity" on public.activity_feed for select using (auth.uid() = user_id);
  drop policy if exists "Users can view their own logs" on public.logs;
  create policy "Users can view their own logs" on public.logs for select using (auth.uid() = user_id);
end
$$;
