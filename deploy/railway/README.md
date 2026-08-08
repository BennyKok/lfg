# Railway

Railway is a demo-friendly deployment target for OMG. It can run the web UI
and API from this repository, but it does not have your local repositories,
`tmux` sessions, or authenticated agent CLIs unless you add them to that
container yourself.

Use Railway for a quick hosted preview. For day-to-day agent work, install
OMG on the machine that already has your repos and CLI credentials.

## Deploy from GitHub

1. Push this repository to GitHub.
2. In Railway, create a new project from the GitHub repository.
3. Railway will pick up `railway.json` and build the shared `Dockerfile`.
4. Set any optional provider secrets in Railway variables, for example:
   - `ANTHROPIC_API_KEY`
   - `OPENAI_API_KEY`
   - `ELEVENLABS_API_KEY`

The Dockerfile binds the app to `0.0.0.0` and maps Railway's injected `$PORT`
to `LFG_PORT`.

The Dockerfile builds from the source tree Railway checks out — there is no
bundle to publish first.

## Private Tailscale Access

For a private Railway deployment, keep Public Networking disabled on the `lfg`
service and add Railway's Tailscale Subnet Router template as a second service
in the same project.

Put the Tailscale auth key on the router service, not the `lfg` service:

```env
TS_AUTHKEY=tskey-auth-...
```

The `lfg` service itself does not run Tailscale on Railway. The router joins
your tailnet and gives your devices access to Railway private service names such
as `lfg.railway.internal`.

## Template Button

The README uses Railway's generic GitHub-template URL. After creating a
published Railway template from the Railway dashboard, replace that README link
with the assigned template URL:

```md
[![Deploy on Railway](https://railway.com/button.svg)](RAILWAY_TEMPLATE_URL)
```

Published Railway template URLs are assigned by Railway after publishing; this
repo cannot know the final URL ahead of time.

A polished one-click Railway template should include two services: `lfg` from
this repo and the Tailscale router service with `TS_AUTHKEY` marked as a required
variable.
