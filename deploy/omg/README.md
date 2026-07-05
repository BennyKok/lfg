# OMG

OMG is the one-click hosted workspace path for `lfg`.

[![Deploy on OMG](https://img.shields.io/badge/Deploy%20on-OMG-ff5530?style=for-the-badge)](https://omg.dev/deploy?repo=https%3A%2F%2Fgithub.com%2FBennyKok%2Flfg)

## Flow

1. Open `https://omg.dev/deploy?repo=https%3A%2F%2Fgithub.com%2FBennyKok%2Flfg`.
2. Sign in to OMG if prompted.
3. OMG normalizes the GitHub URL and maps `BennyKok/lfg` to the prebuilt
   `templateId: "lfg"` sandbox on port `8766`.
4. The control plane starts `lfg serve --host 0.0.0.0 --port 8766`.
5. The browser redirects to the sandbox public URL.

The route is server-side. The infra service token is never sent to the browser.
During the preview, the route is available on free accounts while billing gates
are still being designed.

## First-run Agent Setup

The workspace is intentionally fresh. In LFG, open **Settings → Coding agents**
to check Claude, Codex, OpenCode, Hermes, and Grok setup. The screen reports the
installed binary path, auth state, and setup action where automatic install is
supported.

For Claude or Codex, complete the normal CLI login inside the workspace, or set
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` if you want API-key based operation.

## E2E Contract

The OMG side owns the launch route and template lifecycle:

- Route: `https://omg.dev/deploy?repo=<github-url>`
- LFG repo URL: `https://github.com/BennyKok/lfg`
- Template: `lfg`
- Port: `8766`
- Start command: `lfg serve --host 0.0.0.0 --port 8766`

The underlying lifecycle test in the OMG repo creates the sandbox from
`templateId: "lfg"`, resolves the `8766` public URL, hibernates it, wakes it with
readiness port `8766`, and verifies the URL still reaches LFG.
