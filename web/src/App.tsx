import { Component, createContext, forwardRef, memo, Suspense, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_SCHED_TZ,
  DEFAULT_SIMPLE,
  buildCron,
  describeCron,
  formatRelative,
  nextRunAt,
  parseToSimple,
  type SimpleFreq,
  type SimpleSchedule,
} from "./cron";
import { VoiceOrb } from "./voice-orb";
import {
  livePosition,
  pauseSpeaking,
  resumeSpeaking,
  speakText,
  stopSpeaking,
  useSpeechPlayback,
} from "./voice-tts";
import type {
  CSSProperties,
  ErrorInfo,
  FormEvent,
  MutableRefObject,
  ReactNode,
  TouchEvent as ReactTouchEvent,
} from "react";
import {
  Activity,
  ArrowUp,
  Bot,
  Boxes,
  Braces,
  CalendarClock,
  Flag,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Folder,
  GitFork,
  Loader2,
  MessageSquare,
  Mic,
  Bell,
  MoreVertical,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pause,
  Pencil,
  Pin,
  Play,
  Plus,
  Power,
  Globe,
  Radio,
  RotateCcw,
  ScrollText,
  Send,
  Settings,
  Sparkles,
  Sun,
  TerminalSquare,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { haptic } from "@/lib/haptics";
import { reportError } from "./lib/report-error";
import { lazyWithReload } from "./lib/lazy-with-reload";
import { appPath, appWebSocketUrl } from "./lib/base-path";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
// Code-split: the terminal pulls in ghostty-web's ~400KB WASM, so only load it
// when the Terminal tab is actually opened — keeps the initial bundle lean.
// lazyWithReload recovers from the post-deploy stale-chunk case (React #306).
const TermView = lazyWithReload("TermView", () =>
  import("@/components/TermView").then((m) => ({ default: m.TermView })),
);
const VoiceCall = lazyWithReload("VoiceCall", () =>
  import("./voice-call").then((m) => ({ default: m.VoiceCall })),
);
const BrowserProfiles = lazyWithReload("BrowserProfiles", () => import("./BrowserProfiles"));
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Streamdown } from "streamdown";
import changelogMarkdown from "../../CHANGELOG.md?raw";
import { useExtensionNavTabs } from "./lib/extensions";
import type { ExtensionNavTab } from "./lib/extensions";
import {
  pushSupported,
  pushPermission,
  isSubscribed,
  enablePush,
  disablePush,
} from "./lib/push";
import { AskNavButton, AskPage, AskProvider } from "./components/ask-center";
import {
  STATIC_MODEL_CATALOGS,
  defaultModelForAgent,
  fallbackModelsForAgent,
  mergeModelCatalogs,
  modelsForAgent,
  type AgentKind,
  type ModelCatalogResponse,
  type ModelCatalogs,
} from "./model-catalog";

type Agent = {
  name: string;
  title: string;
  enabled: boolean;
  inputCount: number;
  lastReport: ReportRef | null;
};

type CodingAgentInfo = {
  key: AgentKind;
  label: string;
  visible: boolean;
  status: {
    configured: boolean;
    setupRunning: boolean;
    canAutoSetup: boolean;
    checks: { label: string; ok: boolean; detail?: string }[];
    instructions: string[];
  };
};

type ReportRef = {
  date: string;
  bytes: number;
  mtime: number;
};

type ActionRow = {
  id: string;
  idx?: number;
  text: string;
  status: "pending" | "running" | "done" | "failed";
  result?: { ok: boolean; summary: string };
};

type AgentReport = {
  date: string;
  raw: string;
  html: string;
  actions: ActionRow[];
};

type Session = {
  agent?: "claude" | "aisdk" | "codex" | "codex-aisdk" | "opencode" | "grok" | string;
  pid?: number;
  cmd?: string;
  cwd?: string;
  project?: string;
  title?: string | null;
  lastUserText?: string | null;
  sessionId: string | null;
  startedAt?: number | null;
  lastActivityAt?: number | null;
  last?: { role?: string; kind?: string; text?: string; ts?: number };
  tmuxTarget?: string | null;
  tmuxName?: string | null;
  managed?: boolean;
  assignedUser?: string | null;
  model?: string | null;
  // Build health (from the backend). "blocked" means the session can't make
  // progress until a human acts; statusReason/statusDetail explain why.
  status?: "ok" | "blocked";
  statusReason?: "model_unavailable" | "out_of_credits" | "provider_auth" | "provider_error" | null;
  statusDetail?: string | null;
  // Live "working" flag from the list call (backend computes it from the tmux
  // pane / aisdk registry). Lets a collapsed card show working/idle without
  // holding open a transcript stream — the stream only overrides this while the
  // card is expanded. Polled every 5s with the rest of the list.
  busy?: boolean;
};

type User = { email: string; name?: string; avatar?: string };
type Repo = { name: string; cwd: string; project?: string; custom?: boolean };

// Auto agents: a streamlined agent is JUST a prompt + a schedule. It emits
// findings (notifications), not reports.
type AutoAgent = {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  cwd?: string;
  agent?: AutoAgentBackend;
  model?: string;
  thinkingLevel?: string;
  lastRunAt?: number;
  running?: boolean; // mid-run right now (live, from the server poll)
};

type AutoFinding = {
  id: string;
  agentId: string;
  title: string;
  reasoning: string[];
  suggest?: string;
  severity: "high" | "med" | "low";
  createdAt: number;
  status: "open" | "dismissed" | "session" | "read";
  sessionId?: string;
};

type Message = {
  id?: string;
  role?: string;
  kind?: string;
  text?: string;
  html?: string;
  ts?: number;
  pending?: boolean;
  seed?: boolean;
};

type PromptOption = { index: number; label: string; selected?: boolean };
type SessionPrompt = { question?: string; options: PromptOption[] };
type QueueMsg = {
  id: string;
  text: string;
  status: "pending" | "sending" | "queued" | "failed" | "delivered";
  error?: string;
};

type LoadOlderMessages = (sid: string) => Promise<boolean>;

type ComposerAttachment = {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  previewUrl?: string;
  status: "ready" | "uploading" | "failed";
  error?: string;
};

const THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type AutoAgentBackend = "aisdk" | "codex-aisdk" | "opencode" | "hermes";
const AUTO_AGENT_OPTIONS: { key: AutoAgentBackend; label: string }[] = [
  { key: "aisdk", label: "claude" },
  { key: "codex-aisdk", label: "codex" },
  { key: "opencode", label: "opencode" },
  { key: "hermes", label: "hermes" },
];
const ModelCatalogContext = createContext<ModelCatalogs>(STATIC_MODEL_CATALOGS);

function useModelCatalogs(): ModelCatalogs {
  return useContext(ModelCatalogContext);
}

type ModelSelectionOrigin = "explicit" | "default";

function syncModelWithCatalog({
  defaultModel,
  model,
  models,
  originRef,
  setModel,
}: {
  defaultModel: string;
  model: string;
  models: string[];
  originRef: MutableRefObject<ModelSelectionOrigin>;
  setModel: (model: string) => void;
}) {
  if (!models.includes(model)) {
    originRef.current = "default";
    setModel(defaultModel);
    return;
  }
  if (originRef.current === "default" && model !== defaultModel) {
    setModel(defaultModel);
  }
}

function savedThinkingLevel(): ThinkingLevel {
  const value = localStorage.getItem("lfg_thinking_level");
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : "medium";
}

// Which agents honor a thinking/reasoning-effort level. Claude (CLI + ai-sdk)
// takes an `effort`; Codex (CLI + ai-sdk) takes a `reasoning_effort` — both
// accept the low/medium/high/xhigh values the picker offers. OpenCode's provider
// exposes no reasoning knob, so the selector is hidden for it.
function agentSupportsThinking(agent: AgentKind): boolean {
  return (
    agent === "claude" ||
    agent === "aisdk" ||
    agent === "grok" ||
    agent === "codex" ||
    agent === "codex-aisdk"
  );
}

function agentShowsClaudeUsage(agent: AgentKind): boolean {
  return agent === "claude" || agent === "aisdk";
}

// New-session picker options, in display order. The three AI-SDK agents are the
// only choices ("aisdk" leads since it's the default). Each carries a short
// label + a distinct lucide glyph.
const AGENT_OPTIONS: { key: AgentKind; label: string; Icon: typeof Sparkles }[] = [
  { key: "aisdk", label: "claude", Icon: Sparkles },
  { key: "codex-aisdk", label: "codex", Icon: Braces },
  { key: "grok", label: "grok", Icon: Bot },
  { key: "hermes", label: "hermes", Icon: Sparkles },
  { key: "opencode", label: "opencode", Icon: Boxes },
];

// Maps an agent-kind to its session-card / picker icon. codex variants share the
// codex mark; claude variants (incl. aisdk) share the claude mark.
function agentIconSrc(agent?: string): string {
  if (agent === "codex" || agent === "codex-aisdk") return appPath("/agent-codex.svg");
  if (agent === "grok") return appPath("/agent-grok.svg");
  if (agent === "hermes") return `${appPath("/agent-hermes.svg")}?v=20260629`;
  if (agent === "opencode") return appPath("/agent-opencode.svg");
  return appPath("/agent-claude.svg");
}
function agentIconAlt(agent?: string): string {
  if (agent === "codex" || agent === "codex-aisdk") return "Codex";
  if (agent === "grok") return "Grok";
  if (agent === "hermes") return "Hermes";
  if (agent === "opencode") return "OpenCode";
  return "Claude";
}

function isHarnessAgent(agent?: string | null): boolean {
  return agent === "aisdk" || agent === "codex-aisdk" || agent === "opencode";
}

function canDriveSession(session: Pick<Session, "agent" | "tmuxTarget">): boolean {
  return !!session.tmuxTarget || isHarnessAgent(session.agent);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(appPath(path), init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `${res.status} ${res.statusText}`);
  }
  return data as T;
}

function evlog(event: string, fields: Record<string, unknown> = {}) {
  try {
    const payload = JSON.stringify({
      event,
      source: "browser",
      pageMs: Math.round(performance.now() * 1000) / 1000,
      path: location.pathname + location.search,
      ...fields,
    });
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(appPath("/api/evlog"), blob)) return;
    }
    void fetch(appPath("/api/evlog"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Diagnostics must never affect the UI path being measured.
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function composeAttachmentMessage(
  text: string,
  files: { name: string; path: string }[],
): string {
  if (!files.length) return text;
  const label = files.length === 1 ? "Attached file" : "Attached files";
  const list = files.map((file) => `- ${file.name}: ${file.path}`).join("\n");
  return [text, `${label}:\n${list}`].filter(Boolean).join("\n\n");
}

// Fire-and-forget instrumentation: record which CTA a finding graduated
// through (composer send vs one-tap "Make the change" vs dismiss) and whether
// the user had typed an instruction first. Never block or surface errors — a
// dropped telemetry beat must not interfere with the user's action.
function logFindingAction(
  findingId: string,
  path: "reply" | "execute" | "dismiss",
  hadText: boolean,
): void {
  void fetch(appPath(`/api/auto/findings/${findingId}/action`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, hadText }),
  }).catch(() => {});
}

function timeAgo(value?: number | null) {
  if (!value) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function shortUser(email?: string | null) {
  return email ? email.split("@")[0] : "unassigned";
}

// A human-friendly label for a project. Current backend payloads use the
// top-level folder under the repos root. The legacy dash-encoded full-path shape
// is still accepted so old selected filters degrade cleanly.
function shortProject(project: string): string {
  const legacy = project.match(/(?:^|-)repos-(.+)$/)?.[1];
  if (legacy) return legacy;
  return project;
}

function cycleProjectFilter(options: string[], current: string, dir: 1 | -1): string {
  if (options.length <= 1) return current;
  const idx = Math.max(0, options.indexOf(current));
  return options[(idx + dir + options.length) % options.length];
}

// Fallback mirror of the backend's projectName(cwd): use the top-level folder
// under a repos root when recognizable, otherwise the cwd basename. Newer
// /api/repos payloads include `project`, so this mainly supports older payloads.
function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  const reposIdx = parts.lastIndexOf("repos");
  if (reposIdx >= 0 && parts[reposIdx + 1]) return parts[reposIdx + 1];
  return parts[parts.length - 1] || cwd;
}

function repoProject(repo: Repo): string {
  return repo.project || projectName(repo.cwd);
}

function autoAgentProject(agent: AutoAgent, repos: Repo[]): string {
  const fallbackCwd = repos.find((repo) => repo.name === "lfg")?.cwd || repos[0]?.cwd || "";
  const cwd = agent.cwd || fallbackCwd;
  if (!cwd) return "-";
  return repoProject(repos.find((repo) => repo.cwd === cwd) ?? { name: cwd, cwd });
}

function titleForSession(session: Session) {
  return (
    session.title ||
    session.lastUserText ||
    session.tmuxName ||
    session.project ||
    session.sessionId?.slice(0, 8) ||
    "session"
  );
}

// The most recent activity condensed to one line — used as the collapsed-card
// subtitle. Reuses the exact transcript shortening (buildRenderItems +
// toolGroupLabel): a run of tool calls/results renders as its group summary
// ("2 Bash · 1 Read · 1 result") instead of a raw tool_result dump; prose and
// thinking render as their text.
function latestLine(messages: Message[]): string {
  const items = buildRenderItems(messages);
  const last = items[items.length - 1];
  if (!last) return "";
  return last.type === "tools" ? toolGroupLabel(last.items) : normText(last.message.text);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!);
}

function normText(value?: string) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function seedMessageForSession(session: Session): Message | null {
  const sid = session.sessionId;
  const last = session.last;
  const lastIsProse =
    last?.kind === "text" && (last.role === "assistant" || last.role === "user") && !!last.text;
  const text = normText(lastIsProse ? last.text : session.lastUserText || "");
  if (!sid || !text) return null;
  const role = lastIsProse && last.role === "assistant" ? "assistant" : "user";
  const ts = (lastIsProse ? last.ts : null) ?? session.lastActivityAt ?? session.startedAt ?? Date.now();
  return {
    id: `seed-${sid}-${ts}-${role}`,
    role,
    kind: "text",
    text,
    html: escapeHtml(text).replace(/\n/g, "<br>"),
    ts,
    seed: true,
  };
}

// Encode captured PCM (Float32) as a 16-bit mono WAV — the format the server's
// /api/voice/stt (faster-whisper) accepts. We capture raw PCM via the Web Audio
// API rather than MediaRecorder because MediaRecorder emits webm/opus (Chrome)
// or mp4/aac (iOS Safari), neither of which the upstream takes; PCM→WAV is the
// one path that works the same on every browser, iOS included.
function floatToWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const str = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, v * 32767, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "application/octet-stream" });
}

// Resample a Float32 PCM window (captured at the AudioContext's native rate) to
// the 16 kHz mono signed-16-bit PCM the realtime-STT bridge expects, returning a
// fresh ArrayBuffer ready to ship as a binary WS frame. We request a 16 kHz
// context up front (so this is usually a straight float→int16 cast), but some
// browsers — iOS Safari especially — ignore the requested rate and hand back
// 44.1/48 kHz, so we linear-interpolate down when the rates differ. int16 frames
// are little-endian on every browser we target, which is what the upstream wants.
function pcm16kFrom(samples: Float32Array, inRate: number): ArrayBuffer {
  const clamp = (s: number) => {
    const v = Math.max(-1, Math.min(1, s));
    return v < 0 ? v * 32768 : v * 32767;
  };
  if (inRate === 16000) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = clamp(samples[i]);
    return out.buffer;
  }
  const ratio = inRate / 16000;
  const outLen = Math.max(0, Math.floor(samples.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = idx - i0;
    out[i] = clamp(samples[i0] * (1 - frac) + samples[i1] * frac);
  }
  return out.buffer;
}

// Join the finalized + in-flight halves of a streaming transcript into the one
// string the input should show. Both halves are trimmed and empties dropped so a
// trailing space or a not-yet-started partial never leaks into the field.
function joinTranscript(committed: string, partial: string): string {
  return [committed, partial]
    .map((t) => t.trim())
    .filter(Boolean)
    .join(" ");
}

type DictationState = "idle" | "recording" | "transcribing";

// RMS below this on a 4096-sample window counts as silence. Speech sits well
// above (~0.05–0.2); room tone / mic hiss sits below. Fixed rather than
// adaptive — good enough to tell "talking" from "stopped" for end-of-turn.
const VOICE_RMS_THRESHOLD = 0.01;

// Visual reactivity tuning for the recording button. We already compute the
// per-frame RMS for voice detection; we reuse it to drive a live 0..1 "level"
// that the button glows / scales against. No external audio library needed —
// the Web Audio data is right here, and a viz lib would fight the custom PCM
// pipeline below.
// LEVEL_FULL_SCALE: RMS that maps to a full-intensity (1.0) reaction. Normal
// talking sits ~0.05–0.2, so this lets ordinary speech fill most of the range
// and a raised voice tops it out.
const LEVEL_FULL_SCALE = 0.22;
// Envelope follower: snap up fast on a vocal attack (tracks velocity — sudden
// loudness punches through immediately), ease down slowly so the button glides
// back rather than strobing on every syllable gap.
const LEVEL_ATTACK = 0.55;
const LEVEL_RELEASE = 0.1;

function recordingButtonStyle(level: number): CSSProperties {
  // A held thumb covers the center of a 36-44px button, so the recording state
  // needs a fixed growth floor before the audio-reactive pulse is visible.
  const scale = 1.34 + level * 0.16;
  const glow = 16 + level * 26;
  const spread = 4 + level * 8;
  const opacity = Math.round(45 + level * 45);
  return {
    transform: `scale(${scale.toFixed(3)})`,
    boxShadow: `0 0 0 5px color-mix(in srgb, var(--destructive) 22%, transparent), 0 0 ${glow.toFixed(
      1,
    )}px ${spread.toFixed(1)}px color-mix(in srgb, var(--destructive) ${opacity}%, transparent)`,
    transition: "transform 80ms linear, box-shadow 80ms linear",
  };
}

// Push-to-talk dictation with optional hands-free auto-send. Tap to record, tap
// to stop. Audio streams live to the server's realtime-STT bridge
// (/api/voice/stt-stream → ElevenLabs Scribe v2 Realtime): we capture mic PCM,
// resample to 16 kHz mono int16, and push it as binary WS frames. The bridge
// streams back {type:"partial"} (live interim) and {type:"final"} (committed)
// transcripts — so `onInterim` now reflects the upstream's own running
// hypothesis instead of a re-POST poll, and the final arrives ~150 ms after you
// stop instead of after a whole-clip round trip.
// `onText` receives the transcript on a manual stop (fill the input, let the
// user edit/send). When `onAutoSubmit` is supplied we also run voice-activity
// detection: once speech has been heard, `silenceMs` of quiet auto-stops the
// recording and routes the transcript to `onAutoSubmit` instead — fully
// hands-free (speak, pause, it sends).
// We keep the raw captured PCM as a fallback: if the realtime socket never
// connects (e.g. ELEVENLABS_API_KEY unset → the bridge closes us) or yields no
// text, stop() POSTs the buffered clip to the batch /api/voice/stt endpoint so
// dictation degrades gracefully rather than silently dropping the utterance.
function useDictation(opts: {
  onText: (text: string, base: string) => void;
  onAutoSubmit?: (text: string, base: string) => void;
  // Called repeatedly during recording with the best-guess transcript so far.
  // `base` is the input text captured when recording began, so the live partial
  // and the eventual final result compose against the same anchor.
  onInterim?: (text: string, base: string) => void;
  baseText?: string;
  silenceMs?: number;
}) {
  const [state, setState] = useState<DictationState>("idle");
  // Live 0..1 microphone level, smoothed by an envelope follower. Drives the
  // recording button's glow + scale so it reacts to volume and velocity.
  const [level, setLevel] = useState(0);
  const rawLevelRef = useRef(0); // latest raw RMS written by onaudioprocess
  const levelSmoothRef = useRef(0); // envelope-smoothed value the rAF loop emits
  const rafRef = useRef<number | null>(null);
  const sessionRef = useRef<{
    ac: AudioContext;
    stream: MediaStream;
    proc: ScriptProcessorNode;
    src: MediaStreamAudioSourceNode;
    chunks: Float32Array[]; // native-rate capture, kept only for batch fallback
    rate: number; // native AudioContext sample rate
    vad: number | null;
    // Realtime-STT socket and its running transcript. `committed` is the text the
    // bridge has finalized; `partial` is the live hypothesis for audio not yet
    // committed; their join is what the input shows. `pending` holds resampled
    // frames captured before the socket finished opening (flushed on "open").
    // `broken` flips if the socket errors/closes early so stop() batch-falls-back.
    ws: WebSocket | null;
    pending: ArrayBuffer[];
    committed: string;
    partial: string;
    broken: boolean;
    // Resolvers waiting for the next "final" frame — settled by the flush we send
    // on stop, so we hand back the committed tail instead of a clipped partial.
    finalWaiters: Array<() => void>;
  } | null>(null);

  // start() is async — the mic/socket aren't live until getUserMedia resolves and
  // sessionRef is assigned. `startingRef` marks that window; if a release fires
  // stop() inside it, `pendingStopRef` records the requested stop so start() can
  // honor it the instant the session exists. Without this, a quick release loses
  // the take (stop sees a null session and bails) AND leaks a live recording.
  const startingRef = useRef(false);
  const pendingStopRef = useRef<{ auto: boolean; discard: boolean } | null>(null);

  // Keep the callbacks in refs so the VAD interval / stop always see the latest
  // handlers without needing to tear down and recreate the audio session.
  const onTextRef = useRef(opts.onText);
  const onAutoSubmitRef = useRef(opts.onAutoSubmit);
  const onInterimRef = useRef(opts.onInterim);
  const baseTextRef = useRef(opts.baseText ?? "");
  // Base text snapshotted at record-start, shared by interim + final so the
  // final transcript cleanly replaces the live partial without double-appending.
  const capturedBaseRef = useRef("");
  const silenceMs = opts.silenceMs ?? 2500;
  onTextRef.current = opts.onText;
  onAutoSubmitRef.current = opts.onAutoSubmit;
  onInterimRef.current = opts.onInterim;
  baseTextRef.current = opts.baseText ?? "";

  const supported =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  // `auto` distinguishes a silence-triggered stop (→ onAutoSubmit) from a manual
  // tap (→ onText). `discard` tears the session down without transcribing — used
  // by the press-and-hold FAB's slide-up-to-cancel gesture, where we drop the
  // audio entirely rather than spend a round trip on a transcript we'd throw away.
  // Idempotent: clears sessionRef first so a late VAD tick or a double-tap can't
  // run the teardown twice.
  const stop = useCallback(
    async (auto = false, discard = false) => {
      const s = sessionRef.current;
      sessionRef.current = null;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      rawLevelRef.current = 0;
      levelSmoothRef.current = 0;
      setLevel(0);
      if (!s) {
        // No live session yet. If start() is still acquiring the mic, this is a
        // release that beat initialization — record the request so start() tears
        // down (and submits) the moment the session is ready instead of leaking it.
        if (startingRef.current) pendingStopRef.current = { auto, discard };
        setState("idle");
        return;
      }
      if (s.vad !== null) clearInterval(s.vad);
      // Stop feeding the mic first so no frame races the flush/close below.
      s.proc.disconnect();
      s.src.disconnect();
      s.stream.getTracks().forEach((t) => t.stop());
      await s.ac.close().catch(() => {});
      const closeWs = () => {
        try {
          s.ws?.close();
        } catch {
          /* already closing */
        }
      };
      if (discard) {
        closeWs();
        setState("idle");
        return;
      }
      const deliver = (text: string) => {
        const t = text.trim();
        if (!t) return;
        const base = capturedBaseRef.current;
        if (auto && onAutoSubmitRef.current) onAutoSubmitRef.current(t, base);
        else onTextRef.current(t, base);
      };

      setState("transcribing");

      // Primary path: ask the realtime bridge to commit the trailing audio, wait
      // briefly for the final segment, then deliver the joined transcript. We
      // resolve on the first `final` frame OR a timeout so a missing commit can't
      // hang the button in "transcribing".
      if (s.ws && s.ws.readyState === WebSocket.OPEN && !s.broken) {
        try {
          s.ws.send(JSON.stringify({ type: "flush" }));
        } catch {
          s.broken = true;
        }
        if (!s.broken) {
          await new Promise<void>((resolve) => {
            let done = false;
            const fin = () => {
              if (done) return;
              done = true;
              resolve();
            };
            s.finalWaiters.push(fin);
            setTimeout(fin, 1800);
          });
        }
      }

      const streamed = joinTranscript(s.committed, s.partial);
      closeWs();

      if (streamed && !s.broken) {
        deliver(streamed);
        setState("idle");
        return;
      }

      // Fallback: the realtime socket never connected (e.g. ELEVENLABS_API_KEY
      // unset → bridge closed us) or yielded nothing. POST the buffered clip to
      // the batch endpoint so the utterance isn't silently dropped.
      const total = s.chunks.reduce((n, c) => n + c.length, 0);
      if (!total) {
        if (streamed) deliver(streamed);
        setState("idle");
        return;
      }
      const merged = new Float32Array(total);
      let offset = 0;
      for (const c of s.chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      try {
        const res = await fetch(appPath("/api/voice/stt"), {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: floatToWav(merged, s.rate),
        });
        const data = (await res.json().catch(() => ({}))) as { text?: string };
        const text = (data.text || "").trim();
        if (res.ok && text) deliver(text);
        else if (streamed) deliver(streamed);
      } catch {
        // Batch also failed — fall back to whatever the stream gave us, if any.
        if (streamed) deliver(streamed);
      }
      setState("idle");
    },
    [],
  );

  // `autoStop` (default true) wires the silence-VAD that auto-submits after a
  // pause — the tap-to-dictate behavior. Press-and-hold passes false: the user
  // controls the take by holding, so a mid-utterance pause must not cut it off;
  // release is the only thing that stops + sends.
  const start = useCallback(async (startOpts?: { autoStop?: boolean }) => {
    const autoStop = startOpts?.autoStop ?? true;
    if (sessionRef.current || startingRef.current) return;
    startingRef.current = true;
    pendingStopRef.current = null;
    capturedBaseRef.current = baseTextRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      // Ask for a 16 kHz context so capture matches the bridge's expected rate
      // and pcm16kFrom is a straight cast. Browsers that refuse the hint hand
      // back their native rate, which the resampler handles.
      let ac: AudioContext;
      try {
        ac = new Ctor({ sampleRate: 16000 });
      } catch {
        ac = new Ctor();
      }
      const src = ac.createMediaStreamSource(stream);
      const proc = ac.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];

      // Realtime-STT socket: stream resampled PCM up, receive {partial,final}
      // transcripts back. Built before capture starts so the first frame has
      // somewhere to go (queued in `pending` until the socket opens).
      let ws: WebSocket | null = null;
      try {
        ws = new WebSocket(appWebSocketUrl("/api/voice/stt-stream"));
        ws.binaryType = "arraybuffer";
      } catch {
        ws = null;
      }
      if (ws) {
        ws.onopen = () => {
          const s = sessionRef.current;
          if (!s || s.ws !== ws) return;
          for (const frame of s.pending) {
            try {
              ws!.send(frame);
            } catch {
              s.broken = true;
            }
          }
          s.pending = [];
        };
        ws.onmessage = (ev) => {
          const s = sessionRef.current;
          if (!s || s.ws !== ws) return;
          let d: { type?: string; text?: string };
          try {
            d = JSON.parse(typeof ev.data === "string" ? ev.data : "");
          } catch {
            return;
          }
          if (d.type === "partial") {
            s.partial = (d.text || "").trim();
          } else if (d.type === "final") {
            // Fold the committed segment in and clear the live hypothesis; settle
            // any flush waiting on this final.
            s.committed = joinTranscript(s.committed, d.text || "");
            s.partial = "";
            const waiters = s.finalWaiters;
            s.finalWaiters = [];
            for (const w of waiters) w();
          } else {
            return;
          }
          onInterimRef.current?.(joinTranscript(s.committed, s.partial), capturedBaseRef.current);
        };
        ws.onerror = () => {
          const s = sessionRef.current;
          if (s && s.ws === ws) s.broken = true;
        };
        ws.onclose = () => {
          const s = sessionRef.current;
          if (!s || s.ws !== ws) return;
          // A close before we've delivered anything means the bridge rejected us
          // (provider unconfigured) — mark broken so stop() batch-falls-back, and
          // release any pending flush so the button doesn't hang.
          if (!s.committed && !s.partial) s.broken = true;
          const waiters = s.finalWaiters;
          s.finalWaiters = [];
          for (const w of waiters) w();
        };
      }

      // VAD state: `spoke` gates auto-stop so silence before the first word
      // never fires; `lastVoiceAt` is the clock the silence window runs against.
      let spoke = false;
      let lastVoiceAt = Date.now();
      proc.onaudioprocess = (e) => {
        const buf = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(buf));
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        // Feed the live meter every frame (cheap ref write; the rAF loop reads
        // and smooths it). Kept separate from the auto-submit gate below.
        rawLevelRef.current = rms;
        // Ship this window to the realtime bridge as 16 kHz int16 PCM. Queue it
        // if the socket is still opening; drop silently once it's broken.
        const s = sessionRef.current;
        if (s && s.ws && !s.broken) {
          const frame = pcm16kFrom(buf, s.rate);
          if (s.ws.readyState === WebSocket.OPEN) {
            try {
              s.ws.send(frame);
            } catch {
              s.broken = true;
            }
          } else if (s.ws.readyState === WebSocket.CONNECTING) {
            s.pending.push(frame);
          }
        }
        if (!onAutoSubmitRef.current) return;
        if (rms > VOICE_RMS_THRESHOLD) {
          spoke = true;
          lastVoiceAt = Date.now();
        }
      };
      const vad =
        autoStop && onAutoSubmitRef.current
          ? (setInterval(() => {
              if (!sessionRef.current || !spoke) return;
              if (Date.now() - lastVoiceAt >= silenceMs) void stop(true);
            }, 200) as unknown as number)
          : null;
      sessionRef.current = {
        ac,
        stream,
        proc,
        src,
        chunks,
        rate: ac.sampleRate,
        vad,
        ws,
        pending: [],
        committed: "",
        partial: "",
        broken: false,
        finalWaiters: [],
      };
      // Connect last: audio only starts flowing once the session (and its socket
      // handle) exists, so the first onaudioprocess frame has somewhere to go.
      src.connect(proc);
      proc.connect(ac.destination);
      // Drive the live level on the animation frame clock. Envelope-follow the
      // raw RMS — fast attack tracks how hard/quick you speak (velocity), slow
      // release keeps the glow smooth between words.
      levelSmoothRef.current = 0;
      const tick = () => {
        if (!sessionRef.current) {
          rafRef.current = null;
          return;
        }
        const target = Math.min(1, rawLevelRef.current / LEVEL_FULL_SCALE);
        const cur = levelSmoothRef.current;
        const coeff = target > cur ? LEVEL_ATTACK : LEVEL_RELEASE;
        const next = cur + (target - cur) * coeff;
        levelSmoothRef.current = next;
        setLevel(Math.round(next * 1000) / 1000);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      setState("recording");
      startingRef.current = false;
      // A release that fired during init queued a stop — run it now that the
      // session is live so the take is submitted (and the mic released) instead
      // of recording forever with no way to stop it.
      // Read through the ref's declared type — TS otherwise control-flow-narrows
      // this to the `null` we assigned at start(), unaware stop() can mutate it.
      const queued = pendingStopRef.current as { auto: boolean; discard: boolean } | null;
      if (queued) {
        pendingStopRef.current = null;
        void stop(queued.auto, queued.discard);
      }
    } catch {
      startingRef.current = false;
      pendingStopRef.current = null;
      setState("idle");
    }
  }, [silenceMs, stop]);

  const toggle = useCallback(() => {
    if (state === "transcribing") return;
    // Tapping the button to stop submits the request (stop(auto=true) → routes
    // the transcript through onAutoSubmit), matching the silence-triggered and
    // release-to-send paths. Falls back to onText if no onAutoSubmit is wired.
    if (sessionRef.current) void stop(true);
    else void start();
  }, [state, start, stop]);

  return { state, toggle, start, stop, supported, level };
}

// Imperative handle so a parent (e.g. the orb's press-and-hold gesture) can
// drive dictation without a click on the button itself. `submitOnStop` routes
// the stopped transcript through the auto-submit callback (release-to-send)
// rather than just inserting it.
type MicHandle = { start: () => void; stop: (submitOnStop?: boolean) => void };

// How long the mic button must be held before it becomes push-to-talk. A press
// shorter than this is treated as a tap (toggle dictation); longer engages
// hold-to-talk (record while held, release to send).
const MIC_LONG_PRESS_MS = 300;

const MicButton = forwardRef<
  MicHandle,
  {
    onText: (text: string, base: string) => void;
    onAutoSubmit?: (text: string, base: string) => void;
    onInterim?: (text: string, base: string) => void;
    baseText?: string;
    silenceMs?: number;
    className?: string;
    minimal?: boolean;
    // Fires true while actively recording (tap or hold), false otherwise — lets a
    // parent reflect "listening" in its own chrome (e.g. glow the session border).
    onRecordingChange?: (recording: boolean) => void;
  }
