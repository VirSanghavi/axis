
-- 1. EXTENSIONS
create extension if not exists vector;

-- 2. DROP FUNCTIONS
drop function if exists get_daily_usage(uuid, int);
drop function if exists match_embeddings(vector(1536), float, int, uuid);

-- 3. TABLES (Idempotent Creation)

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

-- Embeddings
create table if not exists public.embeddings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  content text not null,
  embedding vector(1536), 
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create index if not exists embeddings_project_id_idx on public.embeddings(project_id);
create index if not exists embeddings_embedding_idx on public.embeddings using hnsw (embedding vector_cosine_ops);

-- Jobs
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
create index if not exists jobs_project_id_idx on public.jobs(project_id);

-- 4. RLS POLICIES (Strict)
alter table profiles enable row level security;
alter table api_keys enable row level security;
alter table api_usage enable row level security;
alter table projects enable row level security;
alter table embeddings enable row level security;
alter table jobs enable row level security;

-- Profiles
drop policy if exists "Users can view own profile" on profiles;
create policy "Users can view own profile" on profiles for select using (auth.uid() = id);
drop policy if exists "Users can update own profile" on profiles;
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);

-- API Keys
drop policy if exists "Users can view own api keys" on api_keys;
create policy "Users can view own api keys" on api_keys for select using (auth.uid() = user_id);
drop policy if exists "Users can create own api keys" on api_keys;
create policy "Users can create own api keys" on api_keys for insert with check (auth.uid() = user_id);
drop policy if exists "Users can delete own api keys" on api_keys;
create policy "Users can delete own api keys" on api_keys for delete using (auth.uid() = user_id);

-- API Usage
drop policy if exists "Users can view own usage" on api_usage;
create policy "Users can view own usage" on api_usage for select using (auth.uid() = user_id);
-- Allow inserting usage if strict user check passes OR if it's a service role/admin (simplified for now to just owner)
drop policy if exists "Users can insert own usage" on api_usage;
create policy "Users can insert own usage" on api_usage for insert with check (auth.uid() = user_id);

-- Projects
drop policy if exists "Users can view own projects" on projects;
create policy "Users can view own projects" on projects for select using (auth.uid() = owner_id);
drop policy if exists "Users can create own projects" on projects;
create policy "Users can create own projects" on projects for insert with check (auth.uid() = owner_id);
drop policy if exists "Users can delete own projects" on projects;
create policy "Users can delete own projects" on projects for delete using (auth.uid() = owner_id);

-- Embeddings
drop policy if exists "Users can view project embeddings" on embeddings;
create policy "Users can view project embeddings" on embeddings for select using (
  exists (select 1 from projects where id = embeddings.project_id and owner_id = auth.uid())
);
drop policy if exists "Users can manage project embeddings" on embeddings;
create policy "Users can manage project embeddings" on embeddings for all using (
  exists (select 1 from projects where id = embeddings.project_id and owner_id = auth.uid())
);

-- Jobs
drop policy if exists "Users can view project jobs" on jobs;
create policy "Users can view project jobs" on jobs for select using (
  exists (select 1 from projects where id = jobs.project_id and owner_id = auth.uid())
);
drop policy if exists "Users can manage project jobs" on jobs;
create policy "Users can manage project jobs" on jobs for all using (
  exists (select 1 from projects where id = jobs.project_id and owner_id = auth.uid())
);

-- 5. RECREATE FUNCTIONS

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
