# Agent Instructions

## Reporting Style

Report to the user in ASD-STE100 Simplified Technical English. This covers
progress updates, questions, completion reports, and final responses.

- Prefer short sentences, active voice, and one idea per sentence.
- STE governs the prose only. Keep technical identifiers, file paths, commands,
  log lines, and quoted source text verbatim whenever accuracy depends on it.

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

## Local Repro Servers

- Bind ad hoc repro/static servers to loopback only. Use
  `python3 -m http.server --bind 127.0.0.1 <port>` or the equivalent
  localhost-only flag for other tools.
- Do not start throwaway repro servers on `0.0.0.0`. If a server must be shared,
  put a private tunnel or Tailscale Serve in front of a loopback listener.
- Stop any repro server you start before ending the session, especially when it
  runs from `/tmp`, a worktree, or generated build output.

## Reporting Style

Write everything you report to the user in ASD-STE100 Simplified Technical
English: progress updates, questions, completion reports, and final responses.

- One idea per sentence. Use active voice and the simplest verb that fits.
- Keep sentences short — aim for 20 words in instructions, 25 in explanations.
- Do not use contractions. Write "do not", not "don't".
- Do not stack nouns into long strings. Break them into a phrase with a verb.
- Reproduce technical identifiers, commands, paths, and quoted source text
  exactly as they are. Accuracy outranks the vocabulary rules — never reword a
  symbol, an error message, or a log line to make it simpler.

This governs prose written for the user. It does not apply to code, comments,
commit messages, CHANGELOG entries, or other files you edit; those keep the
existing style of the file.
