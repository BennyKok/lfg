// Frontend error auto-report → auto-fix pipeline.
//
// The web app funnels uncaught errors (window.onerror, unhandledrejection, and
// React error boundaries) to POST /api/client-error. Each report is:
//   1. PERSISTED to data/client-errors/errors.jsonl (raw audit trail).
//   2. REPORTED to the human by reusing the auto findings feed + Web Push — the
//      same surface the watch agents use, so it shows up in the UI and wakes the
//      installed PWA with zero new plumbing.
//   3. AUTO-FIXED by dispatching an Opus coding agent into lfg's own checkout,
//      mirroring dispatchSendFixAgent: it locates the bug in web/src, fixes it
//      minimally, rebuilds the frontend (live from disk), and pushes.
//
// The whole thing is heavily guarded against storms: one render loop must not
// spawn fifty Opus agents. Dedup is by a normalized SIGNATURE (message + first
// stack frame, with hashes/line numbers/build ids stripped). A signature is
// fixed at most once — persisted across restarts — and dispatch is additionally
// rate-limited and concurrency-capped globally.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "./config.ts";
import { addFinding, hasOpenSimilar } from "./auto/store.ts";
import { notifyAll } from "./push.ts";
import { spawnManagedAisdkSession } from "./tmux.ts";
import { addManaged } from "./managed.ts";
import { USERS, assignUser } from "./users.ts";

// lfg's own single live checkout — where web/src lives and where the fix agent
// works. The serve process runs from here.
const SELF_REPO = PATHS.root;
// A synthetic auto-agent id so client errors slot into the existing findings
// feed (and its dedup-by-title) without inventing a parallel UI.
const AGENT_ID = "client-error";
// Dispatched fix sessions are owned by the operator so they appear under the
// same per-user session filter as the other agent-started ones.
const AGENT_OWNER = USERS[0];

// Storm guards. At most one auto-fix in flight at a time, and at most one NEW
// dispatch per cooldown window — a flood of distinct errors still trickles
// through one fix at a time instead of forking the repo a dozen ways at once.
const MAX_CONCURRENT_FIXES = 1;
const DISPATCH_COOLDOWN_MS = 5 * 60_000;

export type ClientError = {
  message: string;
  stack?: string;
  componentStack?: string; // React error-boundary component trace
  source?: string;
  line?: number;
  col?: number;
  url?: string;
  userAgent?: string;
  buildId?: string; // hashed entry chunk (e.g. index-ab12cd.js) — present only in prod builds
  kind?: "error" | "unhandledrejection" | "react";
  user?: string | null;
  at: number;
};

const dir = () => join(PATHS.data, "client-errors");
const errorsPath = () => join(dir(), "errors.jsonl");
const dispatchedPath = () => join(dir(), "dispatched.json");

async function ensure() {
  await mkdir(dir(), { recursive: true });
}

// ---------- raw audit trail ----------

async function persist(e: ClientError): Promise<void> {
  await ensure();
  const f = Bun.file(errorsPath());
  const prev = (await f.exists()) ? await f.text() : "";
  await Bun.write(errorsPath(), prev + JSON.stringify(e) + "\n");
}

export async function listClientErrors(limit = 200): Promise<ClientError[]> {
  const f = Bun.file(errorsPath());
  if (!(await f.exists())) return [];
  const rows = (await f.text())
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ClientError);
  rows.sort((a, b) => b.at - a.at);
  return rows.slice(0, limit);
}

// ---------- signature & dedup ----------

// A stable fingerprint that survives cosmetic churn: strip URLs, hex addresses,
// the hashed bundle name, and any :line:col so the SAME bug from two builds (or
// two users) collapses to one signature.
export function signature(e: ClientError): string {
  const msg = (e.message || "(no message)")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/0x[0-9a-f]+/gi, "")
    .replace(/\b\d[\d.]*\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const frameSource = e.componentStack || e.stack || "";
  const frame =
    frameSource
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !/^(Error|TypeError|RangeError|ReferenceError)\b/.test(l)) ?? "";
  const cleanFrame = frame
    .replace(/index-[\w-]+\.js/g, "bundle.js")
    .replace(/:\d+:\d+/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 140);
  return `${msg}::${cleanFrame}`;
}

