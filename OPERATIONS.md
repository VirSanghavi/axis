# Axis Operations Runbook

Everything needed to deploy, release, and recover Axis without asking the person
who wrote it. Every statement here was checked against the actual config in the
repos or against the live Vercel project; where something could not be verified,
it says so explicitly.

Companion docs: [README.md](README.md) for what Axis is,
[docs/RELEASING.md](docs/RELEASING.md) for publish credentials,
[CONTRIBUTING.md](CONTRIBUTING.md) for the contribution path.

---

## 1. The system in one page

Two git repositories, one product.

| Repo | Remote | Visibility | Contains |
|---|---|---|---|
| `shared-context/` | `github.com/VirSanghavi/axis` | public (AGPL-3.0) | local stdio MCP server, `@virsanghavi/axis-server` and `@virsanghavi/axis-init` npm packages, Python SDK, Supabase migrations |
| `axis-frontend/` | `github.com/VirSanghavi/axis-frontend` | private | the Next.js app at useaxis.dev: marketing, docs, dashboard, team board, `/api/v1` REST, hosted MCP at `/api/mcp`, Stripe billing |

The parent directory `/Users/vir/Downloads/Projects/Axis/` is **not** a git repo.
Never run git from it. Always `cd` into one of the two repos first.

There are two MCP surfaces and both are canonical for their context:

- **Hosted** at `https://useaxis.dev/api/mcp`, a Streamable-HTTP adapter living in
  `axis-frontend/frontend/app/api/mcp`. This is what users connect to. Nothing to
  install, new tools land server-side.
- **Local stdio** at `shared-context/src/local/mcp-server.ts`, shipped to npm as
  `@virsanghavi/axis-server`. This is for contributing to Axis itself and for
  offline or self-hosted use.

Two older servers still exist in the tree and are **deprecated, do not extend
them**: `src/local/server.ts` (Express/SSE) and `src/api/index.ts` (a duplicate
Hono API). Both carry `@deprecated` headers and print a warning on startup;
removal is tracked as its own job.

---

## 2. Deploy

### What deploys, and when

The web app deploys to Vercel. Verified with `vercel project inspect axis`:

| Setting | Value |
|---|---|
| Vercel project | `axis`, under the team `vir-sanghavis-projects` |
| Project ID | `prj_aDesbneW0TZzdL43FZdWzw3R29pr` (also in `axis-frontend/frontend/.vercel/project.json`) |
| Root Directory | `frontend` (the Next app lives one level down inside the repo) |
| Framework preset | Next.js, from `axis-frontend/frontend/vercel.json` |
| Node.js version | 24.x |
| Build command | `next build` |

`useaxis.dev` is an alias on the production deployment, confirmed by
`vercel domains inspect useaxis.dev` (project `axis`) and by
`vercel inspect <deployment>`, which lists `https://useaxis.dev` alongside
`https://axis-git-main-vir-sanghavis-projects.vercel.app`. That `git-main` alias
is the proof that the Vercel Git integration is attached to the `main` branch.

**So: pushing to `main` on `VirSanghavi/axis-frontend` deploys to production at
useaxis.dev.** Pull requests get preview deployments. There is no staging
environment and no manual promotion step.

The `shared-context` repo does **not** deploy anywhere. It ships as npm packages
and a PyPI package (section 4). Pushing to `main` there runs CI and nothing else.

### Rollback

Vercel keeps every production deployment. To roll back, promote a known-good one:

```sh
cd axis-frontend/frontend
vercel ls axis                 # find the last Ready deployment from before the break
vercel promote <deployment-url>
```

That is faster than reverting a commit and waiting for a rebuild, and it is the
first move during an incident. Revert the commit afterward so the next push does
not re-deploy the break.

### Manual deploy

Rarely needed, since git push is the normal path:

```sh
cd axis-frontend/frontend
vercel --prod
```

---

## 3. Database and migrations

Supabase hosts Postgres, auth, and RLS for both surfaces. The local stdio server
and the web app talk to the **same** Supabase project.

