-- Enable pgvector extension
create extension if not exists vector;

-- Projects table
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
--   owner_id uuid references auth.users(id), -- Optional: Enable if using Supabase Auth
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique(name)
);

-- Embeddings table
create table if not exists public.embeddings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  content text not null,
  embedding vector(1536), -- Dimension for text-embedding-3-small
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Indexes for performance
create index if not exists embeddings_project_id_idx on public.embeddings(project_id);
create index if not exists embeddings_metadata_gin_idx on public.embeddings using gin (metadata);

-- Search function
create or replace function match_embeddings (
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  p_id uuid
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
  and project_id = p_id
  order by embeddings.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- Job board table
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
create index if not exists jobs_status_idx on public.jobs(status);
