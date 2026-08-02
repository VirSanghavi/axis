# Releasing & publish credentials

Publish credentials live in the **macOS keychain** (service `axis-release`), not in
any `.env` file. They were removed from the web app's runtime env on 2026-08-02
(audit #26) so that a `vercel env push` can never ship supply-chain publish rights
into a web runtime.

## What gets published

| Artifact | Registry | Publish dir |
|---|---|---|
| `@virsanghavi/axis-server` | npm | `packages/axis-server` |
| `@virsanghavi/axis-init` | npm | `packages/axis-init` |
| `virsanghavi-axis` | PyPI | `packages/python-sdk` |

## Reading a credential

```sh
security find-generic-password -s axis-release -a NPM_TOKEN -w
security find-generic-password -s axis-release -a PYPI_TOKEN -w
security find-generic-password -s axis-release -a TWINE_USERNAME -w   # __token__
security find-generic-password -s axis-release -a TWINE_PASSWORD -w   # same value as PYPI_TOKEN
```

## Publishing

npm (both packages):

```sh
cd packages/axis-server   # or packages/axis-init
NODE_AUTH_TOKEN=$(security find-generic-password -s axis-release -a NPM_TOKEN -w) \
  npm publish --access public --//registry.npmjs.org/:_authToken="$NODE_AUTH_TOKEN"
```

PyPI (twine reads `TWINE_USERNAME` / `TWINE_PASSWORD` from the environment):

```sh
cd packages/python-sdk
TWINE_USERNAME=__token__ \
TWINE_PASSWORD=$(security find-generic-password -s axis-release -a TWINE_PASSWORD -w) \
  twine upload dist/*
```

When the tag-triggered CI publish workflow lands (audit #25), the canonical home
for these tokens becomes GitHub Actions secrets (`NPM_TOKEN`, `PYPI_TOKEN`);
the keychain copies then exist only as the local fallback for manual releases.

```sh
gh secret set NPM_TOKEN --body "$(security find-generic-password -s axis-release -a NPM_TOKEN -w)"
gh secret set PYPI_TOKEN --body "$(security find-generic-password -s axis-release -a PYPI_TOKEN -w)"
```

## Rotating

Rotation requires being logged in to the registry web UIs — do all three together:

1. **npm** — npmjs.com → Access Tokens → revoke the old token, create a new
   *granular* token scoped to `@virsanghavi/axis-server` + `@virsanghavi/axis-init`
   with publish rights only.
2. **PyPI** — pypi.org → Account settings → API tokens → revoke the old token,
   create a new token scoped to the `virsanghavi-axis` project. This same value
   is the twine password.
3. Store the new values (overwrites in place):

```sh
security add-generic-password -U -s axis-release -a NPM_TOKEN -w '<new npm token>'
security add-generic-password -U -s axis-release -a PYPI_TOKEN -w '<new pypi token>'
security add-generic-password -U -s axis-release -a TWINE_PASSWORD -w '<new pypi token>'
```

4. If CI secrets exist, re-run the two `gh secret set` commands above.

Never put these tokens back into `.env.local` or any file inside a deployable app.