>(function MicButton(
  { onText, onAutoSubmit, onInterim, baseText, silenceMs, className, minimal = false, onRecordingChange },
  ref,
) {
  const { state, toggle, start, stop, supported, level } = useDictation({
    onText,
    onAutoSubmit,
    onInterim,
    baseText,
    silenceMs,
  });
  useImperativeHandle(
    ref,
    () => ({
      start: () => void start(),
      // submitOnStop → stop(auto=true) delivers via onAutoSubmit (release-to-send).
      stop: (submitOnStop = true) => void stop(submitOnStop),
    }),
    [start, stop],
  );

  // Press-and-hold vs tap. A pointer held past MIC_LONG_PRESS_MS becomes
  // push-to-talk: we start recording with the silence-VAD disabled (hold
  // controls the take) and stop+submit on release. A shorter press falls through
  // to `toggle` — the existing tap-to-dictate (records, auto-sends after a
  // pause). Haptics differ on purpose so the two gestures feel distinct: a light
  // "selection" tick on tap, a firmer "medium" thud when hold engages.
  const holdTimer = useRef<number | null>(null);
  const holdFired = useRef(false);
  const pointerDown = useRef(false);
  // Set on pointer-up so the synthetic click that follows a touch/mouse gesture
  // is ignored — keyboard activation (no preceding pointer) still runs `toggle`.
  const skipNextClick = useRef(false);

  const clearHoldTimer = useCallback(() => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      // Primary button / touch / pen only.
      if (e.button !== 0) return;
      if (state === "transcribing") return;
      pointerDown.current = true;
      holdFired.current = false;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported — pointerup still fires on the element */
      }
      // Only idle → hold can begin a fresh take. If we're already recording
      // (tapped on earlier), a hold shouldn't restart; release will toggle off.
      if (state !== "idle") return;
      clearHoldTimer();
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null;
        holdFired.current = true;
        // "heavy" (35ms, full intensity) — the press-to-talk engage thud. Same
        // preset vibes uses for long-press; strong enough to actually feel.
        haptic("heavy");
        void start({ autoStop: false });
      }, MIC_LONG_PRESS_MS);
    },
    [state, start, clearHoldTimer],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!pointerDown.current) return;
      pointerDown.current = false;
      skipNextClick.current = true;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* nothing captured */
      }
      clearHoldTimer();
      if (holdFired.current) {
        // Hold engaged → release sends.
        holdFired.current = false;
        void stop(true);
      } else {
        // Quick tap → existing toggle behavior (records, auto-sends on pause).
        // "medium" so the tap is felt but stays distinct from the heavier hold.
        haptic("medium");
        toggle();
      }
    },
    [stop, toggle, clearHoldTimer],
  );

  const onPointerCancel = useCallback(() => {
    if (!pointerDown.current) return;
    pointerDown.current = false;
    clearHoldTimer();
    // Interrupted mid-gesture (e.g. the OS stole the pointer). If a hold was
    // live, end it gracefully by sending what we have rather than dropping it.
    if (holdFired.current) {
      holdFired.current = false;
      void stop(true);
    }
  }, [stop, clearHoldTimer]);

  const onClick = useCallback(() => {
    // Pointer gestures already handled this; only keyboard activation (Enter /
    // Space, which fires click with no preceding pointer sequence) reaches here.
    if (skipNextClick.current) {
      skipNextClick.current = false;
      return;
    }
    if (state === "transcribing") return;
    haptic("medium");
    toggle();
  }, [state, toggle]);

  // Surface "listening" to the parent so it can light up around the composer.
  // Cleanup clears it if we unmount mid-recording.
  useEffect(() => {
    onRecordingChange?.(state === "recording");
    return () => onRecordingChange?.(false);
  }, [state, onRecordingChange]);

  if (!supported) return null;
  const recording = state === "recording";
  // While recording, the button reacts to the live mic level: it scales up and
  // throws a red glow ring that swells with your volume. Inline transitions keep
  // it snappy (the className `transition` would lag the per-frame updates by
  // ~150ms and make it feel sluggish).
  const reactiveStyle = recording ? recordingButtonStyle(level) : undefined;
  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={recording ? "Stop dictation" : "Dictate"}
      title="Tap to dictate · hold to talk"
      style={reactiveStyle}
      className={cn(
        "flex shrink-0 touch-none select-none items-center justify-center rounded-full transition",
        recording
          ? "z-10 bg-destructive text-destructive-foreground"
          : minimal
            ? "relative z-10 bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground"
            : "text-muted-foreground hover:bg-muted",
        className,
      )}
    >
      {state === "transcribing" ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Mic className="size-4" />
      )}
    </button>
  );
});

// Composer send button that doubles as push-to-talk. A quick tap sends the
// current message; a press held past MIC_LONG_PRESS_MS engages voice — it records
// while held (silence-VAD disabled so a pause won't cut you off) and stops+submits
// on release, streaming the live transcript into the textarea as you speak. This
// merges the old separate Send + Mic affordances into one control: tap to send,
// hold to talk. Keyboard activation (Enter/Space on the focused button) just sends.
function ComposerSendButton({
  canSend,
  sending,
  baseText,
  onSend,
  onText,
  onInterim,
  onAutoSubmit,
  onRecordingChange,
  className,
}: {
  canSend: boolean;
  sending: boolean;
  baseText: string;
  onSend: () => void;
  onText: (text: string, base: string) => void;
  onInterim: (text: string, base: string) => void;
  onAutoSubmit: (text: string, base: string) => void;
  onRecordingChange?: (recording: boolean) => void;
  className?: string;
}) {
  const { state, start, stop, supported, level } = useDictation({
    onText,
    onAutoSubmit,
    onInterim,
    baseText,
  });

  const holdTimer = useRef<number | null>(null);
  const holdFired = useRef(false);
  const pointerDown = useRef(false);
  // Set on pointer-up so the synthetic click that follows a pointer gesture is
  // ignored — keyboard activation (no preceding pointer) still sends via onClick.
  const skipNextClick = useRef(false);

  const clearHoldTimer = useCallback(() => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      if (state === "transcribing" || sending) return;
      pointerDown.current = true;
      holdFired.current = false;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported — pointerup still fires on the element */
      }
      // Only arm hold-to-talk from idle, and only when dictation is available;
      // otherwise this stays a plain send button.
      if (state !== "idle" || !supported) return;
      clearHoldTimer();
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null;
        holdFired.current = true;
        haptic("heavy"); // the press-to-talk engage thud
        void start({ autoStop: false });
      }, MIC_LONG_PRESS_MS);
    },
    [state, sending, supported, start, clearHoldTimer],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!pointerDown.current) return;
      pointerDown.current = false;
      skipNextClick.current = true;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* nothing captured */
      }
      clearHoldTimer();
      if (holdFired.current || state === "recording") {
        // Hold engaged → release sends the spoken take.
        holdFired.current = false;
        void stop(true);
        return;
      }
      // Quick tap → send the typed message (no-op if there's nothing to send).
      if (canSend && !sending) {
        haptic("selection");
        onSend();
      }
    },
    [stop, state, canSend, sending, onSend, clearHoldTimer],
  );

  const onPointerCancel = useCallback(() => {
    if (!pointerDown.current) return;
    pointerDown.current = false;
    clearHoldTimer();
    // Interrupted mid-gesture — if a hold was live, end it gracefully by sending
    // what we have rather than dropping it.
    if (holdFired.current) {
      holdFired.current = false;
      void stop(true);
    }
  }, [stop, clearHoldTimer]);

  const onClick = useCallback(() => {
    // Pointer gestures already handled this; only keyboard activation reaches here.
    if (skipNextClick.current) {
      skipNextClick.current = false;
      return;
    }
    if (state !== "idle" || sending) return;
    if (canSend) onSend();
  }, [state, sending, canSend, onSend]);

  // Surface "listening" to the parent so the composer chrome can light up.
  useEffect(() => {
    onRecordingChange?.(state === "recording");
    return () => onRecordingChange?.(false);
  }, [state, onRecordingChange]);

  const recording = state === "recording";
  const transcribing = state === "transcribing";
  // Nothing to send while idle → dim the control, but keep it interactive so
  // hold-to-talk still works on an empty composer.
  const dim = !canSend && state === "idle" && !sending;

  // While recording the button reacts to live mic level — scales up and throws a
  // red glow ring that swells with volume. Inline transitions keep it per-frame
  // snappy (the className `transition` would lag the updates and feel sluggish).
  const reactiveStyle = recording ? recordingButtonStyle(level) : undefined;

  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={
        recording ? "Release to send voice message" : canSend ? "Send — hold to talk" : "Hold to talk"
      }
      title={recording ? "Release to send" : "Tap to send · hold to talk"}
      style={reactiveStyle}
      className={cn(
        "flex shrink-0 touch-none select-none items-center justify-center rounded-full font-semibold transition active:scale-[0.97]",
        recording
          ? "z-10 bg-destructive text-destructive-foreground"
          : "relative z-10 bg-foreground/[0.08] text-foreground/80 shadow-sm hover:bg-foreground/[0.12] hover:text-foreground",
        dim && "opacity-50",
        className,
      )}
    >
      {sending || transcribing ? (
        <Loader2 className="size-4 animate-spin" />
      ) : recording ? (
        <Mic className="size-4" />
      ) : (
        <Send className="size-4" />
      )}
    </button>
  );
}

function AppShellSkeleton() {
  return (
    <div className="flex h-dvh items-center justify-center bg-background text-muted-foreground">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" />
        Loading lfg v2
      </div>
    </div>
  );
}

