# HTTP/2 Serving Plan

Last checked: 2026-07-06

## Summary

Do not add HTTP/2 to `src/commands/serve.ts`.

The cold-load browser connection cap bites on the browser-facing origin hop. For
hosted OMG workspaces, that hop is Cloudflare, not Bun. Cloudflare is already
serving the relevant public hosts over HTTP/2, so changing Bun from HTTP/1.1
would not remove a browser-side six-connection limit for those URLs. If a real
workspace still shows `http/1.1` in Chrome, the operator should fix the edge
zone or route configuration for that hostname, not the lfg process.

## Current Serving Topology

`lfg serve` itself is a Bun server:

- `src/commands/serve.ts` calls `Bun.serve(...)` with `port`, `hostname`, HTTP
  routes, SSE responses, and WebSocket upgrades.
- The default bind is `127.0.0.1`; `LFG_HOST=0.0.0.0` is only used by hosted
  container/sandbox deploy paths.
- The checked-in Docker image uses `oven/bun:1.3.13-debian`, matching the local
  `bun --version` result, `1.3.13`.

Repo-local deployment paths:

- Self-hosted setup: `scripts/setup.sh` keeps lfg on loopback and optionally
  fronts it with `tailscale serve --https=<port> http://127.0.0.1:<LFG_PORT>`.
- Fly: `fly.toml` has no public `http_service`; `deploy/fly/README.md` says to
  use private networking, WireGuard, Tailscale, or a local proxy.
- Railway and Render: the shared Dockerfile binds lfg to the platform-provided
  port; the platform edge is the browser-facing TLS/protocol terminator.
- OMG one-click workspace: `deploy/omg/README.md` says the control plane starts
  `lfg serve --host 0.0.0.0 --port 8766` and redirects the browser to the
  sandbox public URL.

The OMG platform topology, confirmed in the sibling `vibes` infra repo, is:

```text
browser
  -> Cloudflare zone / Worker (*.preview.omg.dev, *.apps.omg.dev)
  -> Cloudflare Tunnel
  -> Go `vibes-sandbox` HTTP server on :7070
  -> Go preview/deploy reverse proxy
  -> sandbox VM port, e.g. lfg on :8766
```

Relevant platform files:

- `/home/dev/repos/vibes/apps/infra/INFRA.md`
- `/home/dev/repos/vibes/apps/infra/worker/wrangler.toml`
- `/home/dev/repos/vibes/apps/infra/worker/src/index.ts`
- `/home/dev/repos/vibes/apps/infra/internal/proxy/preview.go`
- `/home/dev/repos/vibes/apps/infra/main.go`

## Where The Six-Connection Cap Bites

The browser's per-origin connection limit applies between the browser and the
origin URL shown in DevTools. For OMG workspace URLs, the origin is a Cloudflare
hostname such as `*.preview.omg.dev` or `*.apps.omg.dev`, not `Bun.serve`
inside the sandbox.

That means:

- HTTP/2 must be enabled on the browser-to-Cloudflare hop to avoid the browser
  opening only a small number of HTTP/1.1 TCP connections per origin.
- The Cloudflare-to-Go, Go-to-VM, and VM-to-Bun hops can remain HTTP/1.1 without
  causing Chrome's per-origin browser queueing. They can still affect backend
  throughput, but they are not the browser connection cap.
- Long-lived SSE streams only consume browser connection slots when the
  browser-facing protocol is HTTP/1.1. Under HTTP/2, they are streams on the
  negotiated HTTP/2 connection.

## Verification Results

Public OMG host checks from this workspace:

```text
curl -I https://lfg.omgs.app/                         -> HTTP/2 200
curl -I https://lfg.apps.omg.dev/                     -> HTTP/2 301
curl -I https://nonexistent-8766.preview.omg.dev/     -> HTTP/2 404
curl -I https://nonexistent.apps.omg.dev/             -> HTTP/2 301
openssl s_client -alpn h2,http/1.1 ... preview host   -> ALPN protocol: h2
openssl s_client -alpn h2,http/1.1 ... apps host      -> ALPN protocol: h2
```

These results show that Cloudflare is already advertising and negotiating h2
for the relevant public wildcard hosts, even when the application route returns
404/redirect.

## Bun HTTP/2 Server Status

Local Bun is `1.3.13`, and the Dockerfile pins the same version. The local
`bun-types` `Serve` options expose `tls`, `http3`, `http1`, `idleTimeout`, and
WebSocket options, but no `http2` or ALPN option for `Bun.serve`.

Official Bun docs currently document TLS and experimental HTTP/3 for
`Bun.serve`, but not native HTTP/2 for `Bun.serve`. The upstream Bun issue
"HTTP2 support for `Bun.serve()`" remains open.

Conclusion: implementing this in Bun would mean a risky app-server/TLS change
or replacing the server stack, and it would target the wrong hop for OMG's
browser-side queueing anyway.

## Lowest-Risk Recommendation

For OMG-hosted lfg:

1. Leave `src/commands/serve.ts` as HTTP/1.1.
2. Keep HTTP/2 enabled on the Cloudflare zone for `preview.omg.dev`,
   `apps.omg.dev`, `omgs.app`, and any workspace hostnames used by lfg.
3. If a specific workspace still shows `http/1.1` in Chrome DevTools, check the
   exact request hostname with:

   ```bash
   curl -I --http2 https://<workspace-host>/
   openssl s_client -alpn h2,http/1.1 -connect <workspace-host>:443 -servername <workspace-host>
   ```

4. If those checks do not negotiate h2, fix the Cloudflare edge setting for that
   zone/hostname. Cloudflare documents HTTP/2 as enabled by default for all
   plans when the edge has an SSL certificate.
5. Do not enable Cloudflare Tunnel `http2Origin` for this purpose. Cloudflare
   documents that setting as cloudflared-to-origin HTTP/2, requiring TLS at the
   origin. It would not change the browser-to-Cloudflare protocol, and lfg/Bun
   is not serving HTTPS with HTTP/2.

For self-hosted Tailscale Serve:

1. The same rule applies: verify the actual browser-facing Tailscale HTTPS URL
   in Chrome's Protocol column or with `curl -I --http2`.
2. If Tailscale Serve negotiates HTTP/2 for that URL, Bun should remain
   unchanged.
3. If it negotiates only HTTP/1.1 and the cold-load request fanout matters, put
   a real HTTP/2-capable reverse proxy at the browser-facing HTTPS hop, or wait
   for native `Bun.serve` HTTP/2 support.

## Implementation Decision

No code or deploy config change was made.

There is no safe, repo-local, config-only HTTP/2 switch in lfg that affects the
browser-facing OMG hop. The relevant public Cloudflare hosts already negotiate
HTTP/2. Changing Bun TLS/server behavior would be riskier, would alter local or
sandbox runtime behavior, and would not address the browser connection cap when
the browser is talking to Cloudflare.

## References

- Bun server docs: https://bun.com/docs/runtime/http/server
- Bun TLS docs: https://bun.com/docs/runtime/http/tls
- Bun `Bun.serve` HTTP/2 issue: https://github.com/oven-sh/bun/issues/14672
- Cloudflare HTTP/2 docs: https://developers.cloudflare.com/speed/optimization/protocol/http2/
- Cloudflare Tunnel origin parameters: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/
