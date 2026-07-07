import { readdir, realpath, stat } from "node:fs/promises";
import { appendFileSync, statSync, mkdirSync, readFileSync, type Dirent } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { marked } from "marked";
import { PATHS, installInfo } from "../config.ts";
import { compressedAssetResponse, maybeCompressResponse } from "../http-compress.ts";
import { getCachedResumableSession } from "../resume-cache.ts";
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
  logFindingAction,
  type FindingActionPath,
} from "../auto/store.ts";
import { runAutoAgent } from "../auto/runner.ts";
import { startAutoScheduler } from "../auto/scheduler.ts";
import { runSessionBrain, runSessionBrainForSession } from "../session-brain/runner.ts";
import { startSessionBrainScheduler } from "../session-brain/scheduler.ts";
import { setBrainPromptSender } from "../session-brain/merge-guard.ts";
import {
  computeSessionDiff,
  computeSessionDiffStat,
  computeSessionDiffSummary,
  computeSessionFilePatch,
} from "../session-diff.ts";
import {
  listPatternSuggestions,
  listSessionBrainRuns,
  listSessionNotes,
  readSessionBrainConfig,
  updatePatternSuggestionStatus,
  updateSessionBrainConfig,
  updateSessionNoteStatus,
  type PatternSuggestionStatus,
  type SessionNoteStatus,
} from "../session-brain/store.ts";
import { reportClientError, listClientErrors } from "../client-errors.ts";
import { getAllUsage } from "../usage.ts";
import {
  vapidPublicKey,
  saveSubscription,
  removeSubscription,
  subscriptionUser,
  type PushSubscription,
} from "../push.ts";
import { notifyAll } from "../push.ts";
import {
  listQuestions,
  getQuestion,
  addQuestion,
  answerQuestion,
  markHandled,
  waitForAnswer,
} from "../ask/store.ts";
import {
  listSessions,
  resolveTranscript,
  recentMessages,
  recentMessagesCached,
  warmRecentMessages,
  searchTranscript,
  messagePage,
  normalizeLineMessages,
  setSessionTitle,
  sessionIdForPid,
  pendingToolPrompt,
  listResumable,
  queryResumable,
  refreshResumableCache,
  cwdForTranscript,
  cwdForCodexTranscript,
  type PendingPrompt,
  type Session,
} from "../sessions.ts";
import {
  invalidateListSessionsCache,
  listSessionsCached,
  noteListSessionsClientActivity,
} from "../session-cache.ts";
import {
  enqueueTranscriptIndex,
  indexedMessagePage,
  indexTranscript,
  searchAllTranscriptIndexes,
  searchTranscriptIndex,
} from "../transcript-index.ts";
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
  spawnManagedGrokSession,
  spawnManagedHermesSession,
  spawnManagedAisdkSession,
  spawnManagedCodexAisdkSession,
  spawnManagedOpencodeAisdkSession,
  dismissCodexUpdatePrompt,
  dismissResumeSummaryGate,
  panePidForSession,
  isBusy,
} from "../tmux.ts";
import { addManaged, patchManaged, removeManaged } from "../managed.ts";
import { PtyBridge, termSessionName } from "../pty.ts";
import { capturePaneScroll, capturePaneEscaped, paneWidth } from "../tmux.ts";
import { detectUrls } from "../links.ts";
import type { ServerWebSocket } from "bun";
import {
  createLiveWsSupport,
  isLiveWsEnabled,
  liveTransportMode,
  liveWsUpgradeAuthenticated,
  type LiveWsSocketData,
} from "../live-ws.ts";
import { appendCmd as appendAisdkCmd, removeEntry as removeAisdkEntry, readEntry as readAisdkEntry, findEntryByAnyId as findAisdkEntryByAnyId, isEntryBusy as isAisdkEntryBusy } from "../aisdk-registry.ts";
import { markClosed } from "../closing.ts";
import { assignUser, userRoster } from "../users.ts";
import { listProfiles, getProfile, deleteProfile } from "../browser/profiles.ts";
import {
  startLoginSession,
  attachStream,
  endSession,
  type WSLike,
  type Viewport,
} from "../browser/session.ts";
import { testProfile } from "../browser/tool.ts";
import { listCustomRepos, addCustomRepo, removeCustomRepo } from "../repos-store.ts";
import { projectName, reposRoot } from "../projects.ts";
import { resolveSessionCwd, startWorktreeSweep } from "../worktree.ts";
import {
  synthesizeTts,
  transcribeStt,
  getVoiceSettings,
  setVoiceSettings,
  listProviders,
  openSttStream,
  type VoiceSettings,
  type SttStreamBridge,
} from "../voice-providers.ts";
import {
  isCodingAgentKind,
  listCodingAgents,
  listSetupChecks,
  runCodingAgentSetup,
  runSetupAction,
  setCodingAgentVisibility,
} from "../coding-agents.ts";
import {
  AISDK_MODELS,
  AUTO_AGENT_BACKENDS,
  CLAUDE_MODELS,
  GROK_MODELS,
  HERMES_MODELS,
  thinkingLevelsForAgent,
} from "../agent-catalog.ts";
import { listSkillCatalog } from "../skills-catalog.ts";
import {
  createImageArtifact,
  getImageArtifact,
  imageArtifactMessagesSince,
  imageArtifactToMessage,
  listImageArtifacts,
  type ImageArtifactMessage,
} from "../artifacts.ts";

// Where the user keeps the repos lfg can launch agents into. Scanned for git
// repos at runtime; defaults to ~/repos. The lfg repo itself (PATHS.root) is
// always offered as a target since it is present and trusted.
const REPOS_ROOT = reposRoot();
const SELF_REPO = PATHS.root;
const EVLOG_DIR = join(PATHS.data, "evlogs");

function evlog(event: string, fields: Record<string, unknown> = {}) {
  try {
    mkdirSync(EVLOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(
      join(EVLOG_DIR, `${day}.jsonl`),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        monoMs: Math.round(performance.now() * 1000) / 1000,
        event,
        ...fields,
      })}\n`,
    );
  } catch {
    // Diagnostics must never affect the app path being measured.
  }
}

const BOOT_API_TIMING_ENDPOINTS = new Set([
  "/api/bootstrap",
  "/api/sessions",
  "/api/skills",
  "/api/agents",
  "/api/repos",
  "/api/users",
  "/api/checks",
  "/api/setup/checks",
  "/api/coding-agents",
  "/api/findings",
  "/api/auto/findings",
  "/api/notes",
  "/api/session-brain/notes",
  "/api/config",
  "/api/session-brain/config",
]);

function apiDurationMs(start: number): number {
  return Math.round((performance.now() - start) * 1000) / 1000;
}

function uploadExt(contentType: string, filename: string): string {
  const fromName = extname(filename).toLowerCase().replace(/^\./, "");
  if (/^[a-z0-9]{1,12}$/.test(fromName)) return fromName;
  const ct = contentType.toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("pdf")) return "pdf";
  if (ct.includes("markdown")) return "md";
  if (ct.includes("json")) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("text")) return "txt";
  return "bin";
}

function uploadStem(filename: string): string {
  const leaf = filename.split(/[\\/]/).pop() || "";
  const stem = leaf.replace(/\.[^.]*$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return stem.slice(0, 48) || "upload";
}

async function persistUpload(req: Request, filename: string, prefix = "upload"): Promise<{ path: string; name: string }> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  const ext = uploadExt(ct, filename);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.length) throw new Error("empty upload");
  const dir = join(tmpdir(), "lfg-uploads");
  mkdirSync(dir, { recursive: true });
  const safePrefix = prefix.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "upload";
  const name = `${safePrefix}-${Date.now()}-${randomBytes(3).toString("hex")}-${uploadStem(filename)}.${ext}`;
  const fp = join(dir, name);
  await Bun.write(fp, buf);
  return { path: fp, name: filename || name };
}

function uploadFilename(req: Request, url: URL): string {
  const rawName = url.searchParams.get("filename") || req.headers.get("x-file-name") || "";
  try {
    return decodeURIComponent(rawName);
  } catch {
    return rawName;
  }
}

const GROK_DEFAULT_MODEL = "grok-composer-2.5-fast";
const HERMES_DEFAULT_MODEL = "nousresearch/hermes-4-405b";
const HERMES_PROVIDER = process.env.LFG_HERMES_PROVIDER?.trim() || undefined;
const OPENCODE_DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";
// Models whose provider currently rejects our requests (Sakana's fugu returns a
// hard 403 Forbidden, and the local Novita credential currently 403s too — see
// opencode.log). A session born onto one of these streams zero output and
// silently goes idle, so redirect create + model-switch away from them to the
// verified OpenCode Go default instead of letting the turn die.
const OPENCODE_DISABLED_MODELS = new Set<string>([
  "fugu/fugu",
  "fugu/fugu-ultra",
  "fugu",
  "fugu-ultra",
  "novita-ai/deepseek/deepseek-v4-pro",
  "novita-ai/zai-org/glm-5.2",
  "novita-ai/zai-org/glm-5.1",
]);
import { enqueueMessage, listQueue, retryMessage, clearResolved, reconcileQueued, getMessage } from "../sendq.ts";
import { startFleetWatcher, subscribeFleet, type FleetEvent } from "../voice-bus.ts";
import { handleElevenLlm, handleElevenToken } from "../voice-eleven-llm.ts";
import { resolveVoiceIntent, type VoiceIntentRequest } from "../voice-intent.ts";

const PORT = Number(process.env.LFG_PORT ?? process.env.PORT ?? 8766);
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
  const repos: Array<{ name: string; cwd: string; project: string; custom?: boolean }> = [];
  const addRepo = async (name: string, cwd: string, custom = false) => {
    if (repos.some((r) => r.cwd === cwd)) return;
    try {
      await stat(join(cwd, ".git"));
      const project = projectName(cwd);
      if (repos.some((r) => r.project === project)) return;
      repos.push(custom ? { name, cwd, project, custom: true } : { name, cwd, project });
    } catch {}
  };
  let entries: Dirent[] = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {}
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    await addRepo(entry.name, join(root, entry.name));
  }
  // Always offer the lfg repo itself as a target — it is present and trusted.
  await addRepo("lfg", SELF_REPO);
  // Merge in user-pinned custom paths (repos outside LFG_REPOS_ROOT). Tagged
  // `custom` so the UI can offer a remove affordance; deduped on cwd against
  // anything already discovered above.
  for (const r of await listCustomRepos()) await addRepo(r.name, r.cwd, true);
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return repos;
}

function repoRootForManagedCwd(cwd: string): string | undefined {
  const top = Bun.spawnSync({
    cmd: ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const topLevel = top.exitCode === 0 ? top.stdout.toString().trim() : "";
  const proc = Bun.spawnSync({
    cmd: ["git", "-C", cwd, "rev-parse", "--git-common-dir"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return topLevel || undefined;
  const common = proc.stdout.toString().trim();
  if (!common) return topLevel || undefined;
  const absCommon = resolve(cwd, common);
  return absCommon.includes("/.git/worktrees/") ? dirname(absCommon.split("/.git/worktrees/")[0] + "/.git") : topLevel || cwd;
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

async function listAgentSummaries() {
  const agents = await listAgents();
  return Promise.all(
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
}

const SETUP_CHECKS_CACHE_TTL_MS = 45_000;
let setupChecksCache:
  | { expiresAt: number; checks: Awaited<ReturnType<typeof listSetupChecks>> }
  | null = null;
let setupChecksInFlight: Promise<Awaited<ReturnType<typeof listSetupChecks>>> | null = null;

async function listSetupChecksCached(opts: { refresh?: boolean } = {}) {
  const now = Date.now();
  if (!opts.refresh && setupChecksCache && setupChecksCache.expiresAt > now) {
    return setupChecksCache.checks;
  }
  if (!opts.refresh && setupChecksInFlight) return setupChecksInFlight;
  setupChecksInFlight = listSetupChecks()
    .then((checks) => {
      setupChecksCache = { checks, expiresAt: Date.now() + SETUP_CHECKS_CACHE_TTL_MS };
      return checks;
    })
    .finally(() => {
      setupChecksInFlight = null;
    });
  return setupChecksInFlight;
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

function agentRunSnapshot(runId: string) {
  const state = RUNS.get(runId);
  if (!state) return null;
  return {
    id: state.id,
    agent: state.agent,
    date: state.date,
    status: state.status,
    logs: state.logs,
    result: state.result,
    error: state.error,
  };
}

function subscribeAgentRun(runId: string, cb: (event: { type: "log"; line: string } | { type: "done" | "failed"; status: "done" | "failed"; result?: unknown; error?: string }) => void) {
  const state = RUNS.get(runId);
  if (!state) return () => {};
  const send = (ev: { line?: string; final?: RunState }) => {
    if (ev.line) cb({ type: "log", line: ev.line });
    if (ev.final) {
      const status = ev.final.status === "failed" ? "failed" : "done";
      cb({
        type: status,
        status,
        result: ev.final.result,
        error: ev.final.error,
      });
    }
  };
  state.subscribers.add(send);
  return () => state.subscribers.delete(send);
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
  "/agent-grok.svg": { path: join(WEB_DIR, "agent-grok.svg"), type: "image/svg+xml" },
  "/agent-hermes.svg": { path: join(WEB_DIR, "agent-hermes.svg"), type: "image/svg+xml" },
  "/apple-touch-icon.png": { path: join(WEB_DIR, "icon.svg"), type: "image/svg+xml" },
};

async function webIndexResponse() {
  // Runtime extension injection: LFG core ships no proprietary UI. Our
  // deployments set LFG_EXTENSIONS (comma-separated ESM URLs) — each is
  // injected as a module <script> AFTER the app bundle, so it runs once
  // window.lfg (host React + registerExtension) exists and contributes UI
  // (e.g. a private tab). Open-source forks set nothing → clean core.
  let html = await Bun.file(INDEX_PATH).text();
  const runtimeConfig = `<script>window.__LFG_CONFIG__=${JSON.stringify({ liveTransport: liveTransportMode() })}</script>`;
  html = html.includes("</head>")
    ? html.replace("</head>", `${runtimeConfig}</head>`)
    : runtimeConfig + html;
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
type HtmlMessage = { kind: string; text: string; html?: string };
const messageHtmlCache = new Map<string, string>();
const MESSAGE_HTML_CACHE_MAX = 4_000;

function messageHtmlCacheKey(m: HtmlMessage): string {
  const id = "id" in m && typeof m.id === "string" ? m.id : "";
  return `${id}\0${m.kind}\0${m.text.length}\0${m.text.slice(0, 96)}`;
}

function rememberMessageHtml(key: string, html: string) {
  if (messageHtmlCache.has(key)) messageHtmlCache.delete(key);
  messageHtmlCache.set(key, html);
  if (messageHtmlCache.size <= MESSAGE_HTML_CACHE_MAX) return;
  const oldest = messageHtmlCache.keys().next().value;
  if (oldest) messageHtmlCache.delete(oldest);
}

function msgWithHtml<T extends HtmlMessage>(m: T) {
  if (m.kind === "text" && m.text) {
    const key = messageHtmlCacheKey(m);
    const cached = messageHtmlCache.get(key);
    if (cached !== undefined) return { ...m, html: cached };
    const html = marked.parse(m.text) as string;
    rememberMessageHtml(key, html);
    return { ...m, html };
  }
  return m;
}

function visibleTranscriptMessages<T extends { kind: string }>(messages: T[]): T[] {
  return messages.filter((message) => message.kind !== "tool_result");
}

function withImageArtifacts<T extends { text: string; ts?: number | null; id?: string | null }>(
  sessionId: string,
  messages: T[],
): Array<T | ImageArtifactMessage> {
  const artifacts = listImageArtifacts(sessionId).map(imageArtifactToMessage);
  if (!artifacts.length) return messages;
  const seen = new Set(messages.map((message) => message.id).filter(Boolean));
  return [...messages, ...artifacts.filter((artifact) => !seen.has(artifact.id))]
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

function transcriptMessagesForClient<T extends { kind: string; text: string; ts?: number | null; id?: string | null }>(
  sessionId: string,
  messages: T[],
): Array<T | ImageArtifactMessage> {
  return withImageArtifacts(sessionId, visibleTranscriptMessages(messages));
}

type DraftState = { id: string; text: string };

type AiTextDeltaPart = {
  type: "text-delta";
  id: string;
  delta?: string;
  text?: string;
  reset?: boolean;
  ts: number;
};

function sendAiTextDeltaPart(
  send: (s: string) => void,
  sid: string,
  entry: { sessionId: string; draftText?: string | null; draftUpdatedAt?: number | null },
  lastDraft: Map<string, DraftState>,
  wrapSid: boolean,
): void {
  const id = `draft-${entry.sessionId}`;
  const text = entry.draftText ?? "";
  const prev = lastDraft.get(sid);
  if (!text) {
    if (prev) lastDraft.delete(sid);
    return;
  }
  let part: AiTextDeltaPart;
  if (!prev || prev.id !== id || !text.startsWith(prev.text)) {
    part = { type: "text-delta", id, text, reset: true, ts: entry.draftUpdatedAt ?? Date.now() };
  } else {
    const delta = text.slice(prev.text.length);
    if (!delta) return;
    part = { type: "text-delta", id, delta, ts: entry.draftUpdatedAt ?? Date.now() };
  }
  lastDraft.set(sid, { id, text });
  const data = wrapSid ? { sid, part } : part;
  send(`event: ai_part\ndata: ${JSON.stringify(data)}\n\n`);
}

function interruptLiveSession(session: Session): { ok: boolean; error?: string; status?: number } {
  const sid = session.sessionId;
  if (!sid) return { ok: false, error: "live session has no id", status: 409 };
  if (
    session.agent === "aisdk" ||
    session.agent === "codex-aisdk" ||
    session.agent === "opencode"
  ) {
    const key = findAisdkEntryByAnyId(sid)?.sessionId ?? sid;
    appendAisdkCmd(key, { type: "interrupt" });
    return { ok: true };
  }
  if (!session.tmuxTarget)
    return { ok: false, error: "session is not in a tmux pane — cannot interrupt", status: 409 };
  if (!tmuxInterrupt(session.tmuxTarget)) return { ok: false, error: "interrupt failed", status: 502 };
  return { ok: true };
}

function sendPromptToLiveSession(
  session: Session,
  text: string,
  opts: { mode?: "steer" | "queue" } = {},
): { ok: boolean; msg?: unknown; error?: string } {
  const prompt = text.trim();
  if (!prompt) return { ok: true };
  const sid = session.sessionId;
  if (!sid) return { ok: false, error: "live session has no id" };
  if ((opts.mode ?? "steer") === "steer" && session.busy) {
    const interrupted = interruptLiveSession(session);
    if (!interrupted.ok) return interrupted;
  }
  if (
    session.agent === "aisdk" ||
    session.agent === "codex-aisdk" ||
    session.agent === "opencode"
  ) {
    const key = findAisdkEntryByAnyId(sid)?.sessionId ?? sid;
    appendAisdkCmd(key, { type: "send", text: prompt });
    return {
      ok: true,
      msg: { id: randomBytes(8).toString("hex"), text: prompt, status: "delivered" },
    };
  }
  if (!session.tmuxTarget) return { ok: false, error: "session is not in a tmux pane — cannot send" };
  return { ok: true, msg: enqueueMessage(sid, prompt) };
}

function liveSessionIds(sessions: Session[]): Set<string> {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (session.sessionId) ids.add(session.sessionId);
    if (session.nativeSessionId) ids.add(session.nativeSessionId);
  }
  return ids;
}

// Live-session enumeration goes through pgrep (~300ms). The resumable picker
// only needs live ids to hide already-running sessions — a cosmetic filter that
// tolerates a few seconds of staleness — so cache them briefly instead of
// re-running listSessions() on every keystroke/filter change in the picker.
let cachedLiveIds: { ids: Set<string>; at: number } | null = null;
const LIVE_IDS_TTL_MS = 3000;
async function liveSessionIdsCached(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedLiveIds && now - cachedLiveIds.at < LIVE_IDS_TTL_MS) return cachedLiveIds.ids;
  const ids = liveSessionIds(await listSessionsCached());
  cachedLiveIds = { ids, at: Date.now() };
  return ids;
}

function warmRenderedBacklogs(sessions: Session[], limit = 40): void {
  for (const session of sessions.slice(0, MESSAGE_HTML_CACHE_MAX)) {
    const path = session.transcriptPath;
    if (!path) continue;
    void recentMessagesCached(path, limit)
      .then((messages) => {
        if (session.sessionId) {
          for (const message of transcriptMessagesForClient(session.sessionId, messages)) msgWithHtml(message);
        } else {
          for (const message of visibleTranscriptMessages(messages)) msgWithHtml(message);
        }
      })
      .catch(() => {});
  }
}

function compactForSpeech(text: string, max = 700): string {
  const oneLine = text
    .replace(/```[\s\S]*?```/g, "code block")
    .replace(/[`*_#>\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trim()}…`;
}

