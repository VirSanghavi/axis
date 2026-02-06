-- Axis Production Schema (Consolidated)
-- Includes: Profiles, API Keys, Usage, Projects, Embeddings, Sessions, Jobs, Feedback, Support, Locks, Rules

-- 1. EXTENSIONS
create extension if not exists vector;

-- 2. TABLES

-- Profiles
create table if not exists public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text not null,
  full_name text,
  stripe_customer_id text,
  subscription_status text default 'free',
  current_period_end timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- API Keys
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  name text not null,
  key_hash text not null unique,
  is_active boolean default true,
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

-- Projects
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid references public.profiles(id) on delete cascade,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique(name, owner_id)
);

-- Sessions (Multi-Agent collaboration history)
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade not null,
  title text not null,
  summary text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  completed_at timestamp with time zone
);

-- Embeddings (RAG)
create table if not exists public.embeddings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  session_id uuid references public.sessions(id) on delete cascade,
  content text not null,
  embedding vector(1536), 
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Jobs (Agent Orchestration)
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

-- Governance Rules
create table if not exists public.governance_rules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  rule_type text not null, -- e.g. "access", "privacy", "governance"
  rule_body text not null,
  target text, -- e.g. "src/lib/*"
  is_active boolean default true,
  created_by uuid references public.profiles(id),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Feedback
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  email text,
  message text not null,
  user_id uuid references public.profiles(id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Support
create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  subject text not null,
  message text not null,
  user_id uuid references public.profiles(id) on delete set null,
  status text default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Concurrency Locks
create table if not exists public.locks (
  file_path text not null,
  project_id uuid references public.projects(id) on delete cascade not null,
  agent_id text not null,
  intent text,
  user_prompt text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  primary key (project_id, file_path)
);

-- 3. RLS Policies

alter table profiles enable row level security;
alter table api_keys enable row level security;
alter table api_usage enable row level security;
alter table projects enable row level security;
alter table embeddings enable row level security;
alter table jobs enable row level security;
alter table governance_rules enable row level security;
alter table feedback enable row level security;
alter table support_requests enable row level security;
alter table locks enable row level security;

-- (Policies simplified: Owner only for all major tables)
do $$ 
begin
    -- Profiles
    execute 'create policy "Owner access" on profiles using (auth.uid() = id)';
    -- API Keys
    execute 'create policy "Owner access" on api_keys using (auth.uid() = user_id)';
    -- API Usage
    execute 'create policy "Owner access" on api_usage using (auth.uid() = user_id)';
    -- Projects
    execute 'create policy "Owner access" on projects using (auth.uid() = owner_id)';
    -- Feedback/Support (Public Insert)
    execute 'create policy "Public insert" on feedback for insert with check (true)';
    execute 'create policy "Public insert" on support_requests for insert with check (true)';
exception when others then null;
end $$;

-- 4. FUNCTIONS

create or replace function get_daily_usage(p_user_id uuid, p_days int)
returns table (day text, request_count bigint, total_tokens bigint)
language plpgsql security definer as $$
begin
  return query
  select to_char(created_at, 'YYYY-MM-DD'), count(*), sum(coalesce(tokens_used, 0))::bigint
  from api_usage where user_id = p_user_id and created_at > now() - (p_days || ' days')::interval
  group by 1 order by 1;
end; $$;

create or replace function match_embeddings (query_embedding vector(1536), match_threshold float, match_count int, p_project_id uuid)
returns table (id uuid, content text, similarity float, metadata jsonb)
language plpgsql as $$
begin
  return query
  select embeddings.id, embeddings.content, 1 - (embeddings.embedding <=> query_embedding) as similarity, embeddings.metadata
  from embeddings where 1 - (embeddings.embedding <=> query_embedding) > match_threshold and project_id = p_project_id
  order by similarity desc limit match_count;
end; $$;
