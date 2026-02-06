-- Migration v4: Feedback and Support Tables
-- Created: 2026-02-07

-- Feedback table
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  email text,
  message text not null,
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Support table
create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  subject text not null,
  message text not null,
  user_id uuid references auth.users(id) on delete set null,
  status text default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- RLS
alter table public.feedback enable row level security;
alter table public.support_requests enable row level security;

-- Policies (Allow insertions from anyone, but view only for service role or later admin UI)
drop policy if exists "Allow internal feedback insertion" on public.feedback;
create policy "Allow internal feedback insertion" on public.feedback for insert with check (true);

drop policy if exists "Allow internal support insertion" on public.support_requests;
create policy "Allow internal support insertion" on public.support_requests for insert with check (true);