// A single bad render (e.g. an unexpected menu/streaming edge case) must never
// blank the whole app — isolate it so the rest of the live view keeps working.
class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: (reset: () => void) => ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("lfg: render error caught by boundary", error, info);
    // Auto-report render errors with the React component stack — it usually
    // names the failing component, which the auto-fix agent uses to locate it.
    reportError({
      kind: "react",
      message: error?.message || String(error),
      stack: error?.stack,
      componentStack: info?.componentStack ?? undefined,
    });
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.reset);
      return (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-center text-sm text-destructive">
          <span>Something went wrong rendering this view.</span>
          <Button size="sm" variant="outline" onClick={this.reset}>
            Retry
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Top-level backstop: if anything outside a card boundary throws, show a
// recoverable full-screen message instead of a blank page.
export function RootErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={(reset) => (
        <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground">
          <div className="text-sm font-semibold">lfg hit an unexpected error</div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={reset}>
              Retry
            </Button>
            <Button size="sm" variant="brand" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

// SSE `data` frames can arrive malformed or truncated (notably on iOS Safari,
// which has thrown "JSON Parse error: Unterminated string" here). A bad frame
// must not bubble out of the EventSource listener and crash the live view, so
// parse defensively and drop anything that won't decode — same posture as the
// voice WS handler above.
function parseLiveEvent<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

// Whether a session card starts collapsed when we've never seen it before (no
// persisted choice). true = lazy by default: a fresh session does NOT open a
// transcript stream until you expand it; you still see it working/idle/blocked
// from the list badges. Flip to false to restore the old "everything expanded"
// behavior. Per-session choices (localStorage `lfg-collapsed:<sid>`) win over this.
const DEFAULT_COLLAPSED = true;

// Whether a card is collapsed, given its persisted choice and the default above.
function isCollapsedSid(sid: string): boolean {
  try {
    const v = localStorage.getItem(`lfg-collapsed:${sid}`);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    /* private mode / quota */
  }
  return DEFAULT_COLLAPSED;
}

function markExpandedSid(sid: string): void {
  try {
    localStorage.setItem(`lfg-collapsed:${sid}`, "0");
  } catch {
    /* private mode / quota */
  }
  window.dispatchEvent(new Event("lfg-collapse-change"));
}

function markCollapsedSid(sid: string): void {
  try {
    localStorage.setItem(`lfg-collapsed:${sid}`, "1");
  } catch {
    /* private mode / quota */
  }
  window.dispatchEvent(new Event("lfg-collapse-change"));
}

// Sessions created in this tab within the last ~2s — drives the one-shot card
// entrance animation. Module-level (not state) so it survives the re-render that
// brings the new card in; the card reads it on its first mount and the entry is
// auto-pruned so the animation never replays on later reorders/re-renders.
const recentlyCreatedSids = new Set<string>();
function markCreatedSid(sid: string): void {
  recentlyCreatedSids.add(sid);
  window.setTimeout(() => recentlyCreatedSids.delete(sid), 2000);
}

// The set of EXPANDED session ids among `sessions`, kept in sync with the
// per-card collapse state. SessionCard dispatches `lfg-collapse-change` when the
// user toggles a card (and the browser fires `storage` for other tabs); we
// recompute from localStorage on either. Drives which sessions actually stream.
function useExpandedIds(sessions: Session[], forceExpanded = false): string[] {
  const sids = useMemo(
    () => sessions.map((s) => s.sessionId).filter((id): id is string => !!id),
    [sessions],
  );
  const sidKey = sids.join(",");
  const read = useCallback(
    () => (forceExpanded ? sids : sids.filter((sid) => !isCollapsedSid(sid))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sidKey, forceExpanded],
  );
  const [expanded, setExpanded] = useState<string[]>(read);
  useEffect(() => {
    setExpanded(read());
    const onChange = () => setExpanded(read());
    window.addEventListener("lfg-collapse-change", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("lfg-collapse-change", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [read]);
  return expanded;
}

// `sessions` is the full live list (used for the polled busy baseline so every
// card — even collapsed ones — knows whether its session is working). `streamIds`
// is the subset to actually open a transcript SSE for (the EXPANDED cards). This
// is the laziness: we no longer hold a live stream open for every session, only
// the ones the user has expanded. Collapsed cards fall back to the 5s list poll.
function useLiveSessionStream(sessions: Session[], streamIds: string[]) {
  const ids = useMemo(
    () => streamIds.filter((id): id is string => !!id),
    [streamIds],
  );
  const streamKey = ids.join(",");
  // Busy baseline straight off the list payload — covers sessions we are NOT
  // streaming. The stream's per-session busy (below) overrides this for expanded
  // cards, where it updates ~1s instead of every 5s poll.
  const listBusy = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const session of sessions) {
      if (session.sessionId) map[session.sessionId] = !!session.busy;
    }
    return map;
  }, [sessions]);
  const seedBySid = useMemo(() => {
    const map: Record<string, Message> = {};
    for (const session of sessions) {
      const seed = seedMessageForSession(session);
      if (session.sessionId && seed) map[session.sessionId] = seed;
    }
    return map;
  }, [sessions]);
  const [messagesBySid, setMessagesBySid] = useState<Record<string, Message[]>>({});
  const [busyBySid, setBusyBySid] = useState<Record<string, boolean>>({});
  const [promptsBySid, setPromptsBySid] = useState<Record<string, SessionPrompt | null>>({});
  const [queuesBySid, setQueuesBySid] = useState<Record<string, QueueMsg[]>>({});
  const [loadingBySid, setLoadingBySid] = useState<Record<string, boolean>>({});
  const [nextBeforeBySid, setNextBeforeBySid] = useState<Record<string, number | null>>({});
  const seenRef = useRef<Record<string, Set<string>>>({});
  const messagesRef = useRef(messagesBySid);
  const nextBeforeRef = useRef(nextBeforeBySid);
  useEffect(() => {
    messagesRef.current = messagesBySid;
  }, [messagesBySid]);
  useEffect(() => {
    nextBeforeRef.current = nextBeforeBySid;
  }, [nextBeforeBySid]);
  // Per-session timers that auto-retire a lingering "thinking…" shimmer. A
  // thinking block is already complete by the time we read it from the
  // transcript, and the next content line can lag many seconds (model still
  // writing its answer), so without this the shimmer sticks long past the
  // thinking phase while the turn is still busy.
  const thinkTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const active = new Set(ids);
    const live = new Set(Object.keys(listBusy));
    seenRef.current = Object.fromEntries(
      Object.entries(seenRef.current).filter(([sid]) => live.has(sid)),
    );
    setMessagesBySid((prev) => {
      const next: Record<string, Message[]> = {};
      for (const sid of live) {
        const current = prev[sid];
        next[sid] = current?.length ? current : seedBySid[sid] ? [seedBySid[sid]] : [];
      }
      return next;
    });
    setBusyBySid((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([sid]) => active.has(sid))),
    );
    setPromptsBySid((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([sid]) => active.has(sid))),
    );
    setQueuesBySid((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([sid]) => active.has(sid))),
    );
    setNextBeforeBySid((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([sid]) => live.has(sid))),
    );
    setLoadingBySid((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([sid]) => live.has(sid)));
      for (const sid of active) {
        if (!(messagesRef.current[sid]?.some((message) => !message.seed))) next[sid] = true;
      }
      return next;
    });

    if (!ids.length) return;
    const rid =
      crypto.randomUUID?.() ??
      `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const t0 = performance.now();
    const firstMsg = new Set<string>();
    const firstReady = new Set<string>();
    evlog("live_stream_client_start", { rid, ids, idsCount: ids.length });
    const es = new EventSource(appPath(`/api/live/stream?ids=${ids.join(",")}&rid=${encodeURIComponent(rid)}`));
    es.onopen = () => {
      evlog("live_stream_client_open", {
        rid,
        elapsedMs: Math.round((performance.now() - t0) * 1000) / 1000,
      });
    };
    const loadingFallback = window.setTimeout(() => {
      evlog("live_stream_client_loading_fallback", {
        rid,
        ids: [...active],
        elapsedMs: Math.round((performance.now() - t0) * 1000) / 1000,
      });
      setLoadingBySid((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const sid of active) {
          if (next[sid] && !(messagesRef.current[sid]?.length)) {
            next[sid] = false;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 8000);

    es.addEventListener("msg", (event) => {
      const payload = parseLiveEvent<{ sid: string; m: Message }>(event.data);
      if (!payload) return;
      const sid = payload.sid;
      const message = payload.m;
      if (!active.has(sid)) return;
      if (!firstMsg.has(sid)) {
        firstMsg.add(sid);
        evlog("live_stream_client_first_msg", {
          rid,
          sid,
          kind: message.kind,
          role: message.role,
          elapsedMs: Math.round((performance.now() - t0) * 1000) / 1000,
        });
      }
      setLoadingBySid((prev) => ({ ...prev, [sid]: false }));
      if (message.id && message.kind !== "thinking") {
        const seen = seenRef.current[sid] || (seenRef.current[sid] = new Set());
        if (seen.has(message.id)) return;
        seen.add(message.id);
        if (seen.size > 800) {
          seenRef.current[sid] = new Set(Array.from(seen).slice(-400));
        }
      }
      setMessagesBySid((prev) => {
        const current = prev[sid] ?? [];
        let next = current;
        if (message.kind === "thinking") {
          next = [...current.filter((item) => item.kind !== "thinking"), message];
        } else {
          const realUser = message.role === "user" && message.kind === "text";
          next = realUser
            ? current.filter((item) => {
                if (!item.pending) return true;
                const needle = normText(message.text).slice(0, 48);
                return !needle || !needle.includes(normText(item.text).slice(0, 48));
              })
            : current.filter((item) => item.kind !== "thinking");
          next = [...next, message];
        }
        return { ...prev, [sid]: next.slice(-80) };
      });

      // Bound the shimmer's lifetime. Each fresh thinking line resets the timer
      // (so an actively-thinking session keeps shimmering); any non-thinking
      // message cancels it (the filter above already cleared the bubble).
      const timers = thinkTimerRef.current;
      if (timers[sid]) clearTimeout(timers[sid]);
      if (message.kind === "thinking") {
        timers[sid] = setTimeout(() => {
          delete timers[sid];
          setMessagesBySid((prev) => {
            const cur = prev[sid];
            if (!cur?.some((item) => item.kind === "thinking")) return prev;
            return { ...prev, [sid]: cur.filter((item) => item.kind !== "thinking") };
          });
        }, 2500);
      } else {
        delete timers[sid];
      }
    });

    es.addEventListener("batch", (event) => {
      const payload = parseLiveEvent<{
        sid: string;
        messages: Message[];
        nextBefore?: number | null;
      }>(event.data);
      if (!payload || !active.has(payload.sid)) return;
      const sid = payload.sid;
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      if (!firstMsg.has(sid) && messages.length) {
        const first = messages[0];
        firstMsg.add(sid);
        evlog("live_stream_client_first_msg", {
          rid,
          sid,
          kind: first.kind,
          role: first.role,
          batch: true,
          count: messages.length,
          elapsedMs: Math.round((performance.now() - t0) * 1000) / 1000,
        });
      }
      setLoadingBySid((prev) => ({ ...prev, [sid]: false }));
      const seen = seenRef.current[sid] || (seenRef.current[sid] = new Set());
      for (const message of messages) {
        if (message.id && message.kind !== "thinking") seen.add(message.id);
      }
      if (seen.size > 800) {
        seenRef.current[sid] = new Set(Array.from(seen).slice(-400));
      }
      setNextBeforeBySid((prev) => ({ ...prev, [sid]: payload.nextBefore ?? null }));
      setMessagesBySid((prev) => {
        const current = prev[sid] ?? [];
        const pending = current.filter((item) => {
          if (!item.pending) return false;
          const pendingNeedle = normText(item.text).slice(0, 48);
          if (!pendingNeedle) return true;
          return !messages.some((message) => {
            if (message.role !== "user" || message.kind !== "text") return false;
            return normText(message.text).slice(0, 48).includes(pendingNeedle);
          });
        });
        return { ...prev, [sid]: [...messages, ...pending].slice(-80) };
      });
    });

    es.addEventListener("ready", (event) => {
      const payload = parseLiveEvent<{ sid: string }>(event.data);
      if (!payload || !active.has(payload.sid)) return;
      if (!firstReady.has(payload.sid)) {
        firstReady.add(payload.sid);
        evlog("live_stream_client_ready", {
          rid,
          sid: payload.sid,
          elapsedMs: Math.round((performance.now() - t0) * 1000) / 1000,
        });
      }
      setLoadingBySid((prev) => ({ ...prev, [payload.sid]: false }));
    });

    es.addEventListener("busy", (event) => {
      const payload = parseLiveEvent<{ sid: string; busy: boolean }>(event.data);
      if (!payload || !active.has(payload.sid)) return;
      setBusyBySid((prev) => ({ ...prev, [payload.sid]: payload.busy }));
      // A thinking block is written to the transcript on its own line, and the
      // live "thinking…" bubble is otherwise only cleared when the *next*
      // non-thinking message arrives (which lags, or gets deduped away). Tie its
      // lifetime to the turn: when the turn ends, drop any lingering thinking so
      // the bubble can't outlive the thinking state.
      if (!payload.busy) {
        const tm = thinkTimerRef.current[payload.sid];
        if (tm) {
          clearTimeout(tm);
          delete thinkTimerRef.current[payload.sid];
        }
        setMessagesBySid((prev) => {
          const current = prev[payload.sid];
          if (!current?.some((item) => item.kind === "thinking")) return prev;
          return { ...prev, [payload.sid]: current.filter((item) => item.kind !== "thinking") };
        });
      }
    });

    es.addEventListener("prompt", (event) => {
      const payload = parseLiveEvent<{ sid: string; prompt: SessionPrompt | null }>(event.data);
      if (!payload || !active.has(payload.sid)) return;
      setPromptsBySid((prev) => ({ ...prev, [payload.sid]: payload.prompt }));
    });

    es.addEventListener("queue", (event) => {
      const payload = parseLiveEvent<{ sid: string; queue: QueueMsg[] }>(event.data);
      if (!payload || !active.has(payload.sid)) return;
      setQueuesBySid((prev) => ({ ...prev, [payload.sid]: payload.queue ?? [] }));
    });

    es.onerror = () => {
      evlog("live_stream_client_error", {
        rid,
        elapsedMs: Math.round((performance.now() - t0) * 1000) / 1000,
      });
      // EventSource reconnects itself; keep existing pane state while it does,
      // but don't leave an empty pane stuck on "Loading..." forever.
      setLoadingBySid((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const sid of active) {
          if (next[sid] && !(messagesRef.current[sid]?.length)) {
            next[sid] = false;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };

    return () => {
      evlog("live_stream_client_close", {
        rid,
        elapsedMs: Math.round((performance.now() - t0) * 1000) / 1000,
        firstMsgCount: firstMsg.size,
        readyCount: firstReady.size,
      });
      es.close();
      clearTimeout(loadingFallback);
      for (const id of Object.keys(thinkTimerRef.current)) {
        clearTimeout(thinkTimerRef.current[id]);
        delete thinkTimerRef.current[id];
      }
    };
  // Only reconnect the SSE when the streamed session-id set changes. listBusy
  // and seedBySid update frequently with status/list refreshes; including them
  // here would tear down the transcript stream and replay backlogs mid-session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamKey]);

  const addOptimisticMessage = useCallback((sid: string, text: string) => {
    const message: Message = {
      id: `optimistic-${Date.now()}`,
      role: "user",
      kind: "text",
      text,
      html: escapeHtml(text).replace(/\n/g, "<br>"),
      ts: Date.now(),
      pending: true,
    };
    setMessagesBySid((prev) => ({
      ...prev,
      [sid]: [...(prev[sid] ?? []).filter((item) => item.kind !== "thinking"), message].slice(-80),
    }));
  }, []);

  const loadOlderMessages = useCallback<LoadOlderMessages>(async (sid) => {
    if (!(sid in nextBeforeRef.current)) return true;
    const before = nextBeforeRef.current[sid];
    if (before == null) return false;
    const page = await api<{
      messages: Message[];
      nextBefore: number | null;
    }>(
      `/api/sessions/${encodeURIComponent(sid)}/messages?page=backward&before=${before}&limit=80`,
    );
    const older = Array.isArray(page.messages) ? page.messages : [];
    setNextBeforeBySid((prev) => ({ ...prev, [sid]: page.nextBefore ?? null }));
    if (!older.length) return (page.nextBefore ?? null) !== null;

    const seen = seenRef.current[sid] || (seenRef.current[sid] = new Set());
    for (const message of older) {
      if (message.id && message.kind !== "thinking") seen.add(message.id);
    }

    setMessagesBySid((prev) => {
      const current = prev[sid] ?? [];
      const existing = new Set(current.map((message) => message.id).filter(Boolean));
      const prepend = older.filter((message) => !message.id || !existing.has(message.id));
      if (!prepend.length) return prev;
      return { ...prev, [sid]: [...prepend, ...current.filter((message) => !message.seed)] };
    });
    return (page.nextBefore ?? null) !== null;
  }, []);

  // List-poll busy for all sessions, with the live stream winning for whichever
  // cards are currently streamed (expanded). Pruning of `busyBySid` to active
  // stream ids (above) means a card that just collapsed cleanly hands its busy
  // state back to the list baseline.
  const mergedBusy = useMemo(
    () => ({ ...listBusy, ...busyBySid }),
    [listBusy, busyBySid],
  );

  return {
    messagesBySid,
    busyBySid: mergedBusy,
    promptsBySid,
    queuesBySid,
    loadingBySid,
    addOptimisticMessage,
    loadOlderMessages,
  };
}

// Header toggle for PWA push notifications. Hidden entirely where the browser
// can't do Web Push (e.g. desktop Safari without the SW, or an http origin).
function PushBell({ user }: { user?: string | null }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [supported] = useState(() => pushSupported());

  useEffect(() => {
    if (!supported) return;
    void isSubscribed().then(setOn);
  }, [supported]);

  if (!supported) return null;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (on) {
        await disablePush();
        setOn(false);
        toast("Notifications off");
      } else {
        if (pushPermission() === "denied") {
          toast.error("Notifications are blocked in your browser settings");
          return;
        }
        if (!user) {
          toast.error("Pick your user in the top filter first, so notifications only show yours");
          return;
        }
        const ok = await enablePush(user);
        setOn(ok);
        toast(ok ? "Notifications on" : "Notifications permission dismissed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change notifications");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Switch
      checked={on}
      onCheckedChange={() => void toggle()}
      disabled={busy}
      aria-label={on ? "Disable notifications" : "Enable notifications"}
    />
  );
}

export function App() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const rootRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const isWide = useIsWide();
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [codingAgents, setCodingAgents] = useState<CodingAgentInfo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [modelCatalogs, setModelCatalogs] = useState<ModelCatalogs>(STATIC_MODEL_CATALOGS);
  // Legacy report-view selector — retained so the old AgentView effects compile,
  // but the live UI now switches on `tab` (Live / Auto), so this stays "__live".
  const [selected, setSelected] = useState("__live");
  const [reports, setReports] = useState<ReportRef[]>([]);
  const [report, setReport] = useState<AgentReport | null>(null);
  const [selectedReportDate, setSelectedReportDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  // Mobile inline create composer (anchored at the bottom of the home screen).
  // `composerExpanded` toggles the compact↔full controls; bumping
  // `composerFocusNonce` (orb double-tap / "new session" affordances) focuses the
  // composer's textarea so the soft keyboard opens.
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerFocusNonce, setComposerFocusNonce] = useState(0);
  const [callOpen, setCallOpen] = useState(false);
  const [runLog, setRunLog] = useState<string | null>(null);
  // Auto agents
  // Tabs are "live" | "settings" | "ask" | "term" | "browser". Auto agents and runtime
  // extension nav-tabs now render inside the Settings page rather than as their
  // own top-level tabs.
  const [tab, setTab] = useState<string>("live");
  const extNavTabs = useExtensionNavTabs();
  const [autoAgents, setAutoAgents] = useState<AutoAgent[]>([]);
  const [schedTz, setSchedTz] = useState<string>(DEFAULT_SCHED_TZ);
  const [findings, setFindings] = useState<AutoFinding[]>([]);
  const [toastedFindingIds, setToastedFindingIds] = useState<Set<string>>(() => new Set());
  const [openFinding, setOpenFinding] = useState<AutoFinding | null>(null);
  const [editingAgent, setEditingAgent] = useState<AutoAgent | "new" | null>(null);
  const seededAuto = useRef(false);
  const seenFindings = useRef<Set<string>>(new Set());
  const [userFilter, setUserFilter] = useState(() => {
    const saved = localStorage.getItem("lfg_v2_user_filter");
    // Honor an explicitly chosen user / unassigned view, but otherwise default
    // to the active profile rather than "everyone".
    if (saved && saved !== "__all") return saved;
    return localStorage.getItem("lfg_user") || "__all";
  });
  const [projectFilter, setProjectFilter] = useState(
    () => localStorage.getItem("lfg_v2_project_filter") || "__all",
  );
  const didDefaultFilter = useRef(false);
  // The active profile for this browser ("who are you"). Null until chosen —
  // when null (and a roster exists) we gate the app behind the picker on start.
  const [identity, setIdentity] = useState<string | null>(() =>
    localStorage.getItem("lfg_user"),
  );

  useEffect(() => {
    let cancelled = false;
    api<ModelCatalogResponse>("/api/model-catalog")
      .then((payload) => {
        if (!cancelled) setModelCatalogs(mergeModelCatalogs(payload));
      })
      .catch(() => {
        if (!cancelled) setModelCatalogs(STATIC_MODEL_CATALOGS);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Mobile soft keyboard ↔ terminal sizing. iOS Safari (and older Androids)
  // shrink only the *visual* viewport when the on-screen keyboard opens — the
  // `100dvh` root and the `interactive-widget=resizes-content` hint don't shrink
  // the *layout* viewport there, so the app (and the terminal's flex host) stay
  // full-height behind the keyboard and FitAddon never re-fits the grid. Pin the
  // root to the visual-viewport height: the flex column collapses, TermView's
  // `h-full` host shrinks, and the ResizeObserver already watching it re-fits the
  // terminal into the visible area. A no-op where `dvh` already tracks the
  // keyboard (Chrome Android), since the two heights then match.
  //
  // Two iOS quirks make the naive "set height = vv.height" leave dead space:
  //   • The browser scrolls the *layout* viewport to reveal the focused field,
  //     so `vv.offsetTop` goes positive while the root stays anchored at layout
  //     top — leaving a strip of background below the app. Translate the root
  //     down by `offsetTop` to re-pin it to the visible band.
  //   • `<main>` reserves bottom padding for the safe-area inset. While the
  //     keyboard is open we collapse that padding (see `keyboardOpen`) so the
  //     terminal fills right up to the keyboard instead of floating above a gap.
  //
  // Scoped to the Terminal tab only. Other pages (Live, Auto, the new-session
  // sheet) want the default browser behavior — `dvh` plus Vaul's own field
  // handling — so we leave the root untouched there and clear anything we set.
  useEffect(() => {
    const vv = window.visualViewport;
    const clear = () => {
      const el = rootRef.current;
      if (el) {
        el.style.height = "";
        el.style.transform = "";
      }
      // Drop the keyboard-height var + flag so the toast/pill offset falls back
      // to the full orb-stack clearance.
      document.documentElement.classList.remove("lfg-keyboard-open");
      document.documentElement.style.removeProperty("--lfg-keyboard-height");
      setKeyboardOpen(false);
    };
    // Not the terminal, or no visualViewport (ancient browsers): fall back to
    // the `h-dvh` class and make sure no stale inline styles linger.
    if (!vv || tab !== "term") {
      clear();
      return;
    }
    const sync = () => {
      const el = rootRef.current;
      if (el) {
        el.style.height = `${Math.round(vv.height)}px`;
        // Only transform when actually offset — a translateY(0) still creates a
        // containing block that would reparent the `fixed` nav unnecessarily.
        el.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : "";
      }
      // Keyboard height ≈ layout height − visual height. `innerHeight` is the
      // layout viewport (doesn't shrink for the keyboard on iOS); 120px clears
      // URL-bar jitter without missing a real keyboard (~250px+).
      const kb = Math.max(0, window.innerHeight - vv.height);
      const open = kb > 120;
      // Publish the live keyboard height + a flag on <html> so toasts and the
      // dictation pill (portaled to <body>, outside rootRef) can hike up to sit
      // just above the keyboard via --lfg-orb-stack-bottom.
      document.documentElement.style.setProperty(
        "--lfg-keyboard-height",
        `${Math.round(kb)}px`,
      );
      document.documentElement.classList.toggle("lfg-keyboard-open", open);
      setKeyboardOpen(open);
    };
    sync();
    vv.addEventListener("resize", sync, { passive: true });
    vv.addEventListener("scroll", sync, { passive: true });
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      clear();
    };
  }, [loading, tab]);

  const loadCore = useCallback(async () => {
    const tasks = [
      // These power secondary/legacy settings surfaces. During a rolling deploy
      // the browser can briefly run newer JS against the previous backend, where
      // /api/coding-agents may not exist yet. Do not let optional settings
      // endpoints block the live session list from painting.
      api<{ agents: Agent[] }>("/api/agents")
        .then((payload) => setAgents(payload.agents ?? []))
        .catch(() => setAgents([])),
      api<{ agents: CodingAgentInfo[] }>("/api/coding-agents")
        .then((payload) => setCodingAgents(payload.agents ?? []))
        .catch(() => setCodingAgents([])),
      api<{ sessions: Session[] }>("/api/sessions").then((payload) => {
        // Guard sessions to [] — it feeds `allLiveSessions`/`liveSessions` which
        // call `.filter()` unconditionally on render, so a malformed/empty
        // payload must degrade to an empty live view rather than crash.
        setSessions(payload.sessions ?? []);
      }),
      api<{ users: User[] }>("/api/users").then((payload) =>
        setUsers(payload.users ?? []),
      ),
      api<{ repos: Repo[] }>("/api/repos").then((payload) =>
        setRepos(payload.repos ?? []),
      ),
    ];
    const results = await Promise.allSettled(tasks);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }, []);

  // Sessions the user just deleted. The server's list can lag a beat (tmux pane
  // still tearing down), and the 5s poll below would otherwise resurrect a card
  // we already removed. We tombstone the sid: hide it deterministically until
  // the server stops returning it, then drop the tombstone.
  const [removedSids, setRemovedSids] = useState<Set<string>>(() => new Set());

  const removeSession = useCallback((sid: string) => {
    setRemovedSids((prev) => {
      if (prev.has(sid)) return prev;
      const next = new Set(prev);
      next.add(sid);
      return next;
    });
    setSessions((prev) => prev.filter((s) => s.sessionId !== sid));
  }, []);

  const hideToastedFinding = useCallback((id: string) => {
    setToastedFindingIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const showToastedFinding = useCallback((id: string) => {
    setToastedFindingIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const liveFindings = useMemo(
    () => findings.filter((f) => !toastedFindingIds.has(f.id)),
    [findings, toastedFindingIds],
  );

  // Pull auto agents + open findings. New findings (after the first load) raise
  // a toast in the live view.
  const refreshAuto = useCallback(async () => {
    const [ag, fd] = await Promise.all([
      api<{ agents: AutoAgent[]; tz?: string }>("/api/auto/agents"),
      api<{ findings: AutoFinding[] }>("/api/auto/findings?status=open"),
    ]);
    // Guard against a malformed/empty payload — these feed array props that
    // render unconditionally (e.g. findings.length in LiveView), so a missing
    // field must degrade to [] rather than crash the live view.
    const findingList = fd.findings ?? [];
    setAutoAgents(ag.agents ?? []);
    if (ag.tz) setSchedTz(ag.tz);
    setFindings(findingList);
    if (!seededAuto.current) {
      findingList.forEach((f) => seenFindings.current.add(f.id));
      seededAuto.current = true;
      return;
    }
    const agentNames = new Map((ag.agents ?? []).map((a) => [a.id, a.name]));
    for (const f of findingList) {
      if (seenFindings.current.has(f.id)) continue;
      seenFindings.current.add(f.id);
      hideToastedFinding(f.id);
      const name = agentNames.get(f.agentId) ?? f.agentId;
      // Announce the finding via the shared Sonner toast system.
      toast.custom(
        (id) => (
          <button
            type="button"
            onClick={() => {
              setTab("live");
              setOpenFinding(f);
              showToastedFinding(f.id);
              toast.dismiss(id);
            }}
            className="pointer-events-auto flex w-full min-w-0 items-center gap-3 text-left"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/12 text-primary">
              <Sparkles className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-semibold leading-tight">
                {name} responded
              </span>
              <span className="block truncate text-xs text-muted-foreground">{f.title}</span>
            </span>
            <span className="shrink-0 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-white">
              View
            </span>
          </button>
        ),
        {
          duration: 6500,
          className: "lfg-finding-toast",
          onDismiss: () => showToastedFinding(f.id),
          onAutoClose: () => showToastedFinding(f.id),
        },
      );
    }
  }, [hideToastedFinding, showToastedFinding]);

  const refreshSessions = useCallback(async (_opts?: { retireLaunchId?: string }) => {
    const payload = await api<{ sessions: Session[] }>("/api/sessions");
    // Guard to [] — `sessions` is consumed by `.filter()`/`.map()` on render
    // (allLiveSessions) and just below, so a missing field must not crash.
    const sessionList = payload.sessions ?? [];
    setSessions(sessionList);
    setError((current) => (current === "not found" ? null : current));
    // Prune tombstones the server has finally forgotten, so the set can't grow
    // unbounded and a recycled sid is never wrongly suppressed.
    setRemovedSids((prev) => {
      if (!prev.size) return prev;
      const present = new Set(sessionList.map((s) => s.sessionId));
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadCore()
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    refreshAuto().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [loadCore, refreshAuto]);

  useEffect(() => {
    const id = setInterval(() => {
      refreshSessions().catch(() => {});
      refreshAuto().catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [refreshSessions, refreshAuto]);

  // Refresh the user roster when the tab regains focus. The roster rarely
  // changes, so it isn't worth the 5s poll above — but avatars carry a
  // time-bucketed cache-buster (see gravatar()), so refetching on focus is how
  // an updated icon shows up without a manual hard-refresh.
  useEffect(() => {
    const onFocus = () => {
      api<{ users: User[] }>("/api/users")
        .then((p) => setUsers(p.users ?? []))
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    history.replaceState(null, "", selected === "__live" ? "#/__live" : `#/${selected}`);
    if (selected === "__live") {
      setReports([]);
      setReport(null);
      setSelectedReportDate(null);
      return;
    }
    let cancelled = false;
    api<{ agent: string; reports: ReportRef[] }>(`/api/agents/${selected}/reports`)
      .then((payload) => {
        if (cancelled) return;
        setReports(payload.reports);
        const date = payload.reports[0]?.date ?? null;
        setSelectedReportDate(date);
        if (!date) setReport(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  useEffect(() => {
    if (selected === "__live" || !selectedReportDate) return;
    let cancelled = false;
    api<AgentReport>(`/api/agents/${selected}/reports/${selectedReportDate}`)
      .then((payload) => {
        if (!cancelled) setReport(payload);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selected, selectedReportDate]);

  // Once users load, pick a default profile to filter by (your saved profile,
  // else the first user) — runs once, so an explicit "All" later still sticks.
  useEffect(() => {
    if (didDefaultFilter.current || !users.length) return;
    didDefaultFilter.current = true;
    const isUser = users.some((u) => u.email === userFilter);
    if (userFilter === "__unassigned" || isUser) return;
    const profile = localStorage.getItem("lfg_user");
    const next = profile && users.some((u) => u.email === profile) ? profile : users[0]?.email;
    if (next) setUserFilter(next);
  }, [users, userFilter]);

  // Drop a filter that points at a user who no longer exists.
  useEffect(() => {
    if (!users.length) return;
    const valid =
      userFilter === "__all" ||
      userFilter === "__unassigned" ||
      users.some((u) => u.email === userFilter);
    if (!valid) setUserFilter(users[0]?.email ?? "__all");
  }, [userFilter, users]);

  useEffect(() => {
    localStorage.setItem("lfg_v2_user_filter", userFilter);
  }, [userFilter]);

  useEffect(() => {
    localStorage.setItem("lfg_v2_project_filter", projectFilter);
  }, [projectFilter]);

  const changeUserFilter = useCallback((value: string) => {
    setUserFilter(value);
    // Selecting a concrete user makes them the active profile (remembered as
    // the default filter and pre-filled as the owner for new sessions).
    if (value !== "__all" && value !== "__unassigned") {
      localStorage.setItem("lfg_user", value);
    }
  }, []);

  const allLiveSessions = useMemo(
    () =>
      sessions
        .filter(
          (session) =>
            session.sessionId &&
            // A pane target means a driveable TUI session. Harness-backed
            // sessions have no pane, so admit those explicitly; otherwise Codex
            // AI-SDK sessions are fetched from /api/sessions and then hidden here.
            canDriveSession(session) &&
            !removedSids.has(session.sessionId),
        )
        // Deterministic, stable position per session (like v1): order by start
        // time so a card never jumps around as its activity changes — newer
        // sessions simply append at the end. sessionId is the tiebreaker.
        .sort(
          (a, b) =>
            (a.startedAt ?? 0) - (b.startedAt ?? 0) ||
            (a.sessionId ?? "").localeCompare(b.sessionId ?? ""),
        ),
    [sessions, removedSids],
  );

  // Unique projects present across the (user-filtered) live sessions plus every
  // known repo. The repo-derived entries are important for persistence: a saved
  // project filter should survive app reopen even when that project has no live
  // session at load time.
  const userScopedSessions = useMemo(() => {
    if (userFilter === "__all") return allLiveSessions;
    if (userFilter === "__unassigned") {
      return allLiveSessions.filter((session) => !session.assignedUser);
    }
    return allLiveSessions.filter((session) => session.assignedUser === userFilter);
  }, [allLiveSessions, userFilter]);

  const projectOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...repos.map((repo) => repoProject(repo)),
          ...autoAgents.map((agent) => autoAgentProject(agent, repos)),
          ...userScopedSessions.map((s) => s.project).filter((p): p is string => !!p),
        ]),
      ).sort((a, b) => shortProject(a).localeCompare(shortProject(b))),
    [autoAgents, repos, userScopedSessions],
  );

  // If the chosen project is no longer a known repo and has no visible session,
  // fall back to "all" rather than keeping a dead filter.
  useEffect(() => {
    if (loading) return;
    if (projectFilter !== "__all" && !projectOptions.includes(projectFilter)) {
      setProjectFilter("__all");
    }
  }, [loading, projectFilter, projectOptions]);

  const liveSessions = useMemo(() => {
    if (projectFilter === "__all") return userScopedSessions;
    return userScopedSessions.filter((session) => session.project === projectFilter);
  }, [userScopedSessions, projectFilter]);

  const projectScopedAutoAgents = useMemo(() => {
    if (projectFilter === "__all") return autoAgents;
    return autoAgents.filter((agent) => autoAgentProject(agent, repos) === projectFilter);
  }, [autoAgents, projectFilter, repos]);

  const projectScopedFindings = useMemo(() => {
    if (projectFilter === "__all") return liveFindings;
    const agentIds = new Set(projectScopedAutoAgents.map((agent) => agent.id));
    return liveFindings.filter((finding) => agentIds.has(finding.agentId));
  }, [liveFindings, projectFilter, projectScopedAutoAgents]);

  const liveStatusIds = useMemo(
    () => allLiveSessions.map((s) => s.sessionId).filter((id): id is string => !!id),
    [allLiveSessions],
  );
  const liveStatusKey = liveStatusIds.join(",");
  useEffect(() => {
    if (tab !== "live" || !liveStatusKey) return;
    const es = new EventSource(appPath(`/api/live/status?ids=${liveStatusKey}`));
    es.addEventListener("status", (event) => {
      const rows = parseLiveEvent<
        Array<
          Pick<
            Session,
            | "sessionId"
            | "busy"
            | "title"
            | "lastUserText"
            | "lastActivityAt"
            | "status"
            | "statusReason"
            | "statusDetail"
            | "model"
          >
        >
      >(event.data);
      if (!rows?.length) return;
      const bySid = new Map(rows.map((row) => [row.sessionId, row]));
      setSessions((prev) => {
        let changed = false;
        const next = prev.map((session) => {
          const sid = session.sessionId;
          const patch = sid ? bySid.get(sid) : undefined;
          if (!patch) return session;
          const merged = { ...session, ...patch };
          let rowChanged = false;
          for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
            if (session[key] !== merged[key]) {
              rowChanged = true;
              break;
            }
          }
          if (!rowChanged) return session;
          changed = true;
          return merged;
        });
        return changed ? next : prev;
      });
    });
    return () => es.close();
  }, [liveStatusKey, tab]);

  const cycleMobileProjectFilter = useCallback(
    (dir: 1 | -1) => {
      const options = ["__all", ...projectOptions];
      if (options.length <= 1) return false;
      setProjectFilter((current) => cycleProjectFilter(options, current, dir));
      return true;
    },
    [projectOptions],
  );

  // Tab / Shift+Tab cycles the live project filter (mirrors the project menu).
  const projectKb = useRef({ tab, projectFilter, projectOptions, setProjectFilter });
  projectKb.current = { tab, projectFilter, projectOptions, setProjectFilter };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = projectKb.current;
      if (s.tab !== "live") return;
      const options = ["__all", ...s.projectOptions];
      if (options.length <= 1) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      e.preventDefault();
      s.setProjectFilter(cycleProjectFilter(options, s.projectFilter, e.shiftKey ? -1 : 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Stream detailed transcripts only for sessions the UI has explicitly opened.
  // Wide-screen stage columns mark their session as expanded when previewed or
  // pinned; rail-only rows keep using lightweight list/status data.
  const expandedIds = useExpandedIds(liveSessions, false);
  const liveStream = useLiveSessionStream(liveSessions, expandedIds);

  function toggleTheme() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    setDark(next);
  }

  async function runAgent(agent: string) {
    setRunLog("Starting agent run...");
    try {
      const start = await api<{ runId: string }>(`/api/agents/${agent}/run`, {
        method: "POST",
      });
      const events = new EventSource(appPath(`/api/agents/${agent}/runs/${start.runId}`));
      events.addEventListener("log", (event) => {
        setRunLog((prev) => `${prev ?? ""}\n${JSON.parse(event.data)}`.trim());
      });
      events.addEventListener("done", async () => {
        events.close();
        setRunLog("Run finished.");
        const payload = await api<{ agent: string; reports: ReportRef[] }>(
          `/api/agents/${agent}/reports`,
        );
        setReports(payload.reports);
        if (payload.reports[0]) setSelectedReportDate(payload.reports[0].date);
      });
      events.addEventListener("failed", (event) => {
        events.close();
        setRunLog(`Run failed: ${event.data}`);
      });
    } catch (e) {
      setRunLog(e instanceof Error ? e.message : String(e));
    }
  }

  // ---- auto agent handlers ----
  const agentName = (id: string) => autoAgents.find((a) => a.id === id)?.name ?? id;

  async function dismissFinding(f: AutoFinding) {
    setFindings((prev) => prev.filter((x) => x.id !== f.id));
    setOpenFinding(null);
    try {
      await api(`/api/auto/findings/${f.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "dismissed" }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Reply graduates a finding into a real agent session, seeded with the
  // finding's context plus the user's instruction. By default it inherits the
  // originating auto agent's backend/model, while the sheet can override them.
  async function replyToFinding(
    f: AutoFinding,
    text: string,
    opts: { agent?: AutoAgentBackend; model?: string; thinkingLevel?: string } = {},
  ) {
    const composed =
      `An automated watch agent ("${agentName(f.agentId)}") flagged this:\n\n` +
      `${f.title}\n\n` +
      (f.reasoning.length ? `Reasoning:\n${f.reasoning.map((r) => `- ${r}`).join("\n")}\n\n` : "") +
      (f.suggest ? `Suggested fix: ${f.suggest}\n\n` : "") +
      `Now do this: ${text}`;
    // Seed the graduated session the same way the quick-start path does, so it
    // is actually visible afterwards: (1) assign it to the active owner —
    // otherwise a user-filtered live view drops the unassigned session; (2) land
    // it in the SAME repo the auto agent is based in, so the session inherits
    // that repo's settings (.claude/settings.json) — falling back to the last
    // selected repo only if the agent has no base; (3) launch on the originating
    // auto agent's backend/model unless the user changed it in the finding sheet.
    const sourceAgent = autoAgents.find((a) => a.id === f.agentId);
    const agentCwd = sourceAgent?.cwd;
    const cwd = agentCwd || localStorage.getItem("lfg_v2_repo") || repos[0]?.cwd || "";
    const owner =
      (userFilter !== "__all" && userFilter !== "__unassigned" ? userFilter : "") ||
      localStorage.getItem("lfg_user") ||
      users[0]?.email ||
      "";
    setOpenFinding(null);
    try {
      const res = await api<{ sessionId?: string }>("/api/sessions/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: cwd || undefined,
          prompt: composed,
          user: owner || undefined,
          agent: opts.agent ?? sourceAgent?.agent ?? "aisdk",
          model: opts.model ?? sourceAgent?.model,
          thinkingLevel: opts.thinkingLevel ?? sourceAgent?.thinkingLevel,
        }),
      });
      const sid = res?.sessionId;
      if (sid) {
        markCreatedSid(sid);
        markCollapsedSid(sid);
      }
      await api(`/api/auto/findings/${f.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "session" }),
      });
      setFindings((prev) => prev.filter((x) => x.id !== f.id));
      setTab("live");
      await Promise.all([refreshSessions(), refreshAuto()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveAutoAgent(input: {
    id?: string;
    name: string;
    prompt: string;
    schedule: string;
    enabled: boolean;
    cwd?: string;
    agent?: AutoAgentBackend;
    model?: string;
    thinkingLevel?: string;
  }) {
    try {
      await api("/api/auto/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      setEditingAgent(null);
      await refreshAuto();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Single-box create runs async: the composer closes the instant you hit
  // Create, and a loading toast tracks the (repo-inspecting, slow) compose →
  // save → refresh chain to success or error. Nothing blocks the UI.
  function createAutoAgent(
    idea: string,
    cwd: string | undefined,
    opts: { agent?: AutoAgentBackend; model?: string; thinkingLevel?: string } = {},
  ) {
    toast.promise(
      api<{ draft: { name: string; schedule: string; prompt: string } }>(
        "/api/auto/compose",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: idea, cwd }),
        },
      )
        .then((r) =>
          api("/api/auto/agents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: r.draft.name,
              prompt: r.draft.prompt,
              schedule: r.draft.schedule,
              enabled: true,
              cwd,
              agent: opts.agent,
              model: opts.model,
              thinkingLevel: opts.thinkingLevel,
            }),
          }),
        )
        .then(() => refreshAuto()),
      {
        loading: "Creating auto agent…",
        success: "Auto agent created",
        error: (e) => (e instanceof Error ? e.message : "Couldn't create agent"),
      },
    );
  }

  async function deleteAutoAgent(id: string) {
    try {
      await api(`/api/auto/agents/${id}`, { method: "DELETE" });
      setEditingAgent(null);
      await refreshAuto();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runAutoNow(id: string) {
    // Optimistic: show the spinner the instant it's clicked. The 5s auto poll
    // then keeps it accurate from the server's real in-flight state, and clears
    // it when the run finishes.
    setAutoAgents((prev) =>
      prev.map((a) => (a.id === id ? { ...a, running: true } : a)),
    );
    try {
      await api(`/api/auto/agents/${id}/run`, { method: "POST" });
    } catch (e) {
      setAutoAgents((prev) =>
        prev.map((a) => (a.id === id ? { ...a, running: false } : a)),
      );
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const refreshCodingAgents = useCallback(async () => {
    const payload = await api<{ agents: CodingAgentInfo[] }>("/api/coding-agents");
    setCodingAgents(payload.agents ?? []);
  }, []);

  async function setCodingAgentVisible(kind: AgentKind, visible: boolean) {
    const previous = codingAgents;
    setCodingAgents((current) =>
      current.map((item) => (item.key === kind ? { ...item, visible } : item)),
    );
    try {
      const payload = await api<{ agents: CodingAgentInfo[] }>(`/api/coding-agents/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible }),
      });
      setCodingAgents(payload.agents ?? []);
    } catch (e) {
      setCodingAgents(previous);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function setupCodingAgent(kind: AgentKind) {
    setCodingAgents((current) =>
      current.map((item) =>
        item.key === kind
          ? { ...item, status: { ...item.status, setupRunning: true } }
          : item,
      ),
    );
    toast.promise(
      api<{ agents: CodingAgentInfo[] }>(`/api/coding-agents/${kind}/setup`, {
        method: "POST",
      })
        .then((payload) => {
          setCodingAgents(payload.agents ?? []);
          window.setTimeout(() => void refreshCodingAgents(), 3000);
        }),
      {
        loading: "Starting setup…",
        success: "Setup started",
        error: (e) => (e instanceof Error ? e.message : "Couldn't start setup"),
      },
    );
  }

  // First start on this browser: ask who you are before showing the app. Only
  // gates when a roster exists and no profile is chosen yet — once picked it's
  // remembered in localStorage (lfg_user) so we don't ask again.
  if (!identity && users.length) {
    return (
      <WhoAreYou
        users={users}
        onPick={(email) => {
          setIdentity(email);
          changeUserFilter(email);
        }}
      />
    );
  }

  const mainBottomPadding =
    tab === "live" && !keyboardOpen
      ? "pb-[var(--lfg-above-orb)] md:pb-3"
      : "pb-3";

  return (
    <ModelCatalogContext.Provider value={modelCatalogs}>
      <AskProvider>
        <div ref={rootRef} className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      {/* Two floating "islands" — brand + Live on the left, an icon-only
          Settings button on the right — mirroring the bottom nav's
          gradient-bordered pill so the whole chrome reads as one matched set.
          Auto + extension tabs now live inside the Settings page. */}
      <header className="z-40 flex shrink-0 items-center justify-between gap-2 px-3 pb-1 pt-[calc(0.5rem+env(safe-area-inset-top))]">
        <NavIsland className="shrink-0">
          <div className="flex h-11 items-center rounded-full bg-background/80 px-1.5 backdrop-blur-xl">
            {tab === "live" ? (
              <button
                type="button"
                onClick={() => setTab("live")}
                aria-label="Live"
                aria-current="page"
                className="flex items-center rounded-full px-1.5 transition-transform active:scale-[0.96]"
              >
                <img src={appPath("/icon.svg")} alt="lfg" className="mx-1 size-6 shrink-0" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() =>
                  setTab(tab === "settings" || tab === "ask" ? "live" : "settings")
                }
                aria-label="Back"
                className="flex h-8 items-center gap-1 rounded-full pl-1.5 pr-3 text-[13px] font-medium tracking-[-0.01em] text-muted-foreground transition-colors duration-200 ease-out hover:text-foreground active:scale-[0.96]"
              >
                <ChevronLeft className="size-[18px]" />
                <span>{tab === "settings" || tab === "ask" ? "Live" : "Settings"}</span>
              </button>
            )}
          </div>
        </NavIsland>

        <NavIsland className="shrink-0">
          <div className="flex h-11 items-center gap-1.5 rounded-full bg-background/80 px-2 backdrop-blur-xl">
            {tab === "live" ? (
              <>
                {!isMobile ? (
                  <ProjectFilterMenu
                    value={projectFilter}
                    projects={projectOptions}
                    onChange={setProjectFilter}
                  />
                ) : null}
                <UserFilterMenu
                  value={userFilter}
                  users={users}
                  onChange={changeUserFilter}
                />
              </>
            ) : null}
            {!callOpen ? (
              <VoiceOrb
                hidden={false}
                onOpenCall={() => setCallOpen(true)}
              />
            ) : null}
            <AskNavButton active={tab === "ask"} onOpen={() => setTab("ask")} />
            <IconTab
              active={tab !== "live"}
              onClick={() => setTab("settings")}
              icon={<Settings className="size-[18px]" />}
              label="Settings"
            />
          </div>
        </NavIsland>
      </header>

      {error ? (
        <div className="mx-3 mt-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <main className={`min-h-0 flex-1 overflow-y-auto px-3 pt-3 ${mainBottomPadding}`}>
        {tab === "live" ? (
          <LiveView
            sessions={liveSessions}
            users={users}
            userFilter={userFilter}
            projectFilter={projectFilter}
            messagesBySid={liveStream.messagesBySid}
            busyBySid={liveStream.busyBySid}
            promptsBySid={liveStream.promptsBySid}
            queuesBySid={liveStream.queuesBySid}
            loadingBySid={liveStream.loadingBySid}
            onLoadOlderMessages={liveStream.loadOlderMessages}
            onOptimisticMessage={liveStream.addOptimisticMessage}
            onRefresh={refreshSessions}
            onRemove={removeSession}
            onNew={() =>
              isMobile ? setComposerFocusNonce((n) => n + 1) : setNewOpen(true)
            }
            findings={projectScopedFindings}
            autoAgents={projectScopedAutoAgents}
            onOpenFinding={setOpenFinding}
          />
        ) : tab === "auto" ? (
          <AutoManageView
            autoAgents={projectScopedAutoAgents}
            findings={
              projectFilter === "__all"
                ? findings
                : findings.filter((finding) =>
                    projectScopedAutoAgents.some((agent) => agent.id === finding.agentId),
                  )
            }
            tz={schedTz}
            onEdit={setEditingAgent}
            onRunNow={runAutoNow}
          />
        ) : tab === "ask" ? (
          <AskPage />
        ) : tab === "usage" ? (
          <UsagePage />
        ) : tab === "coding-agents" ? (
          <CodingAgentsPage
            agents={codingAgents}
            onVisibleChange={(kind, visible) => void setCodingAgentVisible(kind, visible)}
            onSetup={setupCodingAgent}
            onRefresh={() => void refreshCodingAgents()}
          />
        ) : tab === "changelog" ? (
          <ChangelogPage />
        ) : tab === "term" ? (
          <Suspense fallback={<div className="py-10 text-center text-sm text-muted-foreground">Loading terminal…</div>}>
            <TermView />
          </Suspense>
        ) : tab === "browser" ? (
          <Suspense fallback={<div className="py-10 text-center text-sm text-muted-foreground">Loading browser profiles...</div>}>
            <BrowserProfiles />
          </Suspense>
        ) : extNavTabs.some((t) => t.id === tab) ? (
          extNavTabs.find((t) => t.id === tab)!.render()
        ) : (
          <SettingsView
            dark={dark}
            toggleTheme={toggleTheme}
            user={userFilter !== "__all" && userFilter !== "__unassigned" ? userFilter : null}
            onOpenTerminal={() => setTab("term")}
            onOpenBrowser={() => setTab("browser")}
            onOpenCodingAgents={() => setTab("coding-agents")}
            onOpenAuto={() => setTab("auto")}
            onOpenUsage={() => setTab("usage")}
            onOpenChangelog={() => setTab("changelog")}
            extTabs={extNavTabs}
            onOpenExt={setTab}
          />
        )}
      </main>

      {!callOpen ? (
        <>
          {isMobile && tab === "live" ? (
            // Mobile home screen: the create flow lives inline, anchored at the
            // bottom (same component as the desktop drawer, `variant="inline"`).
            // The orb has moved up into the top nav island.
            <NewSessionDialog
              variant="inline"
              open
              expanded={composerExpanded}
              onExpandedChange={setComposerExpanded}
              focusNonce={composerFocusNonce}
              users={users}
              repos={repos}
              scopedProject={projectFilter}
              projectOptions={projectOptions}
              onProjectChange={setProjectFilter}
              onProjectSwipe={cycleMobileProjectFilter}
              onReposChanged={loadCore}
              codingAgents={codingAgents}
              defaultUser={
                userFilter !== "__all" && userFilter !== "__unassigned" ? userFilter : ""
              }
              onClose={() => setComposerExpanded(false)}
              onCreated={async (result) => {
                const launchId = result?.launchId;
                await refreshSessions(launchId ? { retireLaunchId: launchId } : undefined);
              }}
            />
          ) : null}
        </>
      ) : null}
      {callOpen ? (
        <Suspense fallback={null}>
          <VoiceCall
            onClose={() => setCallOpen(false)}
            onCompose={() => setNewOpen(true)}
          />
        </Suspense>
      ) : null}

      {openFinding ? (
        <FindingSheet
          key={openFinding.id}
          finding={openFinding}
          agentName={agentName(openFinding.agentId)}
          sourceAgent={autoAgents.find((a) => a.id === openFinding.agentId)}
          onClose={() => setOpenFinding(null)}
          onReply={replyToFinding}
          onDismiss={dismissFinding}
        />
      ) : null}

      {editingAgent === "new" ? (
        <NewAutoAgentComposer
          repos={repos}
          scopedProject={projectFilter}
          onClose={() => setEditingAgent(null)}
          onCreate={createAutoAgent}
        />
      ) : editingAgent ? (
        <AgentEditorSheet
          agent={editingAgent}
          repos={repos}
          tz={schedTz}
          running={!!autoAgents.find((a) => a.id === editingAgent.id)?.running}
          onClose={() => setEditingAgent(null)}
          onSave={saveAutoAgent}
          onDelete={deleteAutoAgent}
          onRunNow={runAutoNow}
        />
      ) : null}

      <NewSessionDialog
        open={newOpen}
        users={users}
        repos={repos}
        scopedProject={projectFilter}
        onReposChanged={loadCore}
        codingAgents={codingAgents}
        defaultUser={
          userFilter !== "__all" && userFilter !== "__unassigned" ? userFilter : ""
        }
        onClose={() => {
          setNewOpen(false);
        }}
        onCreated={async () => {
          setNewOpen(false);
          setTab("live");
          await refreshSessions();
        }}
      />

      <FloatingSessionAudio
        onOptimisticMessage={liveStream.addOptimisticMessage}
        onRefresh={refreshSessions}
      />

      <Toaster position="bottom-center" />
        </div>
      </AskProvider>
    </ModelCatalogContext.Provider>
  );
}

function FloatingSessionAudio({
  onOptimisticMessage,
  onRefresh,
}: {
  onOptimisticMessage: (sid: string, text: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const playback = useSpeechPlayback();
  const [, forceTick] = useState(0);
  const [sending, setSending] = useState(false);
  const sid = playback.sessionId;

  useEffect(() => {
    if (playback.status !== "playing") return;
    const timer = window.setInterval(() => forceTick((n) => n + 1), 250);
    return () => window.clearInterval(timer);
  }, [playback.status]);

  const sendToSession = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!sid || !t || sending) return;
      setSending(true);
      try {
        onOptimisticMessage(sid, t);
        await api(`/api/sessions/${sid}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: t }),
        });
        await onRefresh();
      } catch (e) {
        toast.error("Could not send voice message", {
          description: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setSending(false);
      }
    },
    [sid, sending, onOptimisticMessage, onRefresh],
  );

  const dictation = useDictation({
    baseText: "",
    silenceMs: 1400,
    onText: (text) => void sendToSession(text),
    onAutoSubmit: (text) => void sendToSession(text),
  });

  if (playback.status === "idle") return null;

  // Position is interpolated live (not part of the stable store snapshot); the
  // forceTick interval above re-renders us every 250ms while playing so the bar
  // advances smoothly.
  const pct =
    playback.duration > 0
      ? Math.max(0, Math.min(100, (livePosition() / playback.duration) * 100))
      : 0;
  const recording = dictation.state === "recording";
  const busy = playback.status === "loading" || sending || dictation.state === "transcribing";

  return (
    <div
      className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] z-[75] flex justify-center px-3 md:bottom-5"
      role="region"
      aria-label="Session audio controls"
    >
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-background/92 shadow-[0_12px_40px_rgba(0,0,0,0.22)] backdrop-blur-xl">
        <div className="h-1 bg-muted">
          <div
            className="h-full bg-primary transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex items-center gap-2 px-2.5 py-2">
          <button
            type="button"
            onClick={() =>
              playback.status === "paused" ? void resumeSpeaking() : pauseSpeaking()
            }
            disabled={playback.status === "loading"}
            aria-label={playback.status === "paused" ? "Resume summary" : "Pause summary"}
            title={playback.status === "paused" ? "Resume" : "Pause"}
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-50"
          >
            {playback.status === "loading" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : playback.status === "paused" ? (
              <Play className="size-4 fill-current" />
            ) : (
              <Pause className="size-4" />
            )}
          </button>

          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">
              {playback.title || "Session summary"}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {recording
                ? "Listening for this session"
                : dictation.state === "transcribing"
                  ? "Transcribing..."
                  : playback.text}
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              if (!sid) {
                toast.error("No session attached to this audio");
                return;
              }
              haptic("medium");
              dictation.toggle();
            }}
            disabled={!sid || busy}
            aria-label={recording ? "Stop and send voice message" : "Speak to this session"}
            title={recording ? "Stop and send" : "Speak to this session"}
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-full transition",
              recording
                ? "bg-destructive text-destructive-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground",
              busy && !recording && "opacity-60",
            )}
          >
            {sending || dictation.state === "transcribing" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Mic className="size-4" />
            )}
          </button>

          <button
            type="button"
            onClick={stopSpeaking}
            aria-label="Close audio controls"
            title="Close"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// Horizontal tab used in the top nav bar. Icon + label sit side by side; the
// active tab gets a soft primary pill behind it.
function TopTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium tracking-[-0.01em] transition-colors duration-200 ease-out",
        active
          ? "bg-primary/12 text-primary"
          : "text-muted-foreground hover:text-foreground active:scale-[0.96]",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// Icon-only variant of TopTab used in the top-right island (Settings).
function IconTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors duration-200 ease-out",
        active
          ? "bg-primary/12 text-primary"
          : "text-muted-foreground hover:text-foreground active:scale-[0.96]",
      )}
    >
      {icon}
    </button>
  );
}

function TabButton({
  active,
  icon,
  label,
  meta,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  meta?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold transition",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-muted/70 text-foreground",
      )}
    >
      {icon}
      <span className="max-w-32 truncate">{label}</span>
      {meta ? <span className="text-[11px] opacity-70">{meta}</span> : null}
    </button>
  );
}

// The shared "island" shell: a 1px gradient border (p-px) wrapping a rounded
// pill, with the same soft shadow the bottom nav uses. Children supply their own
// rounded-full interior so each island can size itself to its contents.
function NavIsland({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-full bg-gradient-to-b from-white/70 via-white/25 to-white/10 p-px shadow-[0_8px_28px_rgba(0,0,0,0.18)] dark:from-white/25 dark:via-white/10 dark:to-white/5",
        className,
      )}
    >
      {children}
    </div>
  );
}

