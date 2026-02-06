-- Drop existing table and policies to ensure clean state
DROP TABLE IF EXISTS public.api_keys CASCADE;

-- Create table with correct columns
CREATE TABLE public.api_keys (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users NOT NULL,
  key_hash text NOT NULL,
  name text NOT NULL,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now())
);

-- Enable RLS
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- Create Policies
CREATE POLICY "Users can view their own keys."
  ON api_keys FOR SELECT
  USING ( auth.uid() = user_id );

CREATE POLICY "Users can insert their own keys."
  ON api_keys FOR INSERT
  WITH CHECK ( auth.uid() = user_id );

CREATE POLICY "Users can delete their own keys."
  ON api_keys FOR DELETE
  USING ( auth.uid() = user_id );

-- Improve performance
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON public.api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON public.api_keys (user_id);