### Layout

Numbered migrations live in `shared-context/supabase/migrations/`, named
`NNNN_description.sql` and applied in filename order. Alongside them,
`supabase/` also holds several older whole-schema snapshots (`schema.sql`,
`schema_prod.sql`, `schema_v2.sql`, and similar). Those snapshots are historical
records of what the database looked like at a point in time. **The numbered
migration chain is the source of truth**; do not apply a snapshot to a live
database.

The Supabase CLI has been linked to the production project at some point:
`supabase/.temp/project-ref` exists, which is a file the CLI writes on
`supabase link`. That directory is gitignored, so the ref is local to whichever
machine ran the link. There is no `supabase/config.toml` checked in.

### Applying a migration

**CI applies migrations now.** `.github/workflows/migrate.yml` runs on any push to
`main` that touches `supabase/migrations/**`, and applies pending migrations to
the production database with the Supabase CLI:

```sh
supabase db push --db-url "$SUPABASE_DB_URL" --include-all
```

It needs two Actions secrets, `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_URL`. The
job runs under a `db-migrate` concurrency group with `cancel-in-progress: false`,
so two migration runs can never overlap. `supabase db push` only applies
migrations it has not already recorded, so re-runs and the manual
`workflow_dispatch` trigger are idempotent.

The workflow means the normal path is: write the migration, commit it, open a
pull request, merge to `main`, and CI applies it. Do not hand-apply a migration
that is on its way through this path; you will not corrupt anything, because the
push is idempotent, but you will confuse everyone reading the migration history.

Manual application still exists for emergencies and for databases CI does not
own (a branch database, a local stack):

```sh
supabase db push          # from the repo root, once `supabase link` has been run
```

### Read this before writing a migration: the gitignore trap

`.gitignore` ignores `/supabase/migrations/*` and then re-allows individual files
**by name**. As of this writing it names only `0008`, `0009`, and `0011`. Every
other migration in the directory is invisible to git, including the `0000`
baseline and the most recent files.

Combined with `migrate.yml`, that is a silent-failure trap: **a new migration is
gitignored by default, so it cannot be committed, cannot reach `main`, and CI
will never apply it,** while the author reasonably believes migrations are now
automated. Nothing fails loudly. The migration simply never runs.

Check before you trust the pipeline, and after adding any migration:

```sh
cd shared-context
for f in supabase/migrations/*.sql; do
  printf '%s: ' "$(basename "$f")"; git check-ignore -q "$f" && echo IGNORED || echo visible
done
```

Anything that prints `IGNORED` will not be deployed by CI. Add it to the
`.gitignore` allowlist and commit it, or the migration does not exist as far as
production is concerned. Migration file tracking is actively being restructured;
re-run the loop above rather than trusting this paragraph's file numbers.

### Rules that keep this safe

- **Idempotent SQL only.** `create table if not exists`, `drop ... if exists`.
  This is a stated convention in `agent-instructions/conventions.md` and the
  existing migrations follow it.
- **Guard references to tables created outside the chain.** Some tables (`orgs`,
  `org_members`, `projects`) were created outside the numbered chain, so
  migrations that reference them wrap the reference in `to_regclass` checks. See
  the header comment of `supabase/migrations/0011_inference_guardrails.sql` for
  the pattern and the reason. A migration must apply cleanly both to a bare
  database built from `0001` upward and to production as it actually exists.
- **Apply to a branch or local database first**, then production.

### The same gap is also bus-factor exposure

Because most migration files are gitignored, a fresh clone of the public repo
cannot rebuild the schema, and those files exist only on the maintainer's
machine. Until the allowlist is fixed, **keep a backup of
`supabase/migrations/` off this machine.**

---

## 4. Releasing and publishing

Three artifacts ship from `shared-context`:

| Artifact | Registry | Directory | Version source |
|---|---|---|---|
| `@virsanghavi/axis-server` | npm | `packages/axis-server` | `package.json` `version` |
| `@virsanghavi/axis-init` | npm | `packages/axis-init` | `package.json` `version` |
| `virsanghavi-axis` | PyPI | `packages/python-sdk` | `setup.py` `version` |

