# Axis database

**The migrations are the source of truth.** `supabase/migrations/` is the only
place a schema change may be defined. Everything else in this directory is
derived from it.

| Path | What it is |
| --- | --- |
| `migrations/` | The ordered, append-only history. Source of truth. |
| `schema.sql` | A generated snapshot of what the migrations produce. Read-only reference — never edit it, never apply it by hand. |
| `config.toml` | Local stack settings (Postgres 17, matching production's 17.6.1). |

## Adding a migration

1. Create `migrations/NNNN_short_description.sql`, taking the next free number.
   **Check `ls migrations/` first.** The CLI keys `supabase_migrations.schema_migrations`
   on the numeric prefix alone, so two files sharing one — `0011_a.sql` and
   `0011_b.sql` — is not a style problem, it is a hard failure:
   `duplicate key value violates unique constraint "schema_migrations_pkey"`,
   and the whole stack refuses to start. Several agents land migrations here in
   parallel; take a number nobody else is holding.
2. Write it **idempotently** — `create table if not exists`, `add column if not
   exists`, `create or replace function`, `drop policy if exists` before
   `create policy`, or a `do $$ ... $$` guard that checks `pg_constraint` /
   `to_regclass` first. This directory's history is full of changes that were
   applied to production by hand before they were ever written down, so a
   migration that cannot be safely re-run is a migration that cannot be trusted.
3. Verify it rebuilds from empty: `supabase db reset` (see below).
4. Regenerate the snapshot so `schema.sql` keeps matching reality:

   ```sh
   supabase db dump --local -f supabase/schema.sql
   ```

Never renumber or edit an already-applied migration. Correct it with a new one.

## Local development

```sh
supabase start      # boots the local stack (Docker required)
supabase db reset   # drops the local DB and replays every migration in order
supabase stop       # tears the stack down
```

`db reset` is the real test: it starts from an empty database and applies
`0000` through the newest migration in filename order. If it succeeds, the
chain is self-sufficient.

Both commands act on the **local** stack only. `supabase db push` and
`supabase db reset --linked` target the remote project — do not run them as part
of routine development.

## How production gets changed

Production is project `rtpjoqplyiedmravytbl`. Historically, changes were pasted
into the Supabase SQL editor and only sometimes written back into a migration
file; several migrations still carry an `Applied to project ... on <date>`
comment from that era. That is the practice this layout exists to end.

Going forward: write the migration first, prove it with `supabase db reset`,
then apply it to production. Because every migration is idempotent, applying one
that someone already ran by hand is a no-op rather than an error.

## Notes on specific migrations

**`0000_baseline_schema.sql`** is the baseline, and it was added after the fact.
`0001` and `0002` only ever created `profiles` and `api_keys`; every other table
— `projects`, `jobs`, `locks`, `embeddings`, `sessions`, and the rest — was
created by hand from schema snapshot files that used to sit in this directory.
The result was that `0003` onward referenced tables no migration had created,
and the chain could not rebuild the database from empty. `0000` reproduces
production as captured by `supabase db dump` on 2026-02-07, which is the state
`0003` was written against. It is numbered `0000` rather than renumbering the
chain because `0001`..`0010` are already applied to production and must keep
their identity.

**`0014_atomic_try_acquire_lock.sql`** and
**`0015_projects_name_owner_unique.sql`** are idempotent folds of SQL that was
hand-applied to production on 2026-02-07 and never numbered. They came from
`migration_atomic_locks_and_jobs.sql` and `migration_fix_constraints.sql`, both
now deleted. `0014` replaces a `try_acquire_lock` that did SELECT-then-INSERT
(two agents could both be told GRANTED for the same file) with a single
`insert ... on conflict`. `0015` moves the `projects` unique constraint from
`(name)` to `(name, owner_id)`, so one user claiming the name "api" no longer
blocks everyone else.

**`0001`, `0002`, and `0003`** used bare `CREATE POLICY` and were the only
migrations here that could not survive a replay. That mattered when
`.github/workflows/migrate.yml` briefly ran `supabase db push --include-all`
on every push to main: `--include-all` applies any migration production has no
`schema_migrations` row for, and these three were applied by hand in the SQL
editor years before anything was being recorded. Replaying them would have hit
`policy ... already exists` and failed the whole push. Each `CREATE POLICY` is
now preceded by `DROP POLICY IF EXISTS`. Behavior on a fresh database is
unchanged; every migration in this directory is now replay-safe.

**`--include-all` has since been removed from the workflow**, because
replay-safe is not enough for `0007`. Production runs the 5-column
`cochange_neighbors` from `0012`; `0007` declares the 4-column original, and
`CREATE OR REPLACE FUNCTION` cannot change a function's return type. Replaying
`0007` therefore errors and rolls back the whole batch, taking every genuinely
pending migration with it. The repair is a one-time, hand-run backfill of the
history rows against production:

```
supabase migration repair --status applied \
  0000 0001 0002 0003 0004 0005 0006 0007 \
  --db-url "$SUPABASE_DB_URL"
supabase migration list --db-url "$SUPABASE_DB_URL"   # local and remote must agree
```

Until that has been run and verified, CI uses a plain `supabase db push`, which
applies only migrations recorded as pending and leaves the unrecorded prehistory
alone.

## The .gitignore trap — read this before adding any file here

The repo's root `.gitignore` ignores this entire directory and then re-admits
individual files by name:

```
/supabase
!/supabase/
/supabase/*
!/supabase/migrations/
/supabase/migrations/*
!/supabase/migrations/0008_oauth_org_binding.sql
...
```

So **a new migration you add here is invisible to git by default.** It is not
that `git add` fails loudly — `git status` simply never mentions the file. You
can write a migration, reset your local database, watch it apply, and commit
nothing at all. `supabase/migrations/0013_realtime_publication.sql` reached this
state; so did every file added by this cleanup until the allowlist was widened.

Two things follow:

- After creating any file under `supabase/`, run
  `git check-ignore -v <path>`. Silence means it is tracked. Any output means it
  is ignored and needs an allowlist entry.
- `0010_mcp_session_events.sql` is the confusing case: it is **tracked but has no
  allowlist entry**. Git only applies ignore rules to files it does not already
  track, so 0010 keeps working purely because it was committed before the rule
  tightened. Do not read its presence in `git ls-files` as evidence the pattern
  covers new files — it does not.

The durable fix is to allowlist by pattern rather than by filename, so a
migration is tracked the moment it is written:

```
/supabase/migrations/*
!/supabase/migrations/*.sql
```

## Known gaps

- `0008_oauth_org_binding.sql` adds `org_id` to `oauth_auth_codes` and
  `oauth_refresh_tokens`, but no migration in this repo creates `orgs`,
  `oauth_auth_codes`, or `oauth_refresh_tokens` and nothing in this repo queries
  them. They belong to the hosted API's own schema. The migration is wrapped in
  `to_regclass` guards, so on a database built from this directory alone it
  silently does nothing. That is intended, but it does mean `db reset` cannot
  prove that migration does what it claims.
- Production has no `UNIQUE` constraint on `api_keys.key_hash`, only a plain
  index. The retired `schema.sql` snapshot claimed the column was unique, which
  was never true of the live database. `0000` matches production. If uniqueness
  is wanted, it needs its own migration.
