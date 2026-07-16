# Contributing

Thanks for your interest in lfg! This is a self-hosted tool for running AI coding
agents on your own box — contributions that keep it simple, private, and easy to
self-host are very welcome.

## Dev setup

Requires [Bun](https://bun.sh), `tmux`, `git`, and the Claude CLI on `PATH`.

```bash
bun install
cp .env.example .env
bun run serve                 # backend + built UI at http://127.0.0.1:8766

# work on the web UI with hot reload (proxies /api to the Bun server):
cd web && bun install && bun run dev
```

Before opening a PR:

```bash
bunx tsc --noEmit             # typecheck the CLI/server
cd web && bun run build       # typecheck + build the UI (commit web/dist)
```

## Code layout

- `src/sessions.ts`, `src/tmux.ts`, `src/managed.ts` — core: discover/drive agent
  sessions in tmux panes.
- `src/commands/serve.ts` + `web/` — the Bun HTTP server and the React PWA.
- `src/agents/` — the insight-agent engine: `registry.ts` (agent format + input
  kinds), `runner.ts` (collect → prompt → report), `backends/`, and `collectors/`.
- `agents/*.md` — example agents.
- `scripts/setup.sh` — the one-command VPS + Tailscale bootstrap.
- `scripts-internal/` — operator-only helpers (cp-sql bridge, X sync, security-scan
  CLI). Gitignored; copy from an existing box or author your own. Never commit
  hosts, paths, or tokens — configure via `.env`.

## Adding a collector

1. Add a file in `src/agents/collectors/` exporting a `collect*` function that
   returns a `CollectorResult`.
2. Add its input shape to the `InputSpec` union and `KNOWN_INPUT_KINDS` in
   `src/agents/registry.ts`.
3. Wire it into the `switch` in `src/agents/collectors/index.ts`.

## Adding an agent

Drop a `name.md` in `agents/` with YAML frontmatter (`name`, `title`,
`schedule`, `enabled`, `inputs`) and a prompt body. See the existing examples and
`lfg agents --help`.

## House rules

- **Deploy vs. release:** in this repo, "deploy" means make the current changes
  visible in the running/dev instance: rebuild the web UI if needed, restart the
  local service/process if needed, and verify the change can be seen. Do not
  create a git tag, GitHub release, or publish `lfg-bundle.tar.gz` unless the
  request explicitly says "release".
- **No secrets or personal data in commits** — config is env-driven via `.env`
  (gitignored). Don't hardcode hosts, paths, tokens, or emails.
- Match the surrounding code's style and comment density.
- Keep the security posture intact: the UI binds to loopback and is meant for a
  tailnet (see [SECURITY.md](./SECURITY.md)).
- When working on a repo other sessions share (e.g. the vibes monorepo),
  follow [docs/repo-hygiene.md](./docs/repo-hygiene.md): author in an isolated
  worktree, no destructive git on the shared tree, explicit-pathspec commits,
  and build (not just typecheck) before merge.