### How to cut a release

Publishing is **tag-triggered CI**, defined in `.github/workflows/release.yml`.
Pushing a matching tag is the only path that ships a package:

| Tag pattern | Publishes |
|---|---|
| `axis-server-v<version>` | `@virsanghavi/axis-server` to npm |
| `axis-init-v<version>` | `@virsanghavi/axis-init` to npm |
| `python-sdk-v<version>` | `virsanghavi-axis` to PyPI |

So a release is: bump the version in the package manifest, merge that to `main`,
then tag and push.

```sh
git tag axis-server-v1.14.0
git push origin axis-server-v1.14.0
```

Each job asserts the tag version matches the manifest (`package.json` for the npm
packages, `setup.py` for the SDK) and fails if they disagree, so a tag can never
ship a version the repo does not declare. The Python job deletes `dist/` and
rebuilds with `python -m build` before uploading, so a stale committed `dist/`
can never reach PyPI.

### Credentials

Two homes, one canonical:

- **CI, canonical for releases:** repository Actions secrets, `NPM_TOKEN` and
  `PYPI_API_TOKEN`. `release.yml` reads these and nothing else.
- **macOS keychain, service `axis-release`, local fallback:** for manual releases
  and emergencies. The read, publish, and rotate procedure is in
  [docs/RELEASING.md](docs/RELEASING.md); that document owns the credential story
  and this one does not duplicate the commands.

One naming detail that will bite during a rotation: `release.yml` reads the PyPI
secret as **`PYPI_API_TOKEN`**. Set a differently named secret and the publish job
gets an empty password and fails at upload. Confirm the name against the workflow
rather than from memory.

The publish tokens are **not** in the web app's runtime environment. Verified with
`vercel env ls production`: the production variable list contains no `NPM_TOKEN`
and no PyPI token. That separation is deliberate, so a `vercel env push` can never
hand supply-chain publish rights to a web runtime. Do not undo it.

### Build-before-publish

Both npm packages carry `"prepublishOnly": "npm run build"`, so `npm publish`
rebuilds `dist/` whether it runs in CI or by hand. `axis-server` builds with tsup,
`axis-init` with tsc. `axis-server`'s `files` array ships only `dist` and
`README.md`, and `tests/package-contents.test.ts` guards what lands in the tarball.

The Python SDK builds with setuptools from `setup.py` into `packages/python-sdk/dist/`.

### Version drift to watch

At the time of writing, the published npm version of `@virsanghavi/axis-server`
is **1.11.0** while the source `package.json` says **1.14.0**
(`npm view @virsanghavi/axis-server version` against
`packages/axis-server/package.json`). Three releases worth of fixes are written
but invisible to anyone running `npx -y @virsanghavi/axis-server`. Check this
gap before assuming a user is running current code:

```sh
npm view @virsanghavi/axis-server version
node -p "require('./packages/axis-server/package.json').version"
```

`@virsanghavi/axis-init` is in sync (published 1.1.2, source 1.1.2). The live
PyPI version of `virsanghavi-axis` was not checked; `setup.py` says 1.0.1.

---

## 5. Environment and secrets

Never commit any of these values. `.gitignore` covers `.env*.local` and `.env` in
both repos. This section lists **names and locations only**.

### Production, on Vercel

Set on the `axis` Vercel project, readable by name with `vercel env ls production`:

| Name | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL, browser-visible |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key, browser-visible |
| `SUPABASE_SERVICE_ROLE_KEY` | full-access Supabase key, server only, **the highest-value secret in the system** |
| `OPENAI_API_KEY` | embeddings and the chat/search intelligence layer |
| `STRIPE_SECRET_KEY` | Stripe server key |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe client key |
| `STRIPE_PRICE_ID` | the per-seat price the checkout charges |
| `STRIPE_WEBHOOK_SECRET` | verifies inbound Stripe webhooks, production only |
| `APP_SESSION_SECRET` | signs app sessions |
| `APP_LOGIN_PASSWORD` | legacy gate |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Redis for rate limiting |

