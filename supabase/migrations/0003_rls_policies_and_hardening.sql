-- 0003_rls_policies_and_hardening.sql
-- Add missing RLS policies for locks, sessions, governance_rules
-- Enable RLS on sessions table
-- Clean up duplicate policies on api_keys and profiles
-- Add sessions index on project_id

-- ============================================================
-- 1. Enable RLS on tables that were missing it
-- ============================================================
ALTER TABLE IF EXISTS sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS governance_rules ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. RLS policies for locks
-- ============================================================
-- Each policy is guarded with drop-if-exists so CI's
-- `supabase db push --include-all` can replay this migration against
-- production, which was hardened by hand before this file was recorded.
DROP POLICY IF EXISTS "Users can manage project locks" ON locks;
CREATE POLICY "Users can manage project locks"
  ON locks
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = locks.project_id
        AND projects.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = locks.project_id
        AND projects.owner_id = auth.uid()
    )
  );

-- ============================================================
-- 3. RLS policies for sessions
-- ============================================================
DROP POLICY IF EXISTS "Users can manage project sessions" ON sessions;
CREATE POLICY "Users can manage project sessions"
  ON sessions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = sessions.project_id
        AND projects.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = sessions.project_id
        AND projects.owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can view own sessions" ON sessions;
CREATE POLICY "Users can view own sessions"
  ON sessions
  FOR SELECT
  USING (auth.uid() = user_id);

-- ============================================================
-- 4. RLS policies for governance_rules
-- ============================================================
DROP POLICY IF EXISTS "Users can manage project governance" ON governance_rules;
CREATE POLICY "Users can manage project governance"
  ON governance_rules
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = governance_rules.project_id
        AND projects.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = governance_rules.project_id
        AND projects.owner_id = auth.uid()
    )
  );

-- ============================================================
-- 5. Clean up duplicate policies on api_keys and profiles
--    (DROP IF EXISTS to be idempotent)
-- ============================================================
-- Drop known duplicates. The naming pattern from initial schema
-- may have created pairs like "policy_name" and "policy_name_1".
-- We keep the original and drop the duplicate suffix variants.
DO $$
BEGIN
  -- api_keys duplicates
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can manage own API keys_1' AND tablename = 'api_keys') THEN
    DROP POLICY "Users can manage own API keys_1" ON api_keys;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can view own API keys_1' AND tablename = 'api_keys') THEN
    DROP POLICY "Users can view own API keys_1" ON api_keys;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can insert own API keys_1' AND tablename = 'api_keys') THEN
    DROP POLICY "Users can insert own API keys_1" ON api_keys;
  END IF;

  -- profiles duplicates
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can view own profile_1' AND tablename = 'profiles') THEN
    DROP POLICY "Users can view own profile_1" ON profiles;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can update own profile_1' AND tablename = 'profiles') THEN
    DROP POLICY "Users can update own profile_1" ON profiles;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can insert own profile_1' AND tablename = 'profiles') THEN
    DROP POLICY "Users can insert own profile_1" ON profiles;
  END IF;
END $$;

-- ============================================================
-- 6. Index on sessions.project_id for query performance
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions (project_id);