function UserFilterMenu({
  value,
  users,
  onChange,
}: {
  value: string;
  users: User[];
  onChange: (value: string) => void;
}) {
  const active = value !== "__all";
  const selected = users.find((user) => user.email === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Filter live sessions by user"
            title={
              selected ? (selected.name ?? shortUser(selected.email)) : active ? "Unassigned" : "All users"
            }
            className={cn(
              "relative inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border transition",
              active ? "border-primary/40 text-primary" : "border-border bg-muted/70 text-foreground",
            )}
          />
        }
      >
        {selected?.avatar ? (
          <img src={selected.avatar} alt="" className="size-full object-cover" />
        ) : active ? (
          <UserRound className="size-4 shrink-0" />
        ) : (
          <Globe className="size-4 shrink-0" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(typeof next === "string" ? next : "__all")}
        >
          <DropdownMenuLabel>Filter by user</DropdownMenuLabel>
          <DropdownMenuRadioItem value="__all">
            <Globe className="size-5 shrink-0 text-muted-foreground" />
            All users
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="__unassigned">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted">
              <UserRound className="size-3" />
            </span>
            Unassigned
          </DropdownMenuRadioItem>
          {users.length ? <DropdownMenuSeparator /> : null}
          {users.map((user) => (
            <DropdownMenuRadioItem key={user.email} value={user.email}>
              {user.avatar ? (
                <img src={user.avatar} alt="" className="size-5 shrink-0 rounded-full object-cover" />
              ) : (
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted">
                  <UserRound className="size-3" />
                </span>
              )}
              <span className="truncate capitalize">{user.name ?? shortUser(user.email)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectFilterMenu({
  value,
  projects,
  onChange,
  solidSurface = false,
}: {
  value: string;
  projects: string[];
  onChange: (value: string) => void;
  solidSurface?: boolean;
}) {
  const active = value !== "__all";
  // Full ordered option list, mirroring the <option>s below, so a vertical
  // swipe on touch devices can cycle through the same choices.
  const options = ["__all", ...projects];
  const touchStartY = useRef<number | null>(null);
  const didSwipe = useRef(false);

  const cycle = (dir: 1 | -1) => {
    onChange(cycleProjectFilter(options, value, dir));
  };

  return (
    <label
      className={cn(
        "relative inline-flex h-8 shrink-0 touch-none select-none items-center justify-center gap-1 rounded-full border transition",
        active ? "max-w-[45vw] px-2.5 sm:max-w-[12rem]" : "size-8",
        solidSurface
          ? active
            ? "border-primary/40 bg-background text-primary shadow-sm"
            : "border-border bg-background text-muted-foreground shadow-sm"
          : active
            ? "border-primary/30 bg-primary/10 text-primary"
            : "border-border bg-muted/70 text-muted-foreground",
      )}
      aria-label="Filter live sessions by project"
      title={active ? shortProject(value) : "All projects"}
      onTouchStart={(event) => {
        touchStartY.current = event.touches[0]?.clientY ?? null;
        didSwipe.current = false;
      }}
      onTouchMove={(event) => {
        if (touchStartY.current === null) return;
        const dy = (event.touches[0]?.clientY ?? 0) - touchStartY.current;
        if (Math.abs(dy) >= 56) {
          // Swipe up → next project, swipe down → previous.
          cycle(dy < 0 ? 1 : -1);
          didSwipe.current = true;
          touchStartY.current = event.touches[0]?.clientY ?? null;
        }
      }}
      onTouchEnd={() => {
        touchStartY.current = null;
      }}
    >
      <Folder className="size-3.5 shrink-0" />
      {active ? (
        <span className="truncate text-xs font-medium">
          {shortProject(value)}
        </span>
      ) : null}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Filter live sessions by project"
        className="absolute inset-0 cursor-pointer appearance-none bg-transparent text-transparent opacity-0 outline-none"
        onMouseDown={(event) => {
          // A swipe gesture shouldn't also pop the native picker open afterwards.
          if (didSwipe.current) {
            event.preventDefault();
            didSwipe.current = false;
          }
        }}
      >
        <option value="__all">All projects</option>
        {projects.map((project) => (
          <option key={project} value={project}>
            {shortProject(project)}
          </option>
        ))}
      </select>
    </label>
  );
}

// First-run identity picker. Shown full-screen when this browser has no chosen
// profile yet — pick yourself from the roster and we tag the sessions you start
// (and default the live filter to you). Choice persists in localStorage.
function WhoAreYou({
  users,
  onPick,
}: {
  users: User[];
  onPick: (email: string) => void;
}) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-sm">
        <div className="mb-4 flex items-center gap-2">
          <img src={appPath("/icon.svg")} alt="lfg" className="size-7 shrink-0" />
        </div>
        <h1 className="text-xl font-semibold">Who are you?</h1>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">
          Pick your profile so we can tag the sessions you start.
        </p>
        <div className="flex flex-col gap-2">
          {users.map((user) => (
            <button
              key={user.email}
              type="button"
              onClick={() => onPick(user.email)}
              className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 px-3 py-2.5 text-left transition-colors hover:bg-muted"
            >
              {user.avatar ? (
                <img
                  src={user.avatar}
                  alt=""
                  className="size-9 shrink-0 rounded-full"
                />
              ) : (
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                  <UserRound className="size-4" />
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium capitalize">
                  {user.name ?? shortUser(user.email)}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {user.email}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Tracks the mobile breakpoint (below Tailwind's md). The collapse + swipe
// gestures only attach below this width; desktop keeps the static grid card.
function useIsMobile() {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return mobile;
}

function isTextEditingElement(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "file", "hidden", "radio", "range", "reset", "submit"].includes(
    el.type,
  );
}

function composerIsEditing(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  const form = el?.closest("form");
  if (!form) return false;

  const active = document.activeElement;
  return active instanceof HTMLElement && form.contains(active) && isTextEditingElement(active);
}

// Wide screens (≥1024px — incl. iPad in landscape) get the rail + stage
// workspace; below that (phones, iPad portrait) we keep the familiar stacked
// grid where narrow columns would be too cramped. Mirrors useIsMobile.
function useIsWide() {
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return wide;
}

// Smooths the busy→idle transition so the rail doesn't thrash. A session going
// busy reflects instantly (you want to see work start), but going idle is held
// for `delay` ms — a brief idle blip between tool calls won't bounce a row out
// of the Working group and back. Returns a stabilized copy of busyBySid.
function useStableBusy(busyBySid: Record<string, boolean>, delay = 2500) {
  const [stable, setStable] = useState<Record<string, boolean>>(() => ({ ...busyBySid }));
  const stableRef = useRef(stable);
  stableRef.current = stable;
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const cur = stableRef.current;
    const patch: Record<string, boolean> = {};
    const createdTimers: ReturnType<typeof setTimeout>[] = [];
    for (const sid of Object.keys(busyBySid)) {
      const want = !!busyBySid[sid];
      const shown = !!cur[sid];
      if (want) {
        // Busy now — cancel any pending demotion and reflect immediately.
        if (timers.current[sid]) {
          clearTimeout(timers.current[sid]);
          delete timers.current[sid];
        }
        if (!shown) patch[sid] = true;
      } else if (shown && !timers.current[sid]) {
        // Wants idle while shown busy — hold the demotion behind a timer.
        timers.current[sid] = setTimeout(() => {
          delete timers.current[sid];
          setStable((p) => ({ ...p, [sid]: false }));
        }, delay);
        createdTimers.push(timers.current[sid]);
      } else if (!(sid in cur)) {
        patch[sid] = false;
      }
    }
    if (Object.keys(patch).length) setStable((p) => ({ ...p, ...patch }));
    return () => {
      for (const timer of createdTimers) clearTimeout(timer);
    };
  }, [busyBySid, delay]);

  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const id of Object.values(t)) clearTimeout(id);
    };
  }, []);

  return stable;
}

// Stable empty fallbacks. A fresh `[]` literal in a prop expression is a new
// reference every render, which would defeat SessionCard's memo for any card
// with no messages/queue — these constants keep the reference identical.
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_QUEUE: QueueMsg[] = [];

function LiveView({
  // Defense-in-depth: `sessions`/`findings`/`autoAgents` are read via `.length`
  // unconditionally below (the original `findings.length` crash site). The fetch
  // layer already guards these to [], but default here too so any future caller
  // passing `undefined` degrades to an empty render instead of crashing the view.
  sessions = [],
  users,
  userFilter,
  projectFilter,
  messagesBySid,
  busyBySid,
  promptsBySid,
  queuesBySid,
  loadingBySid,
  onLoadOlderMessages,
  onOptimisticMessage,
  onRefresh,
  onRemove,
  onNew,
  findings = [],
  autoAgents = [],
  onOpenFinding,
}: {
  sessions: Session[];
  users: User[];
  userFilter: string;
  projectFilter: string;
  messagesBySid: Record<string, Message[]>;
  busyBySid: Record<string, boolean>;
  promptsBySid: Record<string, SessionPrompt | null>;
  queuesBySid: Record<string, QueueMsg[]>;
  loadingBySid: Record<string, boolean>;
  onLoadOlderMessages: LoadOlderMessages;
  onOptimisticMessage: (sid: string, text: string) => void;
  onRefresh: () => Promise<void>;
  onRemove: (sid: string) => void;
  onNew: () => void;
  findings: AutoFinding[];
  autoAgents: AutoAgent[];
  onOpenFinding: (f: AutoFinding) => void;
}) {
  const isWide = useIsWide();
  // Full-height detail sheet (mobile long-press). Held here, above every card,
  // so it can switch which session it shows without unmounting. `origin` anchors
  // the open/close morph to the title the user long-pressed.
  const [sheet, setSheet] = useState<{ sid: string; origin: DOMRect } | null>(null);
  if (!sessions.length && !findings.length) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-muted">
          <MessageSquare className="size-6 text-muted-foreground" />
        </div>
        <div>
          <div className="font-semibold">No running sessions</div>
          <div className="mt-1 text-sm text-muted-foreground">
            {userFilter === "__all"
              ? "Start Claude or Codex from v2."
              : "No sessions match this user filter."}
          </div>
        </div>
        <Button variant="brand" onClick={onNew}>
          <Plus className="size-4" />
          New session
        </Button>
      </div>
    );
  }

  // Reorder into two categories — working agents on top, idle below — while
  // preserving the stable start-time order within each group (sessions arrives
  // pre-sorted). A card moves between groups the moment its busy state flips.
  const working = sessions.filter(
    (session) => !!busyBySid[session.sessionId ?? ""] || recentlyCreatedSids.has(session.sessionId ?? ""),
  );
  const idle = sessions.filter(
    (session) => !busyBySid[session.sessionId ?? ""] && !recentlyCreatedSids.has(session.sessionId ?? ""),
  );
  const nameFor = (id: string) => autoAgents.find((a) => a.id === id)?.name ?? id;

  // Close every idle session in one tap. Each card drops immediately (onRemove)
  // and the backend close fires in parallel; a single refresh reconciles.
  async function clearIdle() {
    const ids = idle.map((s) => s.sessionId).filter((id): id is string => !!id);
    if (!ids.length) return;
    if (!confirm(`Close ${ids.length} idle session${ids.length === 1 ? "" : "s"}?`)) return;
    for (const id of ids) onRemove(id);
    await Promise.allSettled(
      ids.map((id) => api(`/api/sessions/${id}/close`, { method: "POST" })),
    );
    await onRefresh();
  }

  const renderCard = (session: Session) => (
    <ErrorBoundary
      key={session.sessionId}
      fallback={(reset) => (
        <section className="live-pane flex h-[22rem] min-w-0 md:h-[clamp(30rem,72vh,46rem)] flex-col items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center text-sm text-destructive">
          <span>This session card hit a render error.</span>
          <Button size="sm" variant="outline" onClick={reset}>
            Retry
          </Button>
        </section>
      )}
    >
      <SessionCard
        session={session}
        users={users}
        messages={messagesBySid[session.sessionId ?? ""] ?? EMPTY_MESSAGES}
        busy={!!busyBySid[session.sessionId ?? ""]}
        loading={!!loadingBySid[session.sessionId ?? ""]}
        prompt={promptsBySid[session.sessionId ?? ""] ?? null}
        queue={queuesBySid[session.sessionId ?? ""] ?? EMPTY_QUEUE}
        onLoadOlderMessages={onLoadOlderMessages}
        onOptimisticMessage={onOptimisticMessage}
        onRefresh={onRefresh}
        onRemove={onRemove}
        onOpenSheet={(sid, origin) => setSheet({ sid, origin })}
        entering={recentlyCreatedSids.has(session.sessionId ?? "")}
      />
    </ErrorBoundary>
  );

  if (isWide) {
    return (
      <RailStage
        sessions={sessions}
        users={users}
        projectFilter={projectFilter}
        messagesBySid={messagesBySid}
        busyBySid={busyBySid}
        promptsBySid={promptsBySid}
        queuesBySid={queuesBySid}
        loadingBySid={loadingBySid}
        onLoadOlderMessages={onLoadOlderMessages}
        onOptimisticMessage={onOptimisticMessage}
        onRefresh={onRefresh}
        onRemove={onRemove}
        findings={findings}
        nameFor={nameFor}
        onOpenFinding={onOpenFinding}
        onNew={onNew}
      />
    );
  }

  // Sheet navigation follows the on-screen order: working cards first, then idle.
  const sheetOrder = [...working, ...idle]
    .map((s) => s.sessionId)
    .filter((id): id is string => !!id);
  const sheetSession = sheet ? sessions.find((s) => s.sessionId === sheet.sid) : null;

  return (
    <>
    <div className="flex flex-col gap-5">
      {working.length ? (
        <section>
          <CategoryHeader
            label="Working"
            count={working.length}
            dotClass="animate-pulse bg-warning"
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-2">
            {working.map(renderCard)}
          </div>
        </section>
      ) : null}
      {findings.length ? (
        <section>
          <CategoryHeader label="Auto" count={findings.length} dotClass="bg-primary" />
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-2">
            {findings.map((f) => (
              <AutoFindingCard
                key={f.id}
                finding={f}
                agentName={nameFor(f.agentId)}
                onOpen={() => onOpenFinding(f)}
              />
            ))}
          </div>
        </section>
      ) : null}
      {idle.length ? (
        <section>
          <CategoryHeader
            label="Idle"
            count={idle.length}
            dotClass="bg-success/30 ring-1 ring-inset ring-success/20"
            action={
              <button
                type="button"
                onClick={clearIdle}
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <X className="size-3" />
                Clear all
              </button>
            }
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-2">
            {idle.map(renderCard)}
          </div>
        </section>
      ) : null}
    </div>
    {sheet && sheetSession ? (
      <SessionTitleSheet
        sid={sheet.sid}
        session={sheetSession}
        order={sheetOrder}
        origin={sheet.origin}
        messagesBySid={messagesBySid}
        busyBySid={busyBySid}
        loadingBySid={loadingBySid}
        promptsBySid={promptsBySid}
        queuesBySid={queuesBySid}
        onLoadOlderMessages={onLoadOlderMessages}
        onSwitch={(nextSid) => setSheet((s) => (s ? { ...s, sid: nextSid } : s))}
        onOptimisticMessage={onOptimisticMessage}
        onRefresh={onRefresh}
        onClose={() => setSheet(null)}
      />
    ) : null}
    </>
  );
}

// ── Wide-screen workspace: a session rail on the left, a tiled stage on the
// right. Clicking a rail row opens it in a transient "preview" column; pinning
// promotes it to a persistent column. The stage never reorders on its own, so a
// session flipping working↔idle no longer makes the layout jump — that motion
// is confined to the small status dot in the rail. Up to 4 columns.
function RailStage({
  sessions = [],
  users,
  projectFilter,
  messagesBySid,
  busyBySid,
  promptsBySid,
  queuesBySid,
  loadingBySid,
  onLoadOlderMessages,
  onOptimisticMessage,
  onRefresh,
  onRemove,
  findings = [],
  nameFor,
  onOpenFinding,
  onNew,
}: {
  sessions: Session[];
  users: User[];
  projectFilter: string;
  messagesBySid: Record<string, Message[]>;
  busyBySid: Record<string, boolean>;
  promptsBySid: Record<string, SessionPrompt | null>;
  queuesBySid: Record<string, QueueMsg[]>;
  loadingBySid: Record<string, boolean>;
  onLoadOlderMessages: LoadOlderMessages;
  onOptimisticMessage: (sid: string, text: string) => void;
  onRefresh: () => Promise<void>;
  onRemove: (sid: string) => void;
  findings: AutoFinding[];
  nameFor: (id: string) => string;
  onOpenFinding: (f: AutoFinding) => void;
  onNew: () => void;
}) {
  const MAX_COLUMNS = 4;
  const layoutScope = projectFilter || "__all";
  const layoutKey = encodeURIComponent(layoutScope);
  const pinnedStorageKey = `lfg_stage_pinned:${layoutKey}`;
  const railCollapsedStorageKey = `lfg_rail_collapsed:${layoutKey}`;
  const readPinned = useCallback((): string[] => {
    try {
      const raw =
        localStorage.getItem(pinnedStorageKey) ??
        (layoutScope === "__all" ? localStorage.getItem("lfg_stage_pinned") : null);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }, [layoutScope, pinnedStorageKey]);
  const readRailCollapsed = useCallback((): boolean => {
    try {
      const raw =
        localStorage.getItem(railCollapsedStorageKey) ??
        (layoutScope === "__all" ? localStorage.getItem("lfg_rail_collapsed") : null);
      return raw === "1";
    } catch {
      return false;
    }
  }, [layoutScope, railCollapsedStorageKey]);
  const [pinned, setPinned] = useState<string[]>(readPinned);
  const [preview, setPreview] = useState<string | null>(null);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(readRailCollapsed);
  // Keyboard cursor (highlighted rail row) + the shortcuts cheatsheet overlay.
  const [cursor, setCursor] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  // Range-select anchor for shift-click / shift-arrow.
  const anchorRef = useRef<string | null>(null);

  const bySid = useMemo(() => {
    const m = new Map<string, Session>();
    for (const s of sessions) if (s.sessionId) m.set(s.sessionId, s);
    return m;
  }, [sessions]);

  // Drop pinned/preview ids the server has stopped returning (session ended),
  // so columns vanish cleanly instead of rendering blanks.
  useEffect(() => {
    setPinned((prev) => {
      const next = prev.filter((id) => bySid.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [bySid]);
  useEffect(() => {
    setPreview((p) => (p && !bySid.has(p) ? null : p));
  }, [bySid]);

  // Reload layout state when switching projects; each project gets its own local
  // pinned columns and rail collapsed state.
  useLayoutEffect(() => {
    setPinned(readPinned());
    setPreview(null);
    setRailCollapsed(readRailCollapsed());
    anchorRef.current = null;
  }, [readPinned, readRailCollapsed]);

  // Persist the pinned set so each project workspace survives reloads.
  useEffect(() => {
    try {
      localStorage.setItem(pinnedStorageKey, JSON.stringify(pinned));
    } catch {
      /* private mode / quota — non-fatal */
    }
  }, [pinned, pinnedStorageKey]);
  useEffect(() => {
    try {
      localStorage.setItem(railCollapsedStorageKey, railCollapsed ? "1" : "0");
    } catch {
      /* non-fatal */
    }
  }, [railCollapsed, railCollapsedStorageKey]);

  const validPinned = useMemo(() => pinned.filter((id) => bySid.has(id)), [pinned, bySid]);
  const columnIds = useMemo(() => {
    const cols = [...validPinned];
    if (preview && bySid.has(preview) && !cols.includes(preview) && cols.length < MAX_COLUMNS) {
      cols.push(preview);
    }
    return cols.slice(0, MAX_COLUMNS);
  }, [validPinned, preview, bySid]);

  // Stage columns are open transcript surfaces even though they do not use the
  // mobile card collapse toggle. Keep the app-level lazy stream manager in sync
  // so direct-opened / previewed / pinned sessions actually start their SSE.
  useEffect(() => {
    if (!columnIds.length) return;
    try {
      for (const sid of columnIds) localStorage.setItem(`lfg-collapsed:${sid}`, "0");
    } catch {
      /* private mode / quota */
    }
    window.dispatchEvent(new Event("lfg-collapse-change"));
  }, [columnIds]);

  // Never leave the stage empty when there's something to show: preview the
  // first working session (or the first session) on load.
  useEffect(() => {
    if (columnIds.length || !sessions.length) return;
    const first = sessions.find((s) => busyBySid[s.sessionId ?? ""]) ?? sessions[0];
    if (first?.sessionId) setPreview(first.sessionId);
  }, [columnIds.length, sessions, busyBySid]);

  const openSession = useCallback(
    (sid: string) => {
      if (validPinned.includes(sid)) return; // already a persistent column
      setPreview(sid);
    },
    [validPinned],
  );
  const togglePin = useCallback(
    (sid: string) => {
      if (validPinned.includes(sid)) {
        setPinned((prev) => prev.filter((x) => x !== sid));
        return;
      }
      if (validPinned.length >= MAX_COLUMNS) {
        toast.error(`${MAX_COLUMNS} columns max — unpin one first`);
        return;
      }
      setPinned([...validPinned, sid]);
      setPreview((p) => (p === sid ? null : p));
    },
    [validPinned],
  );
  const closeColumn = useCallback((sid: string) => {
    setPinned((prev) => prev.filter((x) => x !== sid));
    setPreview((p) => (p === sid ? null : p));
  }, []);

  // Rail grouping + dots use the stabilized busy state so rows don't bounce
  // between Working/Idle on brief blips. Stage columns keep the real busyBySid.
  const stableBusy = useStableBusy(busyBySid);
  const working = sessions.filter((s) => stableBusy[s.sessionId ?? ""]);
  const idle = sessions.filter((s) => !stableBusy[s.sessionId ?? ""]);

  const projectRailGroups = useMemo(() => {
    if (projectFilter !== "__all") return [];
    const groups = new Map<string, { label: string; sessions: Session[] }>();
    for (const session of sessions) {
      const project = session.project || "";
      const key = project || "__no_project";
      const label = project ? shortProject(project) : "No project";
      const group = groups.get(key);
      if (group) {
        group.sessions.push(session);
      } else {
        groups.set(key, { label, sessions: [session] });
      }
    }
    return Array.from(groups.entries())
      .map(([key, group]) => ({ key, ...group }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [projectFilter, sessions]);

  const railOrderedSessions =
    projectFilter === "__all"
      ? projectRailGroups.flatMap((group) => group.sessions)
      : [...working, ...idle];

  // Flat rail order the keyboard cursor walks (matching the visible rail;
  // findings are not navigable). Keep the cursor pointing at a live session.
  const orderedSids = useMemo(() => {
    const ids: string[] = [];
    for (const session of railOrderedSessions) {
      if (session.sessionId) ids.push(session.sessionId);
    }
    return ids;
  }, [railOrderedSessions]);
  useEffect(() => {
    setCursor((c) => (c && orderedSids.includes(c) ? c : orderedSids[0] ?? null));
  }, [orderedSids]);
  // Scroll the cursored row into view as it moves.
  useEffect(() => {
    if (!cursor) return;
    document
      .querySelector(`[data-rail-sid="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // Pin the contiguous range anchor→sid as the stage set (capped at 4). This is
  // what shift-click / shift-arrow do: select multiple sessions to tile at once.
  const selectTo = useCallback(
    (sid: string) => {
      const a = anchorRef.current ? orderedSids.indexOf(anchorRef.current) : -1;
      const b = orderedSids.indexOf(sid);
      if (a < 0 || b < 0) {
        anchorRef.current = sid;
        setCursor(sid);
        setPreview(sid);
        return;
      }
      const [lo, hi] = a < b ? [a, b] : [b, a];
      let range = orderedSids.slice(lo, hi + 1);
      if (range.length > MAX_COLUMNS) {
        toast.error(`${MAX_COLUMNS} panes max — selection trimmed`);
        // Keep the panes nearest the just-clicked end.
        range = b >= a ? range.slice(range.length - MAX_COLUMNS) : range.slice(0, MAX_COLUMNS);
      }
      setPinned(range);
      setPreview(null);
      setCursor(sid);
    },
    [orderedSids],
  );

  // A plain click/Enter: set the anchor here and preview it. Shift extends the
  // range from the anchor and tiles the selection.
  const activate = useCallback(
    (sid: string, shift: boolean) => {
      if (shift && anchorRef.current) {
        selectTo(sid);
        return;
      }
      anchorRef.current = sid;
      setCursor(sid);
      openSession(sid);
    },
    [selectTo, openSession],
  );

  // Quick-interrupt a session by id. Interrupting an idle session is a harmless
  // server-side no-op, but we still gate on drivability so we never POST for a
  // session this client can't control.
  const interruptSid = useCallback(
    async (sid: string | null) => {
      if (!sid) return;
      const sess = bySid.get(sid);
      if (!sess || !canDriveSession(sess)) return;
      try {
        await api(`/api/sessions/${sid}/interrupt`, { method: "POST" });
        await onRefresh();
      } catch {
        // Best-effort: a failed interrupt shouldn't surface as a hard error.
      }
    },
    [bySid, onRefresh],
  );
  const closeSession = useCallback(
    async (sid: string | null) => {
      if (!sid || !bySid.has(sid)) return;
      closeColumn(sid);
      try {
        await api(`/api/sessions/${sid}/close`, { method: "POST" });
        onRemove(sid);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn't end session");
      } finally {
        await onRefresh();
      }
    },
    [bySid, closeColumn, onRemove, onRefresh],
  );

  // Latest values for the global key handler, so it binds once but never reads
  // stale state.
  const kb = useRef({ orderedSids, cursor, preview, columnIds, activate, selectTo, togglePin, closeColumn, closeSession, setCursor, setPreview, setRailCollapsed, setShowHelp, showHelp, busyBySid, interruptSid, onNew });
  kb.current = { orderedSids, cursor, preview, columnIds, activate, selectTo, togglePin, closeColumn, closeSession, setCursor, setPreview, setRailCollapsed, setShowHelp, showHelp, busyBySid, interruptSid, onNew };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = kb.current;
      const order = s.orderedSids;
      const cur = s.cursor && order.includes(s.cursor) ? s.cursor : order[0] ?? null;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      // Quick-interrupt: Cmd/Ctrl+. cancels the active run from anywhere — even
      // while typing in the composer — targeting the focused session if it's
      // busy, else the first running session.
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        const target = cur && s.busyBySid[cur] ? cur : order.find((id) => s.busyBySid[id]) ?? cur;
        void s.interruptSid(target);
        return;
      }

      // Never hijack browser combos or typing in a composer/input.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;

      const idx = cur ? order.indexOf(cur) : -1;
      const move = (delta: number, shift: boolean, open: boolean) => {
        if (!order.length) return;
        const next = order[Math.max(0, Math.min(order.length - 1, idx + delta))];
        if (!next) return;
        if (shift) {
          // Extend the selection from the anchor and tile it.
          if (!anchorRef.current) anchorRef.current = cur ?? next;
          s.setCursor(next);
          s.selectTo(next);
        } else if (open) {
          // Arrows switch the primary session directly: move the cursor *and*
          // open it in the stage in one step.
          s.activate(next, false);
        } else {
          anchorRef.current = next;
          s.setCursor(next);
        }
      };

      // Enter "focuses into" the cursored session: make sure it's open in the
      // stage, then move keyboard focus into its message composer.
      const focusInto = (sid: string) => {
        if (!s.columnIds.includes(sid)) s.activate(sid, false);
        // Let the column mount/render before grabbing its input.
        window.setTimeout(() => {
          const el = document.querySelector(
            `[data-composer-sid="${sid}"]`,
          ) as HTMLElement | null;
          el?.focus();
        }, 60);
      };

      switch (key) {
        case "?":
          e.preventDefault();
          s.setShowHelp((v) => !v);
          return;
        case "Escape": {
          // Esc unwinds overlays first (help, then preview); with nothing open
          // it cancels the active run for the focused/first-busy session.
          if (s.showHelp) {
            s.setShowHelp(false);
            return;
          }
          if (s.preview) {
            s.setPreview(null);
            return;
          }
          const target = cur && s.busyBySid[cur] ? cur : order.find((id) => s.busyBySid[id]) ?? null;
          if (target) {
            e.preventDefault();
            void s.interruptSid(target);
          }
          return;
        }
        case "c":
          e.preventDefault();
          s.onNew();
          return;
        case "ArrowDown":
          e.preventDefault();
          move(1, e.shiftKey, true);
          return;
        case "ArrowUp":
          e.preventDefault();
          move(-1, e.shiftKey, true);
          return;
        case "j":
          e.preventDefault();
          move(1, e.shiftKey, false);
          return;
        case "k":
          e.preventDefault();
          move(-1, e.shiftKey, false);
          return;
        case "o":
          if (cur) {
            e.preventDefault();
            s.activate(cur, e.shiftKey);
          }
          return;
        case "Enter":
          if (cur) {
            e.preventDefault();
            focusInto(cur);
          }
          return;
        case "p":
          if (cur) {
            e.preventDefault();
            s.togglePin(cur);
          }
          return;
        case "x":
          if (cur && s.columnIds.includes(cur)) {
            e.preventDefault();
            s.closeColumn(cur);
          }
          return;
        case "e":
          if (cur && !e.repeat) {
            e.preventDefault();
            void s.closeSession(cur);
          }
          return;
        case "\\":
          e.preventDefault();
          s.setRailCollapsed((v) => !v);
          return;
        default:
          if (/^[1-9]$/.test(e.key)) {
            const n = Number(e.key) - 1;
            if (order[n]) {
              e.preventDefault();
              s.activate(order[n], e.shiftKey);
            }
          }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const renderRailItem = (session: Session) => {
    const sid = session.sessionId ?? "";
    return (
      <RailItem
        key={sid}
        session={session}
        busy={!!stableBusy[sid]}
        latest={latestLine(messagesBySid[sid] ?? EMPTY_MESSAGES)}
        active={columnIds.includes(sid)}
        cursored={cursor === sid}
        pinned={validPinned.includes(sid)}
        collapsed={railCollapsed}
        onActivate={(shift) => activate(sid, shift)}
        onTogglePin={() => togglePin(sid)}
      />
    );
  };

  const autoRailGroup =
    findings.length && !railCollapsed ? (
      <RailGroup label="Auto" count={findings.length} collapsed={railCollapsed}>
        {findings.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => onOpenFinding(f)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted"
          >
            <span className={cn("size-2 shrink-0 rounded-full", SEV_DOT[f.severity])} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium leading-tight">
                {nameFor(f.agentId)}
              </span>
              <span className="truncate text-[11px] leading-tight text-muted-foreground">
                {f.title}
              </span>
            </span>
          </button>
        ))}
      </RailGroup>
    ) : null;

  return (
    <div className="flex h-full min-h-0 gap-3">
      <aside
        className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card transition-[width] duration-200 ease-ios"
        style={{ width: railCollapsed ? 56 : 280 }}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2.5">
          {!railCollapsed ? (
            <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Sessions · {sessions.length}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setRailCollapsed((v) => !v)}
            aria-label={railCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
          >
            {railCollapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
          {projectFilter === "__all" ? (
            <>
              {projectRailGroups.map((group) => (
                <RailGroup
                  key={group.key}
                  label={group.label}
                  count={group.sessions.length}
                  collapsed={railCollapsed}
                >
                  {group.sessions.map(renderRailItem)}
                </RailGroup>
              ))}
              {autoRailGroup}
            </>
          ) : (
            <>
              {working.length ? (
                <RailGroup label="Working" count={working.length} collapsed={railCollapsed}>
                  {working.map(renderRailItem)}
                </RailGroup>
              ) : null}
              {autoRailGroup}
              {idle.length ? (
                <RailGroup label="Idle" count={idle.length} collapsed={railCollapsed}>
                  {idle.map(renderRailItem)}
                </RailGroup>
              ) : null}
            </>
          )}
        </div>
      </aside>

      <div
        className={cn(
          "grid h-full min-h-0 min-w-0 flex-1 gap-3",
          // 1 pane → full; 2 → side by side; 3-4 → 2×2 (panes 1&2 top, 3&4 bottom).
          columnIds.length <= 1
            ? "grid-cols-1 grid-rows-1"
            : columnIds.length === 2
              ? "grid-cols-2 grid-rows-1"
              : "grid-cols-2 grid-rows-2",
        )}
      >
        {columnIds.length ? (
          columnIds.map((sid) => {
            const session = bySid.get(sid);
            if (!session) return null;
            return (
              <div
                key={sid}
                data-stage-sid={sid}
                className="h-full min-h-0 min-w-0"
                onClickCapture={() => setCursor(sid)}
                onFocusCapture={() => setCursor(sid)}
              >
                <ErrorBoundary
                  fallback={(reset) => (
                    <section className="live-pane flex h-full min-w-0 flex-col items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center text-sm text-destructive">
                      <span>This session column hit a render error.</span>
                      <Button size="sm" variant="outline" onClick={reset}>
                        Retry
                      </Button>
                    </section>
                  )}
                >
                  <SessionCard
                    session={session}
                    users={users}
                    messages={messagesBySid[sid] ?? EMPTY_MESSAGES}
                    busy={!!busyBySid[sid]}
                    loading={!!loadingBySid[sid]}
                    prompt={promptsBySid[sid] ?? null}
                    queue={queuesBySid[sid] ?? EMPTY_QUEUE}
                    onLoadOlderMessages={onLoadOlderMessages}
                    onOptimisticMessage={onOptimisticMessage}
                    onRefresh={onRefresh}
                    onRemove={onRemove}
                    variant="stage"
                    onClose={() => closeColumn(sid)}
                    entering={recentlyCreatedSids.has(sid)}
                  />
                </ErrorBoundary>
              </div>
            );
          })
        ) : (
          <div className="flex h-full flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-center text-sm text-muted-foreground">
            <MessageSquare className="size-6" />
            <span>Select a session from the rail to open it here.</span>
          </div>
        )}
      </div>

      {showHelp ? <ShortcutsHelp onClose={() => setShowHelp(false)} /> : null}
    </div>
  );
}

function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ["Tab", "Switch project"],
    ["↓ / ↑", "Switch primary session"],
    ["j / k", "Move cursor without opening"],
    ["Enter", "Focus into current session"],
    ["o", "Open cursored session"],
    ["c", "New session"],
    ["p", "Pin / unpin cursored session"],
    ["x", "Close cursored column"],
    ["e", "End cursored session"],
    ["1 – 9", "Open the Nth session"],
    ["\\", "Collapse / expand the rail"],
    ["?", "Toggle this help"],
    ["Esc", "Close help / preview"],
  ];
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-label="Close keyboard shortcuts"
      />
      <div
        className="relative w-full max-w-sm rounded-2xl border border-border bg-card p-4 shadow-[0_8px_28px_rgba(0,0,0,0.22)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold">Keyboard shortcuts</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {rows.map(([k, label]) => (
            <div key={k} className="flex items-center justify-between gap-3 text-[13px]">
              <span className="text-muted-foreground">{label}</span>
              <kbd className="shrink-0 rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] font-medium">
                {k}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RailGroup({
  label,
  count,
  collapsed,
  children,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  children: ReactNode;
}) {
  return (
    <div className="mb-2">
      {!collapsed ? (
        <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          {label} · {count}
        </div>
      ) : null}
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

const RailItem = memo(function RailItem({
  session,
  busy,
  latest,
  active,
  cursored,
  pinned,
  collapsed,
  onActivate,
  onTogglePin,
}: {
  session: Session;
  busy: boolean;
  latest: string;
  active: boolean;
  cursored: boolean;
  pinned: boolean;
  collapsed: boolean;
  onActivate: (shiftKey: boolean) => void;
  onTogglePin: () => void;
}) {
  // Touch swipe: drag right to pin, left to unpin. The foreground row slides
  // and a pin glyph is revealed behind it; past ~52px on release it commits.
  // A horizontal drag suppresses the tap-to-open; vertical is left to scroll.
  const fgRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ startX: 0, startY: 0, x: 0, dragging: false, decided: false, horizontal: false, swiped: false });
  const [swiping, setSwiping] = useState(false);
  const COMMIT = 52;

  const onTouchStart = (e: ReactTouchEvent) => {
    const t = e.touches[0];
    const el = fgRef.current;
    if (el) el.style.transition = "";
    drag.current = { startX: t.clientX, startY: t.clientY, x: 0, dragging: true, decided: false, horizontal: false, swiped: false };
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    const d = drag.current;
    if (!d.dragging) return;
    const t = e.touches[0];
    const dx = t.clientX - d.startX;
    const dy = t.clientY - d.startY;
    if (!d.decided && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      d.decided = true;
      d.horizontal = Math.abs(dx) > Math.abs(dy);
      if (d.horizontal) setSwiping(true);
    }
    if (!d.horizontal) return; // vertical → let the rail scroll
    // Only allow the meaningful direction: right to pin, left to unpin.
    let v = pinned ? Math.min(0, dx) : Math.max(0, dx);
    v = Math.max(-96, Math.min(96, v));
    d.x = v;
    if (fgRef.current) fgRef.current.style.transform = `translateX(${v}px)`;
  };
  const onTouchEnd = () => {
    const d = drag.current;
    if (d.horizontal) {
      d.swiped = true;
      if (Math.abs(d.x) >= COMMIT) {
        haptic("selection");
        onTogglePin();
      }
    }
    const el = fgRef.current;
    if (el) {
      el.style.transition = "transform 180ms ease";
      el.style.transform = "translateX(0)";
    }
    d.dragging = false;
    d.decided = false;
    d.horizontal = false;
    d.x = 0;
    setSwiping(false);
  };

  return (
    <div
      data-rail-sid={session.sessionId ?? ""}
      className={cn(
        "relative overflow-hidden rounded-lg",
        cursored && "ring-2 ring-inset ring-primary/60",
      )}
    >
      {swiping ? (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 flex items-center px-3",
            pinned ? "justify-end" : "justify-start",
          )}
        >
          <Pin
            className={cn("size-4", pinned ? "text-muted-foreground" : "text-primary")}
            fill={pinned ? "none" : "currentColor"}
          />
        </div>
      ) : null}
      <div
        ref={fgRef}
        role="button"
        tabIndex={0}
        onClick={(e) => {
          if (drag.current.swiped) {
            drag.current.swiped = false;
            return;
          }
          onActivate(e.shiftKey);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onActivate(e.shiftKey);
          }
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        title={collapsed ? titleForSession(session) : undefined}
        className={cn(
          "group relative flex cursor-pointer touch-pan-y select-none items-center gap-2 rounded-lg py-1.5 outline-none transition-[background-color,box-shadow] duration-150",
          collapsed ? "justify-center px-0" : "px-2",
          swiping
            ? "bg-card"
            : active
              ? "bg-primary/10"
              : "hover:bg-muted",
        )}
      >
        <span className="relative flex size-6 shrink-0 items-center justify-center">
          <img
            src={agentIconSrc(session.agent)}
            alt={agentIconAlt(session.agent)}
            className="size-6 rounded-md"
          />
          <span
            aria-label={busy ? "working" : "idle"}
            className={cn(
              "absolute -bottom-0.5 -right-0.5 size-2.5 shrink-0 rounded-full ring-2 ring-card",
              busy ? "animate-pulse bg-warning" : "bg-success",
            )}
          />
        </span>
        {!collapsed ? (
          <>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium leading-tight">
                {titleForSession(session)}
              </span>
              {latest ? (
                <span className="truncate text-[11px] leading-tight text-muted-foreground">
                  {latest}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin();
              }}
              aria-label={pinned ? "Unpin column" : "Pin as column"}
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-md transition-opacity",
                pinned
                  ? "text-primary opacity-100"
                  : "text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100",
              )}
            >
              <Pin className="size-3.5" fill={pinned ? "currentColor" : "none"} />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
});

const SEV_DOT: Record<AutoFinding["severity"], string> = {
  high: "bg-destructive",
  med: "bg-warning",
  low: "bg-muted-foreground",
};
function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function AutoFindingCard({
  finding,
  agentName,
  onOpen,
}: {
  finding: AutoFinding;
  agentName: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="live-pane flex flex-col gap-1 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition active:scale-[0.99]"
    >
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", SEV_DOT[finding.severity])} />
        <span className="text-[13px] font-semibold">{agentName}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{relTime(finding.createdAt)}</span>
      </div>
      <div className="pl-4 text-[13px] leading-snug text-muted-foreground">{finding.title}</div>
    </button>
  );
}

function CategoryHeader({
  label,
  count,
  dotClass,
  action,
}: {
  label: string;
  count: number;
  dotClass: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center gap-2 px-0.5">
      <span className={cn("size-1.5 rounded-full", dotClass)} />
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
        {count}
      </span>
      {action ? <div className="ml-auto flex items-center">{action}</div> : null}
    </div>
  );
}

// The full chat surface — live transcript + prompt/queue panels + composer.
// Shared verbatim between the in-grid SessionCard and the long-press full-height
// SessionTitleSheet so both drive the same send pipeline (no duplicated state).
// It owns the composer's own text/sending state; `error` is lifted to the host
// so model/assign errors can surface in the same bar.
// A prominent, explained "build paused" banner shown whenever the backend
// marks a session blocked. Two cases today: the session's model became
// unavailable (offer a one-click relaunch onto Opus — the backend respawns the
// pane on the new model since an injected `/model` can't recover a frozen
// session), or the build agent ran out of AI credits (explain + tell them to
// top up). Without this, a frozen session just shows a dead spinner and the
// user has no idea what happened or what to do.
function PausedBanner({
  session,
  onRefresh,
}: {
  session: Session;
  onRefresh: () => Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (session.status !== "blocked") return null;
  const sid = session.sessionId;
  const reason = session.statusReason;
  const canSwitchClaude =
    reason === "model_unavailable" && session.agent === "claude" && !!session.tmuxTarget && !!sid;
  const canSwitchOpencode =
    session.agent === "opencode" &&
    (reason === "provider_auth" || reason === "provider_error") &&
    !!sid;

  async function switchModel(model: string) {
    if (!sid) return;
    setWorking(true);
    setErr(null);
    try {
      await api(`/api/sessions/${sid}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      await onRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  const title =
    reason === "out_of_credits"
      ? "Build paused — out of credits"
      : reason === "provider_auth"
        ? "Build paused — provider rejected the model"
        : reason === "provider_error"
          ? "Build paused — provider error"
          : "Build paused";
  const detail =
    reason === "out_of_credits"
      ? "This app's build agent ran out of AI credits. Top up the wallet to resume the build."
      : reason === "provider_auth"
        ? `${session.statusDetail || "The selected provider rejected the request."} Check the OpenCode provider key or switch models.`
        : reason === "provider_error"
          ? `${session.statusDetail || "The selected provider failed the request."} Check the OpenCode provider logs or switch models.`
      : `${session.statusDetail || "The selected model isn't available."} Switch to a working model to pick the build back up.`;

  return (
    <div className="border-b border-warning/30 bg-warning/12 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-warning">⏸ {title}</div>
          <div className="mt-0.5 text-foreground/70">{detail}</div>
          {err ? <div className="mt-1 text-destructive">{err}</div> : null}
        </div>
        {canSwitchClaude ? (
          <button
            type="button"
            onClick={() => void switchModel("opus")}
            disabled={working}
            className="shrink-0 rounded-lg bg-warning px-3 py-1.5 font-medium text-white disabled:opacity-50"
          >
            {working ? "Resuming…" : "Resume on Opus"}
          </button>
        ) : null}
        {canSwitchOpencode ? (
          <button
            type="button"
            onClick={() => void switchModel("opencode/big-pickle")}
            disabled={working}
            className="shrink-0 rounded-lg bg-warning px-3 py-1.5 font-medium text-white disabled:opacity-50"
          >
            {working ? "Switching…" : "Use Big Pickle"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function SessionChat({
  session,
  messages,
  busy,
  loading,
  prompt,
  queue,
  onLoadOlderMessages,
  error,
  onError,
  onOptimisticMessage,
  onRefresh,
  onCollapse,
  onDictatingChange,
}: {
  session: Session;
  messages: Message[];
  busy: boolean;
  loading: boolean;
  prompt: SessionPrompt | null;
  queue: QueueMsg[];
  onLoadOlderMessages: LoadOlderMessages;
  error: string | null;
  onError: (error: string | null) => void;
  onOptimisticMessage: (sid: string, text: string) => void;
  onRefresh: () => Promise<void>;
  onCollapse?: () => void;
  onDictatingChange?: (recording: boolean) => void;
}) {
  const sid = session.sessionId;
  const [messageText, setMessageText] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewUrls = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      for (const url of previewUrls.current) URL.revokeObjectURL(url);
      previewUrls.current = [];
    };
  }, []);

  function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files).filter((file) => file.size > 0);
    if (!incoming.length) return;
    setAttachments((current) => {
      const room = Math.max(0, 8 - current.length);
      if (!room) {
        toast.error("Remove an attachment before adding another.");
        return current;
      }
      if (incoming.length > room) toast.error(`Added ${room} of ${incoming.length} files.`);
      const next = incoming.slice(0, room).map((file) => {
        const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
        if (previewUrl) previewUrls.current.push(previewUrl);
        return {
          id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
          file,
          name: file.name || "upload",
          size: file.size,
          type: file.type,
          previewUrl,
          status: "ready" as const,
        };
      });
      return [...current, ...next];
    });
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const item = current.find((att) => att.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return current.filter((att) => att.id !== id);
    });
  }

  async function uploadAttachment(att: ComposerAttachment): Promise<{ name: string; path: string }> {
    if (!sid) throw new Error("session not found");
    setAttachments((current) =>
      current.map((item) =>
        item.id === att.id ? { ...item, status: "uploading", error: undefined } : item,
      ),
    );
    try {
      const uploaded = await api<{ path: string; name?: string }>(
        `/api/sessions/${sid}/upload?filename=${encodeURIComponent(att.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": att.type || "application/octet-stream" },
          body: att.file,
        },
      );
      return { name: uploaded.name || att.name, path: uploaded.path };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAttachments((current) =>
        current.map((item) =>
          item.id === att.id ? { ...item, status: "failed", error: message } : item,
        ),
      );
      throw err;
    }
  }

  async function sendMessage(e?: FormEvent, overrideText?: string) {
    e?.preventDefault();
    const text = (overrideText ?? messageText).trim();
    const files = attachments;
    if (!sid || (!text && !files.length)) return;
    setSending(true);
    onError(null);
    setMessageText("");
    try {
      const uploaded = files.length ? await Promise.all(files.map(uploadAttachment)) : [];
      const outgoingText = composeAttachmentMessage(text, uploaded);
      onOptimisticMessage(sid, outgoingText);
      onCollapse?.(); // tuck the card away while it works (auto-expands when done)
      await api(`/api/sessions/${sid}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: outgoingText }),
      });
      for (const att of files) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
      setAttachments([]);
      setSending(false);
      void onRefresh().catch((err) => {
        onError(err instanceof Error ? err.message : String(err));
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setMessageText(text);
      setAttachments((current) =>
        current.map((att) => (att.status === "uploading" ? { ...att, status: "ready" } : att)),
      );
    } finally {
      setSending(false);
    }
  }

  async function interrupt() {
    if (!sid) return;
    try {
      await api(`/api/sessions/${sid}/interrupt`, { method: "POST" });
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PausedBanner session={session} onRefresh={onRefresh} />
      <ChatStream
        sid={sid}
        messages={messages}
        busy={busy}
        loading={loading}
        onLoadOlderMessages={onLoadOlderMessages}
      />

      <PromptPanel prompt={prompt} sid={sid} onError={onError} />
      <QueuePanel queue={queue} sid={sid} messages={messages} />

      {error ? (
        <div className="border-t border-border/70 px-3 py-1.5 text-xs text-destructive">{error}</div>
      ) : null}

      {canDriveSession(session) ? (
        <form
          onSubmit={sendMessage}
          onDragEnter={(event) => {
            if (Array.from(event.dataTransfer.types).includes("Files")) setDraggingFiles(true);
          }}
          onDragOver={(event) => {
            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDraggingFiles(true);
          }}
          onDragLeave={(event) => {
            const nextTarget = event.relatedTarget;
            if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
              setDraggingFiles(false);
            }
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            setDraggingFiles(false);
            addFiles(event.dataTransfer.files);
          }}
          className={cn(
            // Sit on the same surface as the chat (no card/border seam) and let
            // the transcript melt into the bar via a soft gradient fade so the
            // composer reads as part of the conversation, not a bolted-on panel.
            "relative bg-background px-2 pb-2 pt-1.5 transition-colors",
            "before:pointer-events-none before:absolute before:inset-x-0 before:-top-6 before:h-6 before:bg-gradient-to-t before:from-background before:to-transparent before:content-['']",
            draggingFiles && "bg-primary/8",
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            aria-label="Attach files"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) addFiles(event.target.files);
              event.currentTarget.value = "";
            }}
          />
          {attachments.length ? (
            <div className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className={cn(
                    "group flex h-12 max-w-52 shrink-0 items-center gap-2 rounded-lg border bg-muted/55 pl-1.5 pr-1.5 text-xs",
                    att.status === "failed" ? "border-destructive/40 bg-destructive/10" : "border-border/70",
                  )}
                  title={att.error || att.name}
                >
                  {att.previewUrl ? (
                    <img
                      src={att.previewUrl}
                      alt=""
                      className="size-9 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background/80 text-muted-foreground">
                      <Paperclip className="size-4" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="truncate font-medium text-foreground">{att.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {att.status === "uploading" ? "Uploading..." : att.status === "failed" ? "Failed" : formatBytes(att.size)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                    onClick={() => removeAttachment(att.id)}
                    aria-label={`Remove ${att.name}`}
                    title="Remove"
                    disabled={sending}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-2">
            <Button
              size="icon"
              type="button"
              variant={draggingFiles ? "brand-soft" : "tint"}
              className="size-11 md:size-9"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach files"
              title="Attach files"
              disabled={sending}
            >
              <Paperclip className="size-4" />
            </Button>
            <div className="relative min-w-0 flex-1">
              <Textarea
                data-composer-sid={sid}
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                onPaste={(event) => {
                  const files = event.clipboardData?.files;
                  if (files?.length) {
                    event.preventDefault();
                    addFiles(files);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={attachments.length ? "Add a note" : "Message"}
                disabled={sending}
                rows={1}
                className="min-h-11 max-h-28 min-w-0 resize-none overflow-y-auto rounded-2xl border-border/55 bg-muted/65 px-4 py-3 text-base leading-5 shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:border-foreground/20 focus-visible:bg-muted focus-visible:ring-0 md:min-h-9 md:rounded-[1.125rem] md:px-3.5 md:py-2 md:pr-10 md:text-sm"
              />
              <div className="absolute bottom-0.5 right-1 hidden md:block">
                <MicButton
                  minimal
                  className="size-8"
                  silenceMs={2500}
                  baseText={messageText}
                  onRecordingChange={onDictatingChange}
                  onText={(text, base) =>
                    setMessageText(base.trim() ? `${base.trimEnd()} ${text}` : text)
                  }
                  onInterim={(text, base) =>
                    setMessageText(base.trim() ? `${base.trimEnd()} ${text}` : text)
                  }
                  onAutoSubmit={(text, base) => {
                    const combined = base.trim() ? `${base.trimEnd()} ${text}` : text;
                    void sendMessage(undefined, combined);
                  }}
                />
              </div>
            </div>
            {busy && canDriveSession(session) ? (
              <Button
                size="icon"
                type="button"
                variant="tint"
                className="size-11 md:size-9"
                onClick={() => void interrupt()}
                aria-label="Stop (Esc or Ctrl/Cmd+.)"
                title="Stop — Esc or Ctrl/Cmd+."
              >
                <Pause className="size-4" />
              </Button>
            ) : null}
            {/* Send doubles as push-to-talk: tap to send, hold to dictate. */}
            <ComposerSendButton
              className="size-11 md:size-9"
              sending={sending}
              canSend={Boolean(messageText.trim() || attachments.length)}
              baseText={messageText}
              onSend={() => void sendMessage()}
              onRecordingChange={onDictatingChange}
              onText={(text, base) =>
                setMessageText(base.trim() ? `${base.trimEnd()} ${text}` : text)
              }
              onInterim={(text, base) =>
                setMessageText(base.trim() ? `${base.trimEnd()} ${text}` : text)
              }
              onAutoSubmit={(text, base) => {
                const combined = base.trim() ? `${base.trimEnd()} ${text}` : text;
                void sendMessage(undefined, combined);
              }}
            />
          </div>
        </form>
      ) : null}
    </div>
  );
}

// ── long-press session-title sheet ─────────────────────────────────────────
// A full-height modal that morphs out of the session title you long-pressed.
// The morph is a FLIP: the panel renders at full size, then we play it from a
// transform that maps full-screen → the title's on-screen rect back to
// identity, so it visually grows out of the title (and shrinks back into it on
// close). The body content cross-fades in once the panel has mostly expanded so
// the squished mid-morph layout is never seen.
const SHEET_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const SHEET_MS = 420;

// The session title in the details sheet header, pinned to a single line. If
// the title is too wide to fit and the sheet has stayed open for 10s, a gentle
// ping-pong marquee scrolls the full title into view (and back) so it can be
// read without wrapping the header onto a second line.
function SessionTitleLine({ title }: { title: string }) {
  const lineRef = useRef<HTMLDivElement>(null);
  // px the text overflows its line; >0 turns the marquee on.
  const [shift, setShift] = useState(0);

  useLayoutEffect(() => {
    setShift(0);
    const id = setTimeout(() => {
      const el = lineRef.current;
      if (!el) return;
      const over = el.scrollWidth - el.clientWidth;
      if (over > 4) setShift(over);
    }, 10_000);
    return () => clearTimeout(id);
  }, [title]);

  const marquee = shift > 0;
  // Roughly constant scroll speed, with a floor so short overflows still ease.
  const duration = Math.max(2600, Math.round(shift * 28) + 1600);

  return (
    <div className="min-w-0 flex-1 overflow-hidden">
      <div
        ref={lineRef}
        className={cn(
          "text-[17px] font-semibold leading-tight whitespace-nowrap",
          marquee ? "lfg-marquee inline-block" : "overflow-hidden text-ellipsis",
        )}
        style={
          marquee
            ? ({
                "--lfg-marquee-shift": `-${shift}px`,
                animationDuration: `${duration}ms`,
              } as React.CSSProperties)
            : undefined
        }
      >
        {title}
      </div>
    </div>
  );
}

function SessionTitleSheet({
  sid,
  session,
  order,
  messagesBySid,
  busyBySid,
  loadingBySid,
  promptsBySid,
  queuesBySid,
  onLoadOlderMessages,
  origin,
  onSwitch,
  onOptimisticMessage,
  onRefresh,
  onClose,
}: {
  // The active session id. The sheet is a top-level modal (lifted out of any one
  // SessionCard) so it can swap which session it shows while staying mounted —
  // the morph-in/out animation always references the original `origin` rect.
  sid: string;
  session: Session;
  // Sid navigation order, matching the on-screen card order (working then idle).
  order: string[];
  messagesBySid: Record<string, Message[]>;
  busyBySid: Record<string, boolean>;
  loadingBySid: Record<string, boolean>;
  promptsBySid: Record<string, SessionPrompt | null>;
  queuesBySid: Record<string, QueueMsg[]>;
  onLoadOlderMessages: LoadOlderMessages;
  origin: DOMRect;
  onSwitch: (sid: string) => void;
  onOptimisticMessage: (sid: string, text: string) => void;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const switchDirRef = useRef<1 | -1 | null>(null);

  // Per-session live data, selected for whichever session is active right now.
  const messages = messagesBySid[sid] ?? EMPTY_MESSAGES;
  const busy = !!busyBySid[sid];
  const loading = !!loadingBySid[sid];
  const prompt = promptsBySid[sid] ?? null;
  const queue = queuesBySid[sid] ?? EMPTY_QUEUE;

  // Prev/next neighbours in display order (null at the ends — no wrap-around).
  const idx = order.indexOf(sid);
  const prevSid = idx > 0 ? order[idx - 1] : null;
  const nextSid = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
  const go = useCallback(
    (target: string | null) => {
      if (!target || closingRef.current) return;
      const targetIdx = order.indexOf(target);
      const dir: 1 | -1 = targetIdx > idx ? 1 : -1;
      switchDirRef.current = dir;
      haptic("selection");
      const body = bodyRef.current;
      if (body) {
        body.getAnimations().forEach((animation) => animation.cancel());
        body.style.transition = "";
        body.style.transform = "";
        body.style.opacity = "";
      }
      onSwitch(target);
    },
    [idx, onSwitch, order],
  );

  // A stale composer error from the previous session shouldn't bleed across.
  useLayoutEffect(() => setError(null), [sid]);

  // The full-height sheet is a pure consumer of `messages`/`loading`, which only
  // populate while a sid is in the live SSE stream (driven by collapse state).
  // Force each session we view into the stream so its transcript loads, then
  // restore every touched sid's real collapse state when the sheet closes.
  const touchedRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    if (!touchedRef.current.has(sid)) touchedRef.current.set(sid, isCollapsedSid(sid));
    markExpandedSid(sid);
  }, [sid]);
  useEffect(
    () => () => {
      for (const [s, wasCollapsed] of touchedRef.current) {
        try {
          localStorage.setItem(`lfg-collapsed:${s}`, wasCollapsed ? "1" : "0");
        } catch {
          /* private mode / quota — non-fatal */
        }
      }
      window.dispatchEvent(new Event("lfg-collapse-change"));
    },
    [],
  );

  // Slide the newly selected session in from the side its card/page would occupy.
  // The entrance morph below handles the very first mount, so skip this once.
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    const body = bodyRef.current;
    if (!body) return;
    const dir = switchDirRef.current;
    switchDirRef.current = null;
    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!dir || reduceMotion) return;
    const inbound = dir === 1 ? 18 : -18;
    // Clear any inline transform/transition left by an in-progress swipe so the
    // transcript layout starts from a clean slate.
    body.getAnimations().forEach((animation) => animation.cancel());
    body.style.transition = "";
    body.style.transform = "";
    body.animate(
      [
        { opacity: 0, transform: `translateX(${inbound}px)` },
        { opacity: 1, transform: "translateX(0px)" },
      ],
      { duration: 150, easing: "ease-out" },
    );
  }, [sid]);

  // Swipe the composer (input bar) left/right to switch sessions. Horizontal
  // drags that *begin* on the composer form drag the whole transcript with the
  // finger; releasing past the threshold commits to prev/next (rubber-banding at
  // the ends). Vertical intent is released back to the scroller untouched, and we
  // only preventDefault once a horizontal swipe is committed — so tapping into the
  // textarea, scrolling, and caret placement all behave normally. Native
  // non-passive listeners (React's are passive) so preventDefault actually holds.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const SWIPE_COMMIT = 60; // px of travel needed to flip sessions
    const st = { active: false, decided: false, horizontal: false, x0: 0, y0: 0, dx: 0 };
    const setTx = (px: number) => {
      body.style.transition = "none";
      body.style.transform = px ? `translateX(${px}px)` : "";
    };
    const release = (animate: boolean) => {
      if (animate) {
        body.style.transition = "transform 180ms cubic-bezier(0.22,1,0.36,1)";
        body.style.transform = "";
      } else {
        setTx(0);
      }
    };
    const onStart = (e: TouchEvent) => {
      if (closingRef.current || e.touches.length !== 1) return;
      const target = e.target as HTMLElement | null;
      if (!target?.closest("form")) return; // only swipes that start on the input bar
      if (composerIsEditing(target)) return;
      const t = e.touches[0];
      st.active = true;
      st.decided = false;
      st.horizontal = false;
      st.x0 = t.clientX;
      st.y0 = t.clientY;
      st.dx = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!st.active) return;
      const t = e.touches[0];
      const dx = t.clientX - st.x0;
      const dy = t.clientY - st.y0;
      if (!st.decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        st.decided = true;
        st.horizontal = Math.abs(dx) > Math.abs(dy);
        if (!st.horizontal) {
          st.active = false; // vertical → let the textarea / scroller have it
          return;
        }
      }
      if (!st.horizontal) return;
      e.preventDefault(); // suppress browser scroll + textarea caret scrub
      st.dx = dx;
      // Resist when there's nowhere to go in that direction.
      const blocked = dx > 0 ? !prevSid : !nextSid;
      setTx(dx * (blocked ? 0.18 : 0.5));
    };
    const onEnd = () => {
      if (!st.active) return;
      const { horizontal, dx } = st;
      st.active = false;
      if (!horizontal) return;
      const target = dx > SWIPE_COMMIT ? prevSid : dx < -SWIPE_COMMIT ? nextSid : null;
      if (target) {
        // The crossfade effect (on sid change) starts at opacity 0, so it both
        // resets the drag transform and fades the new session in — no spring-back
        // needed, and no transform "snap" is visible.
        go(target);
      } else {
        release(true); // nothing committed → ease back to rest
      }
    };
    body.addEventListener("touchstart", onStart, { passive: true });
    body.addEventListener("touchmove", onMove, { passive: false });
    body.addEventListener("touchend", onEnd, { passive: true });
    body.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      body.removeEventListener("touchstart", onStart);
      body.removeEventListener("touchmove", onMove);
      body.removeEventListener("touchend", onEnd);
      body.removeEventListener("touchcancel", onEnd);
    };
  }, [go, prevSid, nextSid]);

  // The transform that maps the full-screen panel onto the title's rect.
  // transform-origin is the top-left corner, so scale shrinks toward (0,0) and
  // the translate then drops it onto the title.
  const flipTransform = useCallback(() => {
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const sx = Math.max(origin.width / vw, 0.0001);
    const sy = Math.max(origin.height / vh, 0.0001);
    return `translate(${origin.left}px, ${origin.top}px) scale(${sx}, ${sy})`;
  }, [origin]);

  // Enter morph — runs once on mount.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    const body = bodyRef.current;
    if (!panel) return;
    const from = flipTransform();
    panel.animate(
      [
        { transform: from, borderRadius: "16px", opacity: 0.55 },
        { transform: "translate(0px,0px) scale(1,1)", borderRadius: "0px", opacity: 1 },
      ],
      { duration: SHEET_MS, easing: SHEET_EASE, fill: "both" },
    );
    backdrop?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: SHEET_MS,
      easing: SHEET_EASE,
      fill: "both",
    });
    body?.animate(
      [
        { opacity: 0, transform: "translateY(12px)" },
        { opacity: 0, transform: "translateY(12px)", offset: 0.45 },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      { duration: SHEET_MS, easing: "ease-out", fill: "both" },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    haptic("selection");
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    const body = bodyRef.current;
    const to = flipTransform();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      onClose();
    };
    if (panel) {
      const anim = panel.animate(
        [
          { transform: "translate(0px,0px) scale(1,1)", borderRadius: "0px", opacity: 1 },
          { transform: to, borderRadius: "16px", opacity: 0.55 },
        ],
        { duration: SHEET_MS * 0.85, easing: SHEET_EASE, fill: "both" },
      );
      anim.onfinish = finish;
      anim.oncancel = finish;
    } else {
      finish();
    }
    backdrop?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: SHEET_MS * 0.85,
      easing: SHEET_EASE,
      fill: "both",
    });
    body?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: SHEET_MS * 0.4,
      easing: "ease-in",
      fill: "both",
    });
  }, [flipTransform, onClose]);

  // Full-details-only gesture: swipe up from the session composer to dismiss
  // the zoomed-in sheet. This deliberately starts only from the input bar area,
  // leaving transcript scroll and header touches alone.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const DISMISS_Y = 88;
    const VELOCITY = 0.45; // px/ms
    const st = { active: false, decided: false, dismissing: false, x0: 0, y0: 0, y: 0, t0: 0 };
    const setY = (y: number, animate = false) => {
      panel.style.transition = animate
        ? "transform 180ms cubic-bezier(0.22,1,0.36,1), opacity 180ms ease"
        : "none";
      panel.style.transform = y ? `translate3d(0, ${y}px, 0)` : "";
      panel.style.opacity = y ? `${1 - Math.min(0.16, Math.abs(y) / 1200)}` : "";
    };
    const finishDismiss = () => {
      if (closingRef.current) return;
      closingRef.current = true;
      haptic("selection");
      const backdrop = backdropRef.current;
      const body = bodyRef.current;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        onClose();
      };
      panel.getAnimations().forEach((animation) => animation.cancel());
      panel.style.transition =
        "transform 300ms cubic-bezier(0.32,0.72,0,1), opacity 220ms ease-out";
      panel.style.transform = "translate3d(0, -105%, 0)";
      panel.style.opacity = "0.92";
      const onTransitionEnd = (event: TransitionEvent) => {
        if (event.propertyName !== "transform") return;
        panel.removeEventListener("transitionend", onTransitionEnd);
        finish();
      };
      panel.addEventListener("transitionend", onTransitionEnd);
      window.setTimeout(finish, 340);
      if (backdrop) {
        backdrop.style.transition = "opacity 240ms ease-out";
        backdrop.style.opacity = "0";
      }
      if (body) {
        body.style.transition = "transform 260ms cubic-bezier(0.32,0.72,0,1), opacity 180ms ease-out";
        body.style.transform = "translate3d(0, -18px, 0)";
        body.style.opacity = "0";
      }
    };
    const onStart = (event: TouchEvent) => {
      if (closingRef.current || event.touches.length !== 1) return;
      const target = event.target as HTMLElement | null;
      if (!target?.closest("form")) return;
      const touch = event.touches[0];
      st.active = true;
      st.decided = false;
      st.dismissing = false;
      st.x0 = touch.clientX;
      st.y0 = touch.clientY;
      st.y = 0;
      st.t0 = performance.now();
      panel.getAnimations().forEach((animation) => {
        if (animation.playState !== "finished") animation.cancel();
      });
      setY(0);
    };
    const onMove = (event: TouchEvent) => {
      if (!st.active) return;
      const touch = event.touches[0];
      const dx = touch.clientX - st.x0;
      const dy = touch.clientY - st.y0;
      if (!st.decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        st.decided = true;
        st.dismissing = dy < 0 && Math.abs(dy) > Math.abs(dx) * 1.2;
        if (!st.dismissing) {
          st.active = false;
          return;
        }
      }
      if (!st.dismissing) return;
      event.preventDefault();
      st.y = -Math.min(Math.abs(dy), window.innerHeight * 0.6);
      setY(st.y);
      const backdrop = backdropRef.current;
      if (backdrop) backdrop.style.opacity = `${1 - Math.min(0.35, Math.abs(st.y) / 520)}`;
    };
    const onEnd = () => {
      if (!st.active) return;
      st.active = false;
      const dt = Math.max(1, performance.now() - st.t0);
      const velocity = st.y / dt;
      if (st.dismissing && (st.y <= -DISMISS_Y || velocity <= -VELOCITY)) {
        finishDismiss();
        return;
      }
      setY(0, true);
      const backdrop = backdropRef.current;
      if (backdrop) {
        backdrop.style.transition = "opacity 180ms ease";
        backdrop.style.opacity = "";
        window.setTimeout(() => {
          backdrop.style.transition = "";
        }, 200);
      }
      window.setTimeout(() => {
        panel.style.transition = "";
        panel.style.transform = "";
        panel.style.opacity = "";
      }, 200);
    };
    panel.addEventListener("touchstart", onStart, { passive: true });
    panel.addEventListener("touchmove", onMove, { passive: false });
    panel.addEventListener("touchend", onEnd, { passive: true });
    panel.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      panel.removeEventListener("touchstart", onStart);
      panel.removeEventListener("touchmove", onMove);
      panel.removeEventListener("touchend", onEnd);
      panel.removeEventListener("touchcancel", onEnd);
    };
  }, [onClose]);

  // Escape-to-close, arrow-keys-to-switch + lock background scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        requestClose();
        return;
      }
      // Don't hijack arrows while the user is typing in the composer.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        go(prevSid);
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        go(nextSid);
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [requestClose, go, prevSid, nextSid]);

  const title = titleForSession(session);

  return createPortal(
    <div className="fixed inset-0 z-[90]">
      <button
        type="button"
        ref={backdropRef}
        onClick={requestClose}
        className="absolute inset-0 bg-black/50"
        aria-label="Close session details"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ transformOrigin: "top left" }}
        className="absolute inset-0 flex flex-col overflow-hidden bg-background text-foreground"
      >
        <div
          className="flex items-center gap-2 border-b border-border px-4 pb-3"
          style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.75rem)" }}
        >
          <img
            src={agentIconSrc(session.agent)}
            alt={agentIconAlt(session.agent)}
            className="size-7 shrink-0 rounded-lg"
          />
          <SessionTitleLine title={title} />
          {order.length > 1 ? (
            // Switching is gesture-driven (swipe the input bar) + arrow keys, so
            // the header just shows position — no chevron buttons.
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {idx + 1}/{order.length}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            onClick={requestClose}
            className="shrink-0"
          >
            <X />
          </Button>
        </div>
        <div
          ref={bodyRef}
          className="flex min-h-0 flex-1 flex-col"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          <SessionChat
            session={session}
            messages={messages}
            busy={busy}
            loading={loading}
            prompt={prompt}
            queue={queue}
            onLoadOlderMessages={onLoadOlderMessages}
            error={error}
            onError={setError}
            onOptimisticMessage={onOptimisticMessage}
            onRefresh={onRefresh}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function defaultForkAgent(sourceAgent?: string | null): AgentKind {
  const saved = localStorage.getItem("lfg_fork_agent") as AgentKind | null;
  if (saved && STATIC_MODEL_CATALOGS[saved]) return saved;
  return sourceAgent === "codex-aisdk" ? "aisdk" : "codex-aisdk";
}

function ForkSessionDialog({
  session,
  onClose,
  onCreated,
}: {
  session: Session;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const catalogs = useModelCatalogs();
  const initialModelRef = useRef<{ agent: AgentKind; savedModel: string | null } | null>(null);
  if (!initialModelRef.current) {
    const initialAgent = defaultForkAgent(session.agent);
    initialModelRef.current = {
      agent: initialAgent,
      savedModel: localStorage.getItem(`lfg_fork_model_${initialAgent}`),
    };
  }
  const modelOriginRef = useRef<ModelSelectionOrigin>(
    initialModelRef.current.savedModel ? "explicit" : "default",
  );
  const [agent, setAgent] = useState<AgentKind>(() => initialModelRef.current!.agent);
  const [model, setModel] = useState(
    () =>
      initialModelRef.current!.savedModel ||
      defaultModelForAgent(STATIC_MODEL_CATALOGS, initialModelRef.current!.agent),
  );
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() => savedThinkingLevel());
  const [prompt, setPrompt] = useState("");
  const sid = session.sessionId;
  const models = modelsForAgent(catalogs, agent);
  const defaultModel = defaultModelForAgent(catalogs, agent);

  useEffect(() => {
    syncModelWithCatalog({
      defaultModel,
      model,
      models,
      originRef: modelOriginRef,
      setModel,
    });
  }, [defaultModel, models, model]);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!sid) return;
    localStorage.setItem("lfg_fork_agent", agent);
    localStorage.setItem(`lfg_fork_model_${agent}`, model);
    if (agentSupportsThinking(agent)) localStorage.setItem("lfg_thinking_level", thinkingLevel);
    onClose();
    toast.promise(
      api(`/api/sessions/${sid}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim() || undefined,
          user: session.assignedUser || undefined,
          agent,
          model,
          thinkingLevel: agentSupportsThinking(agent) ? thinkingLevel : undefined,
        }),
      }).then(() => onCreated()),
      {
        loading: "Forking session...",
        success: "Session forked",
        error: (err) => (err instanceof Error ? err.message : "Couldn't open session"),
      },
    );
  }

  return (
    <BottomSheet onClose={onClose} title="Fork session">
      <form onSubmit={submit} className="px-4 pb-5 pt-3">
        <div className="mb-3 flex items-center gap-2">
          <GitFork className="size-4 text-muted-foreground" />
          <div className="min-w-0">
            <div className="text-[15px] font-semibold">Fork session</div>
            <div className="truncate text-xs text-muted-foreground">
              {titleForSession(session)}
            </div>
          </div>
        </div>

        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Extra prompt for the new agent..."
          rows={5}
          className="min-h-32 resize-none rounded-xl"
        />

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <div className="inline-flex h-8 items-center rounded-full bg-muted p-0.5 text-xs font-semibold">
            {AGENT_OPTIONS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                title={label}
                aria-label={label}
                onClick={() => {
                  const savedModel = localStorage.getItem(`lfg_fork_model_${key}`);
                  modelOriginRef.current = savedModel ? "explicit" : "default";
                  setAgent(key);
                  setModel(savedModel || defaultModelForAgent(catalogs, key));
                }}
                className={cn(
                  "flex h-7 w-9 items-center justify-center rounded-full transition",
                  agent === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
                )}
              >
                <img src={agentIconSrc(key)} alt="" className="size-5" />
              </button>
            ))}
          </div>

          <FieldPill>
            <select
              value={model}
              onChange={(e) => {
                modelOriginRef.current = "explicit";
                setModel(e.target.value);
              }}
              aria-label="Model"
              className="max-w-36 appearance-none truncate bg-transparent pr-1 text-xs font-medium outline-none"
            >
              {models.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </FieldPill>

          {agentSupportsThinking(agent) ? (
            <FieldPill>
              <select
                value={thinkingLevel}
                onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel)}
                aria-label="Thinking level"
                className="max-w-24 appearance-none truncate bg-transparent pr-1 text-xs font-medium outline-none"
              >
                {THINKING_LEVELS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </FieldPill>
          ) : null}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="brand" disabled={!sid}>
            <GitFork className="size-4" />
            Open
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}

// memo'd: an SSE event for one session replaces the messagesBySid/etc. Record
// reference, re-rendering LiveView's map. Without memo every card re-renders;
// with it, only the card whose own message/busy/queue reference changed does —
// so swipe + collapse animations aren't fighting full-list re-renders.
const SessionCard = memo(function SessionCard({
  session,
  users,
  messages,
  busy,
  loading,
  prompt,
  queue,
  onLoadOlderMessages,
  onOptimisticMessage,
  onRefresh,
  onRemove,
  onOpenSheet,
  variant = "grid",
  onClose,
  entering = false,
}: {
  session: Session;
  users: User[];
  messages: Message[];
  busy: boolean;
  loading: boolean;
  prompt: SessionPrompt | null;
  queue: QueueMsg[];
  onLoadOlderMessages: LoadOlderMessages;
  onOptimisticMessage: (sid: string, text: string) => void;
  onRefresh: () => Promise<void>;
  onRemove: (sid: string) => void;
  // Long-pressing the title asks the parent to open the full-height detail sheet
  // for this sid, anchored to the title's rect. The sheet lives at the parent so
  // it can switch between sessions; undefined → the gesture is disabled.
  onOpenSheet?: (sid: string, origin: DOMRect) => void;
  // "stage" = fill the column height and show a close affordance that removes
  // the column (without ending the session). Default "grid" keeps the classic
  // fixed-height card + mobile gestures.
  variant?: "grid" | "stage";
  onClose?: () => void;
  // True only on the first render after this session was created in-tab — plays
  // the one-shot entrance animation on the card root.
  entering?: boolean;
}) {
  const catalogs = useModelCatalogs();
  const [error, setError] = useState<string | null>(null);
  const [forkOpen, setForkOpen] = useState(false);
  const [summarizing, setSummarizing] = useState(false);

  const sid = session.sessionId;

  async function assign(user: string) {
    if (!sid) return;
    await api(`/api/sessions/${sid}/user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: user || null }),
    });
    await onRefresh();
  }

  async function interrupt() {
    if (!sid) return;
    await api(`/api/sessions/${sid}/interrupt`, { method: "POST" });
    await onRefresh();
  }

  async function changeModel(model: string) {
    if (!sid || !model || model === session.model) return;
    setError(null);
    try {
      await api(`/api/sessions/${sid}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function close() {
    if (!sid || !confirm(`End ${titleForSession(session)}?`)) return;
    onRemove(sid); // drop the card now; the tombstone survives the next poll
    try {
      await api(`/api/sessions/${sid}/close`, { method: "POST" });
    } finally {
      await onRefresh();
    }
  }

  async function speakSummary() {
    if (!sid || summarizing) return;
    setSummarizing(true);
    setError(null);
    haptic("selection");
    try {
      stopSpeaking();
      const res = await fetch(appPath(`/api/sessions/${encodeURIComponent(sid)}/summary/stream`), {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `summary failed (${res.status})`);
      }
      if (!res.body) throw new Error("No summary stream returned");

      toast.message("Speaking session summary");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let full = "";
      let spoken = false;
      let speech = Promise.resolve();
      const title = titleForSession(session);

      const enqueue = (text: string) => {
        const t = text.replace(/\s+/g, " ").trim();
        if (!t) return;
        spoken = true;
        speech = speech.then(() => speakText(t, { sessionId: sid, title }));
      };
      const drainSentences = (force = false) => {
        for (;;) {
          const m = pending.match(/^([\s\S]*?[.!?])(?:\s+|$)/);
          if (!m) break;
          enqueue(m[1]);
          pending = pending.slice(m[0].length);
        }
        if (pending.length > 220) {
          const cut = Math.max(
            pending.lastIndexOf(",", 220),
            pending.lastIndexOf(";", 220),
            pending.lastIndexOf(" ", 220),
          );
          if (cut > 80) {
            enqueue(pending.slice(0, cut));
            pending = pending.slice(cut + 1);
          }
        }
        if (force && pending.trim()) {
          enqueue(pending);
          pending = "";
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;
        full += chunk;
        pending += chunk;
        drainSentences();
      }
      pending += decoder.decode();
      drainSentences(true);
      if (!spoken || !full.trim()) throw new Error("No summary returned");
      await speech;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Could not summarize session", { description: msg });
    } finally {
      setSummarizing(false);
    }
  }

  // ── mobile gestures: tap-header-to-collapse + iOS swipe-to-delete ─────────
  const isMobile = useIsMobile();
  // Fall back to the list payload's last message when we aren't streaming this
  // card (collapsed) so the collapsed preview line still shows something.
  const latest = latestLine(messages) || normText(session.last?.text ?? "");
  const sectionRef = useRef<HTMLElement>(null);
  // True while voice dictation is recording in this card's composer — glows the
  // card border so it's clear which session is listening.
  const [dictating, setDictating] = useState(false);
  const headRef = useRef<HTMLDivElement>(null);
  // Collapsed state persists per session so a card stays the way you left it
  // across reloads / re-renders (localStorage, keyed by sid).
  const collapseKey = sid ? `lfg-collapsed:${sid}` : null;
  const [collapsed, setCollapsed] = useState<boolean>(() => (sid ? isCollapsedSid(sid) : false));
  const [headH, setHeadH] = useState(44);
  const [swipeOpen, setSwipeOpen] = useState(false);
  // True only while a horizontal swipe is in progress. The red delete action is
  // kept out of the paint tree unless this or swipeOpen is set — otherwise it
  // sits behind every card and bleeds at the edges during fast momentum scroll.
  const [swiping, setSwiping] = useState(false);
  // Mutable drag bookkeeping — kept in a ref so touchmove never re-renders.
  const drag = useRef({
    startX: 0, startY: 0, x: 0, w: 0,
    dragging: false, decided: false, horizontal: false, justSwiped: false,
  });
  const openRef = useRef(false);
  const OPEN = 116;    // resting reveal width once snapped open — wide enough to
                       // leave a left gap before the icon + "Delete" label
  const COMMIT = 0.55; // drag past this fraction of the card → delete on release

  // Measure the header so a collapsed card animates down to exactly its height.
  useEffect(() => {
    const el = headRef.current;
    if (!el) return;
    const measure = () => setHeadH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Remember collapse state per session across reloads.
  useEffect(() => {
    if (!collapseKey) return;
    try {
      localStorage.setItem(collapseKey, collapsed ? "1" : "0");
    } catch {
      /* private mode / quota — non-fatal */
    }
    // Notify the app-level stream manager so it opens/closes this session's
    // transcript stream as the card expands/collapses (lazy streaming).
    window.dispatchEvent(new Event("lfg-collapse-change"));
  }, [collapseKey, collapsed]);

  // Auto-expand a card the moment its session stops working (busy true → false),
  // so a finished turn surfaces itself. Pairs with the auto-collapse on send
  // below: collapse while it churns, pop back open when it's done.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) setCollapsed(false);
    wasBusy.current = busy;
  }, [busy]);

  const setTransform = (pxX: number, pxY: number) => {
    const el = sectionRef.current;
    if (!el) return;
    const tx = pxX ? `translateX(${pxX}px)` : "";
    const ty = pxY ? `translateY(${pxY}px)` : "";
    el.style.transform = [tx, ty].filter(Boolean).join(" ") || "";
  };

  async function deleteSession() {
    if (!sid) return;
    onRemove(sid); // drop the card now; the tombstone survives the next poll
    try {
      await api(`/api/sessions/${sid}/close`, { method: "POST" });
    } finally {
      await onRefresh();
    }
  }

  function commitDelete() {
    const el = sectionRef.current;
    haptic("warning");
    setSwipeOpen(false);
    openRef.current = false;
    if (el) {
      el.style.transition = "transform 0.26s var(--ease-ios), opacity 0.26s";
      el.style.transform = `translateX(-${el.offsetWidth}px)`;
      el.style.opacity = "0";
    }
    window.setTimeout(() => void deleteSession(), 280);
  }

  function closeSwipe() {
    const el = sectionRef.current;
    if (el) el.style.transition = "";
    setSwipeOpen(false);
    openRef.current = false;
    setTransform(0, 0);
  }

const onTouchStart = (e: ReactTouchEvent) => {
    if (!isMobile || e.touches.length !== 1) return;
    if ((e.target as HTMLElement).closest("form")) return; // don't hijack the composer
    const el = sectionRef.current;
    if (!el) return;
    const t = e.touches[0];
    const d = drag.current;
    d.startX = t.clientX; d.startY = t.clientY; d.w = el.offsetWidth;
    d.dragging = true; d.decided = false; d.horizontal = false; d.justSwiped = false;
    el.style.transition = "none";
  };

  const onTouchMove = (e: ReactTouchEvent) => {
    const d = drag.current;
    if (!d.dragging) return;
    const t = e.touches[0];
    const mx = t.clientX - d.startX;
    const my = t.clientY - d.startY;
    if (!d.decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      d.decided = true;
      d.horizontal = Math.abs(mx) > Math.abs(my);
      if (d.horizontal) {
        setSwiping(true); // horizontal swipe → reveal the delete action behind it
      } else {
        d.dragging = false; // vertical intent → let the transcript/page scroll
        return;
      }
    }
    if (d.horizontal) {
      let nx = (openRef.current ? -OPEN : 0) + mx;
      if (nx > 0) nx *= 0.3;        // rubber-band past the closed edge
      if (nx < -d.w) nx = -d.w;
      d.x = nx;
      setTransform(nx, 0);
      return;
    }
  };

  const onTouchEnd = () => {
    const d = drag.current;
    if (!d.dragging) return;
    d.dragging = false;
    const el = sectionRef.current;
    if (el) el.style.transition = "";
    if (!d.decided) {
      setSwiping(false);
      return;
    }
    if (d.horizontal) {
      setSwiping(false);
      d.justSwiped = Math.abs(d.x) > 6;
      if (d.x <= -d.w * COMMIT) {
        commitDelete();
        return;
      }
      const willOpen = d.x <= -OPEN * 0.5;
      if (willOpen && !openRef.current) haptic("selection");
      openRef.current = willOpen;
      setSwipeOpen(willOpen);
      setTransform(willOpen ? -OPEN : 0, 0);
      return;
    }
  };

  // ── long-press the title → morphing full-height sheet ──────────────────────
  // The sheet itself lives at the parent (so it can switch between sessions and
  // force whichever sid it shows into the live stream); the card just reports the
  // long-press and the title's rect to anchor the morph.
  const LONG_PRESS_MS = 420;
  const pressTimer = useRef<number | null>(null);
  const pressOrigin = useRef({ x: 0, y: 0 });
  const longPressFired = useRef(false);

  const clearLongPress = () => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const onTitlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!isMobile || !onOpenSheet || !sid) return;
    longPressFired.current = false;
    pressOrigin.current = { x: e.clientX, y: e.clientY };
    const el = e.currentTarget;
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      if (openRef.current) return; // mid swipe-to-delete — ignore
      longPressFired.current = true;
      haptic("selection");
      onOpenSheet(sid, el.getBoundingClientRect());
    }, LONG_PRESS_MS);
  };

  const onTitlePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (pressTimer.current === null) return;
    const dx = Math.abs(e.clientX - pressOrigin.current.x);
    const dy = Math.abs(e.clientY - pressOrigin.current.y);
    if (dx > 10 || dy > 10) clearLongPress(); // moved → it's a scroll/swipe
  };

  const onHeaderTap = () => {
    if (!isMobile) return;
    if (longPressFired.current) { longPressFired.current = false; return; }
    if (drag.current.justSwiped) { drag.current.justSwiped = false; return; }
    if (openRef.current) { closeSwipe(); return; }
    haptic("selection");
    setCollapsed((v) => !v);
  };

  // A collapsed mobile card is stripped to the essentials (no model chip, no
  // actions menu, transcript unmounted) — both to keep it light and to make the
  // collapse tween cheap (nothing heavy to lay out per frame).
  const collapsedView = isMobile && collapsed;

  return (
    <div className={cn("relative min-w-0 md:static", variant === "stage" && "md:h-full")}>
      {forkOpen ? (
        <ForkSessionDialog
          session={session}
          onClose={() => setForkOpen(false)}
          onCreated={onRefresh}
        />
      ) : null}
      {/* swipe-to-delete action revealed behind the card (mobile only) */}
      <button
        type="button"
        aria-label="Delete session"
        tabIndex={swipeOpen ? 0 : -1}
        onClick={commitDelete}
        className={cn(
          "absolute inset-0 flex items-center justify-end gap-2 rounded-xl bg-destructive pr-6 text-sm font-semibold text-white md:hidden",
          swipeOpen || swiping ? "" : "hidden", // out of the paint tree unless mid-swipe
          swipeOpen ? "" : "pointer-events-none",
        )}
      >
        <Trash2 className="size-5" />
        Delete
      </button>
      <section
        ref={sectionRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={isMobile && collapsed ? { height: headH } : undefined}
        className={cn(
          "live-pane relative z-[1] flex h-[22rem] touch-pan-y flex-col overflow-hidden rounded-xl border bg-card text-card-foreground transition-[height,transform,border-color,box-shadow] duration-300 ease-ios md:static md:transition-[border-color,box-shadow]",
          entering && "lfg-card-in",
          variant === "stage" ? "md:h-full" : "md:h-[clamp(30rem,72vh,46rem)]",
          // Listening: soften the border to primary and throw a faint glow ring.
          dictating
            ? "border-primary/60 shadow-[0_0_0_1px_var(--primary),0_0_16px_2px_color-mix(in_srgb,var(--primary)_35%,transparent)]"
            : "border-border",
        )}
      >
        <div
          ref={headRef}
          className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2"
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void speakSummary();
            }}
            disabled={!sid || summarizing}
            aria-label={summarizing ? "Preparing session summary" : "Speak session summary"}
            title={summarizing ? "Preparing summary..." : "Speak session summary"}
            className="relative flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted disabled:cursor-wait disabled:opacity-70"
          >
            {busy || summarizing ? (
              <Loader2
                className={cn(
                  "absolute inset-0 m-auto size-6 animate-spin",
                  summarizing ? "text-primary" : "text-warning",
                )}
                strokeWidth={1.75}
              />
            ) : null}
            {/* "aisdk" is Claude Code under the hood (driven via the AI SDK), so
                it wears the same Claude mark as a tmux claude session; only the
                new-session picker keeps a distinct label to tell them apart. */}
            <img
              src={agentIconSrc(session.agent)}
              alt={agentIconAlt(session.agent)}
              className={cn(
                "rounded-lg transition-all duration-300 ease-ios",
                busy || summarizing ? "size-4" : "size-6",
              )}
            />
          </button>
          <button
            type="button"
            onClick={onHeaderTap}
            onPointerDown={onTitlePointerDown}
            onPointerMove={onTitlePointerMove}
            onPointerUp={clearLongPress}
            onPointerCancel={clearLongPress}
            onContextMenu={(e) => e.preventDefault()}
            className="flex min-w-0 flex-1 select-none items-center gap-2 text-left outline-none [-webkit-touch-callout:none] md:pointer-events-none"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="truncate text-[15px] font-semibold leading-tight">
                {titleForSession(session)}
              </div>
              {isMobile && collapsed && latest ? (
                <div className="truncate text-[11px] leading-tight text-muted-foreground">
                  {latest}
                </div>
              ) : null}
            </div>
          </button>
        {session.status === "blocked" ? (
          <span
            className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning ring-1 ring-inset ring-warning/30"
            title={session.statusDetail || "Build paused"}
          >
            ⏸ paused
          </span>
        ) : null}
        {!collapsedView && (
          (session.agent === "claude" || session.agent === "opencode" || session.agent === "hermes") &&
          (session.tmuxTarget || session.agent === "opencode") &&
          sid ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted/70"
                  aria-label="Change model"
                />
              }
            >
              {session.model || "model"}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-32">
              <DropdownMenuRadioGroup
                value={session.model ?? ""}
                onValueChange={(value) =>
                  void changeModel(typeof value === "string" ? value : "")
                }
              >
                <DropdownMenuLabel>Model</DropdownMenuLabel>
                {modelsForAgent(catalogs, session.agent as AgentKind).map((item) => (
                  <DropdownMenuRadioItem key={item} value={item}>
                    {item}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : session.model ? (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {session.model}
          </span>
        ) : null)}
        <span
          aria-label={busy ? "working" : "idle"}
          className={cn(
            "size-2 shrink-0 rounded-full",
            // Idle: blend into the card surface (soft, low-contrast). Busy: a
            // pulsing amber that actually draws the eye.
            busy ? "animate-pulse bg-warning" : "bg-success/30 ring-1 ring-inset ring-success/20",
          )}
        />
        {!collapsedView && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
                aria-label="Session menu"
              />
            }
          >
            <MoreVertical className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuRadioGroup
              value={session.assignedUser ?? ""}
              onValueChange={(value) =>
                assign(typeof value === "string" ? value : "").catch((err) => setError(String(err)))
              }
            >
              <DropdownMenuLabel>Assign to</DropdownMenuLabel>
              <DropdownMenuRadioItem value="">Unassigned</DropdownMenuRadioItem>
              {users.map((user) => (
                <DropdownMenuRadioItem key={user.email} value={user.email}>
                  {user.name ?? shortUser(user.email)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!sid} onClick={() => setForkOpen(true)}>
              <GitFork className="size-4" />
              Fork
            </DropdownMenuItem>
            {canDriveSession(session) ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void interrupt()}>
                  <Pause className="size-4" />
                  Stop
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => void close()}>
                  <X className="size-4" />
                  End session
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        )}
        {variant === "stage" && onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close column"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {!collapsedView && (
        <SessionChat
          session={session}
          messages={messages}
          busy={busy}
          loading={loading}
          prompt={prompt}
          queue={queue}
          onLoadOlderMessages={onLoadOlderMessages}
          error={error}
          onError={setError}
          onOptimisticMessage={onOptimisticMessage}
          onRefresh={onRefresh}
          onCollapse={() => setCollapsed(true)}
          onDictatingChange={setDictating}
        />
      )}
      </section>
    </div>
  );
});

function toolName(text?: string) {
  // tool_use text is "Name" or "Name: <input>" — the first token is the tool.
  return (text || "").split(":")[0].trim().split(/\s+/)[0] || "tool";
}

// "2 Bash · 1 Read · 1 result" — aggregate a run of tool calls by name,
// preserving first-seen order, with bare results counted at the end.
function toolGroupLabel(items: Message[]) {
  const counts = new Map<string, number>();
  let results = 0;
  for (const m of items) {
    if (m.kind === "tool_use") {
      const name = toolName(m.text);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    } else {
      results += 1;
    }
  }
  const parts = [...counts].map(([name, count]) => `${count} ${name}`);
  if (results) parts.push(`${results} result${results === 1 ? "" : "s"}`);
  return parts.join(" · ") || `${items.length} step${items.length === 1 ? "" : "s"}`;
}

type RenderItem =
  | { type: "msg"; message: Message; key: string }
  | { type: "tools"; items: Message[]; key: string };

// Coalesce adjacent tool_use/tool_result messages into a single collapsible
// group so a busy session doesn't flood the pane with dozens of fold rows
// (matches the v1 live view). Prose and thinking stay as their own items.
function buildRenderItems(messages: Message[]): RenderItem[] {
  const items: RenderItem[] = [];
  messages.forEach((message, index) => {
    const isTool = message.kind === "tool_use" || message.kind === "tool_result";
    if (isTool) {
      const last = items[items.length - 1];
      if (last && last.type === "tools") {
        last.items.push(message);
        return;
      }
      items.push({ type: "tools", items: [message], key: message.id ?? `tools-${message.ts}-${index}` });
      return;
    }
    items.push({ type: "msg", message, key: message.id ?? `${message.kind}-${message.ts}-${index}` });
  });
  return items;
}

const ChatStream = memo(function ChatStream({
  sid,
  messages,
  busy,
  loading,
  onLoadOlderMessages,
}: {
  sid: string | null;
  messages: Message[];
  busy: boolean;
  loading: boolean;
  onLoadOlderMessages: LoadOlderMessages;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  const preserveScrollRef = useRef<{ height: number; top: number } | null>(null);
  const visibleMessages = useMemo(() => messages.filter((message) => !message.seed), [messages]);
  const items = useMemo(() => buildRenderItems(visibleMessages), [visibleMessages]);

  useEffect(() => {
    setHasOlder(true);
    preserveScrollRef.current = null;
  }, [sid]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !stick) return;
    el.scrollTop = el.scrollHeight;
  }, [visibleMessages, busy, stick]);

  useLayoutEffect(() => {
    const el = ref.current;
    const preserve = preserveScrollRef.current;
    if (!el || !preserve) return;
    preserveScrollRef.current = null;
    el.scrollTop = el.scrollHeight - preserve.height + preserve.top;
  }, [visibleMessages]);

  const maybeLoadOlder = useCallback(async () => {
    const el = ref.current;
    if (!sid || !el || loadingOlder || !hasOlder) return;
    if (el.scrollTop > 80) return;
    preserveScrollRef.current = { height: el.scrollHeight, top: el.scrollTop };
    setStick(false);
    setLoadingOlder(true);
    try {
      const more = await onLoadOlderMessages(sid);
      setHasOlder(more);
    } catch {
      preserveScrollRef.current = null;
    } finally {
      setLoadingOlder(false);
    }
  }, [sid, loadingOlder, hasOlder, onLoadOlderMessages]);

  return (
    <div
      ref={ref}
      onScroll={(event) => {
        const el = event.currentTarget;
        setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 72);
        void maybeLoadOlder();
      }}
      className="chat-stream min-h-0 flex-1 overflow-y-auto bg-background px-3 py-3"
    >
      {visibleMessages.length ? (
        <div className="flex flex-col gap-3">
          {loadingOlder ? (
            <div className="flex justify-center py-1 text-xs text-muted-foreground">
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              Loading older messages
            </div>
          ) : null}
          {items.map((item, index) =>
            item.type === "tools" ? (
              <ToolGroup
                key={item.key}
                items={item.items}
                live={busy && index === items.length - 1}
              />
            ) : (
              <MessageBubble key={item.key} message={item.message} />
            ),
          )}
          {busy && !visibleMessages.some((message) => message.kind === "thinking") ? (
            <div className="busy-line">
              <span className="bt">Working...</span>
            </div>
          ) : null}
        </div>
      ) : loading ? (
        <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          <span>Loading transcript</span>
        </div>
      ) : (
        <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
          <MessageSquare className="size-5" />
          <span>No transcript messages yet</span>
        </div>
      )}
    </div>
  );
});

function ToolGroup({ items, live }: { items: Message[]; live: boolean }) {
  return (
    <details className={cn("tool-fold tool-group", live && "tool-group--live")}>
      <summary>
        <span className="tg-count">{toolGroupLabel(items)}</span>
      </summary>
      <div className="tg-body flex flex-col gap-1">
        {items.map((message, index) => (
          <ToolLine key={message.id ?? `${message.kind}-${message.ts}-${index}`} message={message} />
        ))}
      </div>
    </details>
  );
}

function ToolLine({ message }: { message: Message }) {
  const isUse = message.kind === "tool_use";
  const label = isUse ? toolName(message.text) : "result";
  // Drop the leading "Name:" from the summary so the chip isn't doubled
  // (e.g. "[Bash] Bash: …" → "[Bash] …").
  const summary = isUse
    ? normText(message.text).replace(/^[^\s:]+:?\s*/, "")
    : normText(message.text);
  return (
    <details className="tool-fold">
      <summary>
        <span className={cn("msg-kind", `k-${message.kind}`)}>{label}</span>
        {summary.slice(0, 90)}
      </summary>
      <pre className="tool-body">{(message.text || "").slice(0, 6000)}</pre>
    </details>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.kind === "thinking") {
    return <div className="think-live">{message.text || "thinking..."}</div>;
  }

  const isUser = message.role === "user";
  return (
    <div
      className={cn(
        "msg flex",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      {isUser ? (
        // User turns are plain/escaped and rendered as a content-width bubble
        // hugged to the right. While in flight a sheen sweeps across it (the same
        // shimmer language as the "thinking" line) instead of a static dimming.
        <div
          className={cn(
            "msg-text markdown user-bubble w-fit max-w-[85%] px-3 py-2",
            message.pending && "is-pending",
          )}
          dangerouslySetInnerHTML={{ __html: message.html || escapeHtml(message.text || "") }}
        />
      ) : (
        // Assistant turns render markdown from the raw source via Streamdown,
        // which tolerates half-finished markdown mid-stream (no html injection).
        <Streamdown className="msg-text markdown max-w-[92%]">{message.text || ""}</Streamdown>
      )}
    </div>
  );
}

function PromptPanel({
  prompt,
  sid,
  onError,
}: {
  prompt: SessionPrompt | null;
  sid: string | null;
  onError: (error: string | null) => void;
}) {
  // Selecting an option drives the tmux selector (arrow keys + Enter) and the
  // panel only clears on the next ~1s server poll. Without a lock the stale
  // options stay clickable, so a second click fires another /answer that
  // overshoots the (now different) selector — the "answer bricks" symptom.
  const sig = prompt
    ? `${prompt.question ?? ""}|${prompt.options.map((o) => o.label).join("|")}`
    : "";
  // `pending` holds the in-flight option index, or DISMISS while the skip (X)
  // request is in flight. Real option indices are positive, so -1 is a safe
  // sentinel that never collides with one.
  const DISMISS = -1;
  const [pending, setPending] = useState<number | null>(null);

  // Reset the lock whenever the prompt itself changes (answered → new / gone).
  useLayoutEffect(() => {
    setPending(null);
  }, [sig]);

  // Safety valve: if the prompt didn't clear (answer didn't land), re-enable so
  // the user can retry instead of being stuck on a dead panel.
  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => setPending(null), 4000);
    return () => clearTimeout(timer);
  }, [pending]);

  if (!prompt || !sid) return null;
  const locked = pending !== null;
  return (
    <div className="prompt-panel border-t border-warning/25 bg-warning/12 px-3 py-2">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="text-sm font-medium">{prompt.question ?? "Waiting for a choice"}</div>
        <Button
          type="button"
          variant="tint"
          size="icon-sm"
          className="-mr-1 shrink-0"
          disabled={locked}
          title="Skip this question without answering"
          aria-label="Dismiss question"
          onClick={async () => {
            setPending(DISMISS); // lock the panel while the skip is in flight
            onError(null);
            try {
              await api(`/api/sessions/${sid}/dismiss`, { method: "POST" });
            } catch (e) {
              onError(e instanceof Error ? e.message : String(e));
              setPending(null);
            }
          }}
        >
          {pending === DISMISS ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <X className="size-4" />
          )}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {prompt.options.map((option) => (
          <Button
            key={option.index}
            type="button"
            variant={option.selected || pending === option.index ? "brand" : "secondary"}
            size="sm"
            className="h-auto min-h-8 max-w-full whitespace-normal py-1 text-left"
            disabled={locked}
            onClick={async () => {
              setPending(option.index);
              onError(null);
              try {
                await api(`/api/sessions/${sid}/answer`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ index: option.index }),
                });
              } catch (e) {
                onError(e instanceof Error ? e.message : String(e));
                setPending(null);
              }
            }}
          >
            {pending === option.index ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function QueuePanel({
  queue,
  sid,
  messages,
}: {
  queue: QueueMsg[];
  sid: string | null;
  messages: Message[];
}) {
  // Only surface messages that are genuinely still in transit or have failed.
  // "delivered" and "queued" both mean the agent already accepted the message
  // (it left the input box) — to the user that's "sent", so showing a lingering
  // chip is just noise, and the server's lazy promotion to "delivered" can lag
  // or miss entirely, stranding a "queued" chip forever. Drop both.
  // pending/sending are dropped the moment their text surfaces in the live
  // transcript too, in case the status update is slow to arrive.
  const isInTranscript = useMemo(() => {
    const needles: string[] = [];
    for (const message of messages) {
      if (message.role !== "user" || message.kind !== "text" || message.pending) continue;
      const needle = normText(message.text).slice(0, 48);
      if (needle) needles.push(needle);
    }
    return (text: string) => {
      const needle = normText(text).slice(0, 48);
      if (!needle) return false;
      return needles.some((other) => other.includes(needle) || needle.includes(other));
    };
  }, [messages]);

  const live = queue.filter((item) => {
    if (item.status === "failed") return true;
    if (item.status === "delivered" || item.status === "queued") return false;
    return !isInTranscript(item.text); // pending / sending still in flight
  });
  if (!live.length || !sid) return null;
  const labelFor = (status: QueueMsg["status"]) =>
    status === "sending" ? "sending" : status;
  return (
    <div className="send-queue border-t border-border/70 px-3 py-2">
      <div className="flex flex-col gap-1">
        {live.map((item) => (
          <div
            key={item.id}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs",
              item.status === "failed"
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : item.status === "queued"
                  ? "border-warning/30 bg-warning/12 text-warning"
                  : "border-primary/30 bg-primary/10 text-primary",
            )}
            title={item.error || item.text}
          >
            {item.status === "pending" || item.status === "sending" ? (
              <Loader2 className="size-3 shrink-0 animate-spin" />
            ) : null}
            <span className="shrink-0 font-medium">{labelFor(item.status)}</span>
            <span className="min-w-0 flex-1 truncate text-foreground">{normText(item.text)}</span>
            {item.status === "failed" ? (
              <button
                type="button"
                className="shrink-0 font-semibold"
                onClick={() => {
                  void api(`/api/sessions/${sid}/queue/${item.id}/retry`, { method: "POST" });
                }}
              >
                retry
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentView({
  agent,
  reports,
  report,
  selectedDate,
  runLog,
  onSelectDate,
  onRun,
  onRefreshReport,
}: {
  agent: Agent | null;
  reports: ReportRef[];
  report: AgentReport | null;
  selectedDate: string | null;
  runLog: string | null;
  onSelectDate: (date: string) => void;
  onRun: (agent: string) => void;
  onRefreshReport: () => Promise<void>;
}) {
  if (!agent) {
    return <div className="rounded-xl border border-border bg-card p-6">Agent not found.</div>;
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-2">
      <section className="rounded-xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold leading-tight">{agent.title || agent.name}</div>
            <div className="text-xs text-muted-foreground">
              {agent.inputCount} inputs · last report {agent.lastReport?.date ?? "never"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="brand" size="sm" onClick={() => onRun(agent.name)}>
              <Play className="size-4" />
              Run
            </Button>
          </div>
        </div>
        {runLog ? (
          <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted p-2 text-xs text-muted-foreground">
            {runLog}
          </pre>
        ) : null}
      </section>

      <div className="flex gap-1.5 overflow-x-auto">
        {reports.map((item) => (
          <button
            key={item.date}
            type="button"
            onClick={() => onSelectDate(item.date)}
            className={cn(
              "h-7 shrink-0 rounded-full border px-2.5 text-xs font-semibold",
              selectedDate === item.date
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-muted",
            )}
          >
            {item.date.slice(5)}
          </button>
        ))}
      </div>

      {report ? (
        <>
          <ActionsPanel report={report} agent={agent.name} onRefresh={onRefreshReport} />
          <article className="markdown report-markdown rounded-xl border border-border bg-card p-3">
            <Streamdown>{report.raw}</Streamdown>
          </article>
        </>
      ) : (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
          No report selected.
        </div>
      )}
    </div>
  );
}

function ActionsPanel({
  report,
  agent,
  onRefresh,
}: {
  report: AgentReport;
  agent: string;
  onRefresh: () => Promise<void>;
}) {
  const pending = report.actions.filter((action) => action.status === "pending");
  const [selected, setSelected] = useState<string[]>([]);
  const [busyMode, setBusyMode] = useState<"combined" | "separate" | null>(null);

  useLayoutEffect(() => {
    setSelected([]);
  }, [report.date, agent]);

  if (!report.actions.length) return null;

  async function executeSelected() {
    setBusyMode("separate");
    try {
      await Promise.all(
        selected.map((id) =>
          api("/api/actions/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agent, date: report.date, id }),
          }),
        ),
      );
      await onRefresh();
      setSelected([]);
    } finally {
      setBusyMode(null);
    }
  }

  async function executeCombined() {
    setBusyMode("combined");
    try {
      await api("/api/actions/execute-combined", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, date: report.date, ids: selected }),
      });
      await onRefresh();
      setSelected([]);
    } finally {
      setBusyMode(null);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <div className="text-sm font-semibold leading-tight">Actions</div>
          <div className="text-xs text-muted-foreground">
            {pending.length} ready · {report.actions.length} total
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!pending.length || !!busyMode}
          onClick={() => setSelected(pending.map((action) => action.id))}
        >
          Select ready
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!selected.length || !!busyMode}
          onClick={executeCombined}
          title="Create one new session to resolve the selected actions together"
        >
          {busyMode === "combined" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <GitFork className="size-4" />
          )}
          Group into session
        </Button>
        <Button
          variant="brand"
          size="sm"
          disabled={!selected.length || !!busyMode}
          onClick={executeSelected}
          title="Create one new session per selected action"
        >
          {busyMode === "separate" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          Run separately
        </Button>
      </div>
      {selected.length ? (
        <div className="mb-2 text-xs text-muted-foreground">
          {selected.length} selected · group starts one new resolving session
        </div>
      ) : null}
      <div className="divide-y divide-border rounded-lg border border-border">
        {report.actions.map((action) => {
          const actionable = action.status === "pending";
          const checked = selected.includes(action.id);
          return (
            <label
              key={action.id}
              className={cn(
                "flex items-start gap-2 px-3 py-2 text-sm",
                actionable ? "cursor-pointer" : "opacity-70",
              )}
            >
              <input
                type="checkbox"
                disabled={!actionable}
                checked={checked}
                onChange={(e) =>
                  setSelected((items) =>
                    e.target.checked
                      ? [...items, action.id]
                      : items.filter((item) => item !== action.id),
                  )
                }
              />
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{action.text}</span>
              <Badge
                variant={
                  action.status === "done"
                    ? "default"
                    : action.status === "failed"
                      ? "destructive"
                      : action.status === "running"
                        ? "secondary"
                        : "outline"
                }
              >
                {action.status}
              </Badge>
            </label>
          );
        })}
      </div>
    </section>
  );
}

// A closed/rebooted-away claude session that can be brought back with
// `claude --resume` — mirrors the backend ResumableSession shape.
type ResumableSession = {
  sessionId: string;
  cwd: string | null;
  project: string;
  title: string;
  lastActivityAt: number | null;
  lastUserText: string | null;
  // "claude" (resumes via the claude CLI) or "codex" (resumes via a codex-aisdk
  // harness). Drives the engine label in the resume list.
  agent: "claude" | "codex";
};

function NewSessionDialog({
  open,
  repos,
  users,
  defaultUser,
  scopedProject,
  projectOptions,
  onProjectChange,
  onClose,
  onCreated,
  onReposChanged,
  onProjectSwipe,
  // Presentation shell for the shared composer core:
  //  - "drawer" (default): desktop / call-screen bottom sheet (Vaul), opened by
  //    the orb or the "C" shortcut.
  //  - "inline": mobile home screen — anchored at the bottom of the viewport,
  //    compact at rest and expandable. Always mounted (no open/close).
  variant = "drawer",
  expanded = false,
  onExpandedChange,
  focusNonce = 0,
  codingAgents,
}: {
  open: boolean;
  repos: Repo[];
  users: User[];
  defaultUser: string;
  // The active project filter from the live view. When it's a specific project
  // (not "__all"), creating a session is locked to that project's repo and the
  // repo picker is hidden.
  scopedProject: string;
  // Inline only: render the live project selector as a centered tab overlapping
  // the composer edge. The drawer version keeps project selection in its normal
  // repo controls instead.
  projectOptions?: string[];
  onProjectChange?: (value: string) => void;
  onClose: () => void;
  onCreated: (result?: { launchId?: string; sessionId?: string }) => Promise<void>;
  // Inline only: horizontal swipes cycle the live-view project filter.
  onProjectSwipe?: (dir: 1 | -1) => boolean;
  onReposChanged: () => Promise<void>;
  variant?: "drawer" | "inline";
  // Inline only: compact↔full controls toggle (lifted to the parent so the orb
  // and other affordances can drive it).
  expanded?: boolean;
  onExpandedChange?: (next: boolean) => void;
  // Inline only: bump to focus the textarea (orb double-tap / "new session").
  focusNonce?: number;
  codingAgents?: CodingAgentInfo[];
}) {
  const catalogs = useModelCatalogs();
  const initialModelRef = useRef<{
    agent: AgentKind;
    savedModel: string | null;
  } | null>(null);
  if (!initialModelRef.current) {
    const initialAgent = (localStorage.getItem("lfg_v2_agent") as AgentKind | null) || "aisdk";
    initialModelRef.current = {
      agent: initialAgent,
      savedModel:
        localStorage.getItem(`lfg_model_${initialAgent}`) || localStorage.getItem("lfg_model"),
    };
  }
  const modelOriginRef = useRef<ModelSelectionOrigin>(
    initialModelRef.current.savedModel ? "explicit" : "default",
  );
  const [agent, setAgent] = useState<AgentKind>(
    () => initialModelRef.current!.agent,
  );
  const [repo, setRepo] = useState(() => localStorage.getItem("lfg_v2_repo") || "");
  const [model, setModel] = useState(
    () =>
      initialModelRef.current!.savedModel ||
      defaultModelForAgent(STATIC_MODEL_CATALOGS, initialModelRef.current!.agent),
  );
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    () => savedThinkingLevel(),
  );
  // Default the owner to the active profile, falling back to the first known user
  // — never empty when a roster exists. An unowned session lands unassigned, and
  // the live view's auto-default filter (which flips to a specific user) then
  // hides it, so "I created a session but don't see it". The Owner dropdown still
  // lets you pick Unassigned explicitly.
  const [user, setUser] = useState(
    () => defaultUser || localStorage.getItem("lfg_user") || users[0]?.email || "",
  );
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [usage, setUsage] = useState<string | null>(null);
  const [pendingCreates, setPendingCreates] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewUrls = useRef<string[]>([]);
  // Resumable (closed / rebooted-away) sessions. Fetched lazily when the user
  // expands the section so opening the dialog stays instant; reset on close.
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumable, setResumable] = useState<ResumableSession[] | null>(null);
  // Close the resume sheet and drop the cached list so the next open refetches
  // (and shows the skeleton) instead of flashing a stale roster.
  const closeResume = useCallback(() => {
    setResumeOpen(false);
    setResumable(null);
  }, []);
  // Inline variant: focus the textarea (and pop the soft keyboard) when an
  // external affordance bumps `focusNonce`. The shadcn Textarea isn't a
  // forwardRef, so reach it through the wrapping element.
  const fieldRef = useRef<HTMLDivElement>(null);
  const inlineShellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (variant !== "inline" || !focusNonce) return;
    fieldRef.current?.querySelector("textarea")?.focus();
  }, [focusNonce, variant]);
  useEffect(() => {
    if (variant !== "inline" || !onProjectSwipe) return;
    const shell = inlineShellRef.current;
    if (!shell) return;
    const SWIPE_COMMIT = 64;
    const st = { active: false, decided: false, horizontal: false, x0: 0, y0: 0, dx: 0 };
    const reducedMotion = () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const setTx = (px: number) => {
      shell.style.transition = "none";
      shell.style.transform = px ? `translateX(${px}px)` : "";
      shell.style.opacity = px ? String(Math.max(0.72, 1 - Math.abs(px) / 520)) : "";
    };
    const release = () => {
      shell.style.transition =
        "transform 190ms cubic-bezier(0.22,1,0.36,1), opacity 190ms ease-out";
      shell.style.transform = "";
      shell.style.opacity = "";
    };
    const finish = (dir: 1 | -1) => {
      const changed = onProjectSwipe(dir);
      if (!changed || reducedMotion()) {
        release();
        return;
      }
      const width = Math.max(320, window.innerWidth || shell.clientWidth || 320);
      const out = dir === 1 ? -width : width;
      const inbound = -out;
      shell.style.transition =
        "transform 130ms cubic-bezier(0.32,0.72,0,1), opacity 130ms ease-out";
      shell.style.transform = `translateX(${out}px)`;
      shell.style.opacity = "0.15";
      window.setTimeout(() => {
        shell.style.transition = "none";
        shell.style.transform = `translateX(${inbound}px)`;
        shell.style.opacity = "0.35";
        requestAnimationFrame(() => {
          shell.style.transition =
            "transform 210ms cubic-bezier(0.22,1,0.36,1), opacity 210ms ease-out";
          shell.style.transform = "";
          shell.style.opacity = "";
        });
      }, 130);
    };
    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || pendingCreates > 0) return;
      const target = event.target as HTMLElement | null;
      if (!target?.closest("form")) return;
      if (target.closest("select, button, input[type='file'], [data-no-composer-swipe]")) return;
      if (composerIsEditing(target)) return;
      const touch = event.touches[0];
      st.active = true;
      st.decided = false;
      st.horizontal = false;
      st.x0 = touch.clientX;
      st.y0 = touch.clientY;
      st.dx = 0;
    };
    const onMove = (event: TouchEvent) => {
      if (!st.active) return;
      const touch = event.touches[0];
      const dx = touch.clientX - st.x0;
      const dy = touch.clientY - st.y0;
      if (!st.decided) {
        if (Math.abs(dx) < 9 && Math.abs(dy) < 9) return;
        st.decided = true;
        st.horizontal = Math.abs(dx) > Math.abs(dy) * 1.18;
        if (!st.horizontal) {
          st.active = false;
          return;
        }
      }
      if (!st.horizontal) return;
      event.preventDefault();
      st.dx = dx;
      setTx(dx * 0.48);
    };
    const onEnd = () => {
      if (!st.active) return;
      const { horizontal, dx } = st;
      st.active = false;
      if (!horizontal) return;
      if (dx > SWIPE_COMMIT) {
        haptic("selection");
        finish(-1);
      } else if (dx < -SWIPE_COMMIT) {
        haptic("selection");
        finish(1);
      } else {
        release();
      }
    };
    shell.addEventListener("touchstart", onStart, { passive: true });
    shell.addEventListener("touchmove", onMove, { passive: false });
    shell.addEventListener("touchend", onEnd, { passive: true });
    shell.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      shell.removeEventListener("touchstart", onStart);
      shell.removeEventListener("touchmove", onMove);
      shell.removeEventListener("touchend", onEnd);
      shell.removeEventListener("touchcancel", onEnd);
      shell.style.transition = "";
      shell.style.transform = "";
      shell.style.opacity = "";
    };
  }, [onProjectSwipe, pendingCreates, variant]);
  useEffect(() => {
    return () => {
      for (const url of previewUrls.current) URL.revokeObjectURL(url);
      previewUrls.current = [];
    };
  }, []);
  useLayoutEffect(() => {
    const textarea = fieldRef.current?.querySelector("textarea");
    if (!textarea) return;
    textarea.scrollTop = textarea.scrollHeight;
  }, [prompt]);

  useLayoutEffect(() => {
    if (!open) {
      setResumeOpen(false);
      setResumable(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !resumeOpen || resumable) return;
    api<{ sessions: ResumableSession[] }>("/api/sessions/resumable?limit=20")
      .then((r) => setResumable(r.sessions))
      .catch(() => setResumable([]));
  }, [open, resumeOpen, resumable]);

  function resume(sessionId: string) {
    // Carry the chosen model only when it's a Claude alias (resume drives the
    // claude CLI); otherwise let the backend default it. Owner tags the resumed
    // session to whoever's active, same as a fresh create.
    const claudeModel = fallbackModelsForAgent("claude").includes(model) ? model : undefined;
    onClose();
    toast.promise(
      api("/api/sessions/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, user: user || undefined, model: claudeModel }),
      }).then(() => onCreated()),
      {
        loading: "Resuming session…",
        success: "Session resumed",
        error: (err) => (err instanceof Error ? err.message : "Couldn't resume session"),
      },
    );
  }

  // Each time the dialog opens, default the owner to the currently selected
  // user (the live-view filter / active profile) so a new session lands with us.
  useEffect(() => {
    if (open) setUser(defaultUser || localStorage.getItem("lfg_user") || users[0]?.email || "");
  }, [open, defaultUser, users]);

  const models = modelsForAgent(catalogs, agent);
  const defaultModel = defaultModelForAgent(catalogs, agent);
  // When the live view is filtered to a specific project, lock new sessions to
  // that project's repo (and hide the picker below). Falls back to the normal
  // localStorage/first-repo default when viewing "All projects" or when the
  // filtered project has no matching repo in the list.
  const scopedRepo =
    scopedProject !== "__all"
      ? repos.find((r) => repoProject(r) === scopedProject)
      : undefined;
  const projectScoped = !!scopedRepo;
  const selectedRepo = scopedRepo?.cwd || repo || repos[0]?.cwd || "";
  const selectedIsCustom = repos.some((r) => r.cwd === selectedRepo && r.custom);
  const launching = pendingCreates > 0;

  // Pin an arbitrary git repo on the box (outside LFG_REPOS_ROOT) into the
  // picker. The path is resolved/validated server-side; on success we refresh
  // the repo list and select the freshly added path.
  function addCustomPath() {
    const input = window.prompt("Absolute path to a git repo (e.g. ~/work/api):");
    if (input === null) return;
    const path = input.trim();
    if (!path) return;
    toast.promise(
      api<{ repos: Repo[] }>("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      }).then(async (r) => {
        const added = r.repos.find((x) => x.custom && !repos.some((p) => p.cwd === x.cwd));
        await onReposChanged();
        if (added) setRepo(added.cwd);
      }),
      {
        loading: "Adding project…",
        success: "Project added",
        error: (e) => (e instanceof Error ? e.message : "Couldn't add project"),
      },
    );
  }

  function removeCustomPath(cwd: string) {
    toast.promise(
      api("/api/repos", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      }).then(async () => {
        if (selectedRepo === cwd) setRepo("");
        await onReposChanged();
      }),
      {
        loading: "Removing project…",
        success: "Project removed",
        error: (e) => (e instanceof Error ? e.message : "Couldn't remove project"),
      },
    );
  }

  useEffect(() => {
    if (!open || !agentShowsClaudeUsage(agent)) return;
    api<{ ok: true; fiveHour: { pct: number | null }; sevenDay: { pct: number | null } }>(
      "/api/claude/usage",
    )
      .then((payload) =>
        setUsage(`5 hr ${Math.round(payload.fiveHour.pct ?? 0)}% · week ${Math.round(payload.sevenDay.pct ?? 0)}%`),
      )
      .catch(() => setUsage("usage unavailable"));
  }, [open, agent]);

  useEffect(() => {
    syncModelWithCatalog({
      defaultModel,
      model,
      models,
      originRef: modelOriginRef,
      setModel,
    });
  }, [defaultModel, models, model]);

  const visibleAgentOptions = useMemo(() => {
    const visible = new Set<string>();
    for (const item of codingAgents ?? []) {
      if (item.visible) visible.add(item.key);
    }
    const filtered = codingAgents ? AGENT_OPTIONS.filter((option) => visible.has(option.key)) : AGENT_OPTIONS;
    return filtered.length ? filtered : AGENT_OPTIONS;
  }, [codingAgents]);

  useEffect(() => {
    if (visibleAgentOptions.some((option) => option.key === agent)) return;
    const next = visibleAgentOptions[0]?.key ?? "aisdk";
    const savedModel = localStorage.getItem(`lfg_model_${next}`);
    modelOriginRef.current = savedModel ? "explicit" : "default";
    setAgent(next);
    setModel(savedModel || defaultModelForAgent(catalogs, next));
  }, [agent, catalogs, visibleAgentOptions]);

  if (!open) return null;

  function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files).filter((file) => file.size > 0);
    if (!incoming.length) return;
    setAttachments((current) => {
      const room = Math.max(0, 8 - current.length);
      if (!room) {
        toast.error("Remove an attachment before adding another.");
        return current;
      }
      if (incoming.length > room) toast.error(`Added ${room} of ${incoming.length} files.`);
      const next = incoming.slice(0, room).map((file) => {
        const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
        if (previewUrl) previewUrls.current.push(previewUrl);
        return {
          id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
          file,
          name: file.name || "upload",
          size: file.size,
          type: file.type,
          previewUrl,
          status: "ready" as const,
        };
      });
      return [...current, ...next];
    });
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const item = current.find((att) => att.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return current.filter((att) => att.id !== id);
    });
  }

  async function uploadAttachment(att: ComposerAttachment): Promise<{ name: string; path: string }> {
    setAttachments((current) =>
      current.map((item) =>
        item.id === att.id ? { ...item, status: "uploading", error: undefined } : item,
      ),
    );
    try {
      const uploaded = await api<{ path: string; name?: string }>(
        `/api/uploads?filename=${encodeURIComponent(att.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": att.type || "application/octet-stream" },
          body: att.file,
        },
      );
      return { name: uploaded.name || att.name, path: uploaded.path };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAttachments((current) =>
        current.map((item) =>
          item.id === att.id ? { ...item, status: "failed", error: message } : item,
        ),
      );
      throw err;
    }
  }

  function submit(e?: FormEvent, overrideText?: string) {
    e?.preventDefault();
    const taskPrompt = (overrideText ?? prompt).trim();
    const files = attachments;
    if (!taskPrompt && !files.length) return;
    const launchUser = user || null;
    const launchAgent = agent;
    const launchModel = model;
    const launchThinkingLevel = thinkingLevel;
    const revokedUrls = new Set(files.map((att) => att.previewUrl).filter((url): url is string => !!url));
    setError(null);
    setPrompt("");
    setAttachments([]);
    previewUrls.current = previewUrls.current.filter((url) => {
      if (!revokedUrls.has(url)) return true;
      URL.revokeObjectURL(url);
      return false;
    });
    setPendingCreates((n) => n + 1);
    localStorage.setItem("lfg_v2_agent", launchAgent);
    localStorage.setItem("lfg_v2_repo", selectedRepo);
    localStorage.setItem(`lfg_model_${launchAgent}`, launchModel);
    if (agentSupportsThinking(launchAgent)) localStorage.setItem("lfg_thinking_level", launchThinkingLevel);
    if (launchAgent === "claude") localStorage.setItem("lfg_model", launchModel);
    if (launchUser) localStorage.setItem("lfg_user", launchUser);
    // Close only the drawer flow. The inline home composer is the fast-entry
    // path: keep it open and focused so the next session can be typed while this
    // one boots in the background.
    if (variant === "inline") {
      onExpandedChange?.(true);
      requestAnimationFrame(() => fieldRef.current?.querySelector("textarea")?.focus());
    } else {
      onClose();
    }
    void (async () => {
      try {
        const uploaded = files.length ? await Promise.all(files.map(uploadAttachment)) : [];
        const composedPrompt = composeAttachmentMessage(taskPrompt, uploaded);
        const res = await api<{ sessionId?: string }>("/api/sessions/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cwd: selectedRepo,
            prompt: composedPrompt || undefined,
            user: launchUser || undefined,
            agent: launchAgent,
            model: launchModel,
            thinkingLevel: agentSupportsThinking(launchAgent) ? launchThinkingLevel : undefined,
          }),
        });
        const sid = res?.sessionId;
        if (sid) {
          markCreatedSid(sid);
          markCollapsedSid(sid);
        }
        await onCreated({ launchId: sid, sessionId: sid });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        toast.error(message || "Couldn't create session");
        setAttachments((current) =>
          current.map((att) => (att.status === "uploading" ? { ...att, status: "ready" } : att)),
        );
      } finally {
        setPendingCreates((n) => Math.max(0, n - 1));
      }
    })();
  }

  // Inline composer resting state: only the agent icon + prompt + mic + Start
  // show; tapping the agent icon morphs the controls row open. The drawer
  // variant is always expanded.
  const compact = variant === "inline" && !expanded;
  const canSubmit = !!selectedRepo && (!!prompt.trim() || attachments.length > 0);
  const selectedAgentOption =
    visibleAgentOptions.find((option) => option.key === agent) ?? visibleAgentOptions[0] ?? AGENT_OPTIONS[0];
  // Keep every agent in a fixed position so picking one never reshuffles the
  // icons. The selected agent is highlighted in place rather than hoisted out.
  const agentButtons = visibleAgentOptions;

  // The agent switcher + model / thinking / repo pills. Shared between the
  // inline composer (revealed in its own row when expanded) and the always-open
  // drawer variant, so the markup lives in one place.
  const controlsInner = (
    <div
      className={cn(
        "flex items-center gap-1.5 pb-0.5",
        // Inline composer reveals these on a single row (horizontal scroll if
        // they overflow); the drawer has full width to spare, so it wraps.
        variant === "inline" ? "flex-nowrap" : "flex-wrap",
      )}
    >
      {agentButtons.length ? (
        <div
          className={cn(
            "inline-flex h-8 items-center text-xs font-semibold",
            variant === "inline" ? "gap-0.5" : "rounded-full bg-muted p-0.5",
          )}
        >
          {agentButtons.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              title={label}
              aria-label={label}
              onClick={() => {
                // Re-tapping the already-selected agent collapses the row.
                if (variant === "inline" && expanded && agent === key) {
                  onExpandedChange?.(false);
                  return;
                }
                const savedModel = localStorage.getItem(`lfg_model_${key}`);
                modelOriginRef.current = savedModel ? "explicit" : "default";
                setAgent(key);
                setModel(savedModel || defaultModelForAgent(catalogs, key));
              }}
              className={cn(
                "flex h-7 w-9 items-center justify-center rounded-full transition",
                agent === key
                  ? variant === "inline"
                    ? "bg-muted text-foreground"
                    : "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground",
              )}
            >
              <img src={agentIconSrc(key)} alt="" className="size-5" />
            </button>
          ))}
        </div>
      ) : null}

      <FieldPill flat={variant === "inline"}>
        <select
          value={model}
          onChange={(e) => {
            modelOriginRef.current = "explicit";
            setModel(e.target.value);
          }}
          aria-label="Model"
          className="max-w-28 appearance-none truncate bg-transparent pr-1 text-xs font-medium outline-none"
        >
          {models.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </FieldPill>

      {agentSupportsThinking(agent) && (
        <FieldPill flat={variant === "inline"}>
          <select
            value={thinkingLevel}
            onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel)}
            aria-label="Thinking level"
            className="max-w-24 appearance-none truncate bg-transparent pr-1 text-xs font-medium outline-none"
          >
            {THINKING_LEVELS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </FieldPill>
      )}

      {!projectScoped && (
        <FieldPill flat={variant === "inline"} icon={<Folder className="size-3.5 text-muted-foreground" />}>
          <select
            value={selectedRepo}
            onChange={(e) => {
              if (e.target.value === "__add__") addCustomPath();
              else setRepo(e.target.value);
            }}
            aria-label="Repo"
            className="max-w-28 appearance-none truncate bg-transparent pr-1 text-xs font-medium outline-none"
          >
            {repos.map((item) => (
              <option key={item.cwd} value={item.cwd}>
                {item.custom ? `${item.name} ↗` : item.name}
              </option>
            ))}
            <option value="__add__">+ Add custom path…</option>
          </select>
          {selectedIsCustom && (
            <button
              type="button"
              aria-label="Remove custom path"
              title="Remove this custom path"
              onClick={() => removeCustomPath(selectedRepo)}
              className="ml-0.5 text-muted-foreground hover:text-destructive"
            >
              <X className="size-3.5" />
            </button>
          )}
        </FieldPill>
      )}
    </div>
  );

  // The recent-session ("resume") button. A dedicated full-screen sheet (below)
  // opens rather than an inline list — the inline list reflowed the composer and
  // jumped again when the async fetch landed. In the inline composer it rides
  // along inside the expandable controls row (revealed only when expanded); the
  // wrapper keeps it mounted, so toggling expand never flickers the height.
  const resumeButton = (
    <button
      type="button"
      onClick={() => setResumeOpen(true)}
      title="Resume a recent session"
      aria-label="Resume a recent session"
      className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:text-foreground"
    >
      <RotateCcw className="size-4" />
    </button>
  );

  const formBody = (
    <form
      onSubmit={submit}
      onDragEnter={(event) => {
        if (Array.from(event.dataTransfer.types).includes("Files")) setDraggingFiles(true);
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDraggingFiles(true);
      }}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setDraggingFiles(false);
        }
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDraggingFiles(false);
        addFiles(event.dataTransfer.files);
      }}
      className={cn(
        "max-h-[70dvh] overflow-y-auto overscroll-contain px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] transition-colors",
        variant === "inline" ? "pt-1.5" : "pt-1",
        draggingFiles && "bg-primary/8",
      )}
    >
      <input
        ref={fileInputRef}
        type="file"
        aria-label="Attach files"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.currentTarget.value = "";
        }}
      />
      <div className="relative" ref={fieldRef}>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onPaste={(event) => {
            const files = event.clipboardData?.files;
            if (files?.length) {
              event.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={attachments.length ? "Add a note for the files…" : "Describe the task for a new session…"}
          className={cn(
            "max-h-[32dvh] resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 pr-10 text-base leading-relaxed shadow-none focus-visible:border-0 focus-visible:ring-0",
            compact ? "min-h-11" : variant === "inline" ? "min-h-24" : "min-h-40",
            variant !== "inline" && "max-h-[42dvh]",
          )}
        />
        <MicButton
          minimal
          className="absolute bottom-1 right-1 size-9"
          silenceMs={2500}
          baseText={prompt}
          onText={(text, base) =>
            setPrompt(base.trim() ? `${base.trimEnd()} ${text}` : text)
          }
          onInterim={(text, base) =>
            setPrompt(base.trim() ? `${base.trimEnd()} ${text}` : text)
          }
          onAutoSubmit={(text, base) => {
            const combined = base.trim() ? `${base.trimEnd()} ${text}` : text;
            void submit(undefined, combined);
          }}
        />
      </div>

      {attachments.length ? (
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
          {attachments.map((att) => (
            <div
              key={att.id}
              className={cn(
                "group flex h-12 max-w-52 shrink-0 items-center gap-2 rounded-lg border bg-muted/55 pl-1.5 pr-1.5 text-xs",
                att.status === "failed" ? "border-destructive/40 bg-destructive/10" : "border-border/70",
              )}
              title={att.error || att.name}
            >
              {att.previewUrl ? (
                <img
                  src={att.previewUrl}
                  alt=""
                  className="size-9 shrink-0 rounded-md object-cover"
                />
              ) : (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background/80 text-muted-foreground">
                  <Paperclip className="size-4" />
                </div>
              )}
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{att.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {att.status === "uploading" ? "Uploading..." : att.status === "failed" ? "Failed" : formatBytes(att.size)}
                </div>
              </div>
              <button
                type="button"
                className="ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                onClick={() => removeAttachment(att.id)}
                aria-label={`Remove ${att.name}`}
                title="Remove"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {variant === "inline" ? (
        // Single constant-height row: the agent toggle stays put while the
        // controls (and the recent button tucked at their end) reveal to the
        // right when expanded. Collapsed shows only the toggle.
        <div className="mt-2 flex min-h-8 items-center gap-1.5">
          {/* Collapsed-only handle: shows the current agent and opens the row.
              When expanded it tucks away so the agent isn't duplicated — the
              switcher below carries the selected (highlighted) agent, and
              tapping it again collapses. */}
          <button
            type="button"
            title={selectedAgentOption.label}
            aria-label="Choose agent"
            aria-expanded={expanded}
            onClick={() => onExpandedChange?.(true)}
            tabIndex={expanded ? -1 : 0}
            className={cn(
              "flex h-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-foreground shadow-sm transition-[width,opacity,transform] duration-300 ease-ios active:scale-[0.96]",
              expanded ? "pointer-events-none w-0 opacity-0" : "w-9 opacity-100",
            )}
          >
            <img src={agentIconSrc(agent)} alt="" className="size-5" />
          </button>
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto transition-[max-width,opacity] duration-300 ease-ios",
              expanded ? "max-w-full opacity-100" : "pointer-events-none max-w-0 opacity-0",
            )}
            aria-hidden={!expanded}
          >
            {controlsInner}
            {resumeButton}
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-start gap-1.5">
          <div className="min-w-0 max-w-none">{controlsInner}</div>
          {resumeButton}
        </div>
      )}

      <div
        className={cn(
          "flex items-center justify-between gap-3",
          compact ? "mt-2" : "mt-4",
        )}
      >
        <span
          className={cn(
            "min-w-0 truncate text-xs",
            error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {error || (agentShowsClaudeUsage(agent) ? usage : "") || ""}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="icon"
            type="button"
            variant={draggingFiles ? "brand-soft" : "tint"}
            className="size-9"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach files"
            title="Attach files"
          >
            <Paperclip className="size-4" />
          </Button>
          <Button type="submit" variant="secondary" disabled={!canSubmit}>
            <Send className="size-4" />
            Start
          </Button>
        </div>
      </div>

      {resumeOpen ? (
        <ResumeSessionSheet
          sessions={resumable}
          onPick={(sessionId) => {
            closeResume();
            resume(sessionId);
          }}
          onClose={closeResume}
        />
      ) : null}
    </form>
  );

  // Mobile home screen: anchor the shared composer inline at the bottom of the
  // viewport. `interactive-widget=resizes-content` shrinks the layout viewport
  // when the soft keyboard opens, so `bottom-0` rides just above the keyboard.
  if (variant === "inline") {
    return (
      <div
        aria-busy={launching}
        className={cn(
          "pointer-events-auto fixed inset-x-0 bottom-0 z-[55] border-t border-border/60 bg-background/95 pt-4 shadow-[0_-8px_24px_rgba(0,0,0,0.12)] backdrop-blur-xl",
          launching && "lfg-composer-launching",
        )}
      >
        {projectOptions && onProjectChange ? (
          <div className="absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-1/2">
            <ProjectFilterMenu
              value={scopedProject}
              projects={projectOptions}
              onChange={onProjectChange}
              solidSurface
            />
          </div>
        ) : null}
        <div ref={inlineShellRef} className="mx-auto max-w-lg will-change-transform">
          {formBody}
        </div>
      </div>
    );
  }

  return (
    <Drawer
      open
      // Let the browser (viewport `interactive-widget=resizes-content`) handle the
      // on-screen keyboard. Vaul's default reposition imperatively rewrites the
      // sheet's height/bottom on every visualViewport change, which fights the
      // reflow and causes the layout shift/jump when a field takes focus.
      repositionInputs={false}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DrawerContent className="mx-auto max-w-lg">
        <DrawerTitle className="sr-only">New session</DrawerTitle>
        {formBody}
      </DrawerContent>
    </Drawer>
  );
}

// Full-screen "Resume a recent session" picker. Portaled to <body> so it escapes
// the composer's backdrop-filter containing block (a fixed child there would be
// trapped inside the bottom bar). Skeleton rows hold the list's height while the
// fetch is in flight, so the screen never jumps when the data lands.
function ResumeSessionSheet({
  sessions,
  onPick,
  onClose,
}: {
  sessions: ResumableSession[] | null;
  onPick: (sessionId: string) => void;
  onClose: () => void;
}) {
  return createPortal(
    <div className="pointer-events-auto fixed inset-0 z-[80] flex flex-col bg-background text-foreground lfg-resume-in">
      <header
        className="flex shrink-0 items-center gap-2 border-b border-border px-2 pb-3"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.75rem)" }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:text-foreground active:scale-95"
        >
          <ChevronLeft className="size-5" />
        </button>
        <h2 className="text-[15px] font-semibold">Resume a session</h2>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }}
      >
        <div className="mx-auto max-w-lg">
          {sessions === null ? (
            <div className="animate-pulse space-y-1" aria-hidden>
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-3">
                  <div className="size-4 shrink-0 rounded-full bg-muted" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="h-3 w-1/2 rounded bg-muted" />
                    <div className="h-2.5 w-3/4 rounded bg-muted/60" />
                  </div>
                </div>
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center text-sm text-muted-foreground">
              <RotateCcw className="size-5" />
              <span>No recent sessions to resume</span>
            </div>
          ) : (
            <div className="space-y-0.5">
              {sessions.map((s) => (
                <button
                  key={s.sessionId}
                  type="button"
                  onClick={() => onPick(s.sessionId)}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-muted active:scale-[0.99]"
                >
                  <RotateCcw className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {s.title}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {s.agent === "codex" ? "codex · " : ""}
                      {s.project} · {timeAgo(s.lastActivityAt)}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// A compact iOS-style control pill: optional leading icon, a borderless native
// select, and a trailing chevron — no field label, the value speaks for itself.
function FieldPill({ icon, children, flat = false }: { icon?: ReactNode; children: ReactNode; flat?: boolean }) {
  return (
    <label
      className={cn(
        "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full text-foreground",
        flat ? "px-1" : "bg-muted px-3",
      )}
    >
      {icon}
      {children}
      <ChevronDown className="size-3 shrink-0 text-muted-foreground/70" />
    </label>
  );
}

function AutoAgentModelPicker({
  backend,
  setBackend,
  model,
  setModel,
  thinkingLevel,
  setThinkingLevel,
}: {
  backend: AutoAgentBackend;
  setBackend: (v: AutoAgentBackend) => void;
  model: string;
  setModel: (v: string) => void;
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (v: ThinkingLevel) => void;
}) {
  const catalogs = useModelCatalogs();
  const models = modelsForAgent(catalogs, backend);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <div className="inline-flex h-8 items-center rounded-full bg-muted p-0.5 text-xs font-semibold">
        {AUTO_AGENT_OPTIONS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            title={label}
            aria-label={label}
            onClick={() => setBackend(key)}
            className={cn(
              "flex h-7 w-9 items-center justify-center rounded-full transition",
              backend === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
            )}
          >
            <img src={agentIconSrc(key)} alt="" className="size-5" />
          </button>
        ))}
      </div>

      <FieldPill>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          aria-label="Auto agent model"
          className="max-w-36 appearance-none truncate bg-transparent pr-1 text-xs font-medium outline-none"
        >
          {models.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </FieldPill>

      {agentSupportsThinking(backend) ? (
        <FieldPill>
          <select
            value={thinkingLevel}
            onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel)}
            aria-label="Auto agent thinking level"
            className="max-w-24 appearance-none truncate bg-transparent pr-1 text-xs font-medium outline-none"
          >
            {THINKING_LEVELS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </FieldPill>
      ) : null}
    </div>
  );
}

// ---------- auto agents: sheets + manage view ----------

// Bottom sheet built on the shadcn Drawer (vaul) primitive — gives us the drag
// handle, focus trap, escape-to-close, and overlay for free, matching the rest
// of the app's UI kit. `title` feeds the a11y-required (visually hidden) label.
function BottomSheet({
  onClose,
  title,
  children,
}: {
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DrawerContent>
        <DrawerTitle className="sr-only">{title}</DrawerTitle>
        <div className="overflow-y-auto overscroll-contain">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}

function FindingSheet({
  finding,
  agentName,
  sourceAgent,
  onClose,
  onReply,
  onDismiss,
}: {
  finding: AutoFinding;
  agentName: string;
  sourceAgent?: AutoAgent;
  onClose: () => void;
  onReply: (
    f: AutoFinding,
    text: string,
    opts?: { agent?: AutoAgentBackend; model?: string; thinkingLevel?: string },
  ) => Promise<void>;
  onDismiss: (f: AutoFinding) => void;
}) {
  const catalogs = useModelCatalogs();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [backend, setBackend] = useState<AutoAgentBackend>(sourceAgent?.agent ?? "aisdk");
  const modelOriginRef = useRef<ModelSelectionOrigin>(sourceAgent?.model ? "explicit" : "default");
  const previousBackendRef = useRef<AutoAgentBackend>(sourceAgent?.agent ?? "aisdk");
  const [model, setModel] = useState(
    sourceAgent?.model ?? defaultModelForAgent(STATIC_MODEL_CATALOGS, sourceAgent?.agent ?? "aisdk"),
  );
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    (sourceAgent?.thinkingLevel as ThinkingLevel | undefined) ?? savedThinkingLevel(),
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const backendModels = modelsForAgent(catalogs, backend);
  const defaultModel = defaultModelForAgent(catalogs, backend);
  const supportsThinking = agentSupportsThinking(backend);

  useEffect(() => {
    if (previousBackendRef.current !== backend) {
      previousBackendRef.current = backend;
      modelOriginRef.current = "default";
      setModel(defaultModel);
      return;
    }
    syncModelWithCatalog({
      defaultModel,
      model,
      models: backendModels,
      originRef: modelOriginRef,
      setModel,
    });
  }, [backend, backendModels, defaultModel, model]);

  const launchOpts = (): { agent: AutoAgentBackend; model: string; thinkingLevel?: string } => ({
    agent: backend,
    model,
    thinkingLevel: supportsThinking ? thinkingLevel : undefined,
  });

  // Present the finding like a live session you can talk to right away: focus
  // the composer as soon as the sheet settles so the user can start typing
  // immediately (and mobile pops the keyboard) without a tap. The delay lets
  // the Drawer's open animation + focus trap finish first, otherwise the trap
  // steals focus back.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(t);
  }, []);

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    logFindingAction(finding.id, "reply", true);
    try {
      await onReply(finding, t, launchOpts());
    } finally {
      setBusy(false);
    }
  }

  // One-tap path: graduate the finding into a session that immediately acts on
  // the agent's suggested fix, with no typing required. Only offered in the
  // empty state — once the user types, the composer send IS this action (same
  // onReply call), so we collapse to the single ArrowUp affordance.
  async function execute() {
    if (busy) return;
    setBusy(true);
    logFindingAction(finding.id, "execute", !!text.trim());
    try {
      await onReply(
        finding,
        text.trim() || "Go ahead and implement this fix now.",
        launchOpts(),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet onClose={onClose} title={`${agentName} finding`}>
      <div className="px-2 pb-4 pt-1">
        <div className="flex items-center gap-2">
          <span className={cn("size-2.5 rounded-full", SEV_DOT[finding.severity])} />
          <span className="text-[15px] font-semibold">{agentName}</span>
          <span className="ml-auto text-xs text-muted-foreground">{relTime(finding.createdAt)}</span>
        </div>

        <p className="mt-3 text-[15px] font-medium leading-snug">{finding.title}</p>

        {finding.reasoning.length ? (
          <>
            <ul className="mt-3 flex flex-col gap-1.5">
              {finding.reasoning.map((r) => (
                <li key={r} className="flex gap-2 text-[13.5px] text-foreground/90">
                  <span className="text-muted-foreground">•</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {finding.suggest ? (
          <div className="mt-4 rounded-xl bg-muted px-3 py-2.5 text-[13.5px]">
            <span className="font-medium text-muted-foreground">Suggested → </span>
            {finding.suggest}
          </div>
        ) : null}

        <div className="mt-4">
          <AutoAgentModelPicker
            backend={backend}
            setBackend={setBackend}
            model={model}
            setModel={(next) => {
              modelOriginRef.current = "explicit";
              setModel(next);
            }}
            thinkingLevel={thinkingLevel}
            setThinkingLevel={setThinkingLevel}
          />
        </div>

        <div className="mt-5 flex items-end gap-2 rounded-2xl border border-border bg-background px-3 py-2">
          <Textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Type to start a session…"
            // text-base (16px) on mobile keeps iOS from auto-zooming the
            // viewport on focus; drop to text-sm only at md+ where there's no
            // zoom behaviour to trigger.
            className="max-h-28 min-h-0 flex-1 resize-none border-0 bg-transparent p-1 text-base shadow-none focus-visible:ring-0 md:text-sm"
          />
          <Button size="icon-sm" variant="brand" disabled={busy || !text.trim()} onClick={() => void send()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </Button>
        </div>
        {/* The one-tap default only earns its space in the empty state. Once
            the user types, the composer ArrowUp runs the exact same onReply, so
            a second full-width brand button would just be a duplicate CTA. */}
        {text.trim() ? null : (
          <Button
            variant="brand"
            disabled={busy}
            onClick={() => void execute()}
            className="mt-3 w-full"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            Make the change
          </Button>
        )}
        <button
          type="button"
          onClick={() => {
            logFindingAction(finding.id, "dismiss", !!text.trim());
            onDismiss(finding);
          }}
          disabled={busy}
          className="mt-3 w-full rounded-xl border border-border py-2.5 text-[13px] font-medium text-muted-foreground disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </BottomSheet>
  );
}

// Single-box create: the whole "new auto agent" UI is one prompt. The user
// describes what they want watched; /api/auto/compose derives a name, a cron
// schedule, and the enhanced watch instruction, and we save it straight away.
// Everything stays editable afterward via the full editor (tap the agent).
function NewAutoAgentComposer({
  repos,
  scopedProject,
  onClose,
  onCreate,
}: {
  repos: Repo[];
  scopedProject: string;
  onClose: () => void;
  onCreate: (
    idea: string,
    cwd: string | undefined,
    opts: { agent?: AutoAgentBackend; model?: string; thinkingLevel?: string },
  ) => void;
}) {
  const [idea, setIdea] = useState("");
  const scopedRepo =
    scopedProject !== "__all"
      ? repos.find((repo) => repoProject(repo) === scopedProject)
      : undefined;
  const [cwd, setCwd] = useState(scopedRepo?.cwd ?? repos[0]?.cwd ?? "");
  const [backend, setBackend] = useState<AutoAgentBackend>("aisdk");
  const modelOriginRef = useRef<ModelSelectionOrigin>("default");
  const previousBackendRef = useRef<AutoAgentBackend>("aisdk");
  const [model, setModel] = useState(defaultModelForAgent(STATIC_MODEL_CATALOGS, "aisdk"));
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(savedThinkingLevel());
  const catalogs = useModelCatalogs();
  const backendModels = modelsForAgent(catalogs, backend);
  const defaultModel = defaultModelForAgent(catalogs, backend);
  const supportsThinking = agentSupportsThinking(backend);

  useEffect(() => {
    if (previousBackendRef.current !== backend) {
      previousBackendRef.current = backend;
      modelOriginRef.current = "default";
      setModel(defaultModel);
      return;
    }
    syncModelWithCatalog({
      defaultModel,
      model,
      models: backendModels,
      originRef: modelOriginRef,
      setModel,
    });
  }, [backend, backendModels, defaultModel, model]);

  // Fire-and-close: hand the idea to the parent (which runs compose → save
  // under a loading toast) and dismiss the sheet immediately. The slow,
  // repo-inspecting work happens in the background — nothing blocks here.
  function submit() {
    if (!idea.trim()) return;
    onCreate(idea.trim(), cwd || undefined, {
      agent: backend,
      model,
      thinkingLevel: supportsThinking ? thinkingLevel : undefined,
    });
    onClose();
  }

  return (
    <BottomSheet onClose={onClose} title="New auto agent">
      <div className="px-2 pb-4 pt-1">
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-primary" />
          <div className="flex-1 text-[15px] font-semibold">
            Describe the agent
          </div>
          <Button
            size="sm"
            variant="brand"
            disabled={!idea.trim()}
            onClick={submit}
          >
            Create
          </Button>
        </div>

        <Textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          rows={6}
          autoFocus
          placeholder="What should this agent watch for, and roughly how often? e.g. “Every morning, check our npm dependencies for newly disclosed CVEs and flag anything we actually ship.”"
          className="mt-3 resize-none text-sm leading-relaxed"
        />

        <div className="mt-2 flex items-center justify-between rounded-xl border border-border px-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            <Folder className="size-4 text-muted-foreground" /> Based in (repo)
          </div>
          <select
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            aria-label="Repo"
            className="max-w-44 appearance-none truncate bg-transparent text-right text-[13px] font-medium outline-none"
          >
            {repos.length === 0 ? <option value="">(no repos)</option> : null}
            {repos.map((item) => (
              <option key={item.cwd} value={item.cwd}>
                {item.name}
              </option>
            ))}
          </select>
        </div>

        <AutoAgentModelPicker
          backend={backend}
          setBackend={setBackend}
          model={model}
          setModel={(next) => {
            modelOriginRef.current = "explicit";
            setModel(next);
          }}
          thinkingLevel={thinkingLevel}
          setThinkingLevel={setThinkingLevel}
        />

        <div className="mt-2 px-1 text-[11px] text-muted-foreground">
          We'll inspect the selected repo, then name it, pick a schedule, and
          write a watch prompt grounded in the real files — it keeps working
          after you close this. Tap the agent afterward to fine-tune any of it.
        </div>
      </div>
    </BottomSheet>
  );
}

function AgentEditorSheet({
  agent,
  repos,
  tz,
  running,
  onClose,
  onSave,
  onDelete,
  onRunNow,
}: {
  agent: AutoAgent | "new";
  repos: Repo[];
  tz: string;
  running?: boolean;
  onClose: () => void;
  onSave: (input: {
    id?: string;
    name: string;
    prompt: string;
    schedule: string;
    enabled: boolean;
    cwd?: string;
    agent?: AutoAgentBackend;
    model?: string;
    thinkingLevel?: string;
  }) => Promise<void>;
  onDelete: (id: string) => void;
  onRunNow: (id: string) => void;
}) {
  const isNew = agent === "new";
  const existing = isNew ? null : agent;
  const [name, setName] = useState(existing?.name ?? "");
  const [prompt, setPrompt] = useState(existing?.prompt ?? "");
  const [schedule, setSchedule] = useState(existing?.schedule ?? "0 9 * * *");
  // Schedule picker: "simple" drives the cron from friendly controls; "advanced"
  // exposes the raw cron field. We open in simple mode when the existing cron maps
  // to a pattern the picker can represent, else advanced.
  const initialSimple = parseToSimple(existing?.schedule ?? "0 9 * * *");
  const [simple, setSimple] = useState<SimpleSchedule>(initialSimple ?? DEFAULT_SIMPLE);
  const [schedMode, setSchedMode] = useState<"simple" | "advanced">(
    initialSimple ? "simple" : "advanced",
  );
  // In simple mode the picker is the source of truth → keep cron in sync.
  const updateSimple = (patch: Partial<SimpleSchedule>) => {
    setSimple((prev) => {
      const next = { ...prev, ...patch };
      setSchedule(buildCron(next));
      return next;
    });
  };
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  // The base repo this agent runs in (and that graduated sessions inherit). Same
  // repo list as the Create Session dialog. Default to the agent's saved base,
  // else the first repo.
  const [cwd, setCwd] = useState(existing?.cwd ?? repos[0]?.cwd ?? "");
  const [backend, setBackend] = useState<AutoAgentBackend>(existing?.agent ?? "aisdk");
  const modelOriginRef = useRef<ModelSelectionOrigin>(existing?.model ? "explicit" : "default");
  const previousBackendRef = useRef<AutoAgentBackend>(existing?.agent ?? "aisdk");
  const [model, setModel] = useState(
    existing?.model ?? defaultModelForAgent(STATIC_MODEL_CATALOGS, existing?.agent ?? "aisdk"),
  );
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    (existing?.thinkingLevel as ThinkingLevel | undefined) ?? savedThinkingLevel(),
  );
  const [busy, setBusy] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceErr, setEnhanceErr] = useState<string | null>(null);
  // Scan only when the schedule changes, not on every keystroke elsewhere.
  const nextPreview = useMemo(() => nextRunAt(schedule, tz), [schedule, tz]);
  const catalogs = useModelCatalogs();
  const backendModels = modelsForAgent(catalogs, backend);
  const defaultModel = defaultModelForAgent(catalogs, backend);
  const supportsThinking = agentSupportsThinking(backend);

  useEffect(() => {
    if (previousBackendRef.current !== backend) {
      previousBackendRef.current = backend;
      modelOriginRef.current = "default";
      setModel(defaultModel);
      return;
    }
    syncModelWithCatalog({
      defaultModel,
      model,
      models: backendModels,
      originRef: modelOriginRef,
      setModel,
    });
  }, [backend, backendModels, defaultModel, model]);

  // Rewrite the user's rough idea into a sharp watch-agent prompt in place. The
  // server runs a one-shot, tool-less claude pass; we swap the result into the
  // textarea so it stays fully editable afterward.
  async function enhance() {
    if (enhancing || !prompt.trim()) return;
    setEnhancing(true);
    setEnhanceErr(null);
    try {
      const r = await api<{ prompt: string }>("/api/auto/enhance-prompt", {
        method: "POST",
        body: JSON.stringify({
          prompt: prompt.trim(),
          name: name.trim() || undefined,
          cwd: cwd || undefined,
        }),
      });
      if (r.prompt?.trim()) setPrompt(r.prompt.trim());
    } catch (e) {
      setEnhanceErr(e instanceof Error ? e.message : "enhance failed");
    } finally {
      setEnhancing(false);
    }
  }

  async function save() {
    if (!name.trim() || !prompt.trim() || busy) return;
    setBusy(true);
    try {
      await onSave({
        id: existing?.id,
        name: name.trim(),
        prompt: prompt.trim(),
        schedule: schedule.trim(),
        enabled,
        cwd: cwd || undefined,
        agent: backend,
        model: model.trim() || undefined,
        thinkingLevel: supportsThinking ? thinkingLevel : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet onClose={onClose} title={isNew ? "New auto agent" : "Edit auto agent"}>
      <div className="px-2 pb-4 pt-1">
        <div className="flex items-center gap-2">
          <Bot className="size-5 text-primary" />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Auto agent name"
            placeholder="agent-name"
            className="flex-1 bg-transparent text-[17px] font-semibold outline-none placeholder:text-muted-foreground"
          />
          <Button size="sm" variant="brand" disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
        </div>

        {(() => {
          const locale = typeof navigator !== "undefined" ? navigator.language : undefined;
          const weekdays = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
            v: d,
            label: new Date(Date.UTC(2024, 0, 7 + d)).toLocaleDateString(locale, {
              weekday: "long",
              timeZone: "UTC",
            }),
          }));
          const next = nextPreview;
          const selectCls =
            "appearance-none rounded-lg bg-muted px-2 py-1 text-right text-[13px] font-medium outline-none";
          const numCls = "w-14 rounded-lg bg-muted px-2 py-1 text-right text-[13px] outline-none";
          const freqOptions: { v: SimpleFreq; label: string }[] = [
            { v: "minutes", label: "Every N minutes" },
            { v: "hourly", label: "Every hour" },
            { v: "daily", label: "Every day" },
            { v: "weekday", label: "Every weekday" },
            { v: "weekly", label: "Every week" },
            { v: "monthly", label: "Every month" },
          ];
          return (
            <div className="mt-3 rounded-xl border border-border px-3 py-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <CalendarClock className="size-4 text-muted-foreground" /> Schedule
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (schedMode === "advanced") {
                      const parsed = parseToSimple(schedule);
                      if (parsed) {
                        setSimple(parsed);
                        setSchedMode("simple");
                      }
                    } else {
                      setSchedMode("advanced");
                    }
                  }}
                  className="text-[11px] font-semibold uppercase tracking-wide text-primary disabled:text-muted-foreground"
                  disabled={schedMode === "advanced" && !parseToSimple(schedule)}
                >
                  {schedMode === "simple" ? "Advanced (cron)" : "Use picker"}
                </button>
              </div>

              {schedMode === "simple" ? (
                <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5 text-[13px]">
                  <select
                    value={simple.freq}
                    onChange={(e) => updateSimple({ freq: e.target.value as SimpleFreq })}
                    aria-label="Frequency"
                    className={selectCls}
                  >
                    {freqOptions.map((o) => (
                      <option key={o.v} value={o.v}>
                        {o.label}
                      </option>
                    ))}
                  </select>

                  {simple.freq === "minutes" ? (
                    <input
                      type="number"
                      min={1}
                      max={59}
                      value={simple.every}
                      onChange={(e) => updateSimple({ every: parseInt(e.target.value, 10) || 1 })}
                      aria-label="Every N minutes"
                      className={numCls}
                    />
                  ) : null}

                  {simple.freq === "hourly" ? (
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={simple.minute}
                      onChange={(e) =>
                        updateSimple({
                          minute: Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0)),
                        })
                      }
                      aria-label="Minute of the hour"
                      className={numCls}
                    />
                  ) : null}

                  {simple.freq === "weekly" ? (
                    <select
                      value={simple.dow}
                      onChange={(e) => updateSimple({ dow: parseInt(e.target.value, 10) })}
                      aria-label="Day of week"
                      className={selectCls}
                    >
                      {weekdays.map((d) => (
                        <option key={d.v} value={d.v}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  ) : null}

                  {simple.freq === "monthly" ? (
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={simple.dom}
                      onChange={(e) =>
                        updateSimple({
                          dom: Math.max(1, Math.min(31, parseInt(e.target.value, 10) || 1)),
                        })
                      }
                      aria-label="Day of month"
                      className={numCls}
                    />
                  ) : null}

                  {simple.freq === "daily" ||
                  simple.freq === "weekday" ||
                  simple.freq === "weekly" ||
                  simple.freq === "monthly" ? (
                    <input
                      type="time"
                      value={simple.time}
                      onChange={(e) => updateSimple({ time: e.target.value })}
                      aria-label="Time of day"
                      className="rounded-lg bg-muted px-2 py-1 text-[13px] outline-none"
                    />
                  ) : null}
                </div>
              ) : (
                <input
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                  aria-label="Cron schedule"
                  placeholder="0 9 * * *"
                  className="mt-2 w-full rounded-lg bg-muted px-2 py-1 font-mono text-[13px] outline-none"
                />
              )}

              <div className="mt-2 border-t border-border pt-1.5 text-xs text-muted-foreground">
                {describeCron(schedule, locale)}
                {next ? <span> · next {formatRelative(next, locale)}</span> : null}
                <span className="ml-1 text-muted-foreground/60">({tz})</span>
              </div>
            </div>
          );
        })()}

        <div className="mt-2 flex items-center justify-between rounded-xl border border-border px-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            <Folder className="size-4 text-muted-foreground" /> Based in (repo)
          </div>
          <select
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            aria-label="Repo"
            className="max-w-44 appearance-none truncate bg-transparent text-right text-[13px] font-medium outline-none"
          >
            {repos.length === 0 ? <option value="">(no repos)</option> : null}
            {repos.map((item) => (
              <option key={item.cwd} value={item.cwd}>
                {item.name}
              </option>
            ))}
          </select>
        </div>

        <AutoAgentModelPicker
          backend={backend}
          setBackend={setBackend}
          model={model}
          setModel={(next) => {
            modelOriginRef.current = "explicit";
            setModel(next);
          }}
          thinkingLevel={thinkingLevel}
          setThinkingLevel={setThinkingLevel}
        />

        <button
          type="button"
          onClick={() => setEnabled((v) => !v)}
          className="mt-2 flex w-full items-center justify-between rounded-xl border border-border px-3 py-2"
        >
          <div className="flex items-center gap-2 text-sm">
            <Power className="size-4 text-muted-foreground" /> Enabled
          </div>
          <span
            className={cn(
              "relative h-6 w-11 rounded-full transition-colors",
              enabled ? "bg-success" : "bg-border",
            )}
          >
            <span
              className={cn(
                "absolute left-0.5 top-0.5 size-5 rounded-full bg-white transition-transform",
                enabled ? "translate-x-5" : "",
              )}
            />
          </span>
        </button>

        <div className="mt-3 flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Prompt — this is the entire agent
          </div>
          <button
            type="button"
            disabled={enhancing || !prompt.trim()}
            onClick={() => void enhance()}
            className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-primary disabled:text-muted-foreground"
            title="Rewrite your rough idea into a sharp watch-agent prompt"
          >
            {enhancing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {enhancing ? "Enhancing…" : "Enhance"}
          </button>
        </div>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          disabled={enhancing}
          placeholder="Jot a rough idea of what to watch for, then hit Enhance — it rewrites it into a sharp watch-agent prompt. Runs on the selected agent provider and gathers its own context."
          className="mt-1.5 resize-none text-sm leading-relaxed"
        />
        <div className="mt-1.5 px-1 text-[11px] text-muted-foreground">
          {enhanceErr ? (
            <span className="text-destructive">{enhanceErr}</span>
          ) : (
            "No config files, no sources to wire — just the prompt + a schedule."
          )}
        </div>

        {existing ? (
          <div className="mt-4 flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              disabled={running}
              onClick={() => onRunNow(existing.id)}
            >
              {running ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}{" "}
              {running ? "Running…" : "Run now"}
            </Button>
            <Button
              variant="outline"
              className="flex-1 text-destructive"
              onClick={() => onDelete(existing.id)}
            >
              <Trash2 className="size-4" /> Delete
            </Button>
          </div>
        ) : null}
      </div>
    </BottomSheet>
  );
}

const navLocale = typeof navigator !== "undefined" ? navigator.language : undefined;

function ScheduleSummary({ expr, tz }: { expr: string; tz: string }) {
  // describeCron is cheap; nextRunAt scans, so compute it only when expr/tz
  // change — NOT on every 30s re-render.
  const desc = useMemo(() => describeCron(expr, navLocale), [expr]);
  const [tick, force] = useState(0);
  const next = useMemo(() => nextRunAt(expr, tz), [expr, tz, tick]);
  // Tick the relative label; only rescan when the previous run actually passed.
  useEffect(() => {
    const id = setInterval(() => {
      force((n) => n + 1);
    }, 30_000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="flex items-center gap-1" title={expr}>
      <CalendarClock className="size-3.5 shrink-0" />
      <span className="truncate">
        {desc}
        {next ? <span className="text-muted-foreground/70"> · next {formatRelative(next, navLocale)}</span> : null}
      </span>
    </span>
  );
}

type ProviderOption = { id: string; label: string; available: boolean };
type VoiceConfig = {
  settings: { ttsProvider: string; sttProvider: string };
  providers: { tts: ProviderOption[]; stt: ProviderOption[] };
};

function ProviderRow({
  icon,
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  value?: string;
  options?: ProviderOption[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <div className="flex items-center gap-3">
        <span className="flex size-7 items-center justify-center rounded-[7px] bg-primary text-white">
          {icon}
        </span>
        <span className="text-sm font-medium">{label}</span>
      </div>
      <select
        className="max-w-[55%] rounded-lg border border-border bg-background px-2 py-1 text-sm disabled:opacity-50"
        value={value ?? ""}
        disabled={disabled || !options}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      >
        {!options ? (
          <option value="">Loading…</option>
        ) : (
          options.map((o) => (
            <option key={o.id} value={o.id} disabled={!o.available}>
              {o.label}
              {o.available ? "" : " (no key)"}
            </option>
          ))
        )}
      </select>
    </div>
  );
}

function VoiceSettingsSection() {
  const [cfg, setCfg] = useState<VoiceConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetch(appPath("/api/voice/config"))
      .then((r) => (r.ok ? r.json() : null))
      .then((d: VoiceConfig | null) => {
        if (alive && d) setCfg(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const update = async (patch: Partial<VoiceConfig["settings"]>) => {
    setCfg((c) => (c ? { ...c, settings: { ...c.settings, ...patch } } : c));
    setSaving(true);
    try {
      const r = await fetch(appPath("/api/voice/config"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = (await r.json().catch(() => null)) as { settings?: VoiceConfig["settings"] } | null;
      if (d?.settings) setCfg((c) => (c ? { ...c, settings: d.settings! } : c));
    } catch {
      // keep the optimistic value; next load reconciles
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-2">
      <h2 className="px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Voice
      </h2>
      <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
        <ProviderRow
          icon={<Radio className="size-4" />}
          label="Voice output"
          value={cfg?.settings.ttsProvider}
          options={cfg?.providers.tts}
          onChange={(v) => void update({ ttsProvider: v })}
          disabled={!cfg || saving}
        />
        <ProviderRow
          icon={<Mic className="size-4" />}
          label="Voice input"
          value={cfg?.settings.sttProvider}
          options={cfg?.providers.stt}
          onChange={(v) => void update({ sttProvider: v })}
          disabled={!cfg || saving}
        />
      </div>
      <p className="px-4 text-xs text-muted-foreground">
        Applies to the voice orb and every mic button. Greyed-out providers need an API key set on
        the server.
      </p>
    </section>
  );
}

function CodingAgentsPage({
  agents,
  onVisibleChange,
  onSetup,
  onRefresh,
}: {
  agents: CodingAgentInfo[];
  onVisibleChange: (kind: AgentKind, visible: boolean) => void;
  onSetup: (kind: AgentKind) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="mx-auto max-w-xl space-y-3 pb-10">
      <div className="flex items-center justify-between px-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Coding agents
        </h2>
        <button
          type="button"
          onClick={onRefresh}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <RotateCcw className="size-3.5" />
          Refresh
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
        {agents.map((agent) => {
          const configured = agent.status.configured;
          return (
            <div key={agent.key} className="px-4 py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-border bg-background">
                    <img
                      src={agentIconSrc(agent.key)}
                      alt={agentIconAlt(agent.key)}
                      className="size-5"
                    />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{agent.label}</span>
                      <Badge variant={configured ? "default" : "secondary"}>
                        {configured ? "Ready" : "Needs setup"}
                      </Badge>
                    </div>
                    <div className="mt-1 space-y-1">
                      {agent.status.checks.map((check) => (
                        <div
                          key={check.label}
                          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                        >
                          {check.ok ? (
                            <Check className="size-3.5 shrink-0 text-success" />
                          ) : (
                            <X className="size-3.5 shrink-0 text-destructive" />
                          )}
                          <span className="shrink-0">{check.label}</span>
                          {check.detail ? (
                            <span className="min-w-0 truncate text-muted-foreground/70">
                              {check.detail}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <Switch
                  checked={agent.visible}
                  onCheckedChange={(visible) => onVisibleChange(agent.key, visible)}
                  aria-label={`${agent.label} visible in composer`}
                />
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 pl-11">
                {agent.status.instructions.map((instruction) => (
                  <span key={instruction} className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {instruction}
                  </span>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!agent.status.canAutoSetup || agent.status.setupRunning}
                  onClick={() => onSetup(agent.key)}
                  title={
                    agent.status.canAutoSetup
                      ? "Run setup for this agent"
                      : "No automatic setup is available"
                  }
                >
                  {agent.status.setupRunning ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  {agent.status.setupRunning ? "Running…" : "Run setup"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type UsageWindow = { label: string; pct: number | null; resetsAt: number | null };
type ProviderUsage = {
  kind: string;
  label: string;
  available: boolean;
  plan?: string | null;
  note?: string;
  windows?: UsageWindow[];
};

function fmtReset(ms: number | null): string {
  if (!ms) return "";
  const diff = ms - Date.now();
  if (diff <= 0) return "resets now";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `resets in ${hrs}h`;
  return `resets in ${Math.round(hrs / 24)}d`;
}

function UsageBar({ w }: { w: UsageWindow }) {
  const pct = w.pct == null ? null : Math.max(0, Math.min(100, w.pct));
  const tone =
    pct == null
      ? "bg-muted-foreground/40"
      : pct >= 90
        ? "bg-destructive"
        : pct >= 70
          ? "bg-amber-500"
          : "bg-primary";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-muted-foreground">{w.label}</span>
        <span className="tabular-nums">
          {pct == null ? "—" : `${Math.round(pct)}%`}
          {w.resetsAt ? (
            <span className="ml-2 text-muted-foreground/70">{fmtReset(w.resetsAt)}</span>
          ) : null}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]">
        <div
          className={cn("h-full rounded-full transition-all duration-300 ease-ios", tone)}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>
    </div>
  );
}

function UsageLimitsSection() {
  const [providers, setProviders] = useState<ProviderUsage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const d = await api<{ providers: ProviderUsage[] }>("/api/usage");
      setProviders(d.providers);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load usage");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Usage &amp; limits
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <RotateCcw className={cn("size-3.5", refreshing && "animate-spin")} />
          Refresh
        </button>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
        {providers == null && !error ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">Loading…</div>
        ) : error ? (
          <div className="px-4 py-6 text-center text-sm text-destructive">{error}</div>
        ) : (
          providers!.map((p) => (
            <div key={p.kind} className="flex flex-col gap-2.5 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-7 items-center justify-center rounded-[7px] border border-border bg-background">
                    <img
                      src={agentIconSrc(p.kind)}
                      alt={agentIconAlt(p.kind)}
                      className="size-4"
                    />
                  </span>
                  <span className="text-sm font-medium">{p.label}</span>
                  {p.plan ? (
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {p.plan}
                    </span>
                  ) : null}
                </div>
                {!p.available ? (
                  <span className="text-xs text-muted-foreground/70">unavailable</span>
                ) : null}
              </div>
              {p.available && p.windows?.length ? (
                <div className="space-y-2 pl-10">
                  {p.windows.map((w) => (
                    <UsageBar key={w.label} w={w} />
                  ))}
                </div>
              ) : (
                <p className="pl-10 text-xs text-muted-foreground">{p.note ?? "No data"}</p>
              )}
            </div>
          ))
        )}
      </div>
      <p className="px-4 text-xs text-muted-foreground">
        Claude reads the live subscription usage endpoint; Codex reflects the latest rate-limit
        snapshot from its most recent session.
      </p>
    </section>
  );
}

// Usage lives on its own page (opened from Settings) rather than inline, so the
// per-provider limit bars get the full width instead of crowding the settings list.
function UsagePage() {
  return (
    <div className="mx-auto max-w-xl space-y-8 pb-10">
      <UsageLimitsSection />
    </div>
  );
}

function ChangelogPage() {
  return (
    <div className="mx-auto max-w-xl space-y-5 pb-10">
      <article className="markdown rounded-2xl border border-border bg-card/40 px-4 py-4">
        <Streamdown>{changelogMarkdown}</Streamdown>
      </article>
    </div>
  );
}

function SettingsView({
  dark,
  toggleTheme,
  user,
  onOpenTerminal,
  onOpenBrowser,
  onOpenCodingAgents,
  onOpenAuto,
  onOpenUsage,
  onOpenChangelog,
  extTabs,
  onOpenExt,
}: {
  dark: boolean;
  toggleTheme: () => void;
  user: string | null;
  onOpenTerminal: () => void;
  onOpenBrowser: () => void;
  onOpenCodingAgents: () => void;
  onOpenAuto: () => void;
  onOpenUsage: () => void;
  onOpenChangelog: () => void;
  extTabs: ExtensionNavTab[];
  onOpenExt: (id: string) => void;
}) {
  const initial = (user ?? "").trim().slice(0, 1).toUpperCase() || "?";

  return (
    <div className="mx-auto max-w-xl space-y-8 pb-10">
      {/* Account */}
      <div className="flex items-center gap-3.5 px-1">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-secondary text-lg font-semibold text-muted-foreground">
          {initial}
        </div>
        <div className="min-w-0">
          <div className="truncate text-lg font-semibold leading-tight">
            {user ?? "No user selected"}
          </div>
          <div className="text-sm text-muted-foreground">
            {user ? "Signed in on this device" : "Pick your name in the top filter"}
          </div>
        </div>
      </div>

      {/* Usage — opens as its own page. */}
      <section className="space-y-2">
        <h2 className="px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Usage
        </h2>
        <div className="overflow-hidden rounded-2xl border border-border bg-card/40">
          <button
            type="button"
            onClick={onOpenUsage}
            className="flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left transition-colors duration-150 ease-ios hover:bg-foreground/[0.03] active:bg-foreground/[0.06]"
          >
            <div className="flex items-center gap-3">
              <span className="flex size-7 items-center justify-center rounded-[7px] bg-primary text-white">
                <Activity className="size-4" />
              </span>
              <span className="text-sm font-medium">Usage &amp; limits</span>
            </div>
            <ChevronRight className="size-4 text-muted-foreground/60" />
          </button>
        </div>
      </section>

      {/* Auto agents — opens as its own page. */}
      <section className="space-y-2">
        <h2 className="px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Automation
        </h2>
        <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
          <button
            type="button"
            onClick={onOpenCodingAgents}
            className="flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left transition-colors duration-150 ease-ios hover:bg-foreground/[0.03] active:bg-foreground/[0.06]"
          >
            <div className="flex items-center gap-3">
              <span className="flex size-7 items-center justify-center rounded-[7px] bg-foreground text-background">
                <Bot className="size-4" />
              </span>
              <span className="text-sm font-medium">Coding agents</span>
            </div>
            <ChevronRight className="size-4 text-muted-foreground/60" />
          </button>
          <button
            type="button"
            onClick={onOpenAuto}
            className="flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left transition-colors duration-150 ease-ios hover:bg-foreground/[0.03] active:bg-foreground/[0.06]"
          >
            <div className="flex items-center gap-3">
              <span className="flex size-7 items-center justify-center rounded-[7px] bg-primary text-white">
                <CalendarClock className="size-4" />
              </span>
              <span className="text-sm font-medium">Auto agents</span>
            </div>
            <ChevronRight className="size-4 text-muted-foreground/60" />
          </button>
        </div>
      </section>

      {/* Tools — open as their own pages. */}
      <section className="space-y-2">
        <h2 className="px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Tools
        </h2>
        <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
          <button
            type="button"
            onClick={onOpenTerminal}
            className="flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left transition-colors duration-150 ease-ios hover:bg-foreground/[0.03] active:bg-foreground/[0.06]"
          >
            <div className="flex items-center gap-3">
              <span className="flex size-7 items-center justify-center rounded-[7px] bg-foreground text-background">
                <TerminalSquare className="size-4" />
              </span>
              <span className="text-sm font-medium">Open terminal</span>
            </div>
            <ChevronRight className="size-4 text-muted-foreground/60" />
          </button>
          <button
            type="button"
            onClick={onOpenBrowser}
            className="flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left transition-colors duration-150 ease-ios hover:bg-foreground/[0.03] active:bg-foreground/[0.06]"
          >
            <div className="flex items-center gap-3">
              <span className="flex size-7 items-center justify-center rounded-[7px] bg-primary text-white">
                <Globe className="size-4" />
              </span>
              <span className="text-sm font-medium">Browser profiles</span>
            </div>
            <ChevronRight className="size-4 text-muted-foreground/60" />
          </button>
        </div>
      </section>

      {/* Extension tabs — each opens as its own page. */}
      {extTabs.length ? (
        <section className="space-y-2">
          <h2 className="px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Extensions
          </h2>
          <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
            {extTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onOpenExt(t.id)}
                className="flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left transition-colors duration-150 ease-ios hover:bg-foreground/[0.03] active:bg-foreground/[0.06]"
              >
                <div className="flex items-center gap-3">
                  <span className="flex size-7 items-center justify-center rounded-[7px] bg-foreground text-background">
                    {t.icon ?? <Flag className="size-4" />}
                  </span>
                  <span className="text-sm font-medium">{t.label}</span>
                </div>
                <ChevronRight className="size-4 text-muted-foreground/60" />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {/* Display */}
      <section className="space-y-2">
        <h2 className="px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Display
        </h2>
        <div className="overflow-hidden rounded-2xl border border-border bg-card/40">
          <div className="flex items-center justify-between gap-4 px-4 py-2.5">
            <div className="flex items-center gap-3">
              <span className="flex size-7 items-center justify-center rounded-[7px] bg-primary text-white">
                {dark ? <Moon className="size-4" /> : <Sun className="size-4" />}
              </span>
              <span className="text-sm font-medium">Dark mode</span>
            </div>
            <Switch
              checked={dark}
              onCheckedChange={toggleTheme}
              aria-label="Toggle dark mode"
            />
          </div>
        </div>
        <p className="px-4 text-xs text-muted-foreground">
          Follows your system appearance until you set it here.
        </p>
      </section>

      {/* Notifications */}
      <section className="space-y-2">
        <h2 className="px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Notifications
        </h2>
        <div className="overflow-hidden rounded-2xl border border-border bg-card/40">
          <div className="flex items-center justify-between gap-4 px-4 py-2.5">
            <div className="flex items-center gap-3">
              <span className="flex size-7 items-center justify-center rounded-[7px] bg-destructive text-white">
                <Bell className="size-4" />
              </span>
              <span className="text-sm font-medium">Push notifications</span>
            </div>
            <PushBell user={user} />
          </div>
        </div>
        <p className="px-4 text-xs text-muted-foreground">
          Get a push when one of your sessions needs you.
        </p>
      </section>

      <VoiceSettingsSection />

      {/* About */}
      <section className="space-y-2">
        <h2 className="px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          About
        </h2>
        <div className="overflow-hidden rounded-2xl border border-border bg-card/40">
          <button
            type="button"
            onClick={onOpenChangelog}
            className="flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left transition-colors duration-150 ease-ios hover:bg-foreground/[0.03] active:bg-foreground/[0.06]"
          >
            <div className="flex items-center gap-3">
              <span className="flex size-7 items-center justify-center rounded-[7px] bg-foreground text-background">
                <ScrollText className="size-4" />
              </span>
              <span className="text-sm font-medium">Changelog</span>
            </div>
            <ChevronRight className="size-4 text-muted-foreground/60" />
          </button>
        </div>
      </section>
    </div>
  );
}

function AutoManageView({
  autoAgents = [],
  findings = [],
  tz,
  onEdit,
  onRunNow,
}: {
  autoAgents: AutoAgent[];
  findings: AutoFinding[];
  tz: string;
  onEdit: (agent: AutoAgent | "new") => void;
  onRunNow: (id: string) => void;
}) {
  const openByAgent = (id: string) => findings.filter((f) => f.agentId === id).length;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-2">
      {autoAgents.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No auto agents yet. Create one — it's just a prompt and a schedule.
        </div>
      ) : (
        autoAgents.map((a) => (
          <div
            key={a.id}
            className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border border-border bg-card px-3 py-2"
          >
            <span
              className={cn(
                "order-1 size-2.5 shrink-0 rounded-full",
                a.enabled ? "bg-success" : "bg-muted-foreground/40",
              )}
            />
            <button
              type="button"
              onClick={() => onEdit(a)}
              className="order-2 min-w-0 flex-1 text-left"
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{a.name}</span>
                {openByAgent(a.id) ? (
                  <span className="shrink-0 rounded-full bg-primary/12 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                    {openByAgent(a.id)} open
                  </span>
                ) : null}
                {a.running ? (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/12 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                    <Loader2 className="size-2.5 animate-spin" /> running
                  </span>
                ) : null}
              </div>
              <div className="truncate text-xs text-muted-foreground">{a.prompt}</div>
            </button>
            {/* On phones this wraps to its own full-width line under the name; inline on sm+ */}
            <div className="order-5 flex w-full min-w-0 items-center gap-1 pl-5 text-xs text-muted-foreground sm:order-3 sm:w-auto sm:max-w-[11rem] sm:pl-0">
              <ScheduleSummary expr={a.schedule} tz={tz} />
            </div>
            <div className="order-6 flex w-full min-w-0 items-center gap-1 pl-5 text-xs text-muted-foreground sm:order-4 sm:w-auto sm:max-w-[10rem] sm:pl-0">
              <img
                src={agentIconSrc(a.agent ?? "aisdk")}
                alt=""
                className="size-3.5 shrink-0"
              />
              <span className="truncate">
                {AUTO_AGENT_OPTIONS.find((o) => o.key === (a.agent ?? "aisdk"))?.label ?? "claude"}
                {a.model ? <span className="text-muted-foreground/70"> · {a.model}</span> : null}
              </span>
            </div>
            <Button
              size="icon-sm"
              variant="tint"
              className="order-3 shrink-0 sm:order-5"
              onClick={() => onRunNow(a.id)}
              disabled={a.running}
              aria-label={a.running ? "Running…" : "Run now"}
            >
              {a.running ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
            </Button>
            <Button
              size="icon-sm"
              variant="tint"
              className="order-4 shrink-0 sm:order-6"
              onClick={() => onEdit(a)}
              aria-label="Edit"
            >
              <Pencil className="size-4" />
            </Button>
          </div>
        ))
      )}
      <button
        type="button"
        onClick={() => onEdit("new")}
        className="mt-1 flex items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-3 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-4" /> New auto agent
      </button>
    </div>
  );
}
