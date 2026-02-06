create table if not exists public.api_keys (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  key_hash text not null,
  name text not null,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

-- RLS
alter table public.api_keys enable row level security;

create policy "Users can view their own keys."
  on api_keys for select
  using ( auth.uid() = user_id );

create policy "Users can insert their own keys."
  on api_keys for insert
  with check ( auth.uid() = user_id );

create policy "Users can delete their own keys."
  on api_keys for delete
  using ( auth.uid() = user_id );
