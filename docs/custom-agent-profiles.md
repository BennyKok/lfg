# Custom agent profiles

A **custom agent profile** points a managed coding agent at extra system-prompt
text, extra skills, and a display-name override, sourced from a plain local
directory you control. Think of it like your own `~/.claude/CLAUDE.md`: a
reusable customization that layers **on top of** an agent's built-in defaults,
updates without an LFG code change or release (just edit the files), and is a
complete no-op when unconfigured.

It is designed to be generic. Today it is wired into the **`pi`** backend via the
`LFG_PI_PROFILE_DIR` environment variable, because pi's own CLI already exposes
the primitives it needs (`--append-system-prompt` and `--skill`). The mechanism
(`src/agent-profile.ts`) is backend-agnostic and is intended to generalize to
other backends later behind their own `LFG_<AGENT>_PROFILE_DIR` variables.

## Enabling it

Point the env var at a profile directory before starting `lfg`:

```sh
LFG_PI_PROFILE_DIR=/path/to/my-profile lfg serve
```

If the variable is unset — the default for every existing install — nothing
changes. Every `pi` session behaves exactly as before.

## Directory layout

All parts are optional; a profile can supply any subset.

```text
my-profile/
  system-prompt.md      Extra system-prompt text, appended to pi's own default
                        system prompt. system-prompt.txt is also accepted; .md
                        wins if both exist.
  skills/               A directory of skill subfolders. Each subfolder holds a
                        SKILL.md, e.g. skills/my-skill/SKILL.md. pi loads them
                        all, in addition to the project's own auto-discovered
                        .agents/skills/.
  name                  Plain-text display name shown in the UI instead of the
                        raw "pi" agent kind. Alternatively, a profile.json file
                        with a { "displayName": "..." } field. The name file
                        wins when both are present.
```

## What it does under the hood

When a `pi` session starts, LFG reads the profile directory and appends the
matching flags to the arguments it passes to pi's own CLI:

- `system-prompt.md` / `system-prompt.txt` → `--append-system-prompt <path>`
  (pi reads the file contents).
- `skills/` → `--skill <path>` (pi recurses to load every `<name>/SKILL.md`).

Both flags are **additive**. They do not replace pi's built-in system prompt or
the project's own `.agents/skills/` discovery — your profile's text and skills
are layered on top.

The display name from `name` / `profile.json` is recorded on the session so the
web UI can show your branded label (for example, in the session card's agent
tooltip) instead of `pi`.

## Failure handling

Profile loading never crashes a session. If the directory is missing, a
referenced file is absent, `profile.json` is malformed, or `skills/` is not a
directory, LFG logs a `[agent-profile] …` warning and simply skips that part —
the session still starts with whatever remains (or with no customization at
all).

## Notes and limits

- **pi-only for now.** The env var is scoped to the `pi` backend. The loader is
  written generically so other backends can adopt the same convention later.
- **Keep it local.** The profile directory and its contents live on your
  machine, not in this repo — nothing product- or partner-specific belongs in
  LFG itself.
- **No restart needed to change contents.** Editing the files takes effect on
  the next `pi` session you start; the env var itself is read at session launch.
