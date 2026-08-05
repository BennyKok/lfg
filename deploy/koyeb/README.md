# Koyeb

Koyeb can deploy `lfg` from the shared Dockerfile. This is best for a hosted
demo unless you add authentication and a private access path.

The Dockerfile builds from the source tree Koyeb checks out — there is no bundle
to publish first.

## Deploy Button

```md
[![Deploy to Koyeb](https://www.koyeb.com/static/images/deploy/button.svg)](https://app.koyeb.com/deploy?type=git&repository=github.com/BennyKok/omg.dev&branch=main&name=lfg)
```

Recommended variables:

- `LFG_HOST=0.0.0.0`
- `LFG_PORT=8766`
- `LFG_REPOS_ROOT=/data/repos`
- Optional provider keys such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and
  `ELEVENLABS_API_KEY`

Do not publish an unauthenticated `lfg` instance to the public internet.