function clipSummaryText(text: string, max = 1200): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

function sessionSummaryTimeoutMs(): number {
  const raw = Number(process.env.LFG_SESSION_SUMMARY_TIMEOUT_MS || "");
  return Number.isFinite(raw) && raw > 0 ? Math.max(500, Math.min(15_000, raw)) : 2_500;
}

function claudeOauthToken(): string | null {
  try {
    const raw = readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8");
    const creds = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function sessionSummaryModel(): string {
  return process.env.LFG_SESSION_SUMMARY_MODEL || process.env.LFG_VOICE_MODEL || "claude-haiku-4-5";
}

async function claudeSessionSummary(prompt: string): Promise<string | null> {
  const token = claudeOauthToken();
  if (!token) return null;
  try {
    const r = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: sessionSummaryModel(),
        max_tokens: 140,
        system:
          "Summarize the coding-agent session for spoken playback. Use 2 short sentences, no markdown. Say what was requested, what changed or happened, and any current blocker.",
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(sessionSummaryTimeoutMs()),
    });
    if (!r.ok) return null;
    const data = (await r.json().catch(() => null)) as { content?: Array<{ type?: string; text?: string }> } | null;
    return data?.content
      ?.filter((b) => b?.type === "text")
      .map((b) => b.text || "")
      .join("")
      .trim() || null;
  } catch {
    return null;
  }
}

async function sessionSummaryContext(sessionId: string, transcriptPath: string): Promise<{
  prompt: string;
  fallback: string;
}> {
  const [msgs, live] = await Promise.all([
    recentMessages(transcriptPath, 64, { maxBytes: 192 * 1024 }),
    listSessionsCached().catch(() => []),
  ]);
  const session = live.find((s) => s.sessionId === sessionId) ?? null;
  const relevant = msgs
    .filter((m) => m.kind === "text" && m.text.trim() && (m.role === "user" || m.role === "assistant"))
    .slice(-24);
  const transcript = relevant
    .map((m) => `${m.role}: ${clipSummaryText(m.text, 500)}`)
    .join("\n");
  const status = session
    ? `${session.busy ? "working" : "idle"}${session.status === "blocked" ? `, blocked: ${session.statusDetail || session.statusReason || "needs attention"}` : ""}`
    : "not currently live";
  const title = session ? titleForSessionLike(session) : sessionId.slice(0, 8);
  const lastUser = [...relevant].reverse().find((m) => m.role === "user")?.text || "";
  const lastAssistant = [...relevant].reverse().find((m) => m.role === "assistant")?.text || "";
  const parts = [
    title ? `Session ${title}.` : "This session.",
    lastUser ? `Last request: ${compactForSpeech(lastUser, 180)}.` : "",
    lastAssistant ? `Latest update: ${compactForSpeech(lastAssistant, 260)}.` : "No assistant update is in the transcript yet.",
    session?.status === "blocked"
      ? `It is blocked: ${compactForSpeech(session.statusDetail || "needs attention", 120)}.`
      : session?.busy
        ? "It is working now."
        : "It is idle now.",
  ].filter(Boolean);
  return {
    prompt: `Session: ${title}\nStatus: ${status}\n\nRecent transcript:\n${transcript || "(no transcript text)"}`,
    fallback: compactForSpeech(parts.join(" ")),
  };
}

async function summarizeSessionForSpeech(sessionId: string, transcriptPath: string): Promise<{
  summary: string;
  generated: boolean;
  model?: string;
}> {
  const ctx = await sessionSummaryContext(sessionId, transcriptPath);
  const generated = await claudeSessionSummary(ctx.prompt);
  if (generated) return { summary: compactForSpeech(generated), generated: true, model: sessionSummaryModel() };
  return { summary: ctx.fallback, generated: false };
}

async function streamSessionSummaryForSpeech(sessionId: string, transcriptPath: string): Promise<Response> {
  const ctx = await sessionSummaryContext(sessionId, transcriptPath);
  const token = claudeOauthToken();
  if (!token) return new Response(ctx.fallback, { headers: { "Content-Type": "text/plain; charset=utf-8" } });

  const upstream = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: sessionSummaryModel(),
      max_tokens: 140,
      stream: true,
      system:
        "Summarize the coding-agent session for spoken playback. Use 2 short sentences, no markdown. Say what was requested, what changed or happened, and any current blocker.",
      messages: [{ role: "user", content: ctx.prompt }],
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

  if (!upstream?.ok || !upstream.body) {
    return new Response(ctx.fallback, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buf = "";
      try {
        const reader = upstream.body!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            const ev = JSON.parse(payload) as any;
            const delta = ev?.type === "content_block_delta" ? ev.delta : null;
            if (delta?.type === "text_delta" && delta.text) {
              controller.enqueue(encoder.encode(delta.text));
            }
          }
        }
      } catch {
        if (!controller.desiredSize) return;
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-LFG-Summary-Model": sessionSummaryModel(),
    },
  });
}

async function streamSessionSummaryChunksForSpeech(sessionId: string, onChunk: (chunk: string) => void): Promise<void> {
  const tp = await resolveTranscript(sessionId);
  if (!tp) throw new Error("session transcript not found");
  const res = await streamSessionSummaryForSpeech(sessionId, tp);
  if (!res.ok) throw new Error(`summary failed (${res.status})`);
  if (!res.body) throw new Error("No summary stream returned");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (chunk) onChunk(chunk);
  }
  const rest = decoder.decode();
  if (rest) onChunk(rest);
}

function titleForSessionLike(session: { title?: string | null; lastUserText?: string | null; tmuxName?: string | null; project?: string | null; sessionId?: string | null }) {
  return (
    session.title ||
    session.lastUserText ||
    session.tmuxName ||
    session.project ||
    session.sessionId?.slice(0, 8) ||
    "session"
  );
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
// Map a user's free-text/option answer to a deterministic action on the target
// session. This is what makes a reply reach the session immediately and
// reliably, instead of waiting for the supervisor's next run to re-interpret it.
function plannedSessionAction(answer: string): {
  kind: "close" | "send" | "none";
  text?: string;
} {
  const a = (answer ?? "").trim();
  const low = a.toLowerCase();
  if (/^(close|stop|kill|terminate|shut|end\b)/.test(low) || low === "close it")
    return { kind: "close" };
  if (/^(leave|keep|ignore|do nothing|nothing|none|no\b)/.test(low))
    return { kind: "none" };
  const text = a.replace(/^continue\s*:?\s*/i, "").trim();
  return text ? { kind: "send", text } : { kind: "none" };
}

async function voiceStatusSnapshot(user?: string | null): Promise<string> {
  let sessions;
  try {
    sessions = await listSessionsCached();
  } catch {
    return "(session list unavailable)";
  }
  // Scope to the speaking user when one is given, so the voice assistant never
  // surfaces (or acts on) another person's sessions. Empty/"__all" → whole fleet.
  if (user && user !== "__all") {
    sessions = sessions.filter((s) => s.assignedUser === user);
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
    // Surface the agent family so the voice assistant can tell OpenCode and
    // Codex sessions apart from regular Claude ones. Plain Claude (claude/aisdk)
    // is the common case, so leave it untagged to keep lines terse.
    const family =
      s.agent === "codex" || s.agent === "codex-aisdk"
        ? "codex"
        : s.agent === "opencode"
          ? "opencode"
          : s.agent === "grok"
            ? "grok"
            : s.agent === "hermes"
              ? "hermes"
          : null;
    const kind = family ? ` <${family}>` : "";
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
    lines.push(`- ${name}${kind}${who}: ${status}${detail}.${lastBit}${when ? ` (${when})` : ""}`);
  }
  // Pending agent questions for the human — the voice agent should read these
  // out and, when the user replies, answer them via POST /api/ask/<id>/answer.
  try {
    const open = await listQuestions("open");
    if (open.length) {
      lines.push("");
      lines.push("PENDING QUESTIONS FOR YOU (answer with the user's reply):");
      for (const q of open) {
        const opts = q.options?.length ? ` (${q.options.join(" / ")})` : "";
        lines.push(`- [${q.id}] "${clip(q.question, 120)}"${opts}`);
      }
    }
  } catch {
    // questions store unavailable — snapshot still useful without them
  }
  return lines.join("\n");
}

// ── Voice "deep-think" advisor ──────────────────────────────────────────────
// The voice brain is Haiku (fast, cheap, 1-2 sentences). For hard questions it
// escalates here: a persistent Opus aisdk session with full tool + repo access.
// We keep one advisor alive and reuse it across consults; if it's gone (serve
// restart, closed), the next consult lazily respawns it.
const ADVISOR_BRIEF =
  "You are the deep-thinking advisor for the lfg voice assistant. The user is " +
  "talking hands-free and the voice assistant escalates its hardest questions " +
  "to you for more careful reasoning. Think it through, then answer in at most " +
  "3 short, plain spoken sentences — no markdown, no code blocks, no bullet " +
  "lists. Be concrete and decisive; the answer is read aloud.";
let voiceAdvisorId: string | null = null;
// Which repo the live advisor was spawned against. The working tree is fixed at
// spawn, so a question about a different repo needs a fresh advisor.
let voiceAdvisorCwd: string | null = null;

const isAdvisorAnswer = (m: { role: string; kind: string; text?: string }) =>
  m.role === "assistant" && m.kind === "text" && !!m.text?.trim();

// Poll the advisor transcript until a new assistant answer appears AND settles
// (no further growth for one interval), or we hit the timeout.
async function waitForAdvisorAnswer(
  id: string,
  baseline: number,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    const tp = await resolveTranscript(id);
    if (!tp) continue;
    const answers = (await recentMessages(tp, 0, { maxBytes: null })).filter(
      isAdvisorAnswer,
    );
    if (answers.length > baseline) {
      const text = (answers[answers.length - 1].text || "").trim();
      if (text && text === last) return text; // stable for one interval — done
      last = text;
    }
  }
  return last || "I couldn't reach the advisor in time.";
}