To change one, use `vercel env add` / `vercel env rm`, or the Vercel dashboard,
then redeploy. Env changes do not take effect on already-built deployments.

### Local development

| File | Used by | Keys |
|---|---|---|
| `axis-frontend/frontend/.env.local` | the Next app under `next dev` | same set as production, plus `APP_BASE_URL` |
| `shared-context/.env.local` | the local stdio server and scripts | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `SHARED_CONTEXT_API_SECRET`, `PORT`, `CORS_ORIGIN`, `PROJECT_NAME` |

Pull the frontend set from Vercel rather than reconstructing it by hand:

```sh
cd axis-frontend/frontend
vercel env pull .env.local
```

**Do not set `PROJECT_NAME`** unless you deliberately want to pin the project
identity. It outranks repo detection, so a fixed value collapses every repo on
the machine onto one shared job board. This is the single most common cause of
"why are another repo's jobs on my board".

### How the local MCP server finds its config

`src/local/mcp-server.ts` resolves configuration in this order:

1. Environment variables passed by the MCP client from `mcp.json`
   (`SHARED_CONTEXT_API_URL`, `AXIS_API_KEY`). This is the customer path.
2. If neither is set, it walks upward looking for a `.env.local` to load. This is
   the local-development fallback only.
3. With an API key but no explicit URL, it defaults to
   `https://useaxis.dev/api/v1`.
4. With nothing configured at all, it runs the free coordination tools purely
   locally, persisting to `history/nerve-center-state.json`.

---

## 6. Local development

### The stdio MCP server

```sh
cd shared-context
bun install
bun start:local        # bun run src/local/mcp-server.ts
```

Or run the published CLI against any repo:

```sh
npx -y @virsanghavi/axis-server /path/to/repo
```

Probe the tool list without an MCP client, which is the fastest way to confirm a
build is sane:

```sh
cd shared-context/packages/axis-server
npm run build
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| AXIS_SKIP_SUBSCRIPTION_CHECK=1 node dist/mcp-server.mjs 2>/dev/null \
| grep -oE '"name":"[a-z_]+"' | sort -u | wc -l
```

The canonical tool surface is `src/shared/tool-registry.ts`. Count the tool names
there and the probe should match.

### The web app

```sh
cd axis-frontend/frontend
npm install
npm run dev            # http://localhost:3000
```

Note that `axis-frontend/frontend/node_modules` is currently a **symlink** into
`shared-context/frontend/node_modules`. That is a leftover from when the frontend
lived inside `shared-context`. If dependency resolution behaves strangely, this
is why; replacing the symlink with a real `npm install` in place is the fix.

### Tests and checks

Exactly what CI runs, so run these before you push.

```sh
# shared-context (.github/workflows/ci.yml)
cd shared-context
bun install --frozen-lockfile
bunx eslint . --max-warnings=0
bunx tsc --noEmit
bun test
bun tests/load-test.ts        # concurrency and load verification

# axis-frontend (.github/workflows/ci.yml, working-directory: frontend)
cd axis-frontend/frontend
npm ci
npm run lint
npx tsc --noEmit
npm test
```

Both CI workflows run on pushes to `main` and on pull requests. Neither deploys
anything and neither publishes anything; deploying is Vercel's git integration
(section 2), publishing is the tag-triggered `release.yml` (section 4), and
migrations are `migrate.yml` (section 3).

**The two repos use different package managers. This is deliberate, not drift.**

- `shared-context` is **bun only**. `bun.lock` is the sole lockfile, and `.npmrc`
  sets `package-lock=false` so a stray `npm install` cannot reintroduce a
  competing `package-lock.json`. Its `package.json` exposes `test`, `lint`, and
  `typecheck` scripts that mirror CI exactly, so `bun run lint` and
  `bun run typecheck` work as shorthands for the commands above.
