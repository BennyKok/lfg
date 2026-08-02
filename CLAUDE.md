# Agent Instructions

## Versioning & Releases

After landing changes on `main`, evaluate whether to cut a release — don't
leave shippable work untagged.

- **Release when** the change is user-visible (feature, fix, UX/perf
  improvement) and `main` is in a coherent, working state. A single meaningful
  fix is enough; don't wait for commits to pile up.
- **Skip when** the change is internal-only (docs, CI, refactors, tests,
  scripts) or part of an in-flight feature that isn't usable yet — leave it for
  the next real release.
- **Check what's pending** with `git log --oneline $(git describe --tags --abbrev=0)..origin/main`.

To release:

1. Write the release notes: prepend a CHANGELOG.md entry in the existing style
   (`## <Month D, YYYY> - <Short theme> (vX.Y.Z)` + user-facing bullets, not
   raw commit subjects).
2. Run `scripts/tag-release.sh` (patch bump by default; `minor`/`major` as an
   argument). It bumps package.json, verifies the CHANGELOG entry, commits,
   tags, pushes, and publishes the GitHub release bundle.
3. Releases are tagged from a clean, up-to-date `main` only — the script
   enforces this.

## Dependency Advisories

Dependabot can't read `bun.lock`, so `scripts/audit.ts` is our audit
(`.github/workflows/audit.yml`: push, PR, Mondays 09:00 UTC). It reads the
workspace graph, which covers `web/` — `bun audit` resolves the *workspace*
lockfile, so auditing a member directory re-reads the root rather than that
member's own bun.lock.

- Accepted advisories live in `scripts/audit-exceptions.json`, each with a
  written reason and a hard `reviewBy` date.
- The gate fails on: an unaccepted high/critical advisory, an entry past its
  date, an entry no longer in the graph, and a `no-fix-available` entry
  upstream has since fixed — including a fix shipped under a **renamed
  successor package**.
- Never add a bare `bun audit --ignore=` back to the workflow. That is what
  this replaced: it spent two months hiding a fixable high-severity advisory
  while CI stayed green, because a comment promising to revisit it is not a
  check. A test fails if the flag reappears.
- Re-record after a fix or a bump: `bun run audit:exceptions`.

## Local Repro Servers

- Bind ad hoc repro/static servers to loopback only. Use
  `python3 -m http.server --bind 127.0.0.1 <port>` or the equivalent
  localhost-only flag for other tools.
- Do not start throwaway repro servers on `0.0.0.0`. If a server must be shared,
  put a private tunnel or Tailscale Serve in front of a loopback listener.
- Stop any repro server you start before ending the session, especially when it
  runs from `/tmp`, a worktree, or generated build output.
