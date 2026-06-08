-- Tamper-evident locks: store a content fingerprint captured when a lock is
-- granted so hosted (Supabase-backed) sessions can detect when a locked file
-- was changed out from under the holder (parity with local mode).
--
-- Additive and idempotent: existing rows get NULL (treated as "unknown" by the
-- integrity check), and the server writes the hash best-effort after granting.

ALTER TABLE locks ADD COLUMN IF NOT EXISTS content_hash text;

COMMENT ON COLUMN locks.content_hash IS
  'Short sha256 fingerprint of the file contents when the lock was granted; used by verify_file_lock / guarded_write for tamper detection. NULL = not recorded.';
