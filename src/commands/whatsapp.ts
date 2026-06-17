import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import makeWASocket, {
  DisconnectReason,
  getContentType,
  isJidGroup,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { randomBytes } from "node:crypto";
import { PATHS } from "../config.ts";
import { addManaged, removeManaged } from "../managed.ts";
import { enqueueMessage } from "../sendq.ts";
import { listSessions, recentMessages, resolveTranscript, sessionIdForPid } from "../sessions.ts";
import {
  dismissCodexUpdatePrompt,
  panePidForSession,
  spawnManagedAisdkSession,
  spawnManagedCodexAisdkSession,
  spawnManagedCodexSession,
  spawnManagedSession,
  tmuxKillSession,
} from "../tmux.ts";
import { randomUUID } from "node:crypto";
import {
  appendCmd as appendAisdkCmd,
  findEntryByAnyId as findAisdkEntryByAnyId,
  readEntry as readAisdkEntry,
} from "../aisdk-registry.ts";

const HELP = `lfg whatsapp — WhatsApp group sidecar agent

Usage:
  lfg whatsapp              Run the Baileys sidecar
  lfg whatsapp run          Run the Baileys sidecar
  lfg whatsapp sessions     Print saved group/session mappings
  lfg whatsapp help         Show this help

Env:
  LFG_WHATSAPP_ALLOWED_GROUPS   Comma-separated group JIDs, or "*" while discovering
  LFG_WHATSAPP_AGENT            aisdk|codex(=codex-aisdk)|claude-cli|codex-cli (default: aisdk)
  LFG_WHATSAPP_AGENT_CWD        Repo cwd for managed sessions (default: LFG_REPO / cwd)
  LFG_WHATSAPP_TRIGGER          Text trigger (default: lfg)
  LFG_WHATSAPP_ALWAYS_ON        true to forward every group message
  LFG_WHATSAPP_AUTH_DIR         Baileys auth dir (default: data/whatsapp-auth)
`;

const PROJECT_REPO = process.env.LFG_REPO ?? process.cwd();
const AUTH_DIR = process.env.LFG_WHATSAPP_AUTH_DIR ?? join(PATHS.data, "whatsapp-auth");
const STORE_PATH = join(PATHS.data, "whatsapp-sessions.json");
// Default routes through the AI-SDK harness (same as serve.ts's /api/sessions/new
// default): unset / "aisdk" → "aisdk" (claude via AI SDK); "codex" → "codex-aisdk"
// (codex via AI SDK). CLI escape hatches keep the legacy tmux paths: "claude-cli"
// and "codex-cli".
const AGENT: "aisdk" | "codex-aisdk" | "claude" | "codex" = (() => {
  switch (process.env.LFG_WHATSAPP_AGENT) {
    case "codex":
      return "codex-aisdk";
    case "claude-cli":
      return "claude";
    case "codex-cli":
      return "codex";
    default:
      return "aisdk";
  }
})();
const AGENT_CWD = process.env.LFG_WHATSAPP_AGENT_CWD ?? PROJECT_REPO;
const TRIGGER = (process.env.LFG_WHATSAPP_TRIGGER ?? "lfg").trim().toLowerCase();
const ALWAYS_ON = /^(1|true|yes)$/i.test(process.env.LFG_WHATSAPP_ALWAYS_ON ?? "");
const RELAY_POLL_MS = 2500;

type SavedGroupSession = {
  groupJid: string;
  groupName?: string;
  sessionId: string;
  tmuxName: string;
  cwd: string;
  agent: "claude" | "codex" | "aisdk" | "codex-aisdk";
  paused?: boolean;
  createdAt: number;
  updatedAt: number;
  lastRelayedId?: string | null;
  lastRelayedTs?: number | null;
  lastInboundAt?: number | null;
};

type Store = {
  groups: Record<string, SavedGroupSession>;
};

type Inbound = {
  groupJid: string;
  senderJid: string;
  senderName: string;
  text: string;
  messageId: string | null;
  ts: number;
};

export async function cmdWhatsapp(args: string[]) {
  const [sub] = args;
  switch (sub) {
    case undefined:
    case "run":
      return runWhatsappSidecar();
    case "sessions":
      return printSessions();
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown whatsapp subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

async function readStore(): Promise<Store> {
  try {
    const f = Bun.file(STORE_PATH);
    if (!(await f.exists())) return { groups: {} };
    const parsed = (await f.json()) as Store;
    return parsed?.groups && typeof parsed.groups === "object" ? parsed : { groups: {} };
  } catch {
    return { groups: {} };
  }
}

async function writeStore(store: Store): Promise<void> {
  await mkdir(PATHS.data, { recursive: true });
  await Bun.write(STORE_PATH, JSON.stringify(store, null, 2));
}

async function patchGroup(groupJid: string, patch: Partial<SavedGroupSession>) {
  const store = await readStore();
  const cur = store.groups[groupJid];
  if (!cur) return;
  store.groups[groupJid] = { ...cur, ...patch, updatedAt: Date.now() };
  await writeStore(store);
}

function allowedGroups(): Set<string> | "*" {
  const raw = process.env.LFG_WHATSAPP_ALLOWED_GROUPS ?? "";
  if (raw.trim() === "*") return "*";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function isAllowed(groupJid: string): boolean {
  const allowed = allowedGroups();
  return allowed === "*" || allowed.has(groupJid);
}

async function printSessions() {
  const store = await readStore();
  const rows = Object.values(store.groups).sort((a, b) => a.groupJid.localeCompare(b.groupJid));
  if (!rows.length) {
    console.log("(no WhatsApp group sessions saved)");
    return;
  }
  for (const r of rows) {
    const paused = r.paused ? "paused" : "active";
    console.log(`${paused}  ${r.groupName ?? "(unnamed group)"}  ${r.groupJid}`);
    console.log(`        ${r.agent} ${r.sessionId} ${r.tmuxName} cwd=${r.cwd}`);
  }
}

async function runWhatsappSidecar() {
  await mkdir(AUTH_DIR, { recursive: true });
  await mkdir(PATHS.data, { recursive: true });
  console.error(`[whatsapp] auth dir: ${AUTH_DIR}`);
  console.error(`[whatsapp] store: ${STORE_PATH}`);
  console.error(`[whatsapp] agent: ${AGENT} cwd=${AGENT_CWD}`);
  if (allowedGroups() !== "*") {
    const n = (allowedGroups() as Set<string>).size;
    console.error(`[whatsapp] allowed groups: ${n || "(none set; incoming group JIDs will be logged)"}`);
  } else {
    console.error("[whatsapp] allowed groups: *");
  }
  if (!ALWAYS_ON) console.error(`[whatsapp] trigger: ${TRIGGER}: / ${TRIGGER} / @${TRIGGER}`);

  let sock: WASocket | null = null;
  let stopped = false;
  let relayTimer: ReturnType<typeof setInterval> | null = null;

  const connect = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    sock = makeWASocket({ auth: state });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (update) => {
      if (update.qr) {
        console.error("[whatsapp] scan this QR with the agent WhatsApp account:");
        // Call via the module object, not a bare named import: generate()
        // reads `this.error` for the QR error-correction level, so detaching it
        // from `this` makes that undefined and throws "bad rs block".
        qrcode.generate(update.qr, { small: true });
      }
      if (update.connection === "open") {
        console.error("[whatsapp] connected");
      }
      if (update.connection === "close") {
        const status = (update.lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = status !== DisconnectReason.loggedOut;
        console.error(`[whatsapp] disconnected status=${status ?? "unknown"} reconnect=${shouldReconnect}`);
        if (shouldReconnect && !stopped) setTimeout(() => void connect(), 1500);
        else console.error("[whatsapp] logged out; remove auth dir and pair again if needed");
      }
    });

    sock.ev.on("messages.upsert", (event) => {
      for (const msg of event.messages) {
        void handleMessage(sock!, msg).catch((e) =>
          console.error(`[whatsapp] message handler failed: ${e instanceof Error ? e.message : e}`),
        );
      }
    });
  };

  await connect();
  relayTimer = setInterval(() => {
    if (!sock) return;
    void relayAssistantMessages(sock).catch((e) =>
      console.error(`[whatsapp] relay failed: ${e instanceof Error ? e.message : e}`),
    );
  }, RELAY_POLL_MS);

  const stop = () => {
    stopped = true;
    if (relayTimer) clearInterval(relayTimer);
    console.error("[whatsapp] stopping");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await new Promise(() => {});
}

async function handleMessage(sock: WASocket, msg: WAMessage) {
  const inbound = parseInbound(msg);
  if (!inbound) return;

  if (!isAllowed(inbound.groupJid)) {
    console.error(
      `[whatsapp] ignored group ${inbound.groupJid} (${inbound.senderName}: ${clip(inbound.text, 80)})`,
    );
    return;
  }

  const command = parseAgentCommand(inbound.text);
  if (command) {
    await handleAgentCommand(sock, inbound, command);
    return;
  }

  const triggered = triggerText(inbound.text);
  if (!triggered) return;

  const session = await getOrCreateGroupSession(sock, inbound.groupJid);
  if (session.paused) return;

  const firstMessage = !session.lastInboundAt;
  const body = firstMessage
    ? `${systemInstruction(inbound.groupJid, session.groupName)}\n\n${formatInbound(inbound, triggered)}`
    : formatInbound(inbound, triggered);

  sendToSession(session, body);
  await patchGroup(inbound.groupJid, { lastInboundAt: Date.now() });
  console.error(`[whatsapp] → ${session.sessionId} ${inbound.senderName}: ${clip(triggered, 120)}`);
}

function parseInbound(msg: WAMessage): Inbound | null {
  const groupJid = msg.key.remoteJid ?? "";
  if (!isJidGroup(groupJid)) return null;
  if (msg.key.fromMe) return null;
  const text = extractText(msg).trim();
  if (!text) return null;
  const senderJid = jidNormalizedUser(msg.key.participant || msg.participant || "");
  return {
    groupJid,
    senderJid,
    senderName: msg.pushName || senderJid || "Unknown",
    text,
    messageId: msg.key.id ?? null,
    ts: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
  };
}

function unwrapMessage(message: WAMessage["message"]): WAMessage["message"] {
  let cur = message;
  for (let i = 0; i < 4; i++) {
    if (!cur) return cur;
    if (cur.ephemeralMessage?.message) cur = cur.ephemeralMessage.message;
    else if (cur.viewOnceMessage?.message) cur = cur.viewOnceMessage.message;
    else if (cur.viewOnceMessageV2?.message) cur = cur.viewOnceMessageV2.message;
    else if (cur.documentWithCaptionMessage?.message) cur = cur.documentWithCaptionMessage.message;
    else return cur;
  }
  return cur;
}

function extractText(msg: WAMessage): string {
  const message = unwrapMessage(msg.message);
  const type = getContentType(message ?? undefined);
  if (!message || !type) return "";
  switch (type) {
    case "conversation":
      return message.conversation ?? "";
    case "extendedTextMessage":
      return message.extendedTextMessage?.text ?? "";
    case "imageMessage":
      return message.imageMessage?.caption ?? "[image]";
    case "videoMessage":
      return message.videoMessage?.caption ?? "[video]";
    case "documentMessage":
      return message.documentMessage?.caption ?? `[document: ${message.documentMessage?.fileName ?? "file"}]`;
    case "audioMessage":
      return "[audio]";
    case "stickerMessage":
      return "[sticker]";
    case "buttonsResponseMessage":
      return message.buttonsResponseMessage?.selectedDisplayText ?? message.buttonsResponseMessage?.selectedButtonId ?? "";
    case "listResponseMessage":
      return (
        message.listResponseMessage?.title ??
        message.listResponseMessage?.singleSelectReply?.selectedRowId ??
        ""
      );
    case "templateButtonReplyMessage":
      return message.templateButtonReplyMessage?.selectedDisplayText ?? "";
    default:
      return "";
  }
}

function triggerText(text: string): string | null {
  const t = text.trim();
  if (ALWAYS_ON) return t;
  const lower = t.toLowerCase();
  for (const prefix of [`${TRIGGER}:`, `${TRIGGER},`, `${TRIGGER} `, `/${TRIGGER} `, `@${TRIGGER} `]) {
    if (lower.startsWith(prefix)) return t.slice(prefix.length).trim() || t;
  }
  if (lower === TRIGGER || lower === `/${TRIGGER}` || lower === `@${TRIGGER}`) return t;
  return null;
}

function parseAgentCommand(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (t === "/agent" || t.startsWith("/agent ")) return t.replace(/^\/agent\s*/, "") || "help";
  if (t === `${TRIGGER} status`) return "status";
  return null;
}

async function handleAgentCommand(sock: WASocket, inbound: Inbound, command: string) {
  const [verb] = command.split(/\s+/, 1);
  if (verb === "help") {
    await sendChunks(sock, inbound.groupJid, "Commands: /agent status, /agent pause, /agent resume, /agent reset");
    return;
  }
  if (verb === "status") {
    const store = await readStore();
    const s = store.groups[inbound.groupJid];
    const msg = s
      ? `Agent ${s.paused ? "paused" : "active"}: ${s.agent} ${s.sessionId.slice(0, 8)} in ${s.cwd}`
      : "No agent session exists for this group yet.";
    await sendChunks(sock, inbound.groupJid, msg);
    return;
  }
  if (verb === "pause" || verb === "resume") {
    await patchGroup(inbound.groupJid, { paused: verb === "pause" });
    await sendChunks(sock, inbound.groupJid, `Agent ${verb === "pause" ? "paused" : "resumed"}.`);
    return;
  }
  if (verb === "reset") {
    const store = await readStore();
    const s = store.groups[inbound.groupJid];
    if (s?.tmuxName) {
      tmuxKillSession(s.tmuxName);
      removeManaged(s.tmuxName);
    }
    delete store.groups[inbound.groupJid];
    await writeStore(store);
    await sendChunks(sock, inbound.groupJid, "Agent session reset. Next request will start a fresh session.");
    return;
  }
  await sendChunks(sock, inbound.groupJid, "Unknown command. Try /agent help.");
}

async function getOrCreateGroupSession(sock: WASocket, groupJid: string): Promise<SavedGroupSession> {
  const store = await readStore();
  const existing = store.groups[groupJid];
  // AI-SDK harness sessions keep a STABLE stored id (the minted uuid/key) — only
  // the legacy CLI sessions re-key their sessionId on resume, so only refresh
  // from the live list for those. (For codex-aisdk the live list would report
  // the threadId, which must NOT clobber our control-plane key.)
  const isAisdk = existing?.agent === "aisdk" || existing?.agent === "codex-aisdk";
  const live = existing && !isAisdk ? await liveSessionFor(existing.tmuxName) : null;
  if (existing && isAisdk) {
    // Still alive only if the harness entry is present; otherwise fall through to
    // (re)spawn a fresh one.
    if (readAisdkEntry(existing.sessionId)) return existing;
  } else if (existing && live?.sessionId) {
    if (existing.sessionId !== live.sessionId) {
      existing.sessionId = live.sessionId;
      existing.updatedAt = Date.now();
      await writeStore(store);
    }
    return existing;
  }

  const groupName = await groupSubject(sock, groupJid);
  const tmuxName = `lfg-wa-${randomBytes(3).toString("hex")}`;
  // AI-SDK harnesses own their id up front (we mint it), so for aisdk the
  // sessionId IS the minted uuid; for codex-aisdk we mint a control-plane KEY
  // (the codex threadId — and thus the readable transcript id — only lands
  // after turn 1, so we store the key and resolve the threadId lazily in the
  // relay loop via findEntryByAnyId). The legacy CLI paths discover the
  // sessionId from the pane/pidfile as before.
  const aisdkId = AGENT === "aisdk" || AGENT === "codex-aisdk" ? randomUUID() : null;
  const spawned =
    AGENT === "aisdk"
      ? spawnManagedAisdkSession({ name: tmuxName, cwd: AGENT_CWD, model: "opus", sessionId: aisdkId! })
      : AGENT === "codex-aisdk"
        ? spawnManagedCodexAisdkSession({ name: tmuxName, cwd: AGENT_CWD, model: "gpt-5.5", key: aisdkId! })
        : AGENT === "codex"
          ? spawnManagedCodexSession({ name: tmuxName, cwd: AGENT_CWD })
          : spawnManagedSession({ name: tmuxName, cwd: AGENT_CWD });
  if (!spawned.ok) throw new Error(spawned.error || "failed to spawn managed session");
  addManaged({ tmuxName, cwd: AGENT_CWD, createdAt: Date.now(), agent: AGENT });

  let sessionId: string | null = null;
  if (aisdkId) {
    // Wait for the harness to register; the sessionId we track is the minted id
    // (== transcript id for aisdk; == control-plane key for codex-aisdk).
    for (let i = 0; i < 20 && !readAisdkEntry(aisdkId); i++) await sleep(250);
    sessionId = readAisdkEntry(aisdkId) ? aisdkId : null;
  } else {
    for (let i = 0; i < 20 && !sessionId; i++) {
      await sleep(500);
      if (AGENT === "codex") {
        dismissCodexUpdatePrompt(`${tmuxName}:0.0`);
        sessionId = (await liveSessionFor(tmuxName))?.sessionId ?? null;
      } else {
        const pid = panePidForSession(tmuxName);
        if (pid) sessionId = sessionIdForPid(pid);
      }
    }
  }
  if (!sessionId) throw new Error("managed session started but no sessionId was discovered");

  const rec: SavedGroupSession = {
    groupJid,
    groupName,
    sessionId,
    tmuxName,
    cwd: AGENT_CWD,
    agent: AGENT,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastRelayedId: null,
    lastRelayedTs: Date.now(),
  };
  store.groups[groupJid] = rec;
  await writeStore(store);
  console.error(`[whatsapp] started ${AGENT} session ${sessionId} for ${groupName ?? groupJid}`);
  return rec;
}

async function liveSessionFor(tmuxName: string) {
  return (await listSessions()).find((s) => s.tmuxName === tmuxName) ?? null;
}

// Deliver a message to a group's agent on the right transport. AI-SDK harness
// sessions (aisdk/codex-aisdk) have no tmux pane to type into — serve drives
// them by appending a "send" command to their control-plane file (keyed by the
// minted sessionId/key), so we mirror that here. The legacy CLI sessions go
// through the confirmed-delivery tmux send queue as before.
function sendToSession(session: SavedGroupSession, text: string): void {
  if (session.agent === "aisdk" || session.agent === "codex-aisdk") {
    appendAisdkCmd(session.sessionId, { type: "send", text });
  } else {
    enqueueMessage(session.sessionId, text);
  }
}

// Resolve the transcript id used to read assistant replies. For aisdk and the
// CLI sessions the stored sessionId IS the transcript id. For codex-aisdk the
// stored id is the control-plane key; the readable rollout transcript lives at
// the codex threadId, which the harness patches into the registry after turn 1
// — so map the key → threadId via the registry, falling back to the key until
// it's known.
function transcriptIdFor(session: SavedGroupSession): string {
  if (session.agent === "codex-aisdk") {
    return findAisdkEntryByAnyId(session.sessionId)?.threadId ?? session.sessionId;
  }
  return session.sessionId;
}

async function groupSubject(sock: WASocket, groupJid: string): Promise<string | undefined> {
  try {
    const meta = await sock.groupMetadata(groupJid);
    return meta.subject || undefined;
  } catch {
    return undefined;
  }
}

async function relayAssistantMessages(sock: WASocket) {
  const store = await readStore();
  let changed = false;
  for (const rec of Object.values(store.groups)) {
    if (rec.paused) continue;
    const tp = await resolveTranscript(transcriptIdFor(rec));
    if (!tp) continue;
    const messages = await recentMessages(tp, 80);
    const pending = messages.filter((m) => {
      if (m.role !== "assistant" || m.kind !== "text" || !m.text.trim()) return false;
      if (rec.lastRelayedId && m.id === rec.lastRelayedId) return false;
      if (rec.lastRelayedTs && m.ts && m.ts <= rec.lastRelayedTs) return false;
      if (rec.lastInboundAt && m.ts && m.ts < rec.lastInboundAt - 1000) return false;
      return true;
    });
    for (const m of pending) {
      await sendChunks(sock, rec.groupJid, formatOutbound(m.text));
      rec.lastRelayedId = m.id;
      rec.lastRelayedTs = m.ts ?? Date.now();
      rec.updatedAt = Date.now();
      changed = true;
      console.error(`[whatsapp] ← ${rec.sessionId} ${clip(m.text, 120)}`);
    }
  }
  if (changed) await writeStore(store);
}

function systemInstruction(groupJid: string, groupName?: string): string {
  return `You are lfg's WhatsApp group agent.

This Claude/Codex session is controlled by a WhatsApp sidecar. The WhatsApp group is ${groupName ?? groupJid}.

Behavior:
- Treat each message prefixed with "[Name via WhatsApp]" as a message from that human.
- Reply conversationally and concisely because your response is posted back to WhatsApp.
- You can inspect repos, edit code, run commands, and manage lfg sessions using the available tools.
- If a request needs a risky decision, ask the group a clear question instead of guessing.
- Never expose secrets, tokens, raw env files, private credentials, or unrelated local transcripts.
- When work is complete, report the outcome and any verification performed.

Continue applying these rules for all future WhatsApp messages in this session.`;
}

function formatInbound(inbound: Inbound, text: string): string {
  const sender = inbound.senderName.replace(/\s+/g, " ").trim() || inbound.senderJid;
  return `[${sender} via WhatsApp]\n${text.trim()}`;
}

function formatOutbound(text: string): string {
  return text.trim();
}

async function sendChunks(sock: WASocket, jid: string, text: string) {
  const chunks = chunkText(text, 3500);
  for (const chunk of chunks) {
    await sock.sendMessage(jid, { text: chunk });
    await sleep(250);
  }
}

function chunkText(text: string, max: number): string[] {
  const clean = text.trim();
  if (clean.length <= max) return [clean || "(empty reply)"];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
