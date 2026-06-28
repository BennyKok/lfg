# Hetzner Cloud

Hetzner does not provide arbitrary GitHub-repo deploy buttons like Railway. Its
official "Deploy to Hetzner Cloud" button only preselects one of Hetzner's App
images. For `lfg`, use cloud-init or the `hcloud` CLI to create a normal Ubuntu
server and run `scripts/setup.sh` on first boot.

The installer keeps `lfg` bound to `127.0.0.1` and exposes it through
`tailscale serve`. Do not open the `lfg` port to the public internet.

## One-command Server Create

1. Copy `cloud-init.yaml` and replace:
   - `REPLACE_WITH_YOUR_PUBLIC_SSH_KEY`
   - `CHANGE_ME_TS_AUTHKEY`
2. Create the server:

```bash
hcloud server create \
  --name lfg-1 \
  --type cpx21 \
  --image ubuntu-24.04 \
  --location fsn1 \
  --user-data-from-file deploy/hetzner/cloud-init.yaml
```

3. Watch first boot:

```bash
ssh lfg@<server-ip> 'tail -f /var/log/cloud-init-output.log'
```

4. Check the app:

```bash
ssh lfg@<server-ip> 'systemctl --user status lfg --no-pager'
ssh lfg@<server-ip> 'journalctl --user -u lfg -f'
```

When Tailscale is configured, the installer prints the tailnet-only HTTPS URL.

## Manual Console Flow

If you prefer the Hetzner Console:

1. Create an Ubuntu 24.04 server.
2. Paste the contents of `cloud-init.yaml` into the **Cloud config** field.
3. Create the server.
4. SSH in as `lfg` after cloud-init completes.

## Updating

SSH into the server as `lfg` and run:

```bash
lfg setup
```