// Errors that are noise, not bugs in our code: browser/extension cross-origin
// "Script error." with no stack, ResizeObserver loop chatter, and network
// blips. We still STORE these (audit trail) but never dispatch a fix for them.
function isNoise(e: ClientError): boolean {
  const m = (e.message || "").toLowerCase();
  if (!m || m === "script error." || m === "script error") return true;
  if (m.includes("resizeobserver loop")) return true;
  if (m.includes("load failed") && !e.stack) return true;
  if (/networkerror|failed to fetch/.test(m) && !e.componentStack) return true;
  return false;
}

// ---------- dispatched-signature ledger (persisted across restarts) ----------

type DispatchRecord = { sig: string; at: number; session: string; sessionId: string };

async function readDispatched(): Promise<DispatchRecord[]> {
  const f = Bun.file(dispatchedPath());
  if (!(await f.exists())) return [];
  try {
    return JSON.parse(await f.text()) as DispatchRecord[];
  } catch {
    return [];
  }
}

async function recordDispatched(rec: DispatchRecord): Promise<void> {
  await ensure();
  const rows = await readDispatched();
  rows.push(rec);
  // keep the ledger bounded
  await Bun.write(dispatchedPath(), JSON.stringify(rows.slice(-200), null, 2));
}

// ---------- in-flight tracking (process-local) ----------

const inFlight = new Set<string>();
let lastDispatchAt = 0;

// ---------- public entry point ----------

export async function reportClientError(
  input: Partial<ClientError>,
): Promise<{ stored: true; reported: boolean; dispatched: boolean; reason?: string }> {
  const e: ClientError = {
    message: String(input.message ?? "").slice(0, 2000) || "(no message)",
    stack: input.stack ? String(input.stack).slice(0, 8000) : undefined,
    componentStack: input.componentStack ? String(input.componentStack).slice(0, 8000) : undefined,
    source: input.source ? String(input.source).slice(0, 500) : undefined,
    line: typeof input.line === "number" ? input.line : undefined,
    col: typeof input.col === "number" ? input.col : undefined,
    url: input.url ? String(input.url).slice(0, 500) : undefined,
    userAgent: input.userAgent ? String(input.userAgent).slice(0, 500) : undefined,
    buildId: input.buildId ? String(input.buildId).slice(0, 120) : undefined,
    kind: (input.kind as ClientError["kind"]) ?? "error",
    user: input.user ?? null,
    at: Date.now(),
  };

  await persist(e);

  // 1) Report it to the human via the findings feed (+ push). Dedup by title so
  //    a repeated error doesn't re-spam the feed.
  const title = `Frontend error: ${e.message.replace(/\s+/g, " ").slice(0, 100)}`;
  let reported = false;
  if (!(await hasOpenSimilar(AGENT_ID, title))) {
    const reasoning = [
      `Kind: ${e.kind}${e.buildId ? ` · build ${e.buildId}` : " · dev"}`,
      e.componentStack
        ? `Component: ${e.componentStack.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "?"}`
        : e.source
          ? `At: ${e.source}${e.line ? `:${e.line}` : ""}`
          : "No stack frame",
      e.url ? `URL: ${e.url}` : "",
    ].filter(Boolean);
    await addFinding({
      agentId: AGENT_ID,
      title,
      severity: "high",
      reasoning,
      suggest: "Auto-fix agent dispatched to locate and fix this in web/src.",
    });
    void notifyAll().catch(() => {});
    reported = true;
  }

  // 2) Auto-fix it.
  const fix = await maybeDispatchFix(e);
  return { stored: true, reported, dispatched: fix.dispatched, reason: fix.reason };
}

async function maybeDispatchFix(e: ClientError): Promise<{ dispatched: boolean; reason?: string }> {
  if (isNoise(e)) return { dispatched: false, reason: "noise (not dispatched)" };
  // Only auto-fix real shipped builds. Dev/HMR errors are transient and the
  // person editing is already looking at them.
  if (!e.buildId) return { dispatched: false, reason: "no buildId (dev) — not dispatched" };

  const sig = signature(e);

  if (inFlight.has(sig)) return { dispatched: false, reason: "already fixing this signature" };
  if (inFlight.size >= MAX_CONCURRENT_FIXES)
    return { dispatched: false, reason: "fix concurrency cap reached — queued for next report" };
  if (Date.now() - lastDispatchAt < DISPATCH_COOLDOWN_MS)
    return { dispatched: false, reason: "within dispatch cooldown" };

  const already = await readDispatched();
  if (already.some((r) => r.sig === sig))
    return { dispatched: false, reason: "this signature was already auto-fixed once" };

  inFlight.add(sig);
  lastDispatchAt = Date.now();
  try {
    const r = await dispatchFixAgent(e, sig);
    if (r) await recordDispatched({ sig, at: Date.now(), session: r.session, sessionId: r.sessionId });
    return { dispatched: !!r, reason: r ? undefined : "failed to spawn fix agent" };
  } finally {
    inFlight.delete(sig);
  }
}

