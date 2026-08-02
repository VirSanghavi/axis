# Governance TODO

Open items for Axis contribution governance. These are **manual steps for Vir
Sanghavi**; nothing here is automated.

Last triaged: 2026-08-02. Every verdict below was checked against the repository
and against GitHub, with the evidence recorded inline.

---

## Done

No item that was originally listed in this file is complete. What *is* complete
is the paperwork those items depend on, landed in commit `d288a8ba`
("chore: add contributor license agreement and governance docs"):

- **[CLA.md](CLA.md) exists** and defines the agreement contributors must accept.
- **[CONTRIBUTING.md](CONTRIBUTING.md) exists** and documents the two-step
  signal: tick the pull request checkbox, then comment "I agree to the CLA."
- **The pull request template carries the checkbox.**
  `.github/PULL_REQUEST_TEMPLATE.md` contains
  `- [ ] I have read and agree to the Contributor License Agreement in CLA.md.`

So the policy is written and visible to contributors. What is missing is
enforcement and one retroactive signature.

---

## Obsolete / won't do

Nothing. Both original items are still live and still worth doing.

---

## Still open

Each item below is written so it can be posted directly to the board as a job.

### 1. Get retroactive CLA agreement from Angel Garcia for commit `eb6aba9`

**Status: open. Verified 2026-08-02.**

Commit `eb6aba9e` ("fix: publish axis server main entrypoint") is authored by
Angel Garcia `<angel.programador21@gmail.com>`, dated 2026-06-09. It landed
before [CLA.md](CLA.md) existed, so it is not covered by the CLA.

Evidence that no agreement has been recorded: the commit arrived via **pull
request #2**, and `gh pr view 2 --json comments` returns an empty list. There is
no "I agree to the CLA" comment anywhere on it.

Two details that matter for actually reaching the right person, both confirmed
against the GitHub API:

- The **commit author** is GitHub user `Angel-Garcia21`
  (`gh pr view 2 --json commits` maps `angel.programador21@gmail.com` to that
  login).
- The **pull request was opened by a different account**,
  `alejandrorivas-pixel`, from the branch
  `alejandrorivas-pixel:codex/axis-server-main-entrypoint`.

Ask the commit author (`Angel-Garcia21`) to confirm agreement in writing, for
example a comment on pull request #2 saying "I agree to the CLA for commit
eb6aba9", or the same by email. Until that exists, treat it as a pre-CLA
contribution. **Do not rewrite or revert the commit.**

### 2. Install a CLA-enforcing GitHub App

**Status: open. Verified 2026-08-02.**

Set up [CLA Assistant](https://cla-assistant.io) or an equivalent app on
`VirSanghavi/axis` so pull requests are blocked until the contributor signs. That
replaces the manual checkbox-and-comment ritual and produces an auditable record
of every signer.

Evidence that nothing is installed today:

- `.github/workflows/` contains only `ci.yml`. There is no CLA workflow.
- `gh api repos/VirSanghavi/axis/commits/main/check-runs` returns exactly one
  check, `test`.
- Pull request #3, which merged **after** CLA.md landed, ran only `test` and
  `cubic · AI code reviewer`. No CLA gate ran on it.

### 3. Enable branch protection on `main` so a CLA check can actually block a merge

**Status: open. Newly identified during the 2026-08-02 triage.**

`gh api repos/VirSanghavi/axis/branches/main/protection` returns
`404 Branch not protected`. Without protection there are no required status
checks, so even after item 2 is installed its check would be advisory and a pull
request could still be merged unsigned.

Protect `main` and mark both the CI `test` check and the future CLA check as
required. This is a prerequisite for item 2 having any teeth, and it is worth
doing regardless of the CLA work.

---

## How to re-verify this file

```sh
cd shared-context
gh pr view 2 --json comments                                  # item 1
ls .github/workflows/                                          # item 2
gh api repos/VirSanghavi/axis/commits/main/check-runs          # item 2
gh api repos/VirSanghavi/axis/branches/main/protection         # item 3
```

Move an item to **Done** with the date and the evidence when it lands.
