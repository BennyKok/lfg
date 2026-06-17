import { readdir, realpath, stat } from "node:fs/promises";
import { statSync, mkdirSync, type Dirent } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { marked } from "marked";
import { PATHS } from "../config.ts";
import {
  AGENTS_DIR,
  listAgents,
  loadAgent,
  writeAgent,
} from "../agents/registry.ts";
import {
  parseActions,
  readActionsSidecar,
  reportPathFor,
  runAgent,
  type ActionRow,
} from "../agents/runner.ts";
import { executeAction, executeActionsCombined, dispatchSendFixAgent } from "../actions/index.ts";
import {
  listAutoAgents,
  getAutoAgent,
  saveAutoAgent,
  deleteAutoAgent,
  isRunning,
  listFindings,
  updateFinding,
} from "../auto/store.ts";
import { runAutoAgent } from "../auto/runner.ts";
import { startAutoScheduler } from "../auto/scheduler.ts";
import {
  listSessions,
  resolveTranscript,
  recentMessages,
  messagePage,
  normalizeLineMessages,
  setSessionTitle,
  sessionIdForPid,
  pendingToolPrompt,
  listResumable,
  cwdForTranscript,
  type PendingPrompt,
} from "../sessions.ts";
import {
  capturePane,
  parsePrompt,
  type PanePrompt,
  answerPrompt,
  dismissPrompt,
  tmuxInterrupt,
  tmuxKillPane,
  tmuxKillSession,
  spawnManagedSession,
  relaunchSessionWithModel,
  spawnManagedCodexSession,
  spawnManagedAisdkSession,
  spawnManagedCodexAisdkSession,
  spawnManagedOpencodeAisdkSession,
  dismissCodexUpdatePrompt,
  panePidForSession,
  isBusy,
} from "../tmux.ts";
import { addManaged, removeManaged } from "../managed.ts";
import { PtyBridge, termSessionName } from "../pty.ts";
import { capturePaneScroll, capturePaneEscaped, paneWidth } from "../tmux.ts";
import { detectUrls } from "../links.ts";
import type { ServerWebSocket } from "bun";
import { appendCmd as appendAisdkCmd, removeEntry as removeAisdkEntry, readEntry as readAisdkEntry, findEntryByAnyId as findAisdkEntryByAnyId } from "../aisdk-registry.ts";
import { markClosed } from "../closing.ts";
import { assignUser, userRoster } from "../users.ts";

// Where the user keeps the repos lfg can launch agents into. Scanned for git
// repos at runtime; defaults to ~/repos. The lfg repo itself (PATHS.root) is
// always offered as a target since it is present and trusted.
const REPOS_ROOT = process.env.LFG_REPOS_ROOT ?? join(homedir(), "repos");
const SELF_REPO = PATHS.root;

// Allowlisted Claude model aliases. They land both on a launch argv (--model)
// and in a `/model <alias>` slash command we inject mid-session — so an unknown
// value is a hard 400, never a silent fallback. These mirror Claude Code's own
// `/model` aliases (same set the --model flag accepts).
const CLAUDE_MODELS = ["fable", "opus", "sonnet", "haiku"];
// Models the "aisdk" session kind accepts (the provider maps these aliases).
const AISDK_MODELS = ["opus", "sonnet", "haiku"];
import { enqueueMessage, listQueue, retryMessage, clearResolved, reconcileQueued, getMessage } from "../sendq.ts";

const PORT = Number(process.env.LFG_PORT ?? 8766);
// Bind to loopback by default — the UI is meant to be reached over Tailscale
// (via `tailscale serve`), never the public internet. Override LFG_HOST only
// if you understand the exposure.
const HOST = process.env.LFG_HOST ?? "127.0.0.1";

marked.setOptions({ gfm: true, breaks: false });

// Render a report's markdown to HTML, wrapping every table in a horizontal
// scroll container so wide tables (security posture, pricing, db stats) scroll
// within their card on mobile instead of blowing out the viewport width.
function renderReportHtml(raw: string): string {
  const html = marked.parse(raw) as string;
  return html
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, "</table></div>");
}

// ---------- legacy: pre-agents flat reports ----------

async function listLegacyReports() {
  const dir = join(PATHS.data, "reports");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const entries = await Promise.all(
    files
      .filter((f) => f.endsWith(".md") && /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map(async (f) => {
        const s = await stat(join(dir, f));
        return { date: f.replace(/\.md$/, ""), bytes: s.size, mtime: s.mtimeMs };
      }),
  );
  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

async function readLegacyReport(date: string): Promise<string | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const f = Bun.file(join(PATHS.data, "reports", `${date}.md`));
  return (await f.exists()) ? await f.text() : null;
}

async function listRepos() {
  let root: string;
  try {
    root = await realpath(REPOS_ROOT);
  } catch {
    root = REPOS_ROOT;
  }
  const repos: Array<{ name: string; cwd: string }> = [];
  const addRepo = async (name: string, cwd: string) => {
    if (repos.some((r) => r.cwd === cwd)) return;
    try {
      await stat(join(cwd, ".git"));
      repos.push({ name, cwd });
    } catch {}
  };
  let entries: Dirent[] = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {}
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    await addRepo(entry.name, join(root, entry.name));
  }
  // Always offer the lfg repo itself as a target — it is present and trusted.
  await addRepo("lfg", SELF_REPO);
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return repos;
}

// ---------- agent reports ----------

async function listAgentReports(agent: string) {
  const dir = join(PATHS.data, "reports", agent);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const entries = await Promise.all(
    files
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map(async (f) => {
        const s = await stat(join(dir, f));
        return { date: f.replace(/\.md$/, ""), bytes: s.size, mtime: s.mtimeMs };
      }),
  );
  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

async function readAgentReport(agent: string, date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!/^[a-z0-9_-]+$/.test(agent)) return null;
  const f = Bun.file(reportPathFor(agent, date));
  if (!(await f.exists())) return null;
  const raw = await f.text();
  const parsed = parseActions(agent, date, raw).map((p) => p.id);
  const sidecar = await readActionsSidecar(agent, date);
  const byId = new Map(sidecar.map((s) => [s.id, s] as const));
  const actions = parsed
    .map((id) => byId.get(id))
    .filter((r): r is ActionRow => !!r);
  return { date, raw, html: renderReportHtml(raw), actions };
}

// ---------- run lifecycle ----------

type RunState = {
  id: string;
  agent: string;
  date: string;
  startedAt: number;
  status: "running" | "done" | "failed";
  logs: string[];
  result?: unknown;
  error?: string;
  subscribers: Set<(ev: { line?: string; final?: RunState }) => void>;
};

const RUNS = new Map<string, RunState>();
const RUN_TTL_MS = 60 * 60 * 1000;

// Last successful /api/claude/usage payload (60s TTL).
let usageCache: { at: number; data: unknown } | null = null;

function evictOldRuns() {
  const cutoff = Date.now() - RUN_TTL_MS;
  for (const [k, v] of RUNS) if (v.startedAt < cutoff && v.status !== "running") RUNS.delete(k);
}

function emit(state: RunState, ev: { line?: string; final?: RunState }) {
  for (const s of state.subscribers) {
    try {
      s(ev);
    } catch {}
  }
}

async function startRun(agent: string): Promise<RunState> {
  evictOldRuns();
  const id = randomBytes(6).toString("hex");
  const state: RunState = {
    id,
    agent,
    date: new Date().toISOString().slice(0, 10),
    startedAt: Date.now(),
    status: "running",
    logs: [],
    subscribers: new Set(),
  };
  RUNS.set(id, state);

  runAgent(agent, {
    onLog: (line) => {
      state.logs.push(line);
      emit(state, { line });
    },
  })
    .then((r) => {
      state.status = "done";
      state.result = r;
      emit(state, { final: state });
    })
    .catch((e) => {
      state.status = "failed";
      state.error = e instanceof Error ? e.message : String(e);
      emit(state, { final: state });
    });

  return state;
}

// ---------- HTTP helpers ----------

// v2 frontend: the Vite-built React app at <repo>/web/dist. (v1, the hand-written
// single-file src/web/index.html, was removed.) Rebuild with `bun run build` in
// web/ to publish changes.
const WEB_DIR = join(import.meta.dir, "..", "..", "web", "dist");
const INDEX_PATH = join(WEB_DIR, "index.html");

