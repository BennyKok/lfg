# Runtime Base Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make lfg serve its UI, API, streams, WebSockets, service worker, manifest, and static resources under runtime `LFG_BASE_PATH`, such as `/lfg/`.

**Architecture:** Normalize `LFG_BASE_PATH` once in shared config. The Bun server strips the configured prefix before existing route matching and injects the normalized base path into runtime-served assets. The React app uses one base-path helper for same-origin URLs instead of hardcoded root-relative paths.

**Tech Stack:** Bun, TypeScript, Bun.serve, React, Vite, service worker JavaScript, web manifest JSON.

## Global Constraints

- `LFG_BASE_PATH` is runtime configuration; do not rely on Vite's compile-time `base` as the primary mechanism.
- Preserve current root behavior when `LFG_BASE_PATH` is unset or `/`.
- Serve API routes, SSE streams, WebSocket endpoints, static assets, the manifest, and the service worker under the same base path.
- Keep backend route handlers root-relative after request normalization.
- Do not preserve root `/api/*` routes when a non-root base path is configured.
- Invalid `LFG_BASE_PATH` values with query strings, hashes, or `..` path segments must throw during startup.
- Keep same-origin API calls and the existing Tailscale/loopback security assumptions intact.
- Use Bun repo commands: `bunx tsc --noEmit` and `cd web && bun run build`.
- Do not commit changes unless the user explicitly asks.

---

## File Structure

- Modify `src/config.ts`: add `normalizeBasePath(raw: string | undefined): string` and exported `BASE_PATH`.
- Modify `src/commands/serve.ts`: import `BASE_PATH`; strip base path from incoming requests; redirect `/lfg` to `/lfg/`; inject base path into HTML, service worker, and manifest responses; prefix static HTML asset references.
- Create `web/src/lib/base-path.ts`: expose `basePath`, `appPath(path: string): string`, and `appWebSocketUrl(path: string): string`.
- Modify `web/src/vite-env.d.ts`: declare `window.__LFG_BASE_PATH__`.
- Modify frontend files with hardcoded root URLs: `web/src/main.tsx`, `web/src/App.tsx`, `web/src/BrowserProfiles.tsx`, `web/src/BrowserLoginView.tsx`, `web/src/components/TermView.tsx`, `web/src/components/ask-center.tsx`, `web/src/lib/report-error.ts`, `web/src/lib/push.ts`, `web/src/voice-tts.ts`, `web/src/voice-orb.tsx`, `web/src/voice-call.tsx`, and `web/src/eleven-voice.ts`.
- Modify `web/public/sw.js`: support an injected base path placeholder.
- Modify `web/vite.config.ts`: proxy both `/api` and base-prefixed `/api` in dev and preview.
- Modify `AGENTS.md` if needed: update the runtime shape note from root-only `/api/*` to same-origin base-aware API paths.

---

### Task 1: Shared Base Path Configuration

**Files:**
- Modify: `src/config.ts`

**Interfaces:**
- Produces: `normalizeBasePath(raw: string | undefined): string`
- Produces: `BASE_PATH: string`
- Consumes: `process.env.LFG_BASE_PATH`

- [ ] **Step 1: Add the normalizer and export**

In `src/config.ts`, add this code after `PATHS`:

```ts
export function normalizeBasePath(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === "/") return "/";
  if (trimmed.includes("?") || trimmed.includes("#")) {
    throw new Error("LFG_BASE_PATH must be a path without query string or hash");
  }

  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withLeading.replace(/\/+/g, "/");
  const segments = collapsed.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("LFG_BASE_PATH must not contain . or .. path segments");
  }

  return collapsed.endsWith("/") ? collapsed : `${collapsed}/`;
}

export const BASE_PATH = normalizeBasePath(process.env.LFG_BASE_PATH);
```

- [ ] **Step 2: Run server typecheck**

Run: `bunx tsc --noEmit`

Expected: it may fail later because frontend references are not changed yet, but `src/config.ts` should not introduce TypeScript errors. If this command reports an error in `normalizeBasePath`, fix the exact type or syntax issue before continuing.

---

### Task 2: Backend Base Path Routing And Runtime Asset Rewriting

**Files:**
- Modify: `src/commands/serve.ts`