- `axis-frontend` is **npm**. It keeps `frontend/package-lock.json`, and its CI
  installs with `npm ci` against that lockfile.

Do not "unify" these by adding a `package-lock.json` to `shared-context` or a
`bun.lock` to the frontend. Each repo's CI pins the lockfile it expects and will
fail on the other.

---

## 7. Incidents

### First five minutes

1. `curl -s https://useaxis.dev/api/health` and read the JSON. The route
   (`frontend/app/api/health/route.ts`) actively probes Supabase REST and the
   Stripe balance endpoint with a 3 second timeout each, and returns HTTP 503
   with `status: "degraded"` if either fails. It tells you *which* dependency is
   broken, so start here rather than guessing.
2. `vercel ls axis` to see whether the current production deployment is Ready and
   how recently it changed. A break that starts right after a deploy is a bad
   deploy until proven otherwise.
3. `vercel logs <deployment-url>` for runtime errors on functions.
4. https://status.supabase.com for Supabase-side incidents.
5. If the last deploy is the suspect, `vercel promote <last-good-url>` first and
   diagnose afterward. Restoring service beats root-causing it live.

### The hosted MCP endpoint is down

Users connected to `https://useaxis.dev/api/mcp` lose coordination. Two useful
facts about what happens next:

- **Agents on the local stdio server degrade rather than fail.** The HTTP client
  in `src/local/coordination-client.ts` wraps every hosted call in a circuit
  breaker: 5 consecutive 5xx or network failures open the circuit for 60 seconds
  (`CIRCUIT_FAILURE_THRESHOLD = 5`, `CIRCUIT_COOLDOWN_MS = 60_000`). While open,
  calls fail fast with `CircuitOpenError` instead of stacking 10 second timeouts,
  and callers drop to their local JSON fallback. After the cooldown, one probe
  request is allowed through, half-open style; a success resets the counter. The
  practical effect is that jobs and locks keep working per-machine, backed by
  `history/nerve-center-state.json`, and coordination stops being shared until
  the hosted API returns. See the local-only branch in `src/local/job-board.ts`
  for what that path does.
- **Agents connected directly to the hosted MCP have no fallback.** They are a
  thin client over `/api/v1`. For those users the outage is total until the
  endpoint is back.

So the customer impact of a hosted outage is: hosted-MCP users are down,
local-server users silently lose *shared* state but keep working. Say that
plainly in any status update rather than claiming everyone is fine.

### Stripe webhooks failing

`STRIPE_WEBHOOK_SECRET` is set only on Production, not Preview or Development.
Webhook signature failures on a preview deployment are expected and are not an
incident. On production, check the Stripe dashboard's webhook delivery log first,
then `vercel logs`.

### Locks stuck across the team

A crashed agent can leave file locks held. `force_unlock` is the escape hatch and
is intended for locks older than roughly 25 minutes. For a local-only server, the
harder reset is deleting `history/nerve-center-state.json`, which discards local
jobs and locks. Note that with `AXIS_ENFORCE_LOCKS=1` the server also `chmod`s
locked files read-only, so a crash can leave a file physically unwritable;
releasing the lock restores the original mode.

---

## 8. What is not automated

An honest list, so nobody assumes a safety net that does not exist.

- No staging environment. `main` goes straight to production on Vercel.
- No error-tracking or uptime-monitoring integration found in either repo. The
  `/api/health` route exists but nothing is polling it.
- No automated CLA check on pull requests, and `main` is not branch protected, so
  no status check can block a merge. See [GOVERNANCE_TODO.md](GOVERNANCE_TODO.md).
- Most Supabase migration files are gitignored, which means the migration
  pipeline silently skips them. This is the sharpest trap in the repo; see
  section 3.

Recently automated, so do not go looking for the manual procedure:

- **Database migrations** apply from CI on merge to `main` (`migrate.yml`).
- **npm and PyPI publishing** happen from CI on a version tag (`release.yml`).
