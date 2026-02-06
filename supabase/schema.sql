-- Axis Consolidated Supabase Schema

-- 1. EXTENSIONS
create extension if not exists vector;

-- 2. TABLES

-- Profiles (User accounts and billing)
create table if not exists public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text not null,
  full_name text,
  stripe_customer_id text,
  subscription_status text default 'free',
  current_period_end timestamp with time zone,
  usage_count int default 0,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Projects
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid references public.profiles(id) on delete cascade,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique(name)
);

-- API Keys
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  name text not null,
  key_hash text not null unique,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- API Usage
create table if not exists public.api_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  api_key_id uuid references public.api_keys(id) on delete set null,
  endpoint text not null,
  method text not null,
  status_code int not null,
  response_time_ms int,
  tokens_used int default 0,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Embeddings (RAG)
create table if not exists public.embeddings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  content text not null,
  embedding vector(1536), -- Dimension for text-embedding-3-small
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Jobs (Orchestration Job Board)
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  title text not null,
  description text not null,
  priority text not null check (priority in ('low', 'medium', 'high', 'critical')),
  status text not null check (status in ('todo', 'in_progress', 'done', 'cancelled')),
  assigned_to text,
  dependencies jsonb default '[]'::jsonb,
  cancel_reason text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Locks (File Access Concurrency)
create table if not exists public.locks (
  project_id uuid references public.projects(id) on delete cascade not null,
  file_path text not null,
  agent_id text not null,
  intent text,
  user_prompt text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  primary key (project_id, file_path)
);

-- 3. INDEXES
create index if not exists embeddings_project_id_idx on public.embeddings(project_id);
create index if not exists embeddings_metadata_gin_idx on public.embeddings using gin (metadata);
create index if not exists jobs_project_id_idx on public.jobs(project_id);
create index if not exists jobs_status_idx on public.jobs(status);
create index if not exists locks_project_id_idx on public.locks(project_id);
create index if not exists api_keys_key_hash_idx on public.api_keys(key_hash);

-- 4. FUNCTIONS

-- RAG Search
create or replace function match_embeddings (
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  p_project_id uuid
)
returns table (
  id uuid,
  content text,
  similarity float,
  metadata jsonb
)
language plpgsql
as $$
begin
  return query
  select
    embeddings.id,
    embeddings.content,
    1 - (embeddings.embedding <=> query_embedding) as similarity,
    embeddings.metadata
  from embeddings
  where 1 - (embeddings.embedding <=> query_embedding) > match_threshold
  and project_id = p_project_id
  order by embeddings.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- Stale Lock Cleanup
create or replace function clean_stale_locks(p_project_id uuid, p_timeout_seconds int)
returns void
language plpgsql
as $$
begin
  delete from public.locks
  where project_id = p_project_id
  and extract(epoch from (now() - updated_at)) > p_timeout_seconds;
end;
$$;

-- Daily Usage Reports
create or replace function get_daily_usage(p_user_id uuid, p_days int)
returns table (
  day text,
  request_count bigint,
  total_tokens bigint
)
language plpgsql
security definer
as $$
begin
  return query
  select
    to_char(created_at, 'YYYY-MM-DD') as day,
    count(*) as request_count,
    sum(coalesce(tokens_used, 0)) as total_tokens
  from api_usage
  where user_id = p_user_id
  and created_at > now() - (p_days || ' days')::interval
  group by 1
  order by 1;
end;
$$;

-- 5. RLS (Optional/Basic)
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.api_keys enable row level security;
alter table public.api_usage enable row level security;
alter table public.embeddings enable row level security;
alter table public.jobs enable row level security;
alter table public.locks enable row level security;

-- Example baseline policies (allow all authenticated for now or restrict to owner)
-- create policy "Allow users to view own profile" on profiles for select using (auth.uid() = id);
