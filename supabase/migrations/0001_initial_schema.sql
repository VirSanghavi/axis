-- Create profiles to store subscription status
create table if not exists public.profiles (
  id uuid references auth.users not null primary key,
  email text,
  full_name text,
  subscription_status text default 'free',
  stripe_customer_id text,
  updated_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

-- RLS
alter table public.profiles enable row level security;

-- Guarded with drop-if-exists so CI's `supabase db push --include-all` can
-- replay this against production, where these policies were created by hand
-- long before the migration was recorded. Behavior on a fresh database is
-- unchanged.
drop policy if exists "Public profiles are viewable by everyone." on profiles;
create policy "Public profiles are viewable by everyone."
  on profiles for select
  using ( true );

drop policy if exists "Users can insert their own profile." on profiles;
create policy "Users can insert their own profile."
  on profiles for insert
  with check ( auth.uid() = id );

drop policy if exists "Users can update own profile." on profiles;
create policy "Users can update own profile."
  on profiles for update
  using ( auth.uid() = id );