// Send a question to the Opus advisor and return its spoken answer. `cwd` is the
// repo to explore (defaults to the lfg repo for the in-call voice agent); the
// orb's one-shot "ask a question" passes the user's currently-scoped repo so the
// answer has that codebase's full context.
async function voiceConsult(
  question: string,
  cwd: string = SELF_REPO,
): Promise<string> {
  const live = await listSessionsCached();
  let id = voiceAdvisorId;
  // Reuse the advisor only if it's still alive AND already scoped to the repo we
  // want to explore — a different repo means its loaded working tree is wrong, so
  // retire it and spawn fresh.
  const reusable =
    !!id && !!live.find((s) => s.sessionId === id) && voiceAdvisorCwd === cwd;
  if (!reusable) {
    if (id) await retireVoiceAdvisor();
    // Spawn a fresh advisor; the brief + first question are the kickoff turn, so
    // the answer is simply its first assistant message (baseline 0).
    id = crypto.randomUUID();
    const r = spawnManagedAisdkSession({
      name: `lfg-adv-${randomBytes(2).toString("hex")}`,
      cwd,
      prompt: `${ADVISOR_BRIEF}\n\nFirst question: ${question}`,
      model: "opus",
      sessionId: id,
    });
    if (!r.ok) throw new Error(r.error || "advisor spawn failed");
    voiceAdvisorId = id;
    voiceAdvisorCwd = cwd;
    return waitForAdvisorAnswer(id, 0, 120_000);
  }
  // Reuse the live advisor: count existing answers, then send and wait for one
  // more to appear past that baseline. (reusable === true guarantees id here.)
  if (!id) throw new Error("advisor unexpectedly missing");
  const tp = await resolveTranscript(id);
  const baseline = tp
    ? (await recentMessages(tp, 0, { maxBytes: null })).filter(isAdvisorAnswer)
        .length
    : 0;
  appendAisdkCmd(id, { type: "send", text: question });
  return waitForAdvisorAnswer(id, baseline, 90_000);
}

// Retire the persistent advisor so the next consult spawns a fresh one. Called
// when a new voice session starts: the advisor accumulates conversation context
// across consults, so without this the old session's deep-think history would
// leak into the new session. Teardown mirrors the aisdk session-close path and
// is best-effort — a hiccup here must never block a new voice session starting.
async function retireVoiceAdvisor(): Promise<void> {
  const id = voiceAdvisorId;
  voiceAdvisorId = null; // clear first so a concurrent consult respawns cleanly
  voiceAdvisorCwd = null;
  if (!id) return;
  try {
    const sess = (await listSessions()).find((s) => s.sessionId === id);
    if (!sess) return; // already gone (serve restart, closed) — nothing to tear down
    const key = findAisdkEntryByAnyId(id)?.sessionId ?? id;
    appendAisdkCmd(key, { type: "close" });
    if (sess.tmuxName) tmuxKillSession(sess.tmuxName);
    markClosed(sess.pid);
    removeAisdkEntry(key);
    if (sess.tmuxName) {
      removeManaged(sess.tmuxName);
      assignUser(sess.tmuxName, null);
    }
    clearResolved(id);
  } catch {
    // best-effort: voiceAdvisorId is already null, so the next consult respawns
  }
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

// ---- streaming-STT bridge sockets ----
// The LiveKit voice worker holds a websocket to /api/voice/stt-stream and streams
// 16 kHz PCM up / gets {partial,final} transcripts back. Each socket owns one
// upstream realtime-STT bridge (built in voice-providers so the API key stays
// there); the global ws handlers below find it by socket to forward audio / tear
// it down. Tagged in ws.data so open/message/close can tell it apart from the
// terminal and browser-login sockets that share these handlers.
type SttStreamSocketData = { sttStream: true };
const sttBridges = new WeakMap<object, SttStreamBridge>();

// ---- cloud-browser login stream sockets ----
// Browser-login viewer sockets multiplex through the same Bun websocket handlers
// as the terminal; we tag their data with browserSessionId and bridge them to the
// WSLike transport that ../browser/session.ts expects.
type BrowserSocketData = { browserSessionId: string };
type AppSocketData = TermSocketData | SttStreamSocketData | BrowserSocketData | LiveWsSocketData;
const browserSocketCbs = new WeakMap<
  object,
  { onMessage?: (d: string) => void; onClose?: () => void }
>();

function makeBrowserWS(ws: ServerWebSocket<AppSocketData>): WSLike {
  const cbs: { onMessage?: (d: string) => void; onClose?: () => void } = {};
  browserSocketCbs.set(ws, cbs);
  return {
    send: (data) => {
      try {
        ws.send(data);
      } catch {}
    },
    close: () => {
      try {
        ws.close();
      } catch {}
    },
    onMessage: (cb) => {
      cbs.onMessage = cb;
    },
    onClose: (cb) => {
      cbs.onClose = cb;
    },
  };
}

// Parse a terminal dimension from a query param, clamped to a sane range so a
// bogus value can't allocate an absurd pty winsize.
function clampDim(raw: string | null, fallback: number): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, n));
}

