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

create policy "Public profiles are viewable by everyone."
  on profiles for select
  using ( true );

create policy "Users can insert their own profile."
  on profiles for insert
  with check ( auth.uid() = id );

create policy "Users can update own profile."
  on profiles for update
  using ( auth.uid() = id );
