# Contributing to Axis

Thanks for your interest in contributing to Axis. This document explains the
license the project ships under, the agreement every contributor must accept, and
the steps to get a pull request merged.

## License

Axis is the **open-source orchestration core** of the project, distributed under
the **GNU Affero General Public License v3.0** (AGPL-3.0). See [LICENSE](LICENSE)
for the full text. Axis is open-core: a separate hosted version adds the
intelligence layer (code search, indexing, the managed backend) and is closed
source. Contributions to this repository become part of the open-core
distribution and may also be folded into that hosted, closed-source version, so
please read the next section carefully.

## Contributor License Agreement (required)

Every contributor must agree to the **Contributor License Agreement** in
[CLA.md](CLA.md) before a pull request can be merged. The CLA grants Vir
Sanghavi, the project owner and sole copyright holder, a perpetual, worldwide,
irrevocable copyright and patent license to your contribution, including the
right to relicense it under any terms, such as proprietary and closed-source
terms. This is what keeps the core legally clean to ship inside the commercial
build, and it is why a Developer Certificate of Origin (DCO) sign-off alone is
not sufficient: a DCO does not grant relicensing rights.

You keep the copyright to your own contributions. The CLA does not take your
rights away; it grants the owner the licenses described in [CLA.md](CLA.md).

### How to signify agreement

When you open a pull request:

1. Check the box in the pull request template:
   "I have read and agree to the Contributor License Agreement in CLA.md."
2. Add a one-line comment on the pull request that says: "I agree to the CLA."

A maintainer will not merge a pull request until both are present. Over time we
plan to automate this check (see [GOVERNANCE_TODO.md](GOVERNANCE_TODO.md)), but
the requirement applies now regardless of tooling.

## Pull request process

1. Fork the repository and create a topic branch for your change.
2. Keep changes focused; one logical change per pull request is easier to review.
3. Follow the existing code style. The project uses Bun, Prettier, and ESLint;
   run the test suite with `bun test` before opening a pull request.
4. Open your pull request against `main`, fill out the template, and complete the
   CLA steps above.
5. Respond to review feedback. Once review passes and the CLA is recorded, a
   maintainer will merge.

## Questions

If anything about the license or the CLA is unclear, open an issue or ask in your
pull request before you invest significant time. It is always cheaper to clarify
up front than to rework a contribution later.
