# Runtime Base Path Design

## Summary

lfg should run either at the origin root or under a configured URL prefix. Operators configure the prefix with `LFG_BASE_PATH`, for example `LFG_BASE_PATH=/lfg/`. When the variable is unset or set to `/`, current root behavior remains unchanged.

The implementation should normalize the base path once on the server, expose the normalized value to the browser at runtime, and route all frontend-owned URLs through a small helper. This keeps the change runtime-configurable without requiring a Vite rebuild per deployment path.

## Goals

- Serve the web UI at the configured base path, such as `/lfg/`.
- Serve API routes, SSE streams, WebSocket endpoints, static assets, the manifest, and the service worker under the same base path.
- Preserve current behavior when `LFG_BASE_PATH` is unset or `/`.
- Keep the server's existing internal route table root-relative after request normalization.
- Avoid compile-time Vite `base` as the primary mechanism because the requirement is runtime configuration.

## Non-Goals

- Support multiple base paths from one server process.
- Move lfg from same-origin API calls to a separate API origin.
- Add authentication or public exposure changes.
- Preserve root `/api/*` routes while a non-root base path is configured.

## Configuration

Add a normalized `basePath` value to the server configuration.

Normalization rules:

- Empty, missing, or whitespace-only `LFG_BASE_PATH` becomes `/`.
- Values must start with `/`; otherwise, prefix `/`.
- Values other than `/` must end with `/`.
- Repeated slashes collapse to one slash.
- Query strings, hashes, and `..` path segments are invalid and must throw during startup so misconfiguration is visible.

Examples:

| Raw value | Normalized value |
| --- | --- |
| unset | `/` |
| `/` | `/` |
| `lfg` | `/lfg/` |
| `/lfg` | `/lfg/` |
| `/lfg/` | `/lfg/` |

## Server Routing

`src/commands/serve.ts` should derive a route path from the request path before any route comparisons.

For `basePath === "/"`, the route path is `url.pathname`.

For a non-root base path:

- A request to the base path without the trailing slash, such as `/lfg`, should redirect to `/lfg/` with the query string preserved.
- A request whose path does not start with the base path should return `404`.
- A request under the base path strips that prefix before existing route matching. `/lfg/api/sessions` routes internally as `/api/sessions`; `/lfg/assets/index.js` routes internally as `/assets/index.js`; `/lfg/` routes internally as `/`.

This keeps existing API handlers unchanged and limits routing risk.

## Static HTML

`webIndexResponse()` should inject the normalized base path into `index.html` before the app bundle runs.

Use a small runtime global, for example:

```html
<script>window.__LFG_BASE_PATH__ = "/lfg/";</script>
```

The injected value must be JSON-encoded, not string-concatenated, to avoid broken HTML if the value changes later.

The server should also rewrite root-absolute built asset references in `index.html` so production bundles load from the base path. Vite currently emits root-absolute asset paths because the build has no compile-time base path. Server-side HTML rewriting keeps the deployment path runtime-configurable.

## Frontend URL Helper

Add one frontend helper module, for example `web/src/lib/base-path.ts`.

The helper should expose:

- `basePath`: normalized runtime base path.
- `appPath(path: string)`: prefixes same-origin HTTP paths such as `/api/sessions`, `/icon.svg`, `/manifest.webmanifest`, and `/`.
- `appWebSocketUrl(path: string)`: builds `ws:` or `wss:` URLs using `location.host` and the base path.

All app-owned absolute paths in the frontend should use this helper, including:

- `fetch()` calls.
- `navigator.sendBeacon()` calls.
- `EventSource` URLs.
- `WebSocket` URLs.
- Service worker registration.
- Manifest, icon, and agent icon paths.
- Build update polling in `main.tsx`.

External URLs and terminal-detected links must not use the helper.

## Service Worker

`sw.js` must understand the same base path as the app.

The server should inject the base path into the served service worker script. The service worker should then:

- Treat `${basePath}api` as non-cacheable.
- Treat `${basePath}assets/` as cacheable built assets.
- Use base-prefixed icon and badge URLs in notifications.
- Open base-prefixed app URLs from notifications.
- Cache and restore the base-prefixed shell path, not always `/`.

When registering the service worker, the frontend should register the base-prefixed script path. For `/lfg/`, the script path is `/lfg/sw.js`; the default service worker scope is then `/lfg/`.

The server's `Service-Worker-Allowed` header should match the configured base path.

## Web Manifest

The server should serve `manifest.webmanifest` with base-aware `start_url`, `scope`, and icon paths. The source file in `web/public` can remain root-relative; the runtime response should rewrite the fields before sending JSON.

For `LFG_BASE_PATH=/lfg/`, the served manifest should contain:

```json
{
  "start_url": "/lfg/",
  "scope": "/lfg/",
  "icons": [
    { "src": "/lfg/icon.svg" },
    { "src": "/lfg/icon-maskable.svg" }
  ]
}
```

## Development Server

The Vite dev and preview proxies should honor `LFG_BASE_PATH` for API calls. If `LFG_BASE_PATH=/lfg/`, requests to `/lfg/api/*` should proxy to the Bun API target and strip `/lfg` before forwarding, because the Bun server still routes internally as `/api/*` when Vite is the frontend server.

This is a dev-only convenience. Production path handling belongs to `src/commands/serve.ts`.

## Error Handling

Invalid `LFG_BASE_PATH` values should fail fast during startup with a clear error message. This is safer than silently serving a broken UI under a misspelled path.

Requests outside a configured non-root base path should return `404`. The only exception is the slash-normalization redirect from `/lfg` to `/lfg/`.

## Testing

Add focused tests if the repo already has a lightweight test path for config or URL helpers. If not, verify with typecheck, build, and manual smoke tests.

Required verification:

- `bunx tsc --noEmit`
- `cd web && bun run build`
- Start the server with `LFG_BASE_PATH=/lfg/ bun run serve`.
- Confirm `/lfg/` serves the UI.
- Confirm `/lfg/api/sessions` returns JSON.
- Confirm `/lfg/assets/*` bundle URLs load.
- Confirm SSE streams and WebSocket endpoints connect under `/lfg/api/...`.
- Confirm `/api/sessions` returns `404` in base-path mode.
- Confirm unset `LFG_BASE_PATH` preserves root behavior.

## Implementation Notes

- Keep backend route handlers root-relative by stripping the base path before existing checks.
- Use `JSON.stringify(basePath)` when injecting the browser global.
- Prefer the frontend helper over broad monkey-patching of `fetch`, `EventSource`, or `WebSocket`.
- Do not rewrite user-provided URLs, external extension URLs, or detected terminal links.
- Keep the security model intact: same-origin API calls remain behind the existing host and Tailscale assumptions.
