# DigitalOcean

DigitalOcean has two useful paths for `lfg`:

- App Platform via `.do/app.yaml` for a containerized demo.
- A Droplet with cloud-init or `scripts/setup.sh` for real day-to-day agent use.

## App Platform

The `.do/app.yaml` spec builds the shared Dockerfile and starts `lfg` on port
`8766`. The Dockerfile builds from the source tree App Platform checks out —
there is no bundle to publish first.

Add a Deploy to DigitalOcean button once the app spec is published from the
target repo/account:

```md
[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/BennyKok/omg.dev/tree/main)
```

Do not expose the app publicly unless you add authentication in front of `lfg`.

## Droplet

For production-style usage, create an Ubuntu Droplet and run:

```bash
curl -fsSL https://raw.githubusercontent.com/BennyKok/omg.dev/main/scripts/setup.sh \
  | TS_AUTHKEY=tskey-auth-xxxx bash
```
