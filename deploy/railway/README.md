# Railway

Railway is a demo-friendly deployment target for `lfg`. It can run the web UI
and API from this repository, but it does not have your local repositories,
`tmux` sessions, or authenticated agent CLIs unless you add them to that
container yourself.

Use Railway for a quick hosted preview. For day-to-day agent work, install
`lfg` on the machine that already has your repos and CLI credentials.

## Deploy from GitHub

1. Push this repository to GitHub.
2. In Railway, create a new project from the GitHub repository.
3. Railway will pick up `railway.json`.
4. Set any optional provider secrets in Railway variables, for example:
   - `ANTHROPIC_API_KEY`
   - `OPENAI_API_KEY`
   - `ELEVENLABS_API_KEY`

`railway.json` binds the app to `0.0.0.0` and Railway's injected `$PORT`.

## Template Button

The README uses Railway's generic GitHub-template URL. After creating a
published Railway template from the Railway dashboard, replace that README link
with the assigned template URL:

```md
[![Deploy on Railway](https://railway.com/button.svg)](RAILWAY_TEMPLATE_URL)
```

Published Railway template URLs are assigned by Railway after publishing; this
repo cannot know the final URL ahead of time.
