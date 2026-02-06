-- Protocol V2 Migration: Production Hardening

-- 1. File Locks Table (Global Concurrency)
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

-- 2. API Keys Table (Revocable Access)
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  key_value text not null, -- In production, hash this! For MVP/Debug, we keep it visible to admin.
  project_id uuid references public.projects(id) on delete cascade not null,
  name text, -- e.g. "Dev Laptop", "CI/CD"
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  last_used_at timestamp with time zone,
  is_active boolean default true,
  unique(key_value)
);

-- Indexes
create index if not exists locks_project_id_idx on public.locks(project_id);
create index if not exists api_keys_key_value_idx on public.api_keys(key_value);

-- Helper to clean stale locks (can be called by cron or lazy check)
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