const STATIC_FILES: Record<string, { path: string; type: string }> = {
  "/manifest.webmanifest": {
    path: join(WEB_DIR, "manifest.webmanifest"),
    type: "application/manifest+json",
  },
  "/icon.svg": { path: join(WEB_DIR, "icon.svg"), type: "image/svg+xml" },
  "/icon-maskable.svg": {
    path: join(WEB_DIR, "icon-maskable.svg"),
    type: "image/svg+xml",
  },
  "/agent-claude.svg": { path: join(WEB_DIR, "agent-claude.svg"), type: "image/svg+xml" },
  "/agent-codex.svg": { path: join(WEB_DIR, "agent-codex.svg"), type: "image/svg+xml" },
  "/agent-opencode.svg": { path: join(WEB_DIR, "agent-opencode.svg"), type: "image/svg+xml" },
  "/apple-touch-icon.png": { path: join(WEB_DIR, "icon.svg"), type: "image/svg+xml" },
};

function json(obj: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function err(status: number, message: string) {
  return json({ error: message }, { status });
}

// Attach rendered markdown for assistant/user prose; tool/thinking stay raw.
function msgWithHtml<T extends { kind: string; text: string }>(m: T) {
  if (m.kind === "text" && m.text) return { ...m, html: marked.parse(m.text) };
  return m;
}

// Compact, spoken-summary-friendly snapshot of every live session, injected into
// the voice orchestrator's spawn prompt so its FIRST reply can be a proactive
// status briefing with no tool-call round-trip. Each session is classified:
//   BLOCKED  — sitting on a permission / plan / trust selector (needs the user NOW)
//   WORKING  — mid-turn
//   IDLE     — not busy, no pending prompt
// Blocked sessions carry the prompt question + option labels so she can name what
// the user has to decide. Built BEFORE the voice session is spawned, so it never
// lists itself.
async function voiceStatusSnapshot(): Promise<string> {
  let sessions;
  try {
    sessions = await listSessions();
  } catch {
    return "(session list unavailable)";
  }
  if (!sessions.length) return "(no sessions running)";
  const now = Date.now();
  const ago = (t: number | null): string => {
    if (!t) return "";
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.round(m / 60)}h ago`;
  };
  const clip = (t: string, n: number) => {
    const c = t.replace(/\s+/g, " ").trim();
    return c.length > n ? c.slice(0, n - 1).trimEnd() + "…" : c;
  };
  const lines: string[] = [];
  for (const s of sessions) {
    // Titles are often the whole kickoff prompt — clip hard so a line reads as a
    // label, not a paragraph.
    const name = clip(s.title || s.tmuxName || s.sessionId?.slice(0, 8) || "session", 60);
    const who = s.assignedUser ? ` [${s.assignedUser}]` : "";
    let status = "IDLE";
    let detail = "";
    if (s.tmuxTarget) {
      const pane = capturePane(s.tmuxTarget);
      const tp = s.sessionId ? await resolveTranscript(s.sessionId) : null;
      const prompt = await resolveSessionPrompt(tp, pane);
      if (prompt) {
        status = "BLOCKED";
        const opts = prompt.options
          .map((o) => o.label)
          .filter(Boolean)
          .slice(0, 4)
          .join(" / ");
        detail = ` — needs an answer: "${clip(prompt.question, 100)}"${opts ? ` (${opts})` : ""}`;
      } else if (pane && isBusy(pane)) {
        status = "WORKING";
      }
    }
    // Skip "last ask" when it just restates the (clipped) title — common for the
    // agent sessions whose title IS their first prompt.
    const last = clip(s.lastUserText || "", 100);
    const redundant = last && name.replace(/…$/, "").startsWith(last.slice(0, 30));
    const lastBit = last && !redundant ? ` last ask: "${last}"` : "";
    const when = ago(s.lastActivityAt);
    lines.push(`- ${name}${who}: ${status}${detail}.${lastBit}${when ? ` (${when})` : ""}`);
  }
  return lines.join("\n");
}

// Best available interactive prompt for a session. Prefers a structured
// AskUserQuestion read from the transcript (exact text, survives the preview /
// multi-select / wrapped layouts the pane scraper can't follow), and falls back
// to the pane-scraped selector for prompts that only live in the TUI —
// permission, plan-approval (ExitPlanMode) and trust dialogs. Both shapes share
// { question, options:[{index,label,selected}] }, so the SSE `prompt` event and
// the client render either identically.
async function resolveSessionPrompt(
  tp: string | null,
  pane: string | null,
): Promise<PanePrompt | PendingPrompt | null> {
  if (tp) {
    const pending = await pendingToolPrompt(tp);
    if (pending) return pending;
  }
  return pane ? parsePrompt(pane) : null;
}

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

// ---------- server ----------

// Per-socket state for the browser terminal: which tmux session it attaches to
// and the initial geometry the client reported at connect time.
type TermSocketData = { sessionName: string; cols: number; rows: number };

// Live PTY bridges keyed by their websocket, so message/close handlers can find
// the bridge to write to / tear down.
const termBridges = new WeakMap<object, PtyBridge>();

// Parse a terminal dimension from a query param, clamped to a sane range so a
// bogus value can't allocate an absurd pty winsize.
function clampDim(raw: string | null, fallback: number): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, n));
}

export async function cmdServe() {
  const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    idleTimeout: 240,
    websocket: {
      // The browser terminal: each socket owns a PTY attached to a persistent
      // tmux shell session. Input arrives as binary frames (raw keystrokes);
      // text frames are JSON control messages (resize). Output is streamed back
      // as binary frames — the full raw VT byte stream a faithful renderer wants.
      idleTimeout: 600,
      open(ws: ServerWebSocket<TermSocketData>) {
        try {
          const { sessionName, cols, rows } = ws.data;
          const bridge = new PtyBridge(
            ["tmux", "new-session", "-A", "-s", sessionName],
            { cols, rows, cwd: homedir() },
          );
          bridge.onData((chunk) => {
            try {
              ws.send(chunk);
            } catch {}
          });
          bridge.onExit(() => {
            try {
              ws.close();
            } catch {}
          });
          termBridges.set(ws, bridge);
        } catch (e) {
          try {
            ws.send(`\r\n[lfg] failed to open terminal: ${(e as Error).message}\r\n`);
            ws.close();
          } catch {}
        }
      },
      message(ws: ServerWebSocket<TermSocketData>, message) {
        const bridge = termBridges.get(ws);
        if (!bridge) return;
        if (typeof message === "string") {
          // Control channel (resize). Anything unparseable is ignored.
          try {
            const ctrl = JSON.parse(message) as {
              t?: string;
              cols?: number;
              rows?: number;
            };
            if (ctrl.t === "resize" && ctrl.cols && ctrl.rows)
              bridge.resize(ctrl.cols, ctrl.rows);
          } catch {}
          return;
        }
        // Binary frame = raw keystrokes.
        bridge.write(message as Uint8Array);
      },
      close(ws: ServerWebSocket<TermSocketData>) {
        const bridge = termBridges.get(ws);
        termBridges.delete(ws);
        // Tears down our attach client; the tmux session itself persists so the
        // shell (and any in-flight OAuth / long command) survives a reconnect.
        bridge?.close();
      },
    },
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      // ---- browser terminal (websocket upgrade) ----
      if (path === "/api/term") {
        const sessionName = termSessionName(url.searchParams.get("session") || "main");
        const cols = clampDim(url.searchParams.get("cols"), 80);
        const rows = clampDim(url.searchParams.get("rows"), 24);
        const ok = server.upgrade<TermSocketData>(req, {
          data: { sessionName, cols, rows },
        });
        if (ok) return undefined; // upgraded — Bun takes over the socket
        return err(400, "expected a websocket upgrade");
      }

      // Detect links in the terminal for the tappable-chip UI. A long URL is
      // wrapped across rows in the rendered terminal (and often hard-wrapped by
      // the app, so tmux -J can't help). We reconstruct full URLs from the pane
      // by stitching full-width rows, and also read any OSC 8 hyperlink targets.
      if (path === "/api/term/scan" && req.method === "GET") {
        const target = termSessionName(url.searchParams.get("session") || "main");
        const plain = capturePaneScroll(target);
        if (plain == null) return json({ urls: [] });
        const urls = detectUrls({
          plain,
          escaped: capturePaneEscaped(target) ?? undefined,
          width: paneWidth(target) ?? 80,
        });
        return json({ urls });
      }

      // ---- static ----
      if (path === "/" || path === "/index.html") {
        // Runtime extension injection: LFG core ships no proprietary UI. Our
        // deployments set LFG_EXTENSIONS (comma-separated ESM URLs) — each is
        // injected as a module <script> AFTER the app bundle, so it runs once
        // window.lfg (host React + registerExtension) exists and contributes UI
        // (e.g. a private tab). Open-source forks set nothing → clean core.
        let html = await Bun.file(INDEX_PATH).text();
        const exts = (process.env.LFG_EXTENSIONS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (exts.length) {
          const tags = exts
            .map((src) => `<script type="module" src="${src.replace(/"/g, "&quot;")}"></script>`)
            .join("");
          html = html.includes("</body>")
            ? html.replace("</body>", `${tags}</body>`)
            : html + tags;
        }
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      }
      if (path === "/sw.js") {
        const src = await Bun.file(join(WEB_DIR, "sw.js")).text();
        // Version derived from index.html size + mtime — changes invalidate the SW.
        let version = "0";
        try {
          const s = statSync(INDEX_PATH);
          version = `${s.size}-${Math.floor(s.mtimeMs)}`;
        } catch {}
        return new Response(src.replace(/__VERSION__/g, version), {
          headers: {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
            "Service-Worker-Allowed": "/",
          },
        });
      }
      const staticFile = STATIC_FILES[path];
      if (staticFile) {
        return new Response(Bun.file(staticFile.path), {
          headers: {
            "Content-Type": staticFile.type,
            "Cache-Control": "public, max-age=300",
          },
        });
      }

      // Hashed, content-addressed Vite bundles from the v2 build. Filenames
      // change on every build, so they're safe to cache immutably.
      if (path.startsWith("/assets/") && !path.includes("..")) {
        const f = Bun.file(join(WEB_DIR, "assets", path.slice("/assets/".length)));
        if (await f.exists()) {
          const type = path.endsWith(".css")
            ? "text/css; charset=utf-8"
            : path.endsWith(".js")
              ? "application/javascript; charset=utf-8"
              : "application/octet-stream";
          return new Response(f, {
            headers: {
              "Content-Type": type,
              "Cache-Control": "public, max-age=31536000, immutable",
            },
          });
        }
      }

      // ---- voice TTS proxy: forward to the self-hosted SuperTonic service on
      // the control-plane box. The token + upstream URL live server-side (.env)
      // so the browser never sees them; the client just plays the returned WAV.
      if (path === "/api/voice/tts" && req.method === "POST") {
        const up = process.env.TTS_UPSTREAM;
        const tok = process.env.TTS_TOKEN;
        if (!up || !tok) return err(503, "tts not configured");
        const body = (await req.json().catch(() => null)) as {
          text?: string;
          voice?: string;
        } | null;
        const text = body?.text?.trim();
        if (!text) return err(400, "expected { text }");
        try {
          const r = await fetch(`${up}/tts`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${tok}`,
            },
            body: JSON.stringify({ text, voice: body?.voice || "F1" }),
            signal: AbortSignal.timeout(30000),
          });
          if (!r.ok) return err(502, `tts upstream ${r.status}`);
          return new Response(r.body, {
            headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
          });
        } catch {
          return err(502, "tts upstream unreachable");
        }
      }

      // ---- voice STT proxy: forward uploaded WAV audio to the self-hosted
      // faster-whisper service; returns { text }. Keeps the device thin (no
      // local Whisper model).
      if (path === "/api/voice/stt" && req.method === "POST") {
        const up = process.env.TTS_UPSTREAM;
        const tok = process.env.TTS_TOKEN;
        if (!up || !tok) return err(503, "stt not configured");
        const audio = await req.arrayBuffer();
        if (!audio.byteLength) return err(400, "empty audio");
        try {
          const r = await fetch(`${up}/stt`, {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              Authorization: `Bearer ${tok}`,
            },
            body: audio,
            signal: AbortSignal.timeout(30000),
          });
          if (!r.ok) return err(502, `stt upstream ${r.status}`);
          return new Response(r.body, { headers: { "Content-Type": "application/json" } });
        } catch {
          return err(502, "stt upstream unreachable");
        }
      }

      // ---- voice speaker-ID proxy: forward uploaded WAV to the upstream
      // /identify (resemblyzer) and return { embedding }. The client compares
      // the embedding (cosine) against its enrolled refs in localStorage to gate
      // barge-ins to known speakers — keeps refs on-device, box stays stateless.
      if (path === "/api/voice/identify" && req.method === "POST") {
        const up = process.env.TTS_UPSTREAM;
        const tok = process.env.TTS_TOKEN;
        if (!up || !tok) return err(503, "identify not configured");
        const audio = await req.arrayBuffer();
        if (!audio.byteLength) return err(400, "empty audio");
        try {
          const r = await fetch(`${up}/identify`, {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              Authorization: `Bearer ${tok}`,
            },
            body: audio,
            signal: AbortSignal.timeout(30000),
          });
          if (!r.ok) return err(502, `identify upstream ${r.status}`);
          return new Response(r.body, { headers: { "Content-Type": "application/json" } });
        } catch {
          return err(502, "identify upstream unreachable");
        }
      }

      // ---- extension backend proxy (optional, config-driven) ----
      // A same-origin reverse proxy for runtime UI extensions that must call a
      // private backend WITHOUT shipping its token to the browser. Fully driven
      // by env (no defaults, no hardcoded hosts) — builds that set nothing get
      // no proxy:
      //   LFG_PROXY_PREFIX    path prefix to match (e.g. "/_ext")
      //   LFG_PROXY_UPSTREAM  upstream origin to forward to
      //   LFG_PROXY_TOKEN     bearer token injected server-side
      //   LFG_PROXY_ALLOW     comma-sep allowed upstream path prefixes (empty = all)
      const proxyPrefix = process.env.LFG_PROXY_PREFIX;
      if (proxyPrefix && path.startsWith(proxyPrefix + "/")) {
        const upstream = (process.env.LFG_PROXY_UPSTREAM || "").replace(/\/$/, "");
        const tok = process.env.LFG_PROXY_TOKEN || "";
        if (!upstream || !tok) return err(503, "proxy not configured");
        const upstreamPath = path.slice(proxyPrefix.length);
        const allow = (process.env.LFG_PROXY_ALLOW || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (allow.length && !allow.some((p) => upstreamPath.startsWith(p))) {
          return err(403, "forbidden path");
        }
        try {
          const r = await fetch(`${upstream}${upstreamPath}${url.search}`, {
            method: req.method,
            headers: {
              "Content-Type": req.headers.get("content-type") || "application/json",
              Authorization: `Bearer ${tok}`,
            },
            body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
            signal: AbortSignal.timeout(30000),
          });
          return new Response(r.body, {
            status: r.status,
            headers: {
              "Content-Type": r.headers.get("content-type") || "application/json",
              "Cache-Control": "no-store",
            },
          });
        } catch {
          return err(502, "proxy upstream unreachable");
        }
      }

      // ---- legacy flat reports (for back-compat with old UI bookmarks) ----
      if (path === "/api/reports") return json({ reports: await listLegacyReports() });
      {
        const m = path.match(/^\/api\/reports\/(\d{4}-\d{2}-\d{2})$/);
        if (m) {
          const raw = await readLegacyReport(m[1]);
          if (raw === null) return err(404, "not found");
          return json({ date: m[1], raw, html: renderReportHtml(raw) });
        }
      }

      // ---- agents ----
      if (path === "/api/agents") {
        const agents = await listAgents();
        const out = await Promise.all(
          agents.map(async (a) => {
            const reps = await listAgentReports(a.name);
            return {
              name: a.name,
              title: a.frontmatter.title ?? a.name,
              enabled: a.frontmatter.enabled !== false,
              inputCount: a.frontmatter.inputs?.length ?? 0,
              lastReport: reps[0]
                ? { date: reps[0].date, bytes: reps[0].bytes, mtime: reps[0].mtime }
                : null,
            };
          }),
        );
        return json({ agents: out });
      }

      {
        const m = path.match(/^\/api\/agents\/([a-z0-9_-]+)$/);
        if (m) {
          const name = m[1];
          if (req.method === "GET") {
            try {
              const a = await loadAgent(name);
              return json({
                name: a.name,
                filePath: a.filePath,
                frontmatter: a.frontmatter,
                body: a.body,
                raw: a.raw,
              });
            } catch (e) {
              return err(404, e instanceof Error ? e.message : String(e));
            }
          }
          if (req.method === "PUT") {
            const body = (await req.json().catch(() => null)) as { content?: unknown } | null;
            if (!body || typeof body.content !== "string")
              return err(400, "expected { content: string }");
            try {
              const a = await writeAgent(name, body.content);
              return json({ ok: true, name: a.name });
            } catch (e) {
              return err(400, e instanceof Error ? e.message : String(e));
            }
          }
          return err(405, "method not allowed");
        }
      }

      {
        const m = path.match(/^\/api\/agents\/([a-z0-9_-]+)\/reports$/);
        if (m) {
          const reps = await listAgentReports(m[1]);
          return json({ agent: m[1], reports: reps });
        }
      }

      {
        const m = path.match(
          /^\/api\/agents\/([a-z0-9_-]+)\/reports\/(\d{4}-\d{2}-\d{2})$/,
        );
        if (m) {
          const r = await readAgentReport(m[1], m[2]);
          if (!r) return err(404, "not found");
          return json(r);
        }
      }

      // ---- auto agents (streamlined: prompt + schedule → findings) ----
      if (path === "/api/auto/agents") {
        if (req.method === "GET") {
          const agents = await listAutoAgents();
          return json({
            agents: agents.map((a) => ({ ...a, running: isRunning(a.id) })),
            tz: process.env.LFG_SCHED_TZ ?? "Asia/Hong_Kong",
          });
        }
        if (req.method === "POST") {
          const b = (await req.json().catch(() => null)) as {
            id?: string;
            name?: string;
            prompt?: string;
            schedule?: string;
            enabled?: boolean;
            cwd?: string;
            tools?: string[];
          } | null;
          if (!b?.name || !b?.prompt || !b?.schedule) {
            return err(400, "name, prompt and schedule are required");
          }
          const agent = await saveAutoAgent({
            id: b.id,
            name: b.name,
            prompt: b.prompt,
            schedule: b.schedule,
            enabled: b.enabled !== false,
            cwd: b.cwd,
            tools: Array.isArray(b.tools) ? b.tools : undefined,
          });
          return json({ agent });
        }
      }
      {
        const m = path.match(/^\/api\/auto\/agents\/([a-z0-9_-]+)$/);
        if (m && req.method === "DELETE") {
          await deleteAutoAgent(m[1]);
          return json({ ok: true });
        }
      }
      {
        const m = path.match(/^\/api\/auto\/agents\/([a-z0-9_-]+)\/run$/);
        if (m && req.method === "POST") {
          const agent = await getAutoAgent(m[1]);
          if (!agent) return err(404, "unknown auto agent");
          // fire-and-forget; the finding surfaces via the findings poll
          void runAutoAgent(agent, (l) => console.log(l)).catch((e) =>
            console.error("[auto] manual run failed:", e),
          );
          return json({ ok: true });
        }
      }
      if (path === "/api/auto/findings" && req.method === "GET") {
        const status = url.searchParams.get("status") || undefined;
        return json({ findings: await listFindings(status) });
      }
      {
        const m = path.match(/^\/api\/auto\/findings\/([0-9a-f]+)$/);
        if (m && req.method === "POST") {
          const b = (await req.json().catch(() => null)) as {
            status?: "open" | "dismissed" | "session" | "read";
            sessionId?: string;
          } | null;
          const patch: { status?: typeof b.status; sessionId?: string } = {};
          if (b?.status) patch.status = b.status;
          if (b?.sessionId) patch.sessionId = b.sessionId;
          const f = await updateFinding(m[1], patch);
          if (!f) return err(404, "unknown finding");
          return json({ finding: f });
        }
      }

      // ---- runs ----
      {
        const m = path.match(/^\/api\/agents\/([a-z0-9_-]+)\/run$/);
        if (m && req.method === "POST") {
          try {
            await loadAgent(m[1]);
          } catch (e) {
            return err(404, e instanceof Error ? e.message : String(e));
          }
          const state = await startRun(m[1]);
          return json({ runId: state.id, agent: state.agent, date: state.date });
        }
      }

      {
        const m = path.match(/^\/api\/agents\/([a-z0-9_-]+)\/runs\/([0-9a-f]+)$/);
        if (m) {
          const state = RUNS.get(m[2]);
          if (!state) return err(404, "run not found");
          if (req.headers.get("accept")?.includes("text/event-stream")) {
            const stream = new ReadableStream({
              start(controller) {
                const send = (ev: { line?: string; final?: RunState }) => {
                  if (ev.line) {
                    controller.enqueue(
                      `event: log\ndata: ${JSON.stringify(ev.line)}\n\n`,
                    );
                  }
                  if (ev.final) {
                    controller.enqueue(
                      `event: ${ev.final.status}\ndata: ${JSON.stringify({
                        status: ev.final.status,
                        result: ev.final.result,
                        error: ev.final.error,
                      })}\n\n`,
                    );
                    controller.close();
                  }
                };
                for (const l of state.logs) send({ line: l });
                if (state.status !== "running") {
                  send({ final: state });
                  return;
                }
                state.subscribers.add(send);
              },
              cancel() {
                // sub gets evicted with the run eventually
              },
            });
            return new Response(stream, { headers: sseHeaders() });
          }
          // plain JSON status
          return json({
            id: state.id,
            agent: state.agent,
            status: state.status,
            logs: state.logs,
            result: state.result,
            error: state.error,
          });
        }
      }

      // ---- actions ----
      {
        const m = path.match(
          /^\/api\/actions\/([a-z0-9_-]+)\/(\d{4}-\d{2}-\d{2})$/,
        );
        if (m && req.method === "GET") {
          const rows = await readActionsSidecar(m[1], m[2]);
          return json({ agent: m[1], date: m[2], actions: rows });
        }
      }

      if (path === "/api/actions/execute" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          agent?: string;
          date?: string;
          id?: string;
          force?: boolean;
        } | null;
        if (!body?.agent || !body.date || !body.id)
          return err(400, "expected { agent, date, id }");
        try {
          const r = await executeAction(body.agent, body.date, body.id, {
            force: !!body.force,
          });
          return json(r);
        } catch (e) {
          return err(400, e instanceof Error ? e.message : String(e));
        }
      }

      // Run several selected actions inside ONE agent session (one worktree),
      // instead of one dispatched agent per action.
      if (path === "/api/actions/execute-combined" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          agent?: string;
          date?: string;
          ids?: string[];
          force?: boolean;
        } | null;
        if (!body?.agent || !body.date || !Array.isArray(body.ids) || body.ids.length === 0)
          return err(400, "expected { agent, date, ids: string[] }");
        try {
          const r = await executeActionsCombined(body.agent, body.date, body.ids, {
            force: !!body.force,
          });
          return json(r);
        } catch (e) {
          return err(400, e instanceof Error ? e.message : String(e));
        }
      }

      // ---- multi-user (session tagging) ----
      if (path === "/api/users") {
        return json({ users: userRoster() });
      }

      // ---- running claude sessions ----
      if (path === "/api/repos") {
        return json({ repos: await listRepos() });
      }

      if (path === "/api/sessions") {
        return json({ sessions: await listSessions() });
      }

      // Claude subscription usage (5-hour + 7-day windows) via the OAuth usage
      // endpoint, authed with the local Claude Code credentials. Cached for a
      // minute so reopening the new-session dialog doesn't hammer Anthropic.
      if (path === "/api/claude/usage") {
        if (usageCache && Date.now() - usageCache.at < 60_000)
          return json(usageCache.data);
        try {
          const creds = await Bun.file(
            join(process.env.HOME || "", ".claude", ".credentials.json"),
          ).json();
          const token = creds?.claudeAiOauth?.accessToken;
          if (!token) return err(503, "no Claude credentials on this box");
          const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
            headers: {
              Authorization: `Bearer ${token}`,
              "anthropic-beta": "oauth-2025-04-20",
            },
          });
          if (!r.ok) return err(502, `usage endpoint returned ${r.status}`);
          const u = (await r.json()) as {
            five_hour?: { utilization?: number; resets_at?: string | null };
            seven_day?: { utilization?: number; resets_at?: string | null };
          };
          const data = {
            ok: true,
            fiveHour: { pct: u.five_hour?.utilization ?? null, resetsAt: u.five_hour?.resets_at ?? null },
            sevenDay: { pct: u.seven_day?.utilization ?? null, resetsAt: u.seven_day?.resets_at ?? null },
          };
          usageCache = { at: Date.now(), data };
          return json(data);
        } catch (e) {
          return err(502, e instanceof Error ? e.message : String(e));
        }
      }

      // Tag a session to a user (or clear with user:null). Keyed server-side by
      // the session's tmux name so the tag survives /clear sessionId rotation.
      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/user$/);
        if (m && req.method === "POST") {
          const body = (await req.json().catch(() => null)) as { user?: string | null } | null;
          const sess = (await listSessions()).find((s) => s.sessionId === m[1]);
          if (!sess) return err(404, "session not found");
          if (!sess.tmuxName) return err(409, "session is not in a tmux pane — cannot tag");
          if (!assignUser(sess.tmuxName, body?.user ?? null))
            return err(400, "unknown user");
          return json({ ok: true });
        }
      }

      // Start a new lfg-managed session: spin up a detached tmux session
      // running `claude` that we own end-to-end. Because we pick the tmux name
      // we know the exact pane, so we can resolve the authoritative sessionId
      // (no pgrep/heuristic guessing) and tear it down cleanly later.
      // Closed/rebooted-away sessions that can be brought back with `claude
      // --resume`. After the box reboots, the live list (pgrep-based) is empty
      // but every transcript survives on disk — this surfaces those so the UI
      // can offer to resume one. Excludes anything currently live.
      if (path === "/api/sessions/resumable" && req.method === "GET") {
        const liveIds = new Set(
          (await listSessions()).map((s) => s.sessionId).filter((x): x is string => !!x),
        );
        const limit = Number(url.searchParams.get("limit")) || 30;
        const sessions = await listResumable({ limit, excludeIds: liveIds });
        return json({ sessions });
      }

      // Resume a closed claude session: relaunch `claude --resume <id>` in the
      // transcript's original cwd as a fresh managed tmux session, preserving the
      // full conversation. Claude continues into a NEW sessionId, which we resolve
      // from the pidfile (like /new) and hand back so the client can deep-link in.
      if (path === "/api/sessions/resume" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          sessionId?: string;
          model?: string;
          user?: string;
          prompt?: string;
        } | null;
        const sessionId = body?.sessionId?.trim();
        if (!sessionId) return err(400, "sessionId required");
        const model = body?.model?.trim() || undefined;
        if (model && !CLAUDE_MODELS.includes(model))
          return err(400, `unknown model "${model}" (expected one of ${CLAUDE_MODELS.join(", ")})`);
        // Already running? Don't double-spawn — point the client at the live one.
        const live = (await listSessions()).find((s) => s.sessionId === sessionId);
        if (live)
          return json({ ok: true, tmuxName: live.tmuxName, cwd: live.cwd, sessionId, alreadyLive: true, agent: "claude" });
        const transcript = await resolveTranscript(sessionId);
        if (!transcript) return err(404, "no transcript found for that session");
        // claude-only: resume drives the claude CLI, and codex rollouts (under
        // ~/.codex) carry no claude `cwd` line. Reject those with a clear message.
        if (!transcript.includes("/.claude/projects/"))
          return err(400, "only claude sessions can be resumed");
        const cwd = (await cwdForTranscript(transcript)) ?? SELF_REPO;
        const tmuxName = `lfg-${randomBytes(3).toString("hex")}`;
        const r = spawnManagedSession({ name: tmuxName, cwd, model, resume: sessionId, prompt: body?.prompt });
        if (!r.ok) return err(502, r.error || "failed to resume session");
        addManaged({ tmuxName, cwd, createdAt: Date.now(), agent: "claude" });
        if (body?.user) assignUser(tmuxName, body.user);
        // Claude resumes into a fresh sessionId/transcript — wait for the pidfile.
        let newId: string | null = null;
        for (let i = 0; i < 12 && !newId; i++) {
          await new Promise((res) => setTimeout(res, 500));
          const pid = panePidForSession(tmuxName);
          if (pid) newId = sessionIdForPid(pid);
        }
        return json({ ok: true, tmuxName, cwd, sessionId: newId, resumedFrom: sessionId, agent: "claude" });
      }

      if (path === "/api/sessions/new" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          cwd?: string;
          prompt?: string;
          user?: string;
          voice?: boolean;
          model?: string;
          agent?: "claude" | "codex" | "aisdk" | "codex-aisdk" | "opencode";
        } | null;
        // Default flip (Task B): with no agent specified, the default Claude path
        // now goes through the AI SDK ("aisdk") rather than the Claude CLI. Every
        // explicit value still works, INCLUDING explicit "claude" for the CLI.
        const agent =
          body?.agent === "codex"
            ? "codex"
            : body?.agent === "codex-aisdk"
              ? "codex-aisdk"
              : body?.agent === "opencode"
                ? "opencode"
                : body?.agent === "claude"
                  ? "claude"
                  : "aisdk";
        // Allowlist Claude models — they land on a shell argv. Unknown value =
        // hard 400, never a silent fallback to some other model. Codex model
        // names are provider/catalog driven, so validate shape instead.
        const model = body?.model?.trim() || undefined;
        if (agent === "claude" && model && !CLAUDE_MODELS.includes(model))
          return err(400, `unknown model "${model}" (expected one of ${CLAUDE_MODELS.join(", ")})`);
        if (agent === "codex" && model && !/^[A-Za-z0-9_.:-]{1,80}$/.test(model))
          return err(400, "invalid codex model name");
        if (agent === "aisdk" && model && !AISDK_MODELS.includes(model))
          return err(400, `unknown model "${model}" (expected one of ${AISDK_MODELS.join(", ")})`);
        // codex-aisdk drives codex through the AI SDK, so its model is a codex
        // slug (gpt-5.x-codex …) — provider/catalog driven like the tmux codex.
        // Validate by shape, same as the codex branch.
        if (agent === "codex-aisdk" && model && !/^[A-Za-z0-9_.:-]{1,80}$/.test(model))
          return err(400, "invalid codex model name");
        // opencode models are "provider/model" (e.g. anthropic/claude-sonnet-4-6),
        // so the validation shape additionally allows a slash. Catalog-driven, so
        // validate by shape rather than an allowlist.
        if (agent === "opencode" && model && !/^[A-Za-z0-9_.:\/-]{1,80}$/.test(model))
          return err(400, "invalid opencode model name");
        // Always spawn in a trusted folder — claude shows a blocking "trust this
        // folder?" dialog for any untrusted cwd, which hangs session startup. The
        // lfg-sessions skill is installed user-level (~/.claude/skills) so the
        // voice/orchestrator agent gets it regardless of cwd.
        const requestedCwd = body?.cwd?.trim() || SELF_REPO;
        const repo = (await listRepos()).find((r) => r.cwd === requestedCwd);
        if (!repo) return err(400, "unknown repo");
        const cwd = repo.cwd;
        const tmuxName = `lfg-${randomBytes(3).toString("hex")}`;
        // For the voice orchestrator, append a live snapshot of every OTHER
        // session (built before this one spawns, so it's not in the list) so its
        // first spoken reply can be a proactive blockers-first status briefing.
        let prompt = body?.prompt;
        if (body?.voice) {
          const snap = await voiceStatusSnapshot();
          prompt = `${prompt ?? ""}\n\n=== SESSION SNAPSHOT (live, at session start) ===\n${snap}\n=== END SNAPSHOT ===`;
        }
        // aisdk sessions own their sessionId up front (deterministic transcript
        // path), so we generate it here and hand it to the harness.
        const aisdkSessionId = agent === "aisdk" ? crypto.randomUUID() : null;
        // codex-aisdk can't pick its transcript id (codex mints the threadId
        // after turn 1), so we mint a CONTROL-PLANE KEY instead — it names the
        // registry/command files and is what serve routes sends through until
        // the threadId is known. (See the codex-aisdk harness header.)
        const codexAisdkKey = agent === "codex-aisdk" ? crypto.randomUUID() : null;
        // opencode mints a control-plane KEY that is ALSO the transcript id: the
        // harness self-persists the Claude-shaped transcript named by this key, so
        // the returned sessionId == key (no after-turn-1 id to wait for, unlike
        // codex-aisdk). See the opencode harness header.
        const opencodeKey = agent === "opencode" ? crypto.randomUUID() : null;
        const r =
          agent === "codex"
            ? spawnManagedCodexSession({ name: tmuxName, cwd, prompt, model })
            : agent === "aisdk"
              ? spawnManagedAisdkSession({
                  name: tmuxName,
                  cwd,
                  prompt,
                  model: model ?? "opus",
                  sessionId: aisdkSessionId!,
                })
              : agent === "codex-aisdk"
                ? spawnManagedCodexAisdkSession({
                    name: tmuxName,
                    cwd,
                    prompt,
                    model: model ?? "gpt-5.5",
                    key: codexAisdkKey!,
                  })
                : agent === "opencode"
                  ? spawnManagedOpencodeAisdkSession({
                      name: tmuxName,
                      cwd,
                      prompt,
                      model: model ?? "anthropic/claude-sonnet-4-6",
                      key: opencodeKey!,
                    })
                  : spawnManagedSession({ name: tmuxName, cwd, prompt, model });
        if (!r.ok) return err(502, r.error || "failed to start session");
        addManaged({ tmuxName, cwd, createdAt: Date.now(), agent });
        // Tag the new session to whoever created it so it lands in their filter
        // immediately (best-effort: assignUser ignores an unknown email).
        if (body?.user) assignUser(tmuxName, body.user);
        // Resolve the sessionId so the client can deep-link straight into the
        // new session. Claude writes a pidfile; Codex writes its rollout after
        // startup/first prompt, and may first show an update selector that we
        // dismiss automatically. aisdk's id is known immediately — just wait for
        // the harness to register so the session is listable.
        let sessionId: string | null = aisdkSessionId;
        for (let i = 0; i < 12 && !sessionId; i++) {
          await new Promise((res) => setTimeout(res, 500));
          if (agent === "codex") {
            dismissCodexUpdatePrompt(`${tmuxName}:0.0`);
            sessionId =
              (await listSessions()).find((s) => s.tmuxName === tmuxName)?.sessionId ??
              null;
          } else {
            const pid = panePidForSession(tmuxName);
            if (pid) sessionId = sessionIdForPid(pid);
          }
        }
        if (agent === "aisdk") {
          for (let i = 0; i < 20 && !readAisdkEntry(aisdkSessionId!); i++)
            await new Promise((res) => setTimeout(res, 250));
        }
        // opencode: the harness writes the transcript at the key, so the
        // sessionId IS the key — just wait for the harness to register so the
        // session is listable (no after-turn-1 threadId to wait for).
        if (agent === "opencode") {
          for (let i = 0; i < 20 && !readAisdkEntry(opencodeKey!); i++)
            await new Promise((res) => setTimeout(res, 250));
          sessionId = opencodeKey;
        }
        // codex-aisdk: wait for the harness to register (so the session is
        // listable), then prefer the codex threadId once turn 1 reports it (it
        // deep-links to the rollout transcript). The threadId only lands after
        // the first turn completes, so don't block on it — fall back to the
        // control-plane key, a stable handle serve maps back internally. Total
        // added wait stays bounded (~5s registration + ~3s threadId).
        if (agent === "codex-aisdk") {
          for (let i = 0; i < 20 && !readAisdkEntry(codexAisdkKey!); i++)
            await new Promise((res) => setTimeout(res, 250));
          sessionId = codexAisdkKey;
          for (let i = 0; i < 12; i++) {
            const tid = readAisdkEntry(codexAisdkKey!)?.threadId;
            if (tid) {
              sessionId = tid;
              break;
            }
            await new Promise((res) => setTimeout(res, 250));
          }
        }
        return json({ ok: true, tmuxName, cwd, sessionId, agent });
      }

      {
        // Image attach: the browser POSTs raw image bytes; we persist them and
        // hand back an absolute path. The client then includes that path in the
        // message text — Claude Code reads local image paths as image input.
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/upload$/);
        if (m && req.method === "POST") {
          const ct = (req.headers.get("content-type") || "").toLowerCase();
          const ext = ct.includes("png")
            ? "png"
            : ct.includes("webp")
              ? "webp"
              : ct.includes("gif")
                ? "gif"
                : "jpg";
          const buf = new Uint8Array(await req.arrayBuffer());
          if (!buf.length) return err(400, "empty upload");
          const dir = join(tmpdir(), "lfg-uploads");
          mkdirSync(dir, { recursive: true });
          const name = `${m[1]}-${Date.now()}-${randomBytes(3).toString("hex")}.${ext}`;
          const fp = join(dir, name);
          await Bun.write(fp, buf);
          return json({ ok: true, path: fp });
        }
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/send$/);
        if (m && req.method === "POST") {
          const body = (await req.json().catch(() => null)) as {
            text?: string;
          } | null;
          const text = body?.text?.trim();
          if (!text) return err(400, "expected { text }");
          const sess = (await listSessions()).find((s) => s.sessionId === m[1]);
          if (!sess) return err(404, "session not found");
          // aisdk / codex-aisdk sessions have no pane — push the turn through the
          // harness's command file instead of the tmux send-keys queue. The new
          // user turn surfaces in the transcript (and thus the live view) once
          // the harness runs it. For codex-aisdk the live-view id is the codex
          // threadId, not the control-plane key the command file is named by, so
          // map it back via the registry.
          if (
            sess.agent === "aisdk" ||
            sess.agent === "codex-aisdk" ||
            sess.agent === "opencode"
          ) {
            const key = findAisdkEntryByAnyId(m[1])?.sessionId ?? m[1];
            appendAisdkCmd(key, { type: "send", text });
            return json({ ok: true, msg: { id: randomBytes(8).toString("hex"), text, status: "delivered" } });
          }
          if (!sess.tmuxTarget)
            return err(409, "session is not in a tmux pane — cannot send");
          // Enqueue and return immediately; the queue confirms delivery in the
          // background and the client tracks status via the `queue` SSE event.
          const msg = enqueueMessage(m[1], text);
          return json({ ok: true, msg });
        }
      }

      // Change the model of a running session mid-flight. Claude Code's own
      // `/model <alias>` slash command switches the active model for the rest of
      // the session and takes effect on the next turn — so we just inject it
      // through the confirmed-delivery queue (which treats a slash command as
      // delivered the instant it leaves the composer). If Claude raises a
      // "re-read history?" confirmation, it surfaces in the normal prompt panel
      // for the user to confirm. (Inline /model also nudges the global default,
      // but that's inert here: lfg always launches new sessions with an
      // explicit --model.)
      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/model$/);
        if (m && req.method === "POST") {
          const body = (await req.json().catch(() => null)) as {
            model?: string;
          } | null;
          const model = body?.model?.trim();
          if (!model) return err(400, "expected { model }");
          const sess = (await listSessions()).find((s) => s.sessionId === m[1]);
          if (!sess) return err(404, "session not found");
          if (sess.agent !== "claude")
            return err(409, "mid-session model change is only supported for Claude sessions");
          if (!CLAUDE_MODELS.includes(model))
            return err(400, `unknown model "${model}" (expected one of ${CLAUDE_MODELS.join(", ")})`);
          if (!sess.tmuxTarget)
            return err(409, "session is not in a tmux pane — cannot change model");
          // If the session is FROZEN on an unavailable model, an injected
          // `/model` no-ops — Claude Code rejects the turn before handling the
          // slash command ("Kept model as <dead model>"). Relaunch the pane on
          // the new model instead (resumes the transcript, so the build
          // continues). For a healthy session the in-place `/model` is gentler
          // (no process restart), so keep that path for the normal case.
          if (sess.statusReason === "model_unavailable") {
            if (!sess.sessionId || !sess.cwd)
              return err(409, "cannot relaunch: session id or cwd unknown");
            const r = relaunchSessionWithModel({
              tmuxTarget: sess.tmuxTarget,
              cwd: sess.cwd,
              sessionId: sess.sessionId,
              model,
            });
            if (!r.ok) return err(500, r.error || "relaunch failed");
            return json({ ok: true, relaunched: true, model });
          }
          const msg = enqueueMessage(m[1], `/model ${model}`);
          return json({ ok: true, msg });
        }
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/queue$/);
        if (m && req.method === "GET") {
          return json({ id: m[1], queue: listQueue(m[1]) });
        }
        if (m && req.method === "DELETE") {
          return json({ ok: true, cleared: clearResolved(m[1]) });
        }
      }

      // Non-streaming transcript read — lets an orchestrator (e.g. the voice
      // agent via the lfg-sessions skill) inspect what another session is
      // doing without holding an SSE connection.
      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/messages$/);
        if (m && req.method === "GET") {
          const tp = await resolveTranscript(m[1]);
          if (!tp) return err(404, "session transcript not found");
          if (url.searchParams.get("page") === "backward") {
            const rawLimit = parseInt(url.searchParams.get("limit") ?? "220", 10);
            const rawBefore = url.searchParams.get("before");
            const before =
              rawBefore == null ? null : Math.max(0, parseInt(rawBefore, 10) || 0);
            const page = await messagePage(tp, {
              before,
              limit: Number.isFinite(rawLimit) ? rawLimit : 220,
            });
            return json({
              id: m[1],
              total: page.total,
              nextBefore: page.nextBefore,
              messages: page.messages.map(msgWithHtml),
            });
          }
          const full = url.searchParams.get("full") === "1";
          const rawLimit = parseInt(url.searchParams.get("limit") ?? (full ? "0" : "30"), 10);
          const lim = full
            ? Math.max(0, Math.min(20000, Number.isFinite(rawLimit) ? rawLimit : 0))
            : Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 30));
          return json({
            id: m[1],
            messages: (await recentMessages(tp, lim, { maxBytes: full ? null : undefined })).map(msgWithHtml),
          });
        }
      }

      {
        const m = path.match(
          /^\/api\/sessions\/([0-9a-fA-F-]{36})\/queue\/([0-9a-f]+)\/retry$/,
        );
        if (m && req.method === "POST") {
          const msg = retryMessage(m[1], m[2]);
          if (!msg) return err(404, "queued message not found");
          return json({ ok: true, msg });
        }
      }

      // Dispatch a coding agent to debug why a send failed. Only valid for a
      // failed message — it spawns an agent into the lfg repo with the
      // message text, the delivery error, and a live capture of the stuck pane.
      {
        const m = path.match(
          /^\/api\/sessions\/([0-9a-fA-F-]{36})\/queue\/([0-9a-f]+)\/debug$/,
        );
        if (m && req.method === "POST") {
          const msg = getMessage(m[1], m[2]);
          if (!msg) return err(404, "queued message not found");
          if (msg.status !== "failed")
            return err(409, "only a failed message can be debugged");
          const sess = (await listSessions()).find((s) => s.sessionId === m[1]);
          const result = await dispatchSendFixAgent({
            failSessionId: m[1],
            failTarget: sess?.tmuxTarget ?? null,
            failTitle: sess?.title,
            msgId: msg.id,
            msgText: msg.text,
            msgError: msg.error,
            msgAttempts: msg.attempts,
          });
          if (!result.ok) return err(502, result.summary);
          return json({ ok: true, ...(result.data as object) });
        }
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/title$/);
        if (m && req.method === "PUT") {
          const body = (await req.json().catch(() => null)) as {
            title?: string;
          } | null;
          await setSessionTitle(m[1], body?.title ?? "");
          return json({ ok: true });
        }
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/answer$/);
        if (m && req.method === "POST") {
          const body = (await req.json().catch(() => null)) as {
            index?: number;
          } | null;
          if (typeof body?.index !== "number")
            return err(400, "missing option index");
          const sess = (await listSessions()).find((s) => s.sessionId === m[1]);
          if (!sess) return err(404, "session not found");
          if (!sess.tmuxTarget)
            return err(409, "session is not in a tmux pane — cannot answer");
          const r = await answerPrompt(sess.tmuxTarget, body.index);
          if (!r.ok) return err(502, r.error || "answer failed");
          return json({ ok: true });
        }
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/dismiss$/);
        if (m && req.method === "POST") {
          const sess = (await listSessions()).find((s) => s.sessionId === m[1]);
          if (!sess) return err(404, "session not found");
          if (!sess.tmuxTarget)
            return err(409, "session is not in a tmux pane — cannot dismiss");
          // Skip the question without answering: Escape cancels the selector.
          const r = await dismissPrompt(sess.tmuxTarget);
          if (!r.ok) return err(502, r.error || "dismiss failed");
          return json({ ok: true });
        }
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/interrupt$/);
        if (m && req.method === "POST") {
          const sess = (await listSessions()).find((s) => s.sessionId === m[1]);
          if (!sess) return err(404, "session not found");
          if (
            sess.agent === "aisdk" ||
            sess.agent === "codex-aisdk" ||
            sess.agent === "opencode"
          ) {
            // Abort the current turn via the harness (AbortController on its
            // side). Map a codex-aisdk threadId back to the control-plane key.
            const key = findAisdkEntryByAnyId(m[1])?.sessionId ?? m[1];
            appendAisdkCmd(key, { type: "interrupt" });
            return json({ ok: true });
          }
          if (!sess.tmuxTarget)
            return err(409, "session is not in a tmux pane — cannot interrupt");
          // A single Escape stops the current turn. This doubles as "steer":
          // any message already sitting in Claude's own queue gets processed as
          // the next turn once the running one is interrupted. We deliberately
          // don't drop pending sends — that would discard the message the user
          // is steering with.
          if (!tmuxInterrupt(sess.tmuxTarget)) return err(502, "interrupt failed");
          return json({ ok: true });
        }
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/close$/);
        if (m && req.method === "POST") {
          const sess = (await listSessions()).find((s) => s.sessionId === m[1]);
          if (!sess) return err(404, "session not found");
          if (
            sess.agent === "aisdk" ||
            sess.agent === "codex-aisdk" ||
            sess.agent === "opencode"
          ) {
            // Ask the harness to shut down, then tear down its supervisor pane and
            // control-plane files. markClosed tombstones the harness pid so the
            // session drops out of the list immediately. For codex-aisdk the
            // live-view id is the threadId — map it back to the key the command
            // file and registry entry are named by.
            const key = findAisdkEntryByAnyId(m[1])?.sessionId ?? m[1];
            appendAisdkCmd(key, { type: "close" });
            if (sess.tmuxName) tmuxKillSession(sess.tmuxName);
            markClosed(sess.pid);
            removeAisdkEntry(key);
            if (sess.tmuxName) {
              removeManaged(sess.tmuxName);
              assignUser(sess.tmuxName, null);
            }
            clearResolved(m[1]);
            return json({ ok: true });
          }
          if (!sess.tmuxTarget)
            return err(409, "session is not in a tmux pane — cannot close");
          // A session lfg started owns its whole tmux session (one managed
          // claude, no sibling panes) — kill the session and deregister it.
          // Attached sessions might share a tmux session with the user's other
          // panes, so only kill the one pane.
          const ok =
            sess.managed && sess.tmuxName
              ? tmuxKillSession(sess.tmuxName)
              : tmuxKillPane(sess.tmuxTarget);
          if (!ok) return err(502, "close failed");
          // Tombstone the pid so the session drops out of listSessions() at once
          // — the process lingers briefly after the SIGHUP and would otherwise
          // flicker back for a poll or two before pgrep stops seeing it.
          markClosed(sess.pid);
          if (sess.managed && sess.tmuxName) {
            removeManaged(sess.tmuxName);
            assignUser(sess.tmuxName, null); // a managed name is unique + now gone
          }
          clearResolved(m[1]);
          return json({ ok: true });
        }
      }

      {
        const m = path.match(
          /^\/api\/sessions\/([0-9a-fA-F-]{36})\/messages$/,
        );
        if (m && req.method === "GET") {
          const tp = await resolveTranscript(m[1]);
          if (!tp) return err(404, "session transcript not found");
          const msgs = (await recentMessages(tp, 60)).map(msgWithHtml);
          return json({ id: m[1], messages: msgs });
        }
      }

      // Multiplexed live stream: one connection tails many transcripts and
      // polls many panes. The per-session /stream endpoint opens one HTTP
      // connection each, so >6 open panes blow past the browser's per-host
      // connection cap and the oldest panes silently stop updating. This
      // folds them into a single SSE; events carry a `sid` so the client can
      // route them to the right pane.
      if (path === "/api/live/stream") {
        const ids = (url.searchParams.get("ids") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => /^[0-9a-fA-F-]{36}$/.test(s))
          .slice(0, 24);
        const all = await listSessions();
        const panes = (
          await Promise.all(
            ids.map(async (sid) => {
              const tp = await resolveTranscript(sid);
              if (!tp) return null;
              const target = all.find((s) => s.sessionId === sid)?.tmuxTarget ?? null;
              return { sid, tp, target };
            }),
          )
        ).filter((p): p is { sid: string; tp: string; target: string | null } => !!p);

        let iv: ReturnType<typeof setInterval> | null = null;
        let pi: ReturnType<typeof setInterval> | null = null;
        let hb: ReturnType<typeof setInterval> | null = null;
        let closed = false;
        const stream = new ReadableStream({
          start(controller) {
            const send = (s: string) => {
              if (closed) return;
              try {
                controller.enqueue(s);
              } catch {
                closed = true;
              }
            };
            const offsets = new Map<string, number>();
            const bufs = new Map<string, string>();
            const lastSig = new Map<string, string>();
            const pumpOne = async (p: { sid: string; tp: string }) => {
              if (closed) return;
              try {
                const f = Bun.file(p.tp);
                const size = f.size;
                let offset = offsets.get(p.sid) ?? 0;
                if (size < offset) offset = 0; // rotated/truncated
                if (size > offset) {
                  const chunk = await f.slice(offset, size).text();
                  offsets.set(p.sid, size);
                  let buf = (bufs.get(p.sid) ?? "") + chunk;
                  const lines = buf.split("\n");
                  bufs.set(p.sid, lines.pop() ?? "");
                  for (const l of lines) {
                    if (!l) continue;
                    const msgs = normalizeLineMessages(l);
                    for (const msg of msgs)
                      send(
                        `event: msg\ndata: ${JSON.stringify({ sid: p.sid, m: msgWithHtml(msg) })}\n\n`,
                      );
                  }
                }
              } catch {}
            };
            const lastBusy = new Map<string, string>();
            const pollOne = async (p: {
              sid: string;
              tp: string;
              target: string | null;
            }) => {
              if (closed) return;
              if (!p.target) {
                // Pane-less (aisdk / codex-aisdk) session: busy comes from the
                // registry, and there are no pane-scraped prompts. For a
                // codex-aisdk session the sid may be the threadId rather than the
                // control-plane key, so look it up by either.
                const entry = findAisdkEntryByAnyId(p.sid);
                if (!entry) return;
                const bsig = entry.busy ? "1" : "0";
                if (bsig !== (lastBusy.get(p.sid) ?? "0")) {
                  lastBusy.set(p.sid, bsig);
                  send(`event: busy\ndata: ${JSON.stringify({ sid: p.sid, busy: entry.busy })}\n\n`);
                }
                return;
              }
              const pane = capturePane(p.target);
              const prompt = await resolveSessionPrompt(p.tp, pane);
              if (closed) return;
              const sig = prompt ? JSON.stringify(prompt) : "";
              if (sig !== (lastSig.get(p.sid) ?? " ")) {
                lastSig.set(p.sid, sig);
                send(
                  `event: prompt\ndata: ${JSON.stringify({ sid: p.sid, prompt: prompt ?? null })}\n\n`,
                );
              }
              const busy = pane ? isBusy(pane) : false;
              const bsig = busy ? "1" : "0";
              if (bsig !== (lastBusy.get(p.sid) ?? "0")) {
                lastBusy.set(p.sid, bsig);
                send(`event: busy\ndata: ${JSON.stringify({ sid: p.sid, busy })}\n\n`);
              }
            };
            const lastQ = new Map<string, string>();
            const queueOne = (p: { sid: string }) => {
              if (closed) return;
              const queue = listQueue(p.sid);
              const sig = JSON.stringify(queue);
              if (sig === (lastQ.get(p.sid) ?? "[]")) return;
              lastQ.set(p.sid, sig);
              send(`event: queue\ndata: ${JSON.stringify({ sid: p.sid, queue })}\n\n`);
            };
            (async () => {
              for (const p of panes) {
                const msgs = (await recentMessages(p.tp, 40)).map(msgWithHtml);
                for (const m of msgs)
                  send(`event: msg\ndata: ${JSON.stringify({ sid: p.sid, m })}\n\n`);
                offsets.set(p.sid, Bun.file(p.tp).size);
                lastSig.set(p.sid, " ");
                lastQ.set(p.sid, "[]");
                pollOne(p);
                queueOne(p);
              }
              iv = setInterval(() => {
                for (const p of panes) pumpOne(p);
              }, 700);
              pi = setInterval(() => {
                for (const p of panes) {
                  pollOne(p);
                  queueOne(p);
                  void reconcileQueued(p.sid).then((c) => c && queueOne(p));
                }
              }, 1000);
            })();
            hb = setInterval(() => send(`: hb\n\n`), 15000);
          },
          cancel() {
            closed = true;
            if (iv) clearInterval(iv);
            if (pi) clearInterval(pi);
            if (hb) clearInterval(hb);
          },
        });
        return new Response(stream, { headers: sseHeaders() });
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/stream$/);
        if (m) {
          const tp = await resolveTranscript(m[1]);
          if (!tp) return err(404, "session transcript not found");
          const target =
            (await listSessions()).find((s) => s.sessionId === m[1])
              ?.tmuxTarget ?? null;
          const sid = m[1];
          let iv: ReturnType<typeof setInterval> | null = null;
          let pi: ReturnType<typeof setInterval> | null = null;
          let qi: ReturnType<typeof setInterval> | null = null;
          let hb: ReturnType<typeof setInterval> | null = null;
          let closed = false;
          const stream = new ReadableStream({
            start(controller) {
              const send = (s: string) => {
                if (closed) return;
                try {
                  controller.enqueue(s);
                } catch {
                  closed = true;
                }
              };
              let offset = 0;
              let buf = "";
              const pump = async () => {
                if (closed) return;
                try {
                  const f = Bun.file(tp);
                  const size = f.size;
                  if (size < offset) offset = 0; // file rotated/truncated
                  if (size > offset) {
                    const chunk = await f.slice(offset, size).text();
                    offset = size;
                    buf += chunk;
                    const lines = buf.split("\n");
                    buf = lines.pop() ?? "";
                    for (const l of lines) {
                      if (!l) continue;
                      const msgs = normalizeLineMessages(l);
                      for (const msg of msgs)
                        send(`event: msg\ndata: ${JSON.stringify(msgWithHtml(msg))}\n\n`);
                    }
                  }
                } catch {}
              };
              // backlog, then tail
              (async () => {
                const msgs = (await recentMessages(tp, 40)).map(msgWithHtml);
                for (const msg of msgs)
                  send(`event: msg\ndata: ${JSON.stringify(msg)}\n\n`);
                offset = Bun.file(tp).size;
                // Tail fast: the reply is already fully written to the transcript
                // by the time Claude finishes; a slow poll just adds dead wait
                // before it reaches the UI. 200ms keeps perceived latency low
                // without meaningfully more file stats.
                iv = setInterval(pump, 200);
              })();
              // Poll the tmux pane for an interactive selector (permission /
              // plan prompts live in the TUI, not the transcript). Emit only on
              // change so the client can render/clear a prompt panel.
              if (target) {
                let lastSig = " ";
                let lastBusy = "0";
                const pollPrompt = async () => {
                  if (closed) return;
                  const pane = capturePane(target);
                  const prompt = await resolveSessionPrompt(tp, pane);
                  if (closed) return;
                  const sig = prompt ? JSON.stringify(prompt) : "";
                  if (sig !== lastSig) {
                    lastSig = sig;
                    send(`event: prompt\ndata: ${prompt ? sig : "null"}\n\n`);
                  }
                  const bsig = pane && isBusy(pane) ? "1" : "0";
                  if (bsig !== lastBusy) {
                    lastBusy = bsig;
                    send(`event: busy\ndata: ${bsig === "1" ? "true" : "false"}\n\n`);
                  }
                };
                pollPrompt();
                pi = setInterval(pollPrompt, 1000);
              } else {
                // Pane-less (aisdk / codex-aisdk) session: source busy from the
                // registry — by key or threadId (codex-aisdk's sid is the latter).
                let lastBusy = "0";
                const pollBusy = () => {
                  if (closed) return;
                  const entry = findAisdkEntryByAnyId(sid);
                  if (!entry) return;
                  const bsig = entry.busy ? "1" : "0";
                  if (bsig !== lastBusy) {
                    lastBusy = bsig;
                    send(`event: busy\ndata: ${entry.busy ? "true" : "false"}\n\n`);
                  }
                };
                pollBusy();
                pi = setInterval(pollBusy, 1000);
              }
              // Emit the outbound send-queue on change so the composer can show
              // each message's delivery status (pending/queued/delivered/failed).
              let lastQ = "[]";
              const pollQueue = () => {
                if (closed) return;
                const queue = listQueue(sid);
                const sig = JSON.stringify(queue);
                if (sig === lastQ) return;
                lastQ = sig;
                send(`event: queue\ndata: ${sig}\n\n`);
              };
              pollQueue();
              qi = setInterval(() => {
                pollQueue();
                void reconcileQueued(sid).then((c) => c && pollQueue());
              }, 1000);
              hb = setInterval(() => send(`: hb\n\n`), 15000);
            },
            cancel() {
              closed = true;
              if (iv) clearInterval(iv);
              if (pi) clearInterval(pi);
              if (qi) clearInterval(qi);
              if (hb) clearInterval(hb);
            },
          });
          return new Response(stream, { headers: sseHeaders() });
        }
      }

      return err(404, "not found");
    },
  });

  startAutoScheduler((l) => console.log(l));

  console.log(`lfg web → http://${server.hostname}:${server.port}`);
  console.log(`  agents dir: ${AGENTS_DIR}`);
}