**Interfaces:**
- Consumes: `BASE_PATH` from `src/config.ts`
- Produces: `routePathFor(pathname: string): { kind: "route"; path: string } | { kind: "redirect"; locationPath: string } | { kind: "not-found" }`
- Produces: `withBasePath(path: string): string`

- [ ] **Step 1: Import `BASE_PATH`**

Change the config import near the top of `src/commands/serve.ts` from:

```ts
import { PATHS, installInfo } from "../config.ts";
```

to:

```ts
import { BASE_PATH, PATHS, installInfo } from "../config.ts";
```

- [ ] **Step 2: Add base path helpers**

Add this code near the HTTP helpers, before `WEB_DIR`:

```ts
function withBasePath(path: string): string {
  if (BASE_PATH === "/") return path;
  const clean = path.startsWith("/") ? path.slice(1) : path;
  return `${BASE_PATH}${clean}`;
}

function routePathFor(pathname: string):
  | { kind: "route"; path: string }
  | { kind: "redirect"; locationPath: string }
  | { kind: "not-found" } {
  if (BASE_PATH === "/") return { kind: "route", path: pathname };

  const bareBase = BASE_PATH.slice(0, -1);
  if (pathname === bareBase) return { kind: "redirect", locationPath: BASE_PATH };
  if (!pathname.startsWith(BASE_PATH)) return { kind: "not-found" };

  const stripped = pathname.slice(BASE_PATH.length - 1);
  return { kind: "route", path: stripped || "/" };
}

function rewriteIndexHtmlForBasePath(html: string): string {
  const baseScript = `<script>window.__LFG_BASE_PATH__ = ${JSON.stringify(BASE_PATH)};</script>`;
  const withRuntime = html.includes("</head>")
    ? html.replace("</head>", `${baseScript}</head>`)
    : `${baseScript}${html}`;
  if (BASE_PATH === "/") return withRuntime;
  return withRuntime
    .replaceAll('href="/assets/', `href="${BASE_PATH}assets/`)
    .replaceAll('src="/assets/', `src="${BASE_PATH}assets/`)
    .replaceAll('href="/manifest.webmanifest"', `href="${withBasePath("/manifest.webmanifest")}"`)
    .replaceAll('href="/icon.svg"', `href="${withBasePath("/icon.svg")}"`);
}
```

- [ ] **Step 3: Apply HTML rewriting**

In `webIndexResponse()`, after extension injection and before returning the response, add:

```ts
  html = rewriteIndexHtmlForBasePath(html);