export async function cmdServe() {
  const liveWs = createLiveWsSupport({
    evlog,
    getAgentRun: agentRunSnapshot,
    subscribeAgentRun,
    streamSummary: streamSessionSummaryChunksForSpeech,
  });
  const server = Bun.serve<AppSocketData>({
    port: PORT,
    hostname: HOST,
    idleTimeout: 240,
    websocket: {
      // The browser terminal: each socket owns a PTY attached to a persistent
      // tmux shell session. Input arrives as binary frames (raw keystrokes);
      // text frames are JSON control messages (resize). Output is streamed back
      // as binary frames — the full raw VT byte stream a faithful renderer wants.
      idleTimeout: 600,
      open(ws: ServerWebSocket<AppSocketData>) {
        if (liveWs.isLiveSocket(ws as unknown as ServerWebSocket<unknown>)) {
          liveWs.open(ws as unknown as ServerWebSocket<unknown>);
          return;
        }
        // Streaming-STT bridge socket: open the upstream realtime-STT bridge and
        // pipe its results back as {partial,final} text frames. Built synchronously
        // (the bridge queues outbound audio until its upstream connects), so the
        // first PCM frame in message() always finds a bridge.
        if ((ws.data as unknown as SttStreamSocketData)?.sttStream) {
          const send = (o: unknown) => {
            try {
              ws.send(JSON.stringify(o));
            } catch {}
          };
          const bridge = openSttStream({
            onPartial: (text) => send({ type: "partial", text }),
            onFinal: (text) => send({ type: "final", text }),
            onClose: () => {
              try {
                ws.close();
              } catch {}
            },
          });
          if (!bridge) {
            try {
              ws.close();
            } catch {}
            return;
          }
          sttBridges.set(ws, bridge);
          return;
        }
        // Cloud-browser login viewer socket: bridge to the session streamer.
        const bSid = (ws.data as unknown as BrowserSocketData)?.browserSessionId;
        if (typeof bSid === "string") {
          attachStream(bSid, makeBrowserWS(ws));
          return;
        }
        if (!("sessionName" in ws.data)) {
          try {
            ws.close();
          } catch {}
          return;
        }
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
      message(ws: ServerWebSocket<AppSocketData>, message) {
        if (liveWs.isLiveSocket(ws as unknown as ServerWebSocket<unknown>)) {
          liveWs.message(ws as unknown as ServerWebSocket<unknown>, message);
          return;
        }
        // Streaming-STT bridge: binary frames are raw 16 kHz PCM; text frames are
        // the worker's {"type":"flush"|"eof"} control messages.
        const sttBridge = sttBridges.get(ws);
        if (sttBridge) {
          if (typeof message === "string") {
            try {
              const ctrl = JSON.parse(message) as { type?: string };
              if (ctrl.type === "flush") sttBridge.flush();
              else if (ctrl.type === "eof") sttBridge.close();
            } catch {}
          } else {
            sttBridge.pushPcm(message as Uint8Array);
          }
          return;
        }
        const bCbs = browserSocketCbs.get(ws);
        if (bCbs) {
          if (typeof message === "string") bCbs.onMessage?.(message);
          return;
        }
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
      close(ws: ServerWebSocket<AppSocketData>) {
        if (liveWs.isLiveSocket(ws as unknown as ServerWebSocket<unknown>)) {
          liveWs.close(ws as unknown as ServerWebSocket<unknown>);
          return;
        }
        // Streaming-STT bridge: tear the upstream realtime-STT socket down.
        const sttBridge = sttBridges.get(ws);
        if (sttBridge) {
          sttBridges.delete(ws);
          sttBridge.close();
          return;
        }
        const bCbs = browserSocketCbs.get(ws);
        if (bCbs) {
          browserSocketCbs.delete(ws);
          bCbs.onClose?.();
          // Viewer closed: tear the headless browser down so it doesn't leak on
          // this shared box (the saved profile already persists to disk).
          const sid = (ws.data as unknown as BrowserSocketData)?.browserSessionId;
          if (sid) void endSession(sid);
          return;
        }
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
      const apiTimingStart = BOOT_API_TIMING_ENDPOINTS.has(path) ? performance.now() : 0;

      const response = await (async () => {
      try {
      if (path === "/api/evlog") {
        if (req.method === "POST") {
          const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          const event = typeof body?.event === "string" ? body.event : "client_event";
          evlog(event, {
            source: "browser",
            href: req.headers.get("referer") ?? undefined,
            ...((body && typeof body === "object" ? body : {}) as Record<string, unknown>),
          });
          return json({ ok: true, path: join(EVLOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`) });
        }
        if (req.method === "GET") {
          const file = join(EVLOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
          const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") ?? "200", 10) || 200));
          const text = (() => {
            try {
              return readFileSync(file, "utf8");
            } catch {
              return "";
            }
          })();
          const lines = text.trim() ? text.trim().split("\n").slice(-limit) : [];
          return json({ path: file, lines });
        }
        return err(405, "method not allowed");
      }

      // ---- live view stream (websocket upgrade) ----
      if (path === "/api/live/ws") {
        if (!isLiveWsEnabled()) return err(404, "live websocket disabled");
        if (!liveWsUpgradeAuthenticated(req)) return err(401, "unauthorized");
        const ok = server.upgrade(req, {
          data: liveWs.dataForRequest(),
        });
        if (ok) return undefined; // upgraded — Bun takes over the socket
        return err(400, "expected a websocket upgrade");
      }

      // ---- browser terminal (websocket upgrade) ----
      if (path === "/api/term") {
        const sessionName = termSessionName(url.searchParams.get("session") || "main");
        const cols = clampDim(url.searchParams.get("cols"), 80);
        const rows = clampDim(url.searchParams.get("rows"), 24);
        const ok = server.upgrade(req, {
          data: { sessionName, cols, rows },
        });
        if (ok) return undefined; // upgraded — Bun takes over the socket
        return err(400, "expected a websocket upgrade");
      }

      // ---- streaming STT bridge (websocket upgrade) ----
      // The voice worker connects here when STT_WS_URL is set; the socket bridges
      // its raw-PCM/{flush,eof} protocol to the configured realtime-STT provider
      // (ElevenLabs Scribe v2 Realtime) in voice-providers.ts.
      if (path === "/api/voice/stt-stream") {
        const ok = server.upgrade(req, {
          data: { sttStream: true },
        });
        if (ok) return undefined; // upgraded — Bun takes over the socket
        return err(400, "expected a websocket upgrade");
      }

      // ---- cloud-browser login stream (websocket upgrade) ----
      {
        const m = path.match(/^\/api\/browser\/sessions\/([^/]+)\/stream$/);
        if (m) {
          const ok = server.upgrade(req, {
            data: { browserSessionId: decodeURIComponent(m[1]) },
          });
          if (ok) return undefined;
          return err(400, "expected a websocket upgrade");
        }
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
        return webIndexResponse();
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
        const filePath = join(WEB_DIR, "assets", path.slice("/assets/".length));
        const f = Bun.file(filePath);
        if (await f.exists()) {
          const type = path.endsWith(".css")
            ? "text/css; charset=utf-8"
            : path.endsWith(".js")
              ? "application/javascript; charset=utf-8"
              : "application/octet-stream";
          const headers = {
            "Content-Type": type,
            "Cache-Control": "public, max-age=31536000, immutable",
            "Vary": "Accept-Encoding",
          };
          const compressed = await compressedAssetResponse(req, filePath, headers);
          if (compressed) return compressed;
          return new Response(f, {
            headers,
          });
        }
      }

      // ---- LiveKit access token: mint a short-lived JWT so the browser can
      // join the self-hosted voice room. API key/secret live server-side; media
      // + signaling run on this box (livekit-server) over the tailnet.
      if (path === "/api/livekit/token") {
        const key = process.env.LIVEKIT_API_KEY;
        const secret = process.env.LIVEKIT_API_SECRET;
        const wss = process.env.LIVEKIT_WSS_PUBLIC;
        if (!key || !secret || !wss) return err(503, "livekit not configured");
        const room = "voice";
        const identity =
          url.searchParams.get("identity")?.slice(0, 64) ||
          `web-${randomBytes(3).toString("hex")}`;
        const now = Math.floor(Date.now() / 1000);
        const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
        const data = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({
          iss: key,
          sub: identity,
          nbf: now,
          iat: now,
          exp: now + 6 * 60 * 60,
          name: identity,
          video: {
            room,
            roomJoin: true,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
            // Required for localParticipant.setAttributes() — the orb publishes
            // the speaking user as the `lfg.user` attribute so the voice worker
            // can assign new sessions on their behalf. Without this grant the
            // server silently drops the attribute update and CURRENT_USER stays
            // empty, so orb-created sessions land unassigned.
            canUpdateOwnMetadata: true,
          },
        })}`;
        const ck = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const sig = await crypto.subtle.sign("HMAC", ck, new TextEncoder().encode(data));
        return json({
          url: wss,
          room,
          identity,
          token: `${data}.${Buffer.from(sig).toString("base64url")}`,
        });
      }

      // ---- ElevenLabs managed-agent brain (Option B): OpenAI-compatible
      // custom-LLM endpoint. ElevenLabs owns STT/TTS/turn-taking and calls this
      // per user turn; we run the Haiku brain + fleet tools here (see
      // voice-eleven-llm.ts) and stream the spoken reply back as SSE. No Python
      // worker, no shared LiveKit room — so no duplicate-session race.
      if (path === "/v1/chat/completions" && req.method === "POST") {
        return handleElevenLlm(req);
      }
      // Per-connect WebRTC token for the browser @elevenlabs/client SDK (keeps
      // the ElevenLabs API key server-side).
      if (path === "/api/voice/eleven-token" && req.method === "GET") {
        return handleElevenToken(req);
      }

      // ---- voice TTS proxy: synthesize via the configured cloud provider
      // (ElevenLabs by default; see voice-providers.ts). The API key lives
      // server-side (.env) so the browser never sees it; the client just plays
      // the returned raw 24 kHz PCM.
      if (path === "/api/voice/tts" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          text?: string;
          voice?: string;
        } | null;
        const text = body?.text?.trim();
        if (!text) return err(400, "expected { text }");
        return synthesizeTts(text, body?.voice);
      }

      // ---- voice intent: turn a dictated one-shot request (from the orb's
      // push-to-talk) into a session config. Merges the user's spoken overrides
      // onto their saved defaults and returns a short spoken confirmation. Used
      // by createVoiceSession in the frontend before it POSTs /api/sessions/new.
      if (path === "/api/voice/intent" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as
          | VoiceIntentRequest
          | null;
        if (!body?.transcript?.trim() || !body?.base?.cwd) {
          return err(400, "expected { transcript, base, repos, agents }");
        }
        return json(await resolveVoiceIntent(body));
      }

      // ---- voice STT proxy: transcribe uploaded WAV audio via the configured
      // cloud provider (ElevenLabs Scribe by default); returns { text }. Keeps
      // the device thin (no local model). The provider is chosen in Settings
      // and dispatched in voice-providers.ts.
      if (path === "/api/voice/stt" && req.method === "POST") {
        const audio = await req.arrayBuffer();
        if (!audio.byteLength) return err(400, "empty audio");
        return transcribeStt(audio);
      }

      // ---- voice provider config: which TTS/STT provider the proxies use.
      // The selection lives server-side (data/voice-settings.json) because the
      // Python worker's TTS/STT calls go agent→proxy and never see the browser;
      // localStorage alone wouldn't reach them. Secrets stay in env — this only
      // stores the *choice*. GET returns current settings + the provider list
      // (with availability) so the UI can grey out unconfigured ones.
      if (path === "/api/voice/config" && req.method === "GET") {
        return json({ settings: await getVoiceSettings(), providers: listProviders() });
      }
      if (path === "/api/voice/config" && req.method === "POST") {
        const b = (await req.json().catch(() => null)) as Partial<VoiceSettings> | null;
        if (!b) return err(400, "expected body");
        return json({ settings: await setVoiceSettings(b) });
      }

      // ---- coding-agent config: which session backends are shown in the
      // composer, plus lightweight setup health/actions for Settings.
      if (path === "/api/coding-agents" && req.method === "GET") {
        return json({ agents: await listCodingAgents() });
      }
      if (path === "/api/setup/checks" && req.method === "GET") {
        return json({ checks: await listSetupChecksCached() });
      }
      if (path === "/api/bootstrap" && req.method === "GET") {
        noteListSessionsClientActivity();
        const sessionsTask = listSessionsCached().then((sessions) => {
          warmRecentMessages(
            sessions
              .map((session) => session.transcriptPath)
              .filter((path): path is string => !!path),
            40,
          );
          warmRenderedBacklogs(sessions, 40);
          return sessions;
        });
        const reposTask = listRepos();
        const tasks = {
          agents: listAgentSummaries(),
          codingAgents: listCodingAgents(),
          sessions: sessionsTask,
          users: Promise.resolve(userRoster()),
          repos: reposTask,
          skills: reposTask.then((repos) => listSkillCatalog(repos.map((repo) => repo.cwd))),
          autoAgents: listAutoAgents(),
          findings: listFindings("open"),
          brainConfig: readSessionBrainConfig(),
          brainNotes: listSessionNotes("open"),
          brainSuggestions: listPatternSuggestions("open"),
          brainRuns: listSessionBrainRuns(12),
        };
        const taskEntries = Object.entries(tasks);
        const settled = await Promise.allSettled(taskEntries.map(([, task]) => task));
        const boot = Object.fromEntries(
          settled.map((entry, index) => [
            taskEntries[index]![0],
            entry.status === "fulfilled" ? entry.value : null,
          ]),
        ) as {
          agents?: Awaited<ReturnType<typeof listAgentSummaries>> | null;
          codingAgents?: Awaited<ReturnType<typeof listCodingAgents>> | null;
          sessions?: Awaited<ReturnType<typeof listSessionsCached>> | null;
          users?: ReturnType<typeof userRoster> | null;
          repos?: Awaited<ReturnType<typeof listRepos>> | null;
          skills?: Awaited<ReturnType<typeof listSkillCatalog>> | null;
          autoAgents?: Awaited<ReturnType<typeof listAutoAgents>> | null;
          findings?: Awaited<ReturnType<typeof listFindings>> | null;
          brainConfig?: Awaited<ReturnType<typeof readSessionBrainConfig>> | null;
          brainNotes?: Awaited<ReturnType<typeof listSessionNotes>> | null;
          brainSuggestions?: Awaited<ReturnType<typeof listPatternSuggestions>> | null;
          brainRuns?: Awaited<ReturnType<typeof listSessionBrainRuns>> | null;
        };
        return json(
          {
            agents: boot.agents ?? null,
            codingAgents: boot.codingAgents ?? null,
            sessions: boot.sessions ?? null,
            users: boot.users ?? null,
            repos: boot.repos ?? null,
            skills: boot.skills ?? null,
            auto: {
              agents: boot.autoAgents
                ? boot.autoAgents.map((a) => ({ ...a, running: isRunning(a.id) }))
                : null,
              tz: process.env.LFG_SCHED_TZ ?? "Asia/Hong_Kong",
              findings: boot.findings ?? null,
            },
            sessionBrain: {
              config: boot.brainConfig ?? null,
              notes: boot.brainNotes ?? null,
              suggestions: boot.brainSuggestions ?? null,
              runs: boot.brainRuns ?? null,
            },
          },
          { headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" } },
        );
      }
      {
        const m = path.match(/^\/api\/setup\/checks\/([a-z0-9_-]+)\/run$/);
        if (m && req.method === "POST") {
          const key = m[1];
          await runSetupAction(key);
          return json({ ok: true, checks: await listSetupChecksCached({ refresh: true }) });
        }
      }
      if (path === "/api/skills" && req.method === "GET") {
        const repoRoots = (await listRepos().catch(() => [])).map((repo) => repo.cwd);
        return json({ skills: await listSkillCatalog(repoRoots) });
      }
      {
        const m = path.match(/^\/api\/coding-agents\/([a-z0-9_-]+)$/);
        if (m && req.method === "POST") {
          const kind = m[1];
          if (!isCodingAgentKind(kind)) return err(404, "unknown coding agent");
          const b = (await req.json().catch(() => null)) as { visible?: unknown } | null;
          if (!b || typeof b.visible !== "boolean") return err(400, "expected { visible: boolean }");
          await setCodingAgentVisibility(kind, b.visible);
          return json({ agents: await listCodingAgents() });
        }
      }
      {
        const m = path.match(/^\/api\/coding-agents\/([a-z0-9_-]+)\/setup$/);
        if (m && req.method === "POST") {
          const kind = m[1];
          if (!isCodingAgentKind(kind)) return err(404, "unknown coding agent");
          void runCodingAgentSetup(kind).catch((e) =>
            console.error(`[coding-agents] ${kind} setup failed:`, e),
          );
          return json({ ok: true, agents: await listCodingAgents() });
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

      // ---- voice fleet snapshot: live status of every session plus the user's
      // standing context (~/.lfg/voice-context.md). The LiveKit worker fetches
      // this at connect to seed its system prompt and speak a proactive briefing.
      if (path === "/api/voice/snapshot" && req.method === "GET") {
        const snapshot = await voiceStatusSnapshot(url.searchParams.get("user"));
        let context = "";
        try {
          context = (
            await Bun.file(join(homedir(), ".lfg", "voice-context.md")).text()
          ).trim();
        } catch {}
        return json({ snapshot, context });
      }

      // ---- voice deep-think consult: forward a hard question to the persistent
      // Opus advisor session and return its spoken answer. The voice brain
      // (Haiku) calls this as a tool when a question needs heavier reasoning.
      if (path === "/api/voice/consult" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          question?: string;
          cwd?: string;
        } | null;
        const question = body?.question?.trim();
        if (!question) return err(400, "expected { question }");
        try {
          const answer = await voiceConsult(question, body?.cwd?.trim() || undefined);
          return json({ answer });
        } catch (e) {
          return err(502, e instanceof Error ? e.message : "consult failed");
        }
      }

      // ---- voice fleet PUSH: SSE stream of session-completion events, scoped
      // to the speaking user. The voice worker holds this open and reacts the
      // instant another session lands work (refresh its live context + speak a
      // proactive heads-up) — replacing connect-time-snapshot-only awareness.
      if (path === "/api/voice/events" && req.method === "GET") {
        const user = url.searchParams.get("user");
        let unsub: (() => void) | null = null;
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
            // Greet so the client knows the stream is live (and to flush proxies).
            send(`event: ready\ndata: {}\n\n`);
            unsub = subscribeFleet(user, (ev: FleetEvent) => {
              send(`event: completed\ndata: ${JSON.stringify(ev)}\n\n`);
            });
            hb = setInterval(() => send(`event: ping\ndata: {}\n\n`), 20000);
          },
          cancel() {
            closed = true;
            if (unsub) unsub();
            if (hb) clearInterval(hb);
          },
        });
        return new Response(stream, { headers: sseHeaders() });
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
        return json({ agents: await listAgentSummaries() });
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
            agent?: string;
            model?: string;
            thinkingLevel?: string;
            tools?: string[];
          } | null;
          if (!b?.name || !b?.prompt || !b?.schedule) {
            return err(400, "name, prompt and schedule are required");
          }
          const autoAgent = b.agent?.trim() || undefined;
          if (autoAgent && !AUTO_AGENT_BACKENDS.includes(autoAgent as any)) {
            return err(400, `unknown auto agent provider "${autoAgent}"`);
          }
          const autoBackend = autoAgent || "aisdk";
          const model = b.model?.trim() || undefined;
          if (autoBackend === "aisdk" && model && !AISDK_MODELS.includes(model))
            return err(400, `unknown model "${model}" (expected one of ${AISDK_MODELS.join(", ")})`);
          if (autoBackend === "codex-aisdk" && model && !/^[A-Za-z0-9_.:-]{1,80}$/.test(model))
            return err(400, "invalid codex model name");
          if (autoBackend === "opencode" && model && !/^[A-Za-z0-9_.:\/-]{1,80}$/.test(model))
            return err(400, "invalid opencode model name");
          if (autoBackend === "hermes" && model && !/^[A-Za-z0-9_.:\/-]{1,120}$/.test(model))
            return err(400, "invalid hermes model name");
          const thinkingLevel = b.thinkingLevel?.trim() || undefined;
          if (thinkingLevel) {
            const allowed = thinkingLevelsForAgent(autoBackend);
            if (!allowed)
              return err(400, `thinkingLevel is not supported for ${autoBackend} auto agents`);
            if (!allowed.includes(thinkingLevel))
              return err(400, `unknown thinking level "${thinkingLevel}" for ${autoBackend} (expected one of ${allowed.join(", ")})`);
          }
          const agent = await saveAutoAgent({
            id: b.id,
            name: b.name,
            prompt: b.prompt,
            schedule: b.schedule,
            enabled: b.enabled !== false,
            cwd: b.cwd,
            agent: autoAgent as any,
            model,
            thinkingLevel,
            tools: Array.isArray(b.tools) ? b.tools : undefined,
          });
          return json({ agent });
        }
      }
      // Resolve a client-supplied cwd to a KNOWN repo before we ever chdir into
      // it for a compose/enhance pass. Unknown/blank → undefined (repo-blind,
      // tool-less generation) rather than a hard error or an arbitrary chdir.
      const resolveAutoCwd = async (cwd: unknown): Promise<string | undefined> => {
        const want = typeof cwd === "string" ? cwd.trim() : "";
        if (!want) return undefined;
        return (await listRepos()).find((r) => r.cwd === want)?.cwd;
      };
      if (path === "/api/auto/enhance-prompt" && req.method === "POST") {
        const b = (await req.json().catch(() => null)) as {
          prompt?: string;
          name?: string;
          cwd?: string;
        } | null;
        if (!b?.prompt?.trim()) return err(400, "prompt is required");
        try {
          const { enhanceAutoPrompt } = await import("../auto/enhance.ts");
          const cwd = await resolveAutoCwd(b.cwd);
          const prompt = await enhanceAutoPrompt(b.prompt, b.name, cwd, (l) =>
            console.log(l),
          );
          return json({ prompt });
        } catch (e) {
          return err(502, e instanceof Error ? e.message : String(e));
        }
      }
      // Single-box create: one freeform prompt → a full agent draft (name,
      // schedule, enhanced prompt), grounded in the selected repo when given.
      // The UI saves it via POST /api/auto/agents.
      if (path === "/api/auto/compose" && req.method === "POST") {
        const b = (await req.json().catch(() => null)) as {
          prompt?: string;
          cwd?: string;
        } | null;
        if (!b?.prompt?.trim()) return err(400, "prompt is required");
        try {
          const { composeAutoAgent } = await import("../auto/enhance.ts");
          const cwd = await resolveAutoCwd(b.cwd);
          const draft = await composeAutoAgent(b.prompt, cwd, (l) =>
            console.log(l),
          );
          return json({ draft });
        } catch (e) {
          return err(502, e instanceof Error ? e.message : String(e));
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

      if (path === "/api/session-brain/notes" && req.method === "GET") {
        const status = url.searchParams.get("status") || undefined;
        return json({ notes: await listSessionNotes(status) });
      }
      if (path === "/api/session-brain/config" && req.method === "GET") {
        return json({ config: await readSessionBrainConfig() });
      }
      if (path === "/api/session-brain/config" && req.method === "POST") {
        const b = (await req.json().catch(() => null)) as {
          enabled?: boolean;
          autoClose?: boolean;
          intervalMin?: number;
          minIdleMin?: number;
          model?: string;
        } | null;
        if (!b || typeof b !== "object") return err(400, "config patch required");
        const enabled = typeof b.enabled === "boolean" ? b.enabled : undefined;
        const config = await updateSessionBrainConfig({
          enabled,
          // One visible switch controls the whole session-brain system. If a
          // caller explicitly patches autoClose we still honor it for
          // compatibility, otherwise enabling/disabling the brain carries the
          // cleanup behavior with it.
          autoClose: typeof b.autoClose === "boolean" ? b.autoClose : enabled,
          intervalMin: typeof b.intervalMin === "number" ? b.intervalMin : undefined,
          minIdleMin: typeof b.minIdleMin === "number" ? b.minIdleMin : undefined,
          model: typeof b.model === "string" && b.model.trim() ? b.model.trim() : undefined,
        });
        return json({ config });
      }
      if (path === "/api/session-brain/suggestions" && req.method === "GET") {
        const status = url.searchParams.get("status") || undefined;
        return json({ suggestions: await listPatternSuggestions(status) });
      }
      if (path === "/api/session-brain/runs" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit")) || 20;
        return json({ runs: await listSessionBrainRuns(limit) });
      }
      if (path === "/api/session-brain/run" && req.method === "POST") {
        const b = (await req.json().catch(() => null)) as {
          autoClose?: boolean;
          limit?: number;
        } | null;
        const run = await runSessionBrain(
          { autoClose: b?.autoClose, limit: b?.limit },
          (l) => console.log(l),
        );
        return json({ run });
      }
      {
        const m = path.match(/^\/api\/session-brain\/notes\/([a-z0-9]+)\/status$/);
        if (m && req.method === "POST") {
          const b = (await req.json().catch(() => null)) as { status?: string } | null;
          const status = b?.status;
          if (
            status !== "open" &&
            status !== "snoozed" &&
            status !== "done" &&
            status !== "dismissed"
          )
            return err(400, "invalid note status");
          const note = await updateSessionNoteStatus(m[1], status as SessionNoteStatus);
          if (!note) return err(404, "note not found");
          return json({ note });
        }
      }
      {
        const m = path.match(/^\/api\/session-brain\/suggestions\/([a-z0-9]+)\/status$/);
        if (m && req.method === "POST") {
          const b = (await req.json().catch(() => null)) as { status?: string } | null;
          const status = b?.status;
          if (status !== "open" && status !== "accepted" && status !== "dismissed")
            return err(400, "invalid suggestion status");
          const suggestion = await updatePatternSuggestionStatus(
            m[1],
            status as PatternSuggestionStatus,
          );
          if (!suggestion) return err(404, "suggestion not found");
          return json({ suggestion });
        }
      }

      // ── Client (frontend) error auto-report → auto-fix ────────────────────
      // The web app funnels uncaught errors here. Each report is stored, shown
      // to the human via the findings feed + push, and (for real shipped builds)
      // an Opus fix agent is dispatched. Heavily storm-guarded inside the module
      // — a render loop can't fork a fleet of agents. Always 200s so a reporting
      // failure never cascades back into the page that's already broken.
      if (path === "/api/client-error" && req.method === "POST") {
        const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        if (!b || typeof b.message !== "string" || !b.message.trim())
          return err(400, "missing message");
        try {
          const r = await reportClientError(b as Parameters<typeof reportClientError>[0]);
          return json(r);
        } catch (e) {
          console.error("[client-error] report failed:", e);
          return json({ stored: false, reported: false, dispatched: false });
        }
      }
      if (path === "/api/client-errors" && req.method === "GET") {
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 1), 1000);
        return json({ errors: await listClientErrors(limit) });
      }

      // ── Web Push (PWA notifications) ──────────────────────────────────────
      // The VAPID public key the browser needs for pushManager.subscribe().
      if (path === "/api/push/vapid" && req.method === "GET") {
        return json({ key: await vapidPublicKey() });
      }
      // Register / refresh a browser subscription.
      if (path === "/api/push/subscribe" && req.method === "POST") {
        const b = (await req.json().catch(() => null)) as
          | (PushSubscription & { user?: string | null })
          | null;
        if (!b?.endpoint) return err(400, "missing endpoint");
        await saveSubscription(b);
        return json({ ok: true });
      }
      // Drop a subscription (user turned notifications off / re-subscribed).
      if (path === "/api/push/unsubscribe" && req.method === "POST") {
        const b = (await req.json().catch(() => null)) as { endpoint?: string } | null;
        if (b?.endpoint) await removeSubscription(b.endpoint);
        return json({ ok: true });
      }
      // Per-device notification feed: resolve this subscription's bound user and
      // return ONLY that user's pending items. The service worker calls this on
      // a (payload-less) push so it never renders another user's question.
      if (path === "/api/push/pending" && req.method === "GET") {
        const endpoint = url.searchParams.get("endpoint");
        const me = endpoint ? await subscriptionUser(endpoint) : null;
        const openQs = await listQuestions("open");
        const questions = me ? openQs.filter((q) => q.user === me) : openQs;
        // Findings are global (not user-private), so they pass through as-is.
        const findings = await listFindings("open");
        return json({ user: me, questions, findings });
      }

      // ── Ask-user (human-in-the-loop for headless agents) ──────────────────
      // List open/all questions — the UI poller and the voice agent both read
      // this so they can surface and answer what's pending.
      if (path === "/api/ask" && req.method === "GET") {
        const status = url.searchParams.get("status") as
          | "open"
          | "answered"
          | "expired"
          | null;
        const user = url.searchParams.get("user");
        let rows = await listQuestions(status ?? undefined);
        if (user) rows = rows.filter((q) => !q.user || q.user === user);
        return json({ questions: rows });
      }
      // Agent asks a question. Raises a push, then long-polls for the answer so
      // the caller's tool blocks until a human responds (or it times out, at
      // which point the agent decides how to proceed). wait=0 returns immediately
      // with just the id for fire-and-forget asks.
      if (path === "/api/ask" && req.method === "POST") {
        const b = (await req.json().catch(() => null)) as {
          question?: string;
          options?: string[];
          agentId?: string | null;
          sessionId?: string | null;
          user?: string | null;
          wait?: boolean;
          timeoutMs?: number;
        } | null;
        if (!b?.question?.trim()) return err(400, "missing question");
        const q = await addQuestion({
          question: b.question,
          options: b.options,
          agentId: b.agentId,
          sessionId: b.sessionId,
          user: b.user,
        });
        // Wake the user with a push (user-scoped). Voice talk-back happens when
        // they engage: open questions are surfaced in the voice snapshot below,
        // so the voice agent can read them out and answer on the user's behalf.
        void notifyAll({ user: q.user }).catch(() => {});
        if (b.wait === false) return json({ id: q.id, status: q.status });
        // Cap the block so a stuck request can't pin a connection forever.
        const timeoutMs = Math.min(Math.max(b.timeoutMs ?? 180_000, 1_000), 600_000);
        const answered = await waitForAnswer(q.id, timeoutMs);
        if (!answered || answered.status !== "answered") {
          return json({ id: q.id, status: "open", answer: null });
        }
        return json({ id: q.id, status: "answered", answer: answered.answer });
      }
      // Poll a single question (for agents that asked with wait=0).
      {
        const m = path.match(/^\/api\/ask\/([0-9a-f]+)$/);
        if (m && req.method === "GET") {
          const q = await getQuestion(m[1]);
          if (!q) return err(404, "unknown question");
          return json({ question: q });
        }
      }
      // Answer a question — from the web composer OR the voice agent on the
      // user's behalf. Wakes any blocked long-poll.
      {
        const m = path.match(/^\/api\/ask\/([0-9a-f]+)\/answer$/);
        if (m && req.method === "POST") {
          const b = (await req.json().catch(() => null)) as {
            answer?: string;
            via?: "voice" | "web";
          } | null;
          if (!b?.answer?.trim()) return err(400, "missing answer");
          const q = await answerQuestion(m[1], { answer: b.answer.trim(), via: b.via });
          if (!q) return err(404, "unknown or already-answered question");
          // Deliver the reply to the target session NOW (the answer IS the
          // user's consent), deterministically — don't wait for the supervisor's
          // next run to re-interpret it. Reuse the validated /send and /close
          // routes via a loopback call. On any failure we leave the question
          // "answered" so the supervisor's STEP 1 still backstops it.
          if (q.sessionId) {
            const plan = plannedSessionAction(q.answer ?? "");
            try {
              if (plan.kind === "send") {
                const r = await fetch(
                  `http://127.0.0.1:${PORT}/api/sessions/${q.sessionId}/send`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: plan.text }),
                  },
                );
                if (r.ok) await markHandled(q.id);
              } else if (plan.kind === "close") {
                const r = await fetch(
                  `http://127.0.0.1:${PORT}/api/sessions/${q.sessionId}/close`,
                  { method: "POST" },
                );
                if (r.ok) await markHandled(q.id);
              } else {
                await markHandled(q.id); // "leave it" — resolved, nothing to deliver
              }
            } catch {
              // loopback failed — leave answered; STEP 1 retries next run
            }
          }
          return json({ question: q });
        }
      }
      // Mark an answered question as acted-upon (the supervisor calls this after
      // it carries out the user's decision, so it doesn't act on it again).
      {
        const m = path.match(/^\/api\/ask\/([0-9a-f]+)\/handled$/);
        if (m && req.method === "POST") {
          const q = await markHandled(m[1]);
          if (!q) return err(404, "unknown or not-yet-answered question");
          return json({ question: q });
        }
      }
      {
        const m = path.match(/^\/api\/auto\/findings\/([0-9a-f]+)$/);
        if (m && req.method === "POST") {
          const b = (await req.json().catch(() => null)) as {
            status?: "open" | "dismissed" | "session" | "read";
            sessionId?: string;
          } | null;
          const patch: { status?: NonNullable<typeof b>["status"]; sessionId?: string } = {};
          if (b?.status) patch.status = b.status;
          if (b?.sessionId) patch.sessionId = b.sessionId;
          const f = await updateFinding(m[1], patch);
          if (!f) return err(404, "unknown finding");
          return json({ finding: f });
        }
      }

      // Instrumentation: which CTA the user tapped on a finding, and whether
      // they had typed an instruction first. Fire-and-forget from the client.
      {
        const m = path.match(/^\/api\/auto\/findings\/([0-9a-f]+)\/action$/);
        if (m && req.method === "POST") {
          const b = (await req.json().catch(() => null)) as {
            path?: FindingActionPath;
            hadText?: boolean;
          } | null;
          if (b?.path !== "reply" && b?.path !== "execute" && b?.path !== "dismiss")
            return err(400, "expected { path: reply|execute|dismiss }");
          await logFindingAction({
            findingId: m[1],
            path: b.path,
            hadText: !!b.hadText,
          });
          return json({ ok: true });
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
        // no-cache so the browser revalidates the roster on each load and picks
        // up the rotated avatar cache-buster (see gravatar()) rather than
        // serving a stale roster from heuristic HTTP caching.
        return json({ users: userRoster() }, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
          },
        });
      }

      // ---- cloud-browser profiles ----
      // Save a real login once (interactive stream), reuse it from an agent's
      // headless browser forever after.
      if (path === "/api/browser/profiles" && req.method === "GET") {
        // Frontend (BrowserProfiles.tsx) expects a bare ProfileMeta[].
        return json(await listProfiles());
      }
      if (path === "/api/browser/profiles" && req.method === "POST") {
        const b = (await req.json().catch(() => null)) as
          | { url?: unknown; viewport?: unknown }
          | null;
        const u = typeof b?.url === "string" ? b.url.trim() : "";
        if (!u) return err(400, "url is required");
        const { id } = await startLoginSession(u, {
          viewport: b?.viewport as Partial<Viewport> | null | undefined,
        });
        return json({ sessionId: id });
      }
      {
        const m = path.match(/^\/api\/browser\/profiles\/([^/]+)\/reauth$/);
        if (m && req.method === "POST") {
          const id = decodeURIComponent(m[1]);
          const prof = await getProfile(id);
          if (!prof) return err(404, "unknown profile");
          const target = prof.origins[0] || "about:blank";
          const b = (await req.json().catch(() => null)) as
            | { viewport?: unknown }
            | null;
          const { id: sid } = await startLoginSession(target, {
            existingProfileId: id,
            viewport: b?.viewport as Partial<Viewport> | null | undefined,
          });
          return json({ sessionId: sid });
        }
      }
      {
        const m = path.match(/^\/api\/browser\/profiles\/([^/]+)\/test$/);
        if (m && req.method === "POST") {
          const id = decodeURIComponent(m[1]);
          const prof = await getProfile(id);
          if (!prof) return err(404, "unknown profile");
          return json(await testProfile(id));
        }
      }
      {
        const m = path.match(/^\/api\/browser\/profiles\/([^/]+)$/);
        if (m && req.method === "DELETE") {
          await deleteProfile(decodeURIComponent(m[1]));
          return json({ ok: true });
        }
      }

      // ---- running claude sessions ----
      if (path === "/api/repos") {
        if (req.method === "POST") {
          const b = (await req.json().catch(() => null)) as {
            path?: unknown;
            name?: unknown;
          } | null;
          const rawPath = typeof b?.path === "string" ? b.path : "";
          if (!rawPath.trim()) return err(400, "path is required");
          const rawName = typeof b?.name === "string" ? b.name : undefined;
          try {
            await addCustomRepo(rawPath, rawName);
          } catch (e) {
            return err(400, e instanceof Error ? e.message : String(e));
          }
          return json({ repos: await listRepos() });
        }
        if (req.method === "DELETE") {
          const b = (await req.json().catch(() => null)) as { cwd?: unknown } | null;
          const cwd = typeof b?.cwd === "string" ? b.cwd : "";
          if (!cwd.trim()) return err(400, "cwd is required");
          await removeCustomRepo(cwd);
          return json({ repos: await listRepos() });
        }
        return json({ repos: await listRepos() });
      }

      if (path === "/api/sessions") {
        noteListSessionsClientActivity();
        const sessions = await listSessionsCached();
        warmRecentMessages(
          sessions
            .map((session) => session.transcriptPath)
            .filter((path): path is string => !!path),
          40,
        );
        warmRenderedBacklogs(sessions, 40);
        return json({ sessions });
      }

      if (path === "/api/install") {
        return json({ install: installInfo() });
      }

      // Combined usage/limits across every agent provider (Claude, Codex,
      // Grok, OpenCode) for the Settings → Usage page. Each provider is
      // self-cached for 60s inside getAllUsage().
      if (path === "/api/usage") {
        return json({ providers: await getAllUsage() });
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
        const liveIds = await liveSessionIdsCached();
        const limit = Number(url.searchParams.get("limit")) || 30;
        const offset = Number(url.searchParams.get("offset")) || 0;
        const search = url.searchParams.get("search")?.trim() || undefined;
        const agentParam = url.searchParams.get("agent")?.trim();
        const agent = agentParam === "claude" || agentParam === "codex" ? agentParam : undefined;
        const project = url.searchParams.get("project")?.trim() || undefined;
        const { sessions, total, facets } = await queryResumable({
          limit,
          offset,
          search,
          agent,
          project,
          excludeIds: liveIds,
        });
        return json({ sessions, total, facets });
      }

      // Resume a closed session in its original cwd as a fresh managed session,
      // preserving the full conversation. Two engines:
      //  - claude: relaunch `claude --resume <id>`; it continues into a NEW
      //    sessionId, resolved from the pidfile (like /new) and handed back.
      //  - codex: spawn a codex-aisdk harness seeded with the rollout's threadId
      //    (== the resumed id). Codex resumes the SAME thread, so the live id
      //    stays the resumed id — we return it directly.
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
        // Already running? Don't double-spawn — point the client at the live one.
        const live = (await listSessions()).find(
          (s) => s.sessionId === sessionId || s.nativeSessionId === sessionId,
        );
        if (live) {
          if (body?.user && live.tmuxName) assignUser(live.tmuxName, body.user);
          const prompt = body?.prompt?.trim() ?? "";
          const sent = prompt
            // Resuming a session that is already live is a follow-up, not a
            // steering action. Queue it so a status/check click does not abort
            // the active turn or any Claude sidechain Explore agents.
            ? sendPromptToLiveSession(live, prompt, { mode: "queue" })
            : { ok: true as const, msg: undefined };
          if (!sent.ok) return err(409, sent.error || "couldn't send resume prompt");
          return json({
            ok: true,
            tmuxName: live.tmuxName,
            cwd: live.cwd,
            sessionId: live.sessionId ?? sessionId,
            resumedFrom: live.nativeSessionId ?? sessionId,
            alreadyLive: true,
            sentPrompt: !!prompt,
            msg: sent.msg,
            agent: live.agent,
          });
        }
        const transcript = await resolveTranscript(sessionId);
        if (!transcript) return err(404, "no transcript found for that session");
        const cachedResume = getCachedResumableSession(sessionId);

        // Codex rollouts live under ~/.codex/sessions — resume them through a
        // codex-aisdk harness keyed to the rollout's threadId rather than the
        // claude CLI.
        if (transcript.includes("/.codex/")) {
          const cwd = (await cwdForCodexTranscript(transcript)) ?? SELF_REPO;
          const tmuxName = `lfg-${randomBytes(3).toString("hex")}`;
          const key = crypto.randomUUID(); // control-plane key (names registry/cmd files)
          const r = spawnManagedCodexAisdkSession({
            name: tmuxName,
            cwd,
            prompt: body?.prompt,
            model: model ?? "gpt-5.5",
            key,
            resume: sessionId,
          });
          if (!r.ok) return err(502, r.error || "failed to resume session");
          addManaged({
            tmuxName,
            cwd,
            createdAt: Date.now(),
            agent: "codex-aisdk",
            sessionId: key,
            nativeSessionId: sessionId,
            launchState: "running",
            model: model ?? "gpt-5.5",
            title: body?.prompt?.slice(0, 72),
            project: cachedResume?.project || undefined,
            repoRoot: repoRootForManagedCwd(cwd),
          });
          if (body?.user) assignUser(tmuxName, body.user);
          // Wait for the harness to register so the session is listable. The
          // threadId is seeded up front (== resumedFrom), so it's the live id.
          for (let i = 0; i < 20 && !readAisdkEntry(key); i++)
            await new Promise((res) => setTimeout(res, 250));
          return json({
            ok: true,
            tmuxName,
            cwd,
            sessionId: key,
            resumedFrom: sessionId,
            agent: "codex-aisdk",
          });
        }

        // claude path: resume drives the claude CLI.
        if (model && !CLAUDE_MODELS.includes(model))
          return err(400, `unknown model "${model}" (expected one of ${CLAUDE_MODELS.join(", ")})`);
        const cwd = (await cwdForTranscript(transcript)) ?? SELF_REPO;
        const tmuxName = `lfg-${randomBytes(3).toString("hex")}`;
        const resumePrompt =
          body?.prompt?.trim() ||
          "Resume this session and stay open. Do not start new work yet; wait for my next instruction.";
        const r = spawnManagedSession({
          name: tmuxName,
          cwd,
          model,
          resume: sessionId,
          prompt: resumePrompt,
        });
        if (!r.ok) return err(502, r.error || "failed to resume session");
        addManaged({
          tmuxName,
          cwd,
          createdAt: Date.now(),
          agent: "claude",
          project: cachedResume?.project || undefined,
          repoRoot: repoRootForManagedCwd(cwd),
        });
        if (body?.user) assignUser(tmuxName, body.user);
        // Claude Code 2.1+ blocks a heavy `--resume` at a "Resume from summary /
        // full / don't ask again" selector. Nobody is at the pane to answer it,
        // so without this the session freezes at the menu and never forks a new
        // id below (looks like resume is broken). Answer it before we poll.
        await dismissResumeSummaryGate(tmuxName);
        // Claude resumes into a fresh sessionId/transcript — wait for the pidfile.
        let newId: string | null = null;
        for (let i = 0; i < 12 && !newId; i++) {
          await new Promise((res) => setTimeout(res, 500));
          const pid = panePidForSession(tmuxName);
          if (pid) newId = sessionIdForPid(pid);
        }
        if (!newId) {
          const resumed = (await listSessions()).find(
            (s) => s.tmuxName === tmuxName || s.sessionId === sessionId || s.nativeSessionId === sessionId,
          );
          if (!resumed?.sessionId)
            return err(502, "session resumed, but no live session id was discovered");
          newId = resumed.sessionId;
        }
        // Anchor the live id onto the managed record so listSessions recognizes
        // the resumed session immediately (and keeps its visible id stable)
        // rather than depending solely on per-request pgrep/pidfile resolution
        // during the compaction window.
        patchManaged(tmuxName, { nativeSessionId: newId });
        return json({ ok: true, tmuxName, cwd, sessionId: newId, resumedFrom: sessionId, agent: "claude" });
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/fork$/);
        if (m && req.method === "POST") {
          const sourceId = m[1];
          const body = (await req.json().catch(() => null)) as {
            prompt?: string;
            user?: string;
            model?: string;
            thinkingLevel?: string;
            agent?: "claude" | "codex" | "aisdk" | "codex-aisdk" | "opencode" | "grok" | "hermes";
          } | null;
          const source = (await listSessions()).find((s) => s.sessionId === sourceId);
          const transcript = await resolveTranscript(sourceId);
          if (!transcript) return err(404, "source session transcript not found");

          const transcriptCwd = transcript.includes("/.codex/")
            ? await cwdForCodexTranscript(transcript).catch(() => null)
            : await cwdForTranscript(transcript).catch(() => null);
          const sourceCwd = source?.cwd || transcriptCwd || SELF_REPO;
          const repos = await listRepos();
          const repo =
            repos.find((r) => r.cwd === sourceCwd) ??
            repos.find((r) => r.project === source?.project) ??
            repos.find((r) => r.project === projectName(sourceCwd));
          if (!repo) return err(400, "source session repo is not in the repo picker");

          const extra = body?.prompt?.trim();
          const title =
            source?.title ||
            source?.lastUserText ||
            source?.tmuxName ||
            source?.project ||
            sourceId;
          const prompt = [
            "You are starting a fresh agent session from an existing lfg session.",
            "",
            "This is NOT a resume. Treat the source transcript as read-only context, then follow the user's extra prompt below.",
            "",
            `Source session id: ${sourceId}`,
            `Source title: ${title}`,
            `Source cwd: ${sourceCwd}`,
            `Source transcript JSONL: ${transcript}`,
            "",
            "Read the transcript file directly before acting.",
            "",
            "User's extra prompt:",
            extra || "Review the source transcript and continue with the most useful next step.",
          ].join("\n");

          const r = await fetch(`http://127.0.0.1:${PORT}/api/sessions/new`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              cwd: repo.cwd,
              prompt,
              user: body?.user || source?.assignedUser || undefined,
              agent: body?.agent,
              model: body?.model,
              thinkingLevel: body?.thinkingLevel,
            }),
          });
          const text = await r.text();
          return new Response(text, {
            status: r.status,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      if (path === "/api/sessions/new" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          cwd?: string;
          prompt?: string;
          user?: string;
          voice?: boolean;
          worktree?: boolean;
          model?: string;
          thinkingLevel?: string;
          parentSessionId?: string;
          spawnedBy?: string;
          agent?: "claude" | "codex" | "aisdk" | "codex-aisdk" | "opencode" | "grok" | "hermes";
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
                : body?.agent === "grok"
                  ? "grok"
                  : body?.agent === "hermes"
                    ? "hermes"
                    : body?.agent === "claude"
                      ? "claude"
                      : "aisdk";
        // Allowlist Claude models — they land on a shell argv. Unknown value =
        // hard 400, never a silent fallback to some other model. Codex model
        // names are provider/catalog driven, so validate shape instead.
        const requestedModel = body?.model?.trim() || undefined;
        const model =
          agent === "opencode" && requestedModel && OPENCODE_DISABLED_MODELS.has(requestedModel)
            ? OPENCODE_DEFAULT_MODEL
            : requestedModel;
        if (agent === "claude" && model && !CLAUDE_MODELS.includes(model))
          return err(400, `unknown model "${model}" (expected one of ${CLAUDE_MODELS.join(", ")})`);
        if (agent === "codex" && model && !/^[A-Za-z0-9_.:-]{1,80}$/.test(model))
          return err(400, "invalid codex model name");
        if (agent === "aisdk" && model && !AISDK_MODELS.includes(model))
          return err(400, `unknown model "${model}" (expected one of ${AISDK_MODELS.join(", ")})`);
        if (agent === "grok" && model && !GROK_MODELS.includes(model))
          return err(400, `unknown model "${model}" (expected one of ${GROK_MODELS.join(", ")})`);
        if (agent === "hermes" && model && !/^[A-Za-z0-9_.:\/-]{1,120}$/.test(model))
          return err(400, "invalid hermes model name");
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
        const thinkingLevel = body?.thinkingLevel?.trim() || undefined;
        // Thinking mode is supported on every agent kind that exposes a
        // reasoning-effort knob: Codex (reasoning_effort) and Claude (the claude
        // CLI's --effort / the claude-code provider's `effort`). opencode is the
        // lone exception — its provider exposes no per-call thinking control
        // (effort is set in opencode's own model config instead). Validate the
        // value against THAT agent's own level set so an out-of-range value (a
        // voice-supplied `none` for Claude, or `max` for Codex) is a clean 400
        // rather than a session that boots straight into a provider error.
        if (thinkingLevel) {
          const allowed = thinkingLevelsForAgent(agent);
          if (!allowed)
            return err(400, `thinkingLevel is not supported for ${agent} sessions`);
          if (!allowed.includes(thinkingLevel))
            return err(400, `unknown thinking level "${thinkingLevel}" for ${agent} (expected one of ${allowed.join(", ")})`);
        }
        // Always spawn in a trusted folder — claude shows a blocking "trust this
        // folder?" dialog for any untrusted cwd, which hangs session startup. The
        // lfg-sessions skill is installed user-level (~/.claude/skills) so the
        // voice/orchestrator agent gets it regardless of cwd.
        const requestedCwd = body?.cwd?.trim() || SELF_REPO;
        const repo = (await listRepos()).find((r) => r.cwd === requestedCwd);
        if (!repo) return err(400, "unknown repo");
        const parentId = body?.parentSessionId?.trim() || undefined;
        const parent = parentId
          ? (await listSessions()).find(
              (s) => s.sessionId === parentId || s.nativeSessionId === parentId,
            )
          : undefined;
        if (parentId && !parent) return err(404, "parent session not found");
        const tmuxName = `lfg-${randomBytes(3).toString("hex")}`;
        const cwdResolved = resolveSessionCwd(repo.cwd, tmuxName, {
          voice: !!body?.voice,
          worktree: body?.worktree,
          selfRepo: SELF_REPO,
        });
        if (!cwdResolved.ok) return err(502, cwdResolved.error);
        const cwd = cwdResolved.cwd;
        const worktree = cwdResolved.worktree;
        // For the voice orchestrator, append a live snapshot of every OTHER
        // session (built before this one spawns, so it's not in the list) so its
        // first spoken reply can be a proactive blockers-first status briefing.
        let prompt = body?.prompt;
        if (body?.voice) {
          // Clear lingering state from any previous voice session before this
          // one starts: retire the persistent deep-think advisor so it doesn't
          // carry the prior session's conversation context into this one. The
          // snapshot below is already rebuilt fresh each time.
          await retireVoiceAdvisor();
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
        // Grok does not write ~/.grok/active_sessions.json until a real
        // conversation starts, so a newly-opened blank TUI has no native id yet.
        // Mint a stable lfg id up front; listSessions maps it to Grok's native
        // transcript later once Grok creates one.
        const grokKey = agent === "grok" ? crypto.randomUUID() : null;
        const hermesKey = agent === "hermes" ? crypto.randomUUID() : null;
        const launchId =
          aisdkSessionId ??
          codexAisdkKey ??
          opencodeKey ??
          grokKey ??
          hermesKey ??
          crypto.randomUUID();
        const createdAt = Date.now();
        const launchModel =
          agent === "grok"
            ? model ?? GROK_DEFAULT_MODEL
            : agent === "hermes"
              ? model ?? HERMES_DEFAULT_MODEL
              : agent === "opencode"
                ? model ?? OPENCODE_DEFAULT_MODEL
                : agent === "codex-aisdk"
                  ? model ?? "gpt-5.5"
                  : agent === "aisdk"
                    ? model ?? "opus"
                    : model;
        addManaged({
          tmuxName,
          cwd,
          createdAt,
          agent,
          sessionId: launchId,
          nativeSessionId:
            agent === "aisdk" || agent === "opencode" || agent === "hermes"
              ? launchId
              : undefined,
          launchState: "launching",
          model: launchModel,
          title: prompt?.slice(0, 72),
          project: repo.project,
          parentSessionId: parent?.sessionId ?? parentId,
          parentNativeSessionId: parent?.nativeSessionId ?? undefined,
          parentAgent: parent?.agent,
          spawnedBy: body?.spawnedBy?.trim() || (parent ? "subagent" : undefined),
          repoRoot: worktree?.repoRoot,
          worktreeBranch: worktree?.branch,
        });
        invalidateListSessionsCache();
        // Tag the new session before spawn so a concurrent /api/sessions refresh
        // can show the durable row under the right user filter immediately.
        if (body?.user || parent?.assignedUser) assignUser(tmuxName, body?.user || parent?.assignedUser || null);
        const r =
          agent === "codex"
            ? spawnManagedCodexSession({ name: tmuxName, cwd, prompt, model, thinkingLevel, lfgSessionId: launchId })
            : agent === "grok"
              ? spawnManagedGrokSession({
                  name: tmuxName,
                  cwd,
                  prompt,
                  model: model ?? GROK_DEFAULT_MODEL,
                  thinkingLevel,
                  lfgSessionId: launchId,
                })
            : agent === "hermes"
              ? spawnManagedHermesSession({
                  name: tmuxName,
                  cwd,
                  model: model ?? HERMES_DEFAULT_MODEL,
                  provider: HERMES_PROVIDER,
                  lfgSessionId: launchId,
                })
            : agent === "aisdk"
              ? spawnManagedAisdkSession({
                  name: tmuxName,
                  cwd,
                  prompt,
                  model: model ?? "opus",
                  sessionId: aisdkSessionId!,
                  thinkingLevel,
                  lfgSessionId: launchId,
                })
              : agent === "codex-aisdk"
                ? spawnManagedCodexAisdkSession({
                    name: tmuxName,
                    cwd,
                    prompt,
                    model: model ?? "gpt-5.5",
                    key: codexAisdkKey!,
                    thinkingLevel,
                    lfgSessionId: launchId,
                  })
                : agent === "opencode"
                  ? spawnManagedOpencodeAisdkSession({
                      name: tmuxName,
                      cwd,
                      prompt,
                      model: model ?? OPENCODE_DEFAULT_MODEL,
                      key: opencodeKey!,
                      lfgSessionId: launchId,
                    })
                  : spawnManagedSession({ name: tmuxName, cwd, prompt, model, thinkingLevel, lfgSessionId: launchId });
        if (!r.ok) {
          removeManaged(tmuxName);
          assignUser(tmuxName, null);
          return err(502, r.error || "failed to start session");
        }
        if (agent === "hermes" && hermesKey && prompt?.trim()) {
          enqueueMessage(hermesKey, prompt);
        }
        if (agent === "codex") {
          void (async () => {
            for (let i = 0; i < 12; i++) {
              await new Promise((res) => setTimeout(res, 500));
              if (dismissCodexUpdatePrompt(`${tmuxName}:0.0`)) break;
            }
          })();
        }
        if (agent === "aisdk" || agent === "opencode" || agent === "hermes")
          patchManaged(tmuxName, { launchState: "running" });
        return json({
          ok: true,
          tmuxName,
          cwd,
          sessionId: launchId,
          agent,
          parentSessionId: parent?.sessionId ?? parentId ?? null,
          worktree: worktree?.path ?? null,
        });
      }

      {
        const m = path.match(/^\/api\/artifacts\/([a-z0-9-]+)$/);
        if (m && req.method === "GET") {
          const artifact = getImageArtifact(m[1]);
          if (!artifact) return err(404, "artifact not found");
          const file = Bun.file(artifact.filePath);
          if (!(await file.exists())) return err(404, "artifact file not found");
          return new Response(file, {
            headers: {
              "Content-Type": artifact.mimeType,
              "Cache-Control": "private, max-age=31536000, immutable",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/artifacts\/images$/);
        if (m && req.method === "POST") {
          const body = (await req.json().catch(() => null)) as {
            path?: string;
            caption?: string;
            alt?: string;
          } | null;
          if (!body?.path?.trim()) return err(400, "path required");
          try {
            const artifact = createImageArtifact({
              sessionId: m[1],
              path: body.path,
              caption: body.caption,
              alt: body.alt,
            });
            return json({ ok: true, artifact, message: imageArtifactToMessage(artifact) });
          } catch (e) {
            return err(400, e instanceof Error ? e.message : "could not create image artifact");
          }
        }
      }

      {
        // Pre-session file attach for the home composer. The browser uploads
        // first, then includes the returned absolute paths in /api/sessions/new's
        // initial prompt.
        if (path === "/api/uploads" && req.method === "POST") {
          try {
            const uploaded = await persistUpload(req, uploadFilename(req, url), "new-session");
            return json({ ok: true, ...uploaded });
          } catch (e) {
            return err(400, e instanceof Error ? e.message : "upload failed");
          }
        }
      }

      {
        // File attach: the browser POSTs raw bytes; we persist them and hand
        // back an absolute path. The client then includes that path in the
        // message text — coding agents can read local files, and Claude Code
        // treats local image paths as image input.
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/upload$/);
        if (m && req.method === "POST") {
          try {
            const uploaded = await persistUpload(req, uploadFilename(req, url), m[1]);
            return json({ ok: true, ...uploaded });
          } catch (e) {
            return err(400, e instanceof Error ? e.message : "upload failed");
          }
        }
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/send$/);
        if (m && req.method === "POST") {
          const body = (await req.json().catch(() => null)) as {
            text?: string;
            mode?: "steer" | "queue";
          } | null;
          const text = body?.text?.trim();
          if (!text) return err(400, "expected { text }");
          const mode = body?.mode === "queue" ? "queue" : "steer";
          const sess = (await listSessions()).find(
            (s) => s.sessionId === m[1] || s.nativeSessionId === m[1],
          );
          if (!sess) return err(404, "session not found");
          const sent = sendPromptToLiveSession(sess, text, { mode });
          if (!sent.ok) return err(409, sent.error || "couldn't send message");
          return json({ ok: true, msg: sent.msg });
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
          if (sess.agent === "opencode") {
            if (!/^[A-Za-z0-9_.:\/-]{1,80}$/.test(model))
              return err(400, "invalid opencode model name");
            if (OPENCODE_DISABLED_MODELS.has(model))
              return err(409, `${model} is disabled because the configured provider returns 403`);
            const key = findAisdkEntryByAnyId(m[1])?.sessionId ?? m[1];
            appendAisdkCmd(key, { type: "set_model", model });
            return json({ ok: true, model });
          }
          if (sess.agent === "hermes") {
            if (!/^[A-Za-z0-9_.:\/-]{1,120}$/.test(model))
              return err(400, "invalid hermes model name");
            if (!sess.tmuxTarget)
              return err(409, "session is not in a tmux pane — cannot change model");
            const msg = enqueueMessage(m[1], `/model ${model}`);
            return json({ ok: true, msg });
          }
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
            const nativeSessionId = sess.nativeSessionId ?? sess.sessionId;
            if (!nativeSessionId || !sess.cwd)
              return err(409, "cannot relaunch: session id or cwd unknown");
            const r = relaunchSessionWithModel({
              tmuxTarget: sess.tmuxTarget,
              cwd: sess.cwd,
              sessionId: nativeSessionId,
              model,
            });
            if (!r.ok) return err(500, r.error || "relaunch failed");
            // Same 2.1+ resume gate as /api/sessions/resume — the relaunched pane
            // is a `--resume`, so answer the summary selector or the build freezes
            // at the menu instead of continuing on the new model.
            await dismissResumeSummaryGate(sess.tmuxTarget);
            return json({ ok: true, relaunched: true, model });
          }
          const msg = enqueueMessage(m[1], `/model ${model}`);
          return json({ ok: true, msg });
        }
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/queue$/);
        if (m && req.method === "GET") {
          await reconcileQueued(m[1]);
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
          enqueueTranscriptIndex(tp, m[1]);
          if (url.searchParams.get("page") === "backward") {
            const rawLimit = parseInt(url.searchParams.get("limit") ?? "220", 10);
            const rawBefore = url.searchParams.get("before");
            const before =
              rawBefore == null ? null : Math.max(0, parseInt(rawBefore, 10) || 0);
            const page =
              (await indexedMessagePage(tp, m[1], {
                before,
                limit: Number.isFinite(rawLimit) ? rawLimit : 220,
              })) ??
              (await messagePage(tp, {
                before,
                limit: Number.isFinite(rawLimit) ? rawLimit : 220,
              }));
            return json({
              id: m[1],
              total: page.total,
              nextBefore: page.nextBefore,
              messages: transcriptMessagesForClient(m[1], page.messages).map(msgWithHtml),
            });
          }
          const full = url.searchParams.get("full") === "1";
          const rawLimit = parseInt(url.searchParams.get("limit") ?? (full ? "0" : "30"), 10);
          const lim = full
            ? Math.max(0, Math.min(20000, Number.isFinite(rawLimit) ? rawLimit : 0))
            : Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 30));
          if (!full) {
            const page = await indexedMessagePage(tp, m[1], { limit: lim });
            if (page) {
              return json({
                id: m[1],
                messages: transcriptMessagesForClient(m[1], page.messages).map(msgWithHtml),
              });
            }
          }
          return json({
            id: m[1],
            messages: transcriptMessagesForClient(
              m[1],
              await (full ? recentMessages : recentMessagesCached)(tp, lim, {
                maxBytes: full ? null : undefined,
              }),
            ).map(msgWithHtml),
          });
        }
      }

      {
        // Full-text search inside a session's transcript — lets the voice agent
        // (and any client) answer "what did session X say about Y?" without
        // streaming the whole history. Resolves the transcript path the same way
        // as /messages, then greps normalized prose. POST so the query can carry
        // spaces/punctuation cleanly.
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/transcript\/search$/);
        if (m && req.method === "POST") {
          const tp = await resolveTranscript(m[1]);
          if (!tp) return err(404, "session transcript not found");
          const body = (await req.json().catch(() => null)) as {
            query?: string;
            limit?: number;
          } | null;
          const query = body?.query?.trim();
          if (!query) return err(400, "expected { query }");
          const r = await searchTranscriptIndex(tp, m[1], query, { limit: body?.limit }).catch(() =>
            searchTranscript(tp, query, { limit: body?.limit }),
          );
          return json({ id: m[1], query, ...r });
        }
      }

      if (path === "/api/transcripts/search" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          query?: string;
          limit?: number;
        } | null;
        const query = body?.query?.trim();
        if (!query) return err(400, "expected { query }");
        return json({ query, ...(await searchAllTranscriptIndexes(query, { limit: body?.limit })) });
      }

      if (path === "/api/transcripts/index" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          limit?: number;
        } | null;
        const limit = Math.max(1, Math.min(200, body?.limit ?? 50));
        const live = await listSessions();
        const liveIds = liveSessionIds(live);
        const resumable = await listResumable({ limit, excludeIds: liveIds });
        const targets = [
          ...live
            .filter((session) => session.sessionId && session.transcriptPath)
            .map((session) => ({
              sessionId: session.sessionId as string,
              path: session.transcriptPath as string,
            })),
          ...(await Promise.all(
            resumable.map(async (session) => {
              const path = await resolveTranscript(session.sessionId).catch(() => null);
              return path ? { sessionId: session.sessionId, path } : null;
            }),
          )).filter((target): target is { sessionId: string; path: string } => !!target),
        ];
        const seen = new Set<string>();
        const results: Array<{ sessionId: string; indexed: number; size: number; offset: number }> = [];
        for (const target of targets) {
          if (seen.has(target.sessionId)) continue;
          seen.add(target.sessionId);
          const r = await indexTranscript(target.path, target.sessionId);
          results.push({ sessionId: target.sessionId, ...r });
        }
        return json({
          indexedSessions: results.length,
          indexedMessages: results.reduce((sum, result) => sum + result.indexed, 0),
          results,
        });
      }

      {
        // Streaming spoken summary for the dashboard shortcut. Haiku starts
        // returning text before the full summary is done; the browser feeds
        // completed sentences into TTS as they arrive.
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/summary\/stream$/);
        if (m && req.method === "POST") {
          const tp = await resolveTranscript(m[1]);
          if (!tp) return err(404, "session transcript not found");
          return streamSessionSummaryForSpeech(m[1], tp);
        }
      }

      {
        // Short spoken summary for the dashboard shortcut. The browser uses the
        // returned text directly for TTS, so keep it plain and capped.
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/summary$/);
        if (m && req.method === "POST") {
          const tp = await resolveTranscript(m[1]);
          if (!tp) return err(404, "session transcript not found");
          const summary = await summarizeSessionForSpeech(m[1], tp);
          return json({ id: m[1], ...summary });
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
          // A single Escape stops the current turn. This doubles as "steer":
          // any message already sitting in Claude's own queue gets processed as
          // the next turn once the running one is interrupted. We deliberately
          // don't drop pending sends — that would discard the message the user
          // is steering with.
          const interrupted = interruptLiveSession(sess);
          if (!interrupted.ok)
            return err(interrupted.status ?? 502, interrupted.error || "interrupt failed");
          return json({ ok: true });
        }
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/diff-stat$/);
        if (m && req.method === "GET") {
          const sess = (await listSessions()).find((s) => s.sessionId === m[1]);
          if (!sess) return err(404, "session not found");
          return json({ stat: computeSessionDiffStat(sess.cwd) });
        }
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/diff$/);
        if (m && req.method === "GET") {
          const sess = (await listSessions()).find((s) => s.sessionId === m[1]);
          if (!sess) return err(404, "session not found");
          // ?summary=1 → fast file-list overview (no patch bodies); the viewer
          // then lazy-loads each file via /diff-file.
          const summary = url.searchParams.get("summary") === "1";
          return json({ diff: summary ? computeSessionDiffSummary(sess.cwd) : computeSessionDiff(sess.cwd) });
        }
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/diff-file$/);
        if (m && req.method === "GET") {
          const sess = (await listSessions()).find((s) => s.sessionId === m[1]);
          if (!sess) return err(404, "session not found");
          const p = url.searchParams.get("path");
          if (!p) return err(400, "missing path");
          const file = computeSessionFilePatch(sess.cwd, p);
          if (!file) return err(404, "no diff for path");
          return json({ file });
        }
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/brain$/);
        if (m && req.method === "POST") {
          const run = await runSessionBrainForSession(m[1], (l) => console.log(l));
          if (run.errors.length && !run.decisions.length) return err(404, run.errors[0] || "session not found");
          return json({ run, decision: run.decisions[0] ?? null });
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
            invalidateListSessionsCache();
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
          invalidateListSessionsCache();
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
          enqueueTranscriptIndex(tp, m[1]);
          const page = await indexedMessagePage(tp, m[1], { limit: 60 });
          const msgs = transcriptMessagesForClient(
            m[1],
            page?.messages ?? await recentMessagesCached(tp, 60),
          ).map(msgWithHtml);
          return json({ id: m[1], messages: msgs });
        }
      }

      if (path === "/api/live/status") {
        noteListSessionsClientActivity();
        const ids = (url.searchParams.get("ids") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => /^[0-9a-fA-F-]{36}$/.test(s))
          .slice(0, 120);
        const wanted = new Set(ids);
        let iv: ReturnType<typeof setInterval> | null = null;
        let hb: ReturnType<typeof setInterval> | null = null;
        let closed = false;
        const slim = (s: Session) => ({
          sessionId: s.sessionId,
          busy: !!s.busy,
          title: s.title ?? null,
          lastUserText: s.lastUserText ?? null,
          lastActivityAt: s.lastActivityAt ?? null,
          status: s.status ?? "ok",
          statusReason: s.statusReason ?? null,
          statusDetail: s.statusDetail ?? null,
          model: s.model ?? null,
        });
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
            let lastSig = "";
            const publish = async () => {
              if (closed) return;
              const t0 = performance.now();
              const rows = (await listSessions())
                .filter((s) => s.sessionId && (!wanted.size || wanted.has(s.sessionId)))
                .map(slim);
              const sig = JSON.stringify(rows);
              const changed = sig !== lastSig;
              if (changed) {
                lastSig = sig;
                send(`event: status\ndata: ${sig}\n\n`);
              }
              evlog("live_status_tick", {
                idsCount: ids.length,
                sessions: rows.length,
                changed,
                durationMs: Math.round((performance.now() - t0) * 1000) / 1000,
              });
            };
            void publish();
            iv = setInterval(() => void publish(), 2000);
            hb = setInterval(() => send(`: hb\n\n`), 15000);
          },
          cancel() {
            closed = true;
            if (iv) clearInterval(iv);
            if (hb) clearInterval(hb);
          },
        });
        return new Response(stream, { headers: sseHeaders() });
      }

      // Multiplexed live stream: one connection tails many transcripts and
      // polls many panes. The per-session /stream endpoint opens one HTTP
      // connection each, so >6 open panes blow past the browser's per-host
      // connection cap and the oldest panes silently stop updating. This
      // folds them into a single SSE; events carry a `sid` so the client can
      // route them to the right pane.
      if (path === "/api/live/stream") {
        noteListSessionsClientActivity();
        const rid =
          (url.searchParams.get("rid") || "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) ||
          randomBytes(6).toString("hex");
        const ids = (url.searchParams.get("ids") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => /^[0-9a-fA-F-]{36}$/.test(s))
          .slice(0, 24);
        evlog("live_stream_request", { rid, ids, idsCount: ids.length });
        type LivePane = { sid: string; tp: string | null; target: string | null };
        let panes: LivePane[] = [];

        let iv: ReturnType<typeof setInterval> | null = null;
        let pi: ReturnType<typeof setInterval> | null = null;
        let di: ReturnType<typeof setInterval> | null = null;
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
            send(`: open\n\n`);
            evlog("live_stream_start", { rid, idsCount: ids.length });
            const offsets = new Map<string, number>();
            const bufs = new Map<string, string>();
            const lastSig = new Map<string, string>();
            const lastArtifactAt = new Map<string, number>();
            const artifactOne = (sid: string) => {
              if (closed) return;
              const after = lastArtifactAt.get(sid) ?? 0;
              const messages = imageArtifactMessagesSince(sid, after);
              for (const message of messages) {
                lastArtifactAt.set(sid, Math.max(lastArtifactAt.get(sid) ?? 0, message.ts ?? 0));
                send(`event: msg\ndata: ${JSON.stringify({ sid, m: msgWithHtml(message) })}\n\n`);
              }
            };
            const pumpOne = async (p: LivePane) => {
              if (closed) return;
              try {
                if (!p.tp) {
                  const tp = await resolveTranscript(p.sid);
                  if (!tp) return;
                  p.tp = tp;
                  enqueueTranscriptIndex(tp, p.sid);
                  offsets.set(p.sid, Bun.file(tp).size);
                  return;
                }
                const pumpT0 = performance.now();
                const f = Bun.file(p.tp);
                const size = f.size;
                let offset = offsets.get(p.sid) ?? 0;
                if (size < offset) offset = 0; // rotated/truncated
                if (size > offset) {
                  const bytes = size - offset;
                  const chunk = await f.slice(offset, size).text();
                  offsets.set(p.sid, size);
                  let buf = (bufs.get(p.sid) ?? "") + chunk;
                  const lines = buf.split("\n");
                  bufs.set(p.sid, lines.pop() ?? "");
                  for (const l of lines) {
                    if (!l) continue;
                    const msgs = visibleTranscriptMessages(normalizeLineMessages(l));
                    for (const msg of msgs)
                      send(
                        `event: msg\ndata: ${JSON.stringify({ sid: p.sid, m: msgWithHtml(msg) })}\n\n`,
                      );
                  }
                  evlog("live_stream_pump", {
                    rid,
                    sid: p.sid,
                    bytes,
                    lines: lines.filter(Boolean).length,
                    durationMs: Math.round((performance.now() - pumpT0) * 1000) / 1000,
                  });
                }
              } catch {}
            };
            const lastBusy = new Map<string, string>();
            const lastDraft = new Map<string, DraftState>();
            const pollDraftOne = (p: LivePane) => {
              if (closed || p.target) return;
              const entry = findAisdkEntryByAnyId(p.sid);
              if (!entry || !isAisdkEntryBusy(entry)) return;
              sendAiTextDeltaPart(send, p.sid, entry, lastDraft, true);
            };
            const pollOne = async (p: LivePane) => {
              if (closed) return;
              if (!p.target) {
                // Pane-less (aisdk / codex-aisdk) session: busy comes from the
                // registry, and there are no pane-scraped prompts. For a
                // codex-aisdk session the sid may be the threadId rather than the
                // control-plane key, so look it up by either.
                const entry = findAisdkEntryByAnyId(p.sid);
                if (!entry) return;
                const busy = isAisdkEntryBusy(entry);
                const bsig = busy ? "1" : "0";
                if (bsig !== (lastBusy.get(p.sid) ?? "0")) {
                  lastBusy.set(p.sid, bsig);
                  send(`event: busy\ndata: ${JSON.stringify({ sid: p.sid, busy })}\n\n`);
                }
                if (busy) sendAiTextDeltaPart(send, p.sid, entry, lastDraft, true);
                else lastDraft.delete(p.sid);
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
            const hydrateTargets = async () => {
              if (closed || !panes.length) return;
              const listT0 = performance.now();
              const all = await listSessions();
              evlog("live_stream_list_sessions", {
                rid,
                sessionCount: all.length,
                durationMs: Math.round((performance.now() - listT0) * 1000) / 1000,
                phase: "target_hydration",
              });
              const bySid = new Map(all.map((s) => [s.sessionId, s.tmuxTarget ?? null]));
              for (const p of panes) p.target = bySid.get(p.sid) ?? null;
            };
            (async () => {
              const resolveT0 = performance.now();
              const resolved = await Promise.all(
                ids.map(async (sid) => {
                  const sidT0 = performance.now();
                  const tp = await resolveTranscript(sid);
                  if (tp) enqueueTranscriptIndex(tp, sid);
                  const entry = findAisdkEntryByAnyId(sid);
                  evlog("live_stream_resolve_transcript", {
                    rid,
                    sid,
                    found: !!tp,
                    durationMs: Math.round((performance.now() - sidT0) * 1000) / 1000,
                  });
                  return tp || entry
                    ? ({ sid, tp, target: null } satisfies LivePane)
                    : null;
                }),
              );
              if (closed) return;
              panes = resolved.filter((p): p is NonNullable<typeof p> => !!p);
              const paneIds = new Set(panes.map((p) => p.sid));
              const missingIds = ids.filter((sid) => !paneIds.has(sid));
              evlog("live_stream_resolved", {
                rid,
                panesCount: panes.length,
                missingCount: missingIds.length,
                durationMs: Math.round((performance.now() - resolveT0) * 1000) / 1000,
              });
              for (const sid of missingIds) {
                send(`event: ready\ndata: ${JSON.stringify({ sid })}\n\n`);
                evlog("live_stream_ready", { rid, sid, missing: true });
              }
              await Promise.all(panes.map(async (p) => {
                try {
                  if (!p.tp) {
                    lastSig.set(p.sid, " ");
                    lastQ.set(p.sid, "[]");
                    lastBusy.set(p.sid, "?");
                    lastArtifactAt.set(p.sid, 0);
                    artifactOne(p.sid);
                    pollOne(p);
                    queueOne(p);
                    return;
                  }
                  const backlogT0 = performance.now();
                  const page =
                    (await indexedMessagePage(p.tp, p.sid, { limit: 40 })) ??
                    (await messagePage(p.tp, { limit: 40 }));
                  const readMs = performance.now() - backlogT0;
                  const renderT0 = performance.now();
                  const msgs = transcriptMessagesForClient(p.sid, page.messages).map(msgWithHtml);
                  lastArtifactAt.set(
                    p.sid,
                    Math.max(0, ...msgs.filter((msg) => msg.kind === "image").map((msg) => msg.ts ?? 0)),
                  );
                  evlog("live_stream_backlog", {
                    rid,
                    sid: p.sid,
                    messages: msgs.length,
                    nextBefore: page.nextBefore,
                    readMs: Math.round(readMs * 1000) / 1000,
                    renderMs: Math.round((performance.now() - renderT0) * 1000) / 1000,
                    totalMs: Math.round((performance.now() - backlogT0) * 1000) / 1000,
                  });
                  send(
                    `event: batch\ndata: ${JSON.stringify({
                      sid: p.sid,
                      messages: msgs,
                      nextBefore: page.nextBefore,
                    })}\n\n`,
                  );
                  offsets.set(p.sid, Bun.file(p.tp).size);
                  lastSig.set(p.sid, " ");
                  lastQ.set(p.sid, "[]");
                  // Seed busy with a sentinel (not "0") so the first pollOne always
                  // emits the CURRENT busy state as a baseline. Without this, a
                  // client reconnecting (e.g. after a serve restart) while holding a
                  // stale busy=true never gets a corrective event, because the new
                  // connection's implicit "0" baseline matches a now-idle session
                  // and the change-gate suppresses the emit — leaving the card stuck
                  // showing "Working".
                  lastBusy.set(p.sid, "?");
                  pollOne(p);
                  queueOne(p);
                } finally {
                  send(`event: ready\ndata: ${JSON.stringify({ sid: p.sid })}\n\n`);
                  evlog("live_stream_ready", { rid, sid: p.sid, missing: false });
                }
              }));
              void hydrateTargets().then(() => {
                for (const p of panes) {
                  pollOne(p);
                  artifactOne(p.sid);
                  queueOne(p);
                }
              });
              iv = setInterval(() => {
                for (const p of panes) pumpOne(p);
              }, 700);
              pi = setInterval(() => {
                for (const p of panes) {
                  pollOne(p);
                  artifactOne(p.sid);
                  queueOne(p);
                  void reconcileQueued(p.sid).then((c) => c && queueOne(p));
                }
              }, 1000);
              di = setInterval(() => {
                for (const p of panes) pollDraftOne(p);
              }, 150);
            })();
            hb = setInterval(() => send(`: hb\n\n`), 15000);
          },
          cancel() {
            closed = true;
            if (iv) clearInterval(iv);
            if (pi) clearInterval(pi);
            if (di) clearInterval(di);
            if (hb) clearInterval(hb);
          },
        });
        return new Response(stream, { headers: sseHeaders() });
      }

      {
        const m = path.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})\/stream$/);
        if (m) {
          const session = (await listSessions()).find(
            (s) => s.sessionId === m[1] || s.nativeSessionId === m[1],
          );
          const sid = session?.sessionId ?? m[1];
          const tp = await resolveTranscript(m[1]);
          if (!tp) return err(404, "session transcript not found");
          enqueueTranscriptIndex(tp, sid);
          const target = session?.tmuxTarget ?? null;
          let iv: ReturnType<typeof setInterval> | null = null;
          let pi: ReturnType<typeof setInterval> | null = null;
          let di: ReturnType<typeof setInterval> | null = null;
          let qi: ReturnType<typeof setInterval> | null = null;
          let ai: ReturnType<typeof setInterval> | null = null;
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
              let lastArtifactAt = 0;
              const pollArtifacts = () => {
                if (closed) return;
                const messages = imageArtifactMessagesSince(sid, lastArtifactAt);
                for (const message of messages) {
                  lastArtifactAt = Math.max(lastArtifactAt, message.ts ?? 0);
                  send(`event: msg\ndata: ${JSON.stringify(msgWithHtml(message))}\n\n`);
                }
              };
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
                      const msgs = visibleTranscriptMessages(normalizeLineMessages(l));
                      for (const msg of msgs)
                        send(`event: msg\ndata: ${JSON.stringify(msgWithHtml(msg))}\n\n`);
                    }
                  }
                } catch {}
              };
              // backlog, then tail
              (async () => {
                const page = await indexedMessagePage(tp, sid, { limit: 40 });
                const msgs = transcriptMessagesForClient(
                  sid,
                  page?.messages ?? await recentMessagesCached(tp, 40),
                ).map(msgWithHtml);
                lastArtifactAt = Math.max(
                  0,
                  ...msgs.filter((msg) => msg.kind === "image").map((msg) => msg.ts ?? 0),
                );
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
                // Sentinel (not "0") so the first poll emits the current busy
                // baseline — corrects a client holding a stale busy across reconnect.
                let lastBusy = "?";
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
                // Sentinel baseline so the first poll always emits current state.
                let lastBusy = "?";
                const lastDraft = new Map<string, DraftState>();
                const pollBusy = () => {
                  if (closed) return;
                  const entry = findAisdkEntryByAnyId(sid);
                  if (!entry) return;
                  const busy = isAisdkEntryBusy(entry);
                  const bsig = busy ? "1" : "0";
                  if (bsig !== lastBusy) {
                    lastBusy = bsig;
                    send(`event: busy\ndata: ${busy ? "true" : "false"}\n\n`);
                  }
                  if (!busy) lastDraft.delete(sid);
                };
                const pollDraft = () => {
                  if (closed) return;
                  const entry = findAisdkEntryByAnyId(sid);
                  if (!entry || !isAisdkEntryBusy(entry)) return;
                  sendAiTextDeltaPart(send, sid, entry, lastDraft, false);
                };
                pollBusy();
                pollDraft();
                pi = setInterval(pollBusy, 1000);
                di = setInterval(pollDraft, 150);
              }
              pollArtifacts();
              ai = setInterval(pollArtifacts, 1000);
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
              if (di) clearInterval(di);
              if (qi) clearInterval(qi);
              if (ai) clearInterval(ai);
              if (hb) clearInterval(hb);
            },
          });
          return new Response(stream, { headers: sseHeaders() });
        }
      }

      if (
        req.method === "GET" &&
        !path.startsWith("/api/") &&
        !path.startsWith("/assets/") &&
        req.headers.get("accept")?.includes("text/html")
      ) {
        return webIndexResponse();
      }

      return err(404, "not found");
      } finally {
        if (apiTimingStart) evlog("api_timing", { endpoint: path, durationMs: apiDurationMs(apiTimingStart) });
      }
      })();
      return maybeCompressResponse(req, path, response);
    },
  });

  startAutoScheduler((l) => console.log(l));
  // Let the session-brain merge-guard nudge a live session's agent (queue mode)
  // when it detects unmerged worktree work before archiving.
  setBrainPromptSender((session, text, opts) => sendPromptToLiveSession(session, text, opts));
  startSessionBrainScheduler((l) => console.log(l));
  startWorktreeSweep((l) => console.log(l));
  // Watch the fleet for busy -> idle transitions and fan "completed" events out
  // to voice subscribers (/api/voice/events). Idempotent + best-effort.
  startFleetWatcher();
  // Warm the resumable-session cache in the background so the first time someone
  // opens the resume picker it's already served from SQLite (no cold scan wait).
  void refreshResumableCache({ force: true }).catch(() => {});

  console.log(`lfg web → http://${server.hostname}:${server.port}`);
  console.log(`  agents dir: ${AGENTS_DIR}`);
}