function buildPrompt(e: ClientError): string {
  return `You are a debugging agent dispatched by lfg because the **web frontend threw an uncaught error in a shipped build**. Your job: find the root cause in the React frontend, fix it minimally, rebuild, and ship the fix.

# The error
- Kind: ${e.kind}
- Message: ${e.message}
- Build: ${e.buildId ?? "(unknown)"}
- URL: ${e.url ?? "(unknown)"}
- User agent: ${e.userAgent ?? "(unknown)"}
${e.source ? `- Source: ${e.source}${e.line ? `:${e.line}` : ""}${e.col ? `:${e.col}` : ""}` : ""}

# Stack
\`\`\`
${(e.stack || "(no stack captured)").slice(0, 4000)}
\`\`\`

# React component stack (if a render error)
\`\`\`
${(e.componentStack || "(not a render error / unavailable)").slice(0, 2000)}
\`\`\`

# How to operate
- You are in the lfg repo at ${SELF_REPO} (lfg's single live checkout — work in it directly, do NOT create a worktree).
- The frontend is React 19 + TypeScript + Vite under \`web/src\` (entry \`web/src/main.tsx\`, the bulk lives in \`web/src/App.tsx\` and \`web/src/components\`, \`web/src/lib\`).
- LOCATE the bug: the message + React component stack usually name the failing component — grep \`web/src\` for it. The runtime stack frames point at hashed bundle files; source maps are emitted to \`web/dist/assets/*.js.map\` if you need to map a minified frame back to source, but the original source in \`web/src\` is what you edit.
- DIAGNOSE the root cause (e.g. reading a property off undefined, an unguarded API shape, a bad effect dependency, an unhandled rejection). Fix it MINIMALLY and defensively, matching the file's existing style and comments.
- REBUILD the frontend: \`npm --prefix web run build\` (this runs \`tsc --noEmit\` then \`vite build\`). The build output is served live from disk by lfg-serve — NO server restart is needed for a frontend change, and open PWAs auto-reload when the hashed entry chunk changes. The build MUST pass (typecheck + bundle) before you ship.
- If you changed backend code too (you usually should NOT for a frontend error), restart with \`systemctl --user restart lfg-serve.service\` and confirm \`systemctl --user is-active lfg-serve.service\`.
- COMMIT and push to main: \`git -C ${SELF_REPO} add -A && git -C ${SELF_REPO} commit -m "fix(web): ..." && git -C ${SELF_REPO} push\`.
- If the error is transient or external (a browser extension, a one-off network failure, a ResizeObserver loop, a user offline) with no real bug in our code, do NOT invent a change — explain why and stop.
- On the LAST line of your output, print a one-line result starting with \`RESULT:\` summarizing the root cause and what you changed (or why no change was needed).`;
}

async function dispatchFixAgent(
  e: ClientError,
  sig: string,
): Promise<{ session: string; sessionId: string } | null> {
  // Derive a short, stable, tmux-safe session name from the signature.
  const tag = Buffer.from(sig).toString("hex").slice(0, 6);
  const session = `fix_clienterr_${tag}`;
  const sessionId = randomUUID();
  const spawned = spawnManagedAisdkSession({
    name: session,
    cwd: SELF_REPO,
    prompt: buildPrompt(e),
    model: "opus",
    sessionId,
  });
  if (!spawned.ok) {
    console.error(`[client-error] failed to spawn fix agent: ${spawned.error ?? "unknown"}`);
    return null;
  }
  addManaged({ tmuxName: session, cwd: SELF_REPO, createdAt: Date.now(), agent: "aisdk" });
  assignUser(session, AGENT_OWNER);
  console.log(`[client-error] dispatched auto-fix agent ${session} for: ${e.message.slice(0, 80)}`);
  return { session, sessionId };
}
