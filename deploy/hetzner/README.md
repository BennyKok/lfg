# Hetzner Cloud

Hetzner does not provide arbitrary GitHub-repo deploy buttons like Railway. Its
official "Deploy to Hetzner Cloud" button only preselects one of Hetzner's App
images. For OMG, use cloud-init or the `hcloud` CLI to create a normal Ubuntu
server and run `scripts/setup.sh` on first boot.

The installer keeps OMG bound to `127.0.0.1` and exposes it through
`tailscale serve`. Do not open the OMG port to the public internet.

## One-command Server Create

1. Copy `cloud-init.yaml` and replace:
   - `REPLACE_WITH_YOUR_PUBLIC_SSH_KEY`
   - `CHANGE_ME_TS_AUTHKEY`
2. Create the server:

```bash
hcloud server create \
  --name omg-1 \
  --type cpx21 \
  --image ubuntu-24.04 \
  --location fsn1 \
  --user-data-from-file deploy/hetzner/cloud-init.yaml
```

3. Watch first boot:

```bash
ssh omg@<server-ip> 'tail -f /var/log/cloud-init-output.log'
```

4. Check the app:

```bash
ssh omg@<server-ip> 'systemctl --user status omg --no-pager'
ssh omg@<server-ip> 'journalctl --user -u omg -f'
```

When Tailscale is configured, the installer prints the tailnet-only HTTPS URL.

## Manual Console Flow

If you prefer the Hetzner Console:

1. Create an Ubuntu 24.04 server.
2. Paste the contents of `cloud-init.yaml` into the **Cloud config** field.
3. Create the server.
4. SSH in as `omg` after cloud-init completes.

## Updating

SSH into the server as `omg` and run:

```bash
omg setup
```
