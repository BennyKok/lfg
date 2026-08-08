# Repo hygiene — working on shared checkouts

Conventions for any agent (or human) editing a repo that **other sessions are
editing at the same time** (the vibes monorepo on the dev box is the canonical
case: multiple twcli/Claude sessions share one working tree). Ignoring these is
how prod breaks — see the avatar saga at the bottom.

## Rules

1. **Author in an isolated git worktree, never the shared tree.**
   The action prompts already tell agents to do this (`src/actions/index.ts`):
   ```bash
   git -C "$REPO" worktree add -b "$session" /tmp/lfg-wt/"$session" origin/main
   # …do ALL work inside the worktree…
   git -C "$REPO" worktree remove --force /tmp/lfg-wt/"$session"
   ```
   A worktree gives you a clean `origin/main` that another session's
   `reset`/`checkout` can't yank out from under you, and your build/test runs
   aren't polluted by someone else's half-finished edits.

2. **Never run destructive git on a shared checkout.**
   No `git reset --hard`, `git checkout -- .`, `git clean -fd`, or `git stash`
   on the shared tree — another session's uncommitted work lives there. Those
   commands have silently wiped in-progress features before.

3. **Commit with explicit pathspecs.**
   `git commit -- path/a path/b`, never bare `git add -A` / `git commit -a`.
   The shared tree usually has unrelated WIP staged; a broad commit sweeps it
   into yours.

4. **Build before you merge — typecheck + lint are not enough.**
   `tsc` and the linter pass on plenty of things the production bundler rejects
   (a missing relative module is the classic: tsc shrugged, `vp build` died).
   Run the real production build, or rely on the CI step that now does it for
   you (`apps/web` builds in CI as of the build-guard commit). A green
   typecheck is not a green deploy.

5. **Don't resurrect deleted modules via a stale base.**
   The #1 cause of these incidents is a long-lived branch whose base predates a
   refactor: merging it drags a deleted file's import back into the tree. Rebase
   onto fresh `origin/main` before merging, and if a build fails on an import
   that "was definitely there," check whether the module was *removed* upstream.

## The worktree root is swept — know what it will and won't touch

`~/lfg-worktrees` (`LFG_WORKTREE_ROOT`) is where serve provisions per-session
worktrees, and a background sweeper reclaims them every 15 minutes.

The sweeper only deletes worktrees **it provisioned itself**, tracked by a
marker in `~/lfg-worktrees/.lfg-owned/`. Anything else you put in that
directory — a hand-made worktree, a release checkout, a full clone — is
reported as `unmanaged` and left alone permanently.

It also refuses to delete an owned worktree that has uncommitted changes
(`git status --porcelain` non-empty), even when every liveness signal says the
session is gone. Ignored files don't count, so a clean-but-built worktree is
still reclaimable.

Both guards exist because the sweeper previously treated every directory in
that root as its own and removed it with `git worktree remove --force`. That
deleted hand-made worktrees within minutes of creation (`vibes-frontdoor` and
`vibes-lfgpin`, 2026-08-08) and took uncommitted work with it. If you want a
worktree the sweeper can never reason about at all, keep it outside
`~/lfg-worktrees` — `~/repos/<name>` is the convention.

## Settled decisions (don't re-litigate via merge)

- **Avatar is unified.** The one initials-avatar is
  `apps/web/src/components/ui/avatar.tsx` → `Avatar` (props `initial`, `size`,
  `tone`). The old `inspect/avatar.tsx` (`InspectAvatar`, prop `init`) was
  **deleted on purpose** (vibes #70 unify → #85 remove duplicate). Do not
  reintroduce `inspect/avatar`; if inspect needs a variant, pass `tone`/`size`
  to the unified `Avatar`. A stale-base merge resurrected the dead import three
  times (#150, then #165) — the last one turned every Vercel deploy red for ~2h
  because the build emitted no assets and `vite-plugin-pwa`'s `generateSW` then
  failed with a misleading "empty precache" error. The CI build guard (rule 4)
  now catches this class before it ships.