```

The final part of the function should look like:

```ts
  if (exts.length) {
    const tags = exts
      .map((src) => `<script type="module" src="${src.replace(/"/g, "&quot;")}"></script>`)
      .join("");
    html = html.includes("</body>")
      ? html.replace("</body>", `${tags}</body>`)
      : html + tags;
  }
  html = rewriteIndexHtmlForBasePath(html);
  return new Response(html, {
```

- [ ] **Step 4: Normalize request path at fetch entry**

In the `fetch(req, server)` handler, replace:

```ts
      const path = url.pathname;
```

with:

```ts
      const route = routePathFor(url.pathname);
      if (route.kind === "redirect") {
        return Response.redirect(`${route.locationPath}${url.search}`, 308);
      }
      if (route.kind === "not-found") return err(404, "not found");
      const path = route.path;
```

- [ ] **Step 5: Rewrite `sw.js` response**

Replace the `/sw.js` static block with:

```ts
      if (path === "/sw.js") {
        const src = await Bun.file(join(WEB_DIR, "sw.js")).text();
        let version = "0";
        try {
          const s = statSync(INDEX_PATH);
          version = `${s.size}-${Math.floor(s.mtimeMs)}`;
        } catch {}
        return new Response(
          src
            .replace(/__VERSION__/g, version)
            .replace(/__LFG_BASE_PATH__/g, JSON.stringify(BASE_PATH)),
          {
            headers: {
              "Content-Type": "application/javascript; charset=utf-8",
              "Cache-Control": "no-cache",
              "Service-Worker-Allowed": BASE_PATH,
            },
          },
        );
      }
```

- [ ] **Step 6: Rewrite manifest response**

Before `const staticFile = STATIC_FILES[path];`, add a manifest-specific route:

```ts
      if (path === "/manifest.webmanifest") {
        const raw = await Bun.file(join(WEB_DIR, "manifest.webmanifest")).json();
        const manifest = raw as {
          start_url?: string;
          scope?: string;
          icons?: { src?: string; [key: string]: unknown }[];
          [key: string]: unknown;
        };
        return json({
          ...manifest,
          start_url: BASE_PATH,
          scope: BASE_PATH,
          icons: (manifest.icons ?? []).map((icon) => ({
            ...icon,
            src: icon.src?.startsWith("/") ? withBasePath(icon.src) : icon.src,
          })),
        });
      }
```

Then remove the `"/manifest.webmanifest"` entry from `STATIC_FILES` to avoid duplicate handling.

- [ ] **Step 7: Update startup log**

At the end of `cmdServe()`, after the existing web URL log, add:

```ts
  if (BASE_PATH !== "/") console.log(`  base path: ${BASE_PATH}`);
```

- [ ] **Step 8: Run server typecheck**

Run: `bunx tsc --noEmit`

Expected: server changes should typecheck. Frontend changes may still be pending, but no new errors should point to `src/commands/serve.ts`.

---

### Task 3: Frontend Base Path Helper And Call-Site Updates

**Files:**
- Create: `web/src/lib/base-path.ts`
- Modify: `web/src/vite-env.d.ts`
- Modify: `web/src/main.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/BrowserProfiles.tsx`
- Modify: `web/src/BrowserLoginView.tsx`
- Modify: `web/src/components/TermView.tsx`
- Modify: `web/src/components/ask-center.tsx`
- Modify: `web/src/lib/report-error.ts`
- Modify: `web/src/lib/push.ts`
- Modify: `web/src/voice-tts.ts`
- Modify: `web/src/voice-orb.tsx`
- Modify: `web/src/voice-call.tsx`
- Modify: `web/src/eleven-voice.ts`

**Interfaces:**
- Consumes: `window.__LFG_BASE_PATH__`
- Produces: `basePath: string`
- Produces: `appPath(path: string): string`
- Produces: `appWebSocketUrl(path: string): string`

- [ ] **Step 1: Add the frontend helper**

Create `web/src/lib/base-path.ts` with:

```ts
const rawBasePath = window.__LFG_BASE_PATH__ ?? "/";

export const basePath = rawBasePath === "/" ? "/" : rawBasePath.replace(/\/+$/, "/");

export function appPath(path: string): string {
  const clean = path.startsWith("/") ? path.slice(1) : path;
  if (!clean) return basePath;
  return basePath === "/" ? `/${clean}` : `${basePath}${clean}`;
}

export function appWebSocketUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${appPath(path)}`;
}
```

- [ ] **Step 2: Declare the runtime global**

Add this declaration to `web/src/vite-env.d.ts`:

```ts
interface Window {
  __LFG_BASE_PATH__?: string;
}
```

- [ ] **Step 3: Update `main.tsx`**

Import the helper:

```ts
import { appPath } from "./lib/base-path";
```

Replace service worker registration:

```ts
navigator.serviceWorker.register(appPath("/sw.js")).catch(() => {});
```

Replace current build selector with:

```ts
    .querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')
```

Keep the selector unchanged because it matches absolute resolved URLs too.

Replace update polling fetch:

```ts
const res = await fetch(appPath("/"), { cache: "no-store" });
```

- [ ] **Step 4: Update generic API wrappers**

In `web/src/App.tsx`, import:

```ts
import { appPath, appWebSocketUrl } from "./lib/base-path";
```

Change `api()` to:

```ts
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(appPath(path), init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `${res.status} ${res.statusText}`);
  }
  return data as T;
}
```

In `web/src/BrowserProfiles.tsx`, import:

```ts
import { appPath } from "./lib/base-path";
```

Change its local `api()` wrapper to fetch `appPath(path)`.

- [ ] **Step 5: Update direct fetch and beacon calls**

Replace direct same-origin fetches and beacons with `appPath(...)`.

Examples in `web/src/App.tsx`:

```ts
navigator.sendBeacon(appPath("/api/evlog"), blob)
void fetch(appPath("/api/evlog"), { ... })
void fetch(appPath(`/api/auto/findings/${findingId}/action`), { ... })
const res = await fetch(appPath("/api/voice/stt"), { ... })
const res = await fetch(appPath(`/api/sessions/${encodeURIComponent(sid)}/summary/stream`), { ... })
void fetch(appPath("/api/voice/config"))
const r = await fetch(appPath("/api/voice/config"), { ... })
```

Examples in other files:

```ts
await fetch(appPath("/api/voice/tts"), { ... })
await fetch(appPath("/api/livekit/token"))
await fetch(appPath("/api/voice/eleven-token"))
await fetch(appPath("/api/client-error"), { ... })
await fetch(appPath("/api/push/vapid"))
await fetch(appPath("/api/push/subscribe"), { ... })
await fetch(appPath("/api/push/unsubscribe"), { ... })
```

- [ ] **Step 6: Update EventSource and WebSocket calls**

Use `appPath()` for `EventSource` and `appWebSocketUrl()` for WebSockets.

Examples:

```ts
new EventSource(appPath(`/api/live/stream?ids=${ids.join(",")}&rid=${encodeURIComponent(rid)}`));
new EventSource(appPath(`/api/live/status?ids=${liveStatusKey}`));
new EventSource(appPath(`/api/agents/${agent}/runs/${start.runId}`));
new WebSocket(appWebSocketUrl("/api/voice/stt-stream"));
new WebSocket(appWebSocketUrl(`/api/browser/sessions/${encodeURIComponent(sessionId)}/stream`));
new WebSocket(appWebSocketUrl(`/api/term?session=${encodeURIComponent(TERM_SESSION)}&cols=${cols}&rows=${rows}`));
```

- [ ] **Step 7: Update static app-owned image paths**

Change `agentIconSrc()` in `web/src/App.tsx` to return `appPath(...)` values:

```ts
function agentIconSrc(agent?: string): string {
  if (agent === "codex" || agent === "codex-aisdk") return appPath("/agent-codex.svg");
  if (agent === "grok") return appPath("/agent-grok.svg");
  if (agent === "hermes") return `${appPath("/agent-hermes.svg")}?v=20260629`;
  if (agent === "opencode") return appPath("/agent-opencode.svg");
  return appPath("/agent-claude.svg");
}
```

Replace inline logo paths:

```tsx
<img src={appPath("/icon.svg")} alt="lfg" className="mx-1 size-6 shrink-0" />
<img src={appPath("/icon.svg")} alt="lfg" className="size-7 shrink-0" />
```

- [ ] **Step 8: Run frontend grep check**

Run: `bunx tsc --noEmit`

Expected: no TypeScript errors from missing imports or `window.__LFG_BASE_PATH__`.

Then search for remaining hardcoded same-origin root paths:

Run: `rg 'fetch\("/api|fetch\(`/api|new EventSource\(`/api|new WebSocket\([^)]*/api|sendBeacon\("/api|src="/icon|href="/manifest|register\("/sw' web/src web/index.html web/public/sw.js`

Expected: no matches in `web/src`. Remaining matches in comments are acceptable only if they are explanatory comments and not executable code.

---

### Task 4: Service Worker, Vite Proxy, Documentation, And Verification

**Files:**
- Modify: `web/public/sw.js`
- Modify: `web/vite.config.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: server replacement of `__LFG_BASE_PATH__` in `sw.js`
- Consumes: `process.env.LFG_BASE_PATH` in `web/vite.config.ts`

- [ ] **Step 1: Add base path support to service worker**

At the top of `web/public/sw.js`, after `CACHE`, add:

```js
const BASE_PATH = __LFG_BASE_PATH__;

function appPath(path) {
  const clean = path.startsWith("/") ? path.slice(1) : path;
  if (!clean) return BASE_PATH;
  return BASE_PATH === "/" ? `/${clean}` : `${BASE_PATH}${clean}`;
}
```

Then replace root hardcoded app paths:

```js
if (url.pathname.startsWith(appPath("/api"))) return false;
if (url.pathname.startsWith(appPath("/assets/"))) return true;
icon: appPath("/icon.svg"),
badge: appPath("/icon-maskable.svg"),
data: { url: payload.url || appPath("/") },
let feedUrl = appPath("/api/ask?status=open");
feedUrl = appPath(`/api/push/pending?endpoint=${encodeURIComponent(sub.endpoint)}`);
data: { url: appPath("/") },
const findings = asked?.findings || (await fetchJson(appPath("/api/auto/findings?status=open")))?.findings || [];
data: { url: appPath("/"), findingId: f?.id || null },
const target = event.notification.data?.url || appPath("/");
const shell = await caches.match(appPath("/"));
```

- [ ] **Step 2: Update Vite proxy config**

In `web/vite.config.ts`, add helpers after `API_TARGET`:

```ts
function normalizeBasePath(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withLeading.replace(/\/+/g, "/");
  return collapsed.endsWith("/") ? collapsed : `${collapsed}/`;
}

const BASE_PATH = normalizeBasePath(process.env.LFG_BASE_PATH);
const baseApiPrefix = BASE_PATH === "/" ? "/api" : `${BASE_PATH}api`;
const apiProxy = {
  target: API_TARGET,
  changeOrigin: true,
  ...(BASE_PATH === "/" ? {} : { rewrite: (p: string) => p.replace(new RegExp(`^${BASE_PATH.slice(0, -1)}`), "") }),
};
```

Replace both `proxy` blocks with:

```ts
proxy: {
  "/api": { target: API_TARGET, changeOrigin: true },
  ...(baseApiPrefix === "/api" ? {} : { [baseApiPrefix]: apiProxy }),
},
```

- [ ] **Step 3: Update repo guidance**

In `AGENTS.md`, replace:

```md
- The web app lives under `web/src` and talks to same-origin `/api/*`. In dev, Vite proxies `/api` to `LFG_API_TARGET` or `http://localhost:8766`.
```

with:

```md
- The web app lives under `web/src` and talks to same-origin API paths through the runtime base-path helper. In dev, Vite proxies `/api` and base-prefixed API paths to `LFG_API_TARGET` or `http://localhost:8766`.
```

- [ ] **Step 4: Run full typecheck**

Run: `bunx tsc --noEmit`

Expected: success.

- [ ] **Step 5: Run web build**

Run: `cd web && bun run build`

Expected: success. The build should emit `web/dist` with no TypeScript or Vite errors.

- [ ] **Step 6: Smoke test root mode**

Run: `bun run serve`

Expected: server logs `lfg web → http://127.0.0.1:8766` and no base path line.

In another shell or browser, check:

```bash
curl -i http://127.0.0.1:8766/
curl -i http://127.0.0.1:8766/api/sessions
curl -i http://127.0.0.1:8766/manifest.webmanifest
```

Expected: `/` returns HTML, `/api/sessions` returns JSON, and manifest `start_url` is `/`.

- [ ] **Step 7: Smoke test base-path mode**

Stop the previous server. Run: `LFG_BASE_PATH=/lfg/ bun run serve`

In another shell or browser, check:

```bash
curl -i http://127.0.0.1:8766/lfg/
curl -i http://127.0.0.1:8766/lfg/api/sessions
curl -i http://127.0.0.1:8766/lfg/manifest.webmanifest
curl -i http://127.0.0.1:8766/api/sessions
curl -i http://127.0.0.1:8766/lfg
```

Expected: `/lfg/` returns HTML with `window.__LFG_BASE_PATH__ = "/lfg/"`; `/lfg/api/sessions` returns JSON; `/lfg/manifest.webmanifest` contains `"start_url":"/lfg/"`; `/api/sessions` returns `404`; `/lfg` redirects with status `308` to `/lfg/`.

- [ ] **Step 8: Check runtime UI in browser**

Open `http://127.0.0.1:8766/lfg/` and verify:

- App shell loads with icons.
- Network requests go to `/lfg/api/...`.
- Live status/EventSource requests connect under `/lfg/api/...`.
- Terminal and browser profile WebSockets use `/lfg/api/...` when those views are opened.

---

## Self-Review Notes

- Spec coverage: Tasks cover config normalization, server routing, HTML injection, static asset rewriting, frontend helper updates, service worker, manifest, Vite dev proxy, errors, and verification.
- Placeholder scan: No placeholder markers or vague follow-up steps remain.
- Type consistency: Server exports `BASE_PATH`; frontend uses `appPath` and `appWebSocketUrl` consistently; service worker consumes the JSON-literal replacement provided by the server.
