# Render

Render can run the shared Docker image via `render.yaml`. Treat this as a demo
or private-network deployment unless you add authentication in front of OMG.

## Deploy

1. Create a new Blueprint from this repository.
2. Render will read `render.yaml`.
3. Add optional secrets such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
   `ELEVENLABS_API_KEY`.
4. If you need private access, pair it with Render's Tailscale subnet router
   template and put the Tailscale auth key on that router service.

The service mounts `/data` for OMG data and scanned repos.

The Dockerfile builds from the source tree Render checks out — there is no
bundle to publish first.
