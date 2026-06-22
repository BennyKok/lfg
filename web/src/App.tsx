import { Component, lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import type {
  CSSProperties,
  ErrorInfo,
  FormEvent,
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
  ChevronRight,
  Code2,
  FlaskConical,
  Folder,
  Loader2,
  MessageSquare,
  Mic,
  Bell,
  BellOff,
  MoreVertical,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Pencil,
  Pin,
  Play,
  Plus,
  Power,
  Radio,
  RotateCcw,
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
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
// Code-split: the terminal pulls in ghostty-web's ~400KB WASM, so only load it
// when the Terminal tab is actually opened — keeps the initial bundle lean.
const TermView = lazy(() =>
  import("@/components/TermView").then((m) => ({ default: m.TermView })),
);
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
import { useExtensionNavTabs } from "./lib/extensions";
import {
  pushSupported,
  pushPermission,
  isSubscribed,
  enablePush,
  disablePush,
} from "./lib/push";
import { AskCenter } from "./components/ask-center";

type Agent = {
  name: string;
  title: string;
  enabled: boolean;
  inputCount: number;
  lastReport: ReportRef | null;
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
  agent?: "claude" | "aisdk" | "codex" | "codex-aisdk" | "opencode" | string;
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
  statusReason?: "model_unavailable" | "out_of_credits" | null;
  statusDetail?: string | null;
};

type User = { email: string; name?: string; avatar?: string };
type Repo = { name: string; cwd: string; custom?: boolean };

// Auto agents: a streamlined agent is JUST a prompt + a schedule. It emits
// findings (notifications), not reports.
type AutoAgent = {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  cwd?: string;
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
};

type PromptOption = { index: number; label: string; selected?: boolean };
type SessionPrompt = { question?: string; options: PromptOption[] };
type QueueMsg = {
  id: string;
  text: string;
  status: "pending" | "sending" | "queued" | "failed" | "delivered";
  error?: string;
};

const CLAUDE_MODELS = ["sonnet", "opus", "haiku", "fable"];
const CODEX_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
// Models the one-shot AI-SDK test option supports (the provider maps these
// aliases). Kept in sync with the AISDK_MODELS allowlist in serve.ts.
const AISDK_MODELS = ["opus", "sonnet", "haiku"];
const CODEX_AISDK_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
const OPENCODE_MODELS = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-haiku-4-5",
  "openai/gpt-5.5",
  "openai/gpt-5.4",
  "fugu/fugu",
  "fugu/fugu-ultra",
];
const THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
function savedThinkingLevel(): ThinkingLevel {
  const value = localStorage.getItem("lfg_thinking_level");
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : "medium";
}

type AgentKind = "claude" | "aisdk" | "codex" | "codex-aisdk" | "opencode";

// Per-agent model lists + default model, keyed by the backend agent-kind
// contract. The new-session dialog and session cards both read from here so the
// model picker stays correct per agent.
const AGENT_MODELS: Record<AgentKind, string[]> = {
  claude: CLAUDE_MODELS,
  aisdk: AISDK_MODELS,
  codex: CODEX_MODELS,
  "codex-aisdk": CODEX_AISDK_MODELS,
  opencode: OPENCODE_MODELS,
};
const AGENT_DEFAULT_MODEL: Record<AgentKind, string> = {
  claude: "sonnet",
  aisdk: "opus",
  codex: "gpt-5.5",
  "codex-aisdk": "gpt-5.5",
  opencode: "anthropic/claude-sonnet-4-6",
};

// New-session picker options, in display order. The three AI-SDK agents are the
// primary, always-visible choices ("aisdk" leads since it's the default); the
// two legacy CLI agents are tagged `cli` and tucked behind a disclosure toggle.
// Each carries a short label + a distinct lucide glyph for the toggle.
const AGENT_OPTIONS: { key: AgentKind; label: string; Icon: typeof Sparkles; cli?: boolean }[] = [
  { key: "aisdk", label: "claude (ai sdk)", Icon: Sparkles },
  { key: "codex-aisdk", label: "codex (ai sdk)", Icon: Braces },
  { key: "opencode", label: "opencode", Icon: Boxes },
  { key: "claude", label: "claude (cli)", Icon: FlaskConical, cli: true },
  { key: "codex", label: "codex (cli)", Icon: Code2, cli: true },
];

// Maps an agent-kind to its session-card / picker icon. codex variants share the
// codex mark; claude variants (incl. aisdk) share the claude mark.
function agentIconSrc(agent?: string): string {
  if (agent === "codex" || agent === "codex-aisdk") return "/agent-codex.svg";
  if (agent === "opencode") return "/agent-opencode.svg";
  return "/agent-claude.svg";
}
function agentIconAlt(agent?: string): string {
  if (agent === "codex" || agent === "codex-aisdk") return "Codex";
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
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `${res.status} ${res.statusText}`);
  }
  return data as T;
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
  void fetch(`/api/auto/findings/${findingId}/action`, {
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

// A human-friendly label for a project. The backend derives `project` from the
// session's cwd as a dash-joined path (e.g. "home-dev-repos-lfg"), so show the
// last path segment ("lfg") in compact UI like the filter menu.
function shortProject(project: string): string {
  const parts = project.split("-").filter(Boolean);
  return parts[parts.length - 1] || project;
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

// Push-to-talk dictation with optional hands-free auto-send. Tap to record, tap
// to stop → POST WAV to the server's Whisper proxy → hand the transcript back.
// `onText` receives the transcript on a manual stop (fill the input, let the
// user edit/send). When `onAutoSubmit` is supplied we also run voice-activity
// detection: once speech has been heard, `silenceMs` of quiet auto-stops the
// recording and routes the transcript to `onAutoSubmit` instead — fully
// hands-free (speak, pause, it sends).
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
    chunks: Float32Array[];
    rate: number;
    vad: number | null;
    interim: number | null;
    interimInFlight: boolean;
    abort: AbortController | null;
  } | null>(null);

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
        setState("idle");
        return;
      }
      if (s.vad !== null) clearInterval(s.vad);
      if (s.interim !== null) clearInterval(s.interim);
      s.abort?.abort();
      s.proc.disconnect();
      s.src.disconnect();
      s.stream.getTracks().forEach((t) => t.stop());
      await s.ac.close().catch(() => {});
      if (discard) {
        setState("idle");
        return;
      }
      const total = s.chunks.reduce((n, c) => n + c.length, 0);
      if (!total) {
        setState("idle");
        return;
      }
      const merged = new Float32Array(total);
      let offset = 0;
      for (const c of s.chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      setState("transcribing");
      try {
        const res = await fetch("/api/voice/stt", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: floatToWav(merged, s.rate),
        });
        const data = (await res.json().catch(() => ({}))) as { text?: string };
        const text = (data.text || "").trim();
        if (res.ok && text) {
          const base = capturedBaseRef.current;
          if (auto && onAutoSubmitRef.current) onAutoSubmitRef.current(text, base);
          else onTextRef.current(text, base);
        }
      } catch {
        /* swallow — the input is untouched, user can retry */
      }
      setState("idle");
    },
    [],
  );

  const start = useCallback(async () => {
    if (sessionRef.current) return;
    capturedBaseRef.current = baseTextRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ac = new Ctor();
      const src = ac.createMediaStreamSource(stream);
      const proc = ac.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
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
        if (!onAutoSubmitRef.current) return;
        if (rms > VOICE_RMS_THRESHOLD) {
          spoke = true;
          lastVoiceAt = Date.now();
        }
      };
      src.connect(proc);
      proc.connect(ac.destination);
      const vad = onAutoSubmitRef.current
        ? (setInterval(() => {
            if (!sessionRef.current || !spoke) return;
            if (Date.now() - lastVoiceAt >= silenceMs) void stop(true);
          }, 200) as unknown as number)
        : null;
      // Live partial transcription: every INTERIM_MS, re-transcribe the audio
      // captured so far against the existing batch /stt endpoint and surface it
      // as a live preview. We skip a tick while a request is still in flight so
      // the upstream whisper box isn't hammered with overlapping work, and we
      // drop any response that resolves after the session ended (stale partial).
      const interim = onInterimRef.current
        ? (setInterval(() => {
            void (async () => {
              const s = sessionRef.current;
              if (!s || s.interimInFlight) return;
              const total = s.chunks.reduce((n, c) => n + c.length, 0);
              if (total < s.rate * 0.4) return; // need ~0.4s before guessing
              const merged = new Float32Array(total);
              let off = 0;
              for (const c of s.chunks) {
                merged.set(c, off);
                off += c.length;
              }
              s.interimInFlight = true;
              s.abort = new AbortController();
              try {
                const res = await fetch("/api/voice/stt", {
                  method: "POST",
                  headers: { "Content-Type": "application/octet-stream" },
                  body: floatToWav(merged, s.rate),
                  signal: s.abort.signal,
                });
                const data = (await res.json().catch(() => ({}))) as { text?: string };
                const text = (data.text || "").trim();
                // Only apply if this is still the live session (drop stale results).
                if (res.ok && text && sessionRef.current === s && onInterimRef.current)
                  onInterimRef.current(text, capturedBaseRef.current);
              } catch {
                /* aborted on stop, or a transient error — next tick retries */
              } finally {
                if (sessionRef.current === s) s.interimInFlight = false;
              }
            })();
          }, 1500) as unknown as number)
        : null;
      sessionRef.current = {
        ac,
        stream,
        proc,
        src,
        chunks,
        rate: ac.sampleRate,
        vad,
        interim,
        interimInFlight: false,
        abort: null,
      };
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
    } catch {
      setState("idle");
    }
  }, [silenceMs, stop]);

  const toggle = useCallback(() => {
    if (state === "transcribing") return;
    if (sessionRef.current) void stop();
    else void start();
  }, [state, start, stop]);

  return { state, toggle, start, stop, supported, level };
}

function MicButton({
  onText,
  onAutoSubmit,
  onInterim,
  baseText,
  silenceMs,
  className,
}: {
  onText: (text: string, base: string) => void;
  onAutoSubmit?: (text: string, base: string) => void;
  onInterim?: (text: string, base: string) => void;
  baseText?: string;
  silenceMs?: number;
  className?: string;
}) {
  const { state, toggle, supported, level } = useDictation({
    onText,
    onAutoSubmit,
    onInterim,
    baseText,
    silenceMs,
  });
  if (!supported) return null;
  const recording = state === "recording";
  // While recording, the button reacts to the live mic level: it scales up and
  // throws a red glow ring that swells with your volume. Inline transitions keep
  // it snappy (the className `transition` would lag the per-frame updates by
  // ~150ms and make it feel sluggish).
  const reactiveStyle: CSSProperties | undefined = recording
    ? {
        transform: `scale(${(1 + level * 0.14).toFixed(3)})`,
        boxShadow: `0 0 ${(8 + level * 22).toFixed(1)}px ${(level * 5).toFixed(
          1,
        )}px color-mix(in srgb, var(--destructive) ${Math.round(
          35 + level * 55,
        )}%, transparent)`,
        transition: "transform 80ms linear, box-shadow 80ms linear",
      }
    : undefined;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={recording ? "Stop dictation" : "Dictate"}
      style={reactiveStyle}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full transition",
        recording
          ? "bg-destructive text-destructive-foreground"
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

function useLiveSessionStream(sessions: Session[]) {
  const ids = useMemo(
    () => sessions.map((session) => session.sessionId).filter((id): id is string => !!id),
    [sessions],
  );
  const streamKey = ids.join(",");
  const [messagesBySid, setMessagesBySid] = useState<Record<string, Message[]>>({});
  const [busyBySid, setBusyBySid] = useState<Record<string, boolean>>({});
  const [promptsBySid, setPromptsBySid] = useState<Record<string, SessionPrompt | null>>({});
  const [queuesBySid, setQueuesBySid] = useState<Record<string, QueueMsg[]>>({});
  const seenRef = useRef<Record<string, Set<string>>>({});
  // Per-session timers that auto-retire a lingering "thinking…" shimmer. A
  // thinking block is already complete by the time we read it from the
  // transcript, and the next content line can lag many seconds (model still
  // writing its answer), so without this the shimmer sticks long past the
  // thinking phase while the turn is still busy.
  const thinkTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const active = new Set(ids);
    seenRef.current = Object.fromEntries(
      Object.entries(seenRef.current).filter(([sid]) => active.has(sid)),
    );
    setMessagesBySid((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([sid]) => active.has(sid))),
    );
    setBusyBySid((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([sid]) => active.has(sid))),
    );
    setPromptsBySid((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([sid]) => active.has(sid))),
    );
    setQueuesBySid((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([sid]) => active.has(sid))),
    );

    if (!ids.length) return;
    const es = new EventSource(`/api/live/stream?ids=${ids.join(",")}`);

    es.addEventListener("msg", (event) => {
      const payload = JSON.parse(event.data) as { sid: string; m: Message };
      const sid = payload.sid;
      const message = payload.m;
      if (!active.has(sid)) return;
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

    es.addEventListener("busy", (event) => {
      const payload = JSON.parse(event.data) as { sid: string; busy: boolean };
      if (!active.has(payload.sid)) return;
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
      const payload = JSON.parse(event.data) as { sid: string; prompt: SessionPrompt | null };
      if (!active.has(payload.sid)) return;
      setPromptsBySid((prev) => ({ ...prev, [payload.sid]: payload.prompt }));
    });

    es.addEventListener("queue", (event) => {
      const payload = JSON.parse(event.data) as { sid: string; queue: QueueMsg[] };
      if (!active.has(payload.sid)) return;
      setQueuesBySid((prev) => ({ ...prev, [payload.sid]: payload.queue ?? [] }));
    });

    es.onerror = () => {
      // EventSource reconnects itself; keep existing pane state while it does.
    };

    return () => {
      es.close();
      for (const id of Object.keys(thinkTimerRef.current)) {
        clearTimeout(thinkTimerRef.current[id]);
        delete thinkTimerRef.current[id];
      }
    };
  }, [streamKey]);

  const addOptimisticMessage = useCallback((sid: string, text: string) => {
    const message: Message = {
      id: `optimistic-${Date.now()}`,
      role: "user",
      kind: "text",
      text,
      html: escapeHtml(text),
      ts: Date.now(),
      pending: true,
    };
    setMessagesBySid((prev) => ({
      ...prev,
      [sid]: [...(prev[sid] ?? []).filter((item) => item.kind !== "thinking"), message].slice(-80),
    }));
  }, []);

  return { messagesBySid, busyBySid, promptsBySid, queuesBySid, addOptimisticMessage };
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
    <Button
      variant="tint"
      size="icon-sm"
      onClick={toggle}
      disabled={busy}
      aria-label={on ? "Disable notifications" : "Enable notifications"}
      title={on ? "Notifications on" : "Enable notifications"}
    >
      {on ? <Bell className="size-4" /> : <BellOff className="size-4" />}
    </Button>
  );
}

export function App() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const rootRef = useRef<HTMLDivElement>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  // Legacy report-view selector — retained so the old AgentView effects compile,
  // but the live UI now switches on `tab` (Live / Auto), so this stays "__live".
  const [selected, setSelected] = useState("__live");
  const [reports, setReports] = useState<ReportRef[]>([]);
  const [report, setReport] = useState<AgentReport | null>(null);
  const [selectedReportDate, setSelectedReportDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [runLog, setRunLog] = useState<string | null>(null);
  // Auto agents
  // Base tabs are "live" | "auto"; runtime extensions contribute more (their
  // nav-tab id becomes a valid tab value), so this is a plain string.
  const [tab, setTab] = useState<string>("live");
  const extNavTabs = useExtensionNavTabs();
  const allTabIds = ["live", "auto", ...extNavTabs.map((t) => t.id), "settings"];
  const tabIndex = Math.max(0, allTabIds.indexOf(tab));
  const activeExtTab = extNavTabs.find((t) => t.id === tab);
  const [autoAgents, setAutoAgents] = useState<AutoAgent[]>([]);
  const [schedTz, setSchedTz] = useState<string>(DEFAULT_SCHED_TZ);
  const [findings, setFindings] = useState<AutoFinding[]>([]);
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
  //   • `<main>` reserves `pb-28` for the floating nav pill, and the pill itself
  //     sits over the keyboard region. While the keyboard is open we collapse
  //     that padding and hide the pill (see `keyboardOpen`) so the terminal
  //     fills right up to the keyboard instead of floating above a gap.
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
      setKeyboardOpen(window.innerHeight - vv.height > 120);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      clear();
    };
  }, [loading, tab]);

  const loadCore = useCallback(async () => {
    const [agentsPayload, sessionsPayload, usersPayload, reposPayload] =
      await Promise.all([
        api<{ agents: Agent[] }>("/api/agents"),
        api<{ sessions: Session[] }>("/api/sessions"),
        api<{ users: User[] }>("/api/users"),
        api<{ repos: Repo[] }>("/api/repos"),
      ]);
    setAgents(agentsPayload.agents ?? []);
    // Guard sessions to [] — it feeds `allLiveSessions`/`liveSessions` which call
    // `.filter()` unconditionally on render, so a malformed/empty payload must
    // degrade to an empty live view rather than crash it (undefined.filter).
    setSessions(sessionsPayload.sessions ?? []);
    setUsers(usersPayload.users ?? []);
    setRepos(reposPayload.repos ?? []);
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
    for (const f of findingList) {
      if (seenFindings.current.has(f.id)) continue;
      seenFindings.current.add(f.id);
      const name = (ag.agents ?? []).find((a) => a.id === f.agentId)?.name ?? f.agentId;
      // Announce the finding via the shared Sonner toast system.
      toast.custom(
        (id) => (
          <button
            type="button"
            onClick={() => {
              setTab("live");
              setOpenFinding(f);
              toast.dismiss(id);
            }}
            className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-2xl border border-border bg-card/95 px-3.5 py-3 text-left shadow-[0_8px_28px_rgba(0,0,0,0.22)] backdrop-blur-xl"
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
        { duration: 6500 },
      );
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    const payload = await api<{ sessions: Session[] }>("/api/sessions");
    // Guard to [] — `sessions` is consumed by `.filter()`/`.map()` on render
    // (allLiveSessions) and just below, so a missing field must not crash.
    const sessionList = payload.sessions ?? [];
    setSessions(sessionList);
    // Prune tombstones the server has finally forgotten, so the set can't grow
    // unbounded and a recycled sid is never wrongly suppressed.
    setRemovedSids((prev) => {
      if (!prev.size) return prev;
      const present = new Set(sessionList.map((s) => s.sessionId));
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  // Hands-free session creation from the FAB's hold-to-talk gesture. There's no
  // dialog here, so we reuse the same defaults the New Session dialog persists
  // (last agent/model/repo/owner) and fall back to the active filter / first
  // known repo+user. If there's no repo to run in we can't create blind, so we
  // open the full dialog instead of failing silently.
  //
  // The spawn is slow (tmux + agent boot), so we DON'T block on it: jump to the
  // live view immediately and hand the request to a sonner toast that shows a
  // loading spinner → success/error on its own. The caller isn't awaited.
  const createVoiceSession = useCallback(
    async (prompt: string) => {
      const agent = (localStorage.getItem("lfg_v2_agent") as AgentKind | null) || "aisdk";
      const model =
        localStorage.getItem(`lfg_model_${agent}`) ||
        localStorage.getItem("lfg_model") ||
        AGENT_DEFAULT_MODEL[agent];
      const cwd = localStorage.getItem("lfg_v2_repo") || repos[0]?.cwd || "";
      const owner =
        (userFilter !== "__all" && userFilter !== "__unassigned" ? userFilter : "") ||
        localStorage.getItem("lfg_user") ||
        users[0]?.email ||
        "";
      if (!cwd) {
        setNewOpen(true);
        return;
      }
      setTab("live");
      toast.promise(
        api("/api/sessions/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cwd,
            prompt,
            user: owner || undefined,
            agent,
            model,
          }),
        }).then(() => refreshSessions()),
        {
          loading: "Creating session…",
          success: "Session started",
          error: (e) => (e instanceof Error ? e.message : "Couldn't create session"),
        },
      );
    },
    [repos, users, userFilter, refreshSessions],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadCore(), refreshAuto().catch(() => {})])
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
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

  // Unique projects present across the (user-filtered) live sessions, so the
  // project menu only ever offers projects you can actually see.
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
        new Set(userScopedSessions.map((s) => s.project).filter((p): p is string => !!p)),
      ).sort((a, b) => shortProject(a).localeCompare(shortProject(b))),
    [userScopedSessions],
  );

  // If the chosen project disappears (sessions ended, or it's hidden by the
  // current user filter), fall back to "all" rather than showing nothing.
  useEffect(() => {
    if (projectFilter !== "__all" && !projectOptions.includes(projectFilter)) {
      setProjectFilter("__all");
    }
  }, [projectFilter, projectOptions]);

  const liveSessions = useMemo(() => {
    if (projectFilter === "__all") return userScopedSessions;
    return userScopedSessions.filter((session) => session.project === projectFilter);
  }, [userScopedSessions, projectFilter]);

  const liveStream = useLiveSessionStream(liveSessions);

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
      const events = new EventSource(`/api/agents/${agent}/runs/${start.runId}`);
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

  // Reply graduates a finding into a real Claude session, seeded with the
  // finding's context plus the user's instruction.
  async function replyToFinding(f: AutoFinding, text: string) {
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
    // selected repo only if the agent has no base; (3) leave `agent` unset so it
    // takes the default aisdk path, which the live-view filter admits explicitly.
    const agentCwd = autoAgents.find((a) => a.id === f.agentId)?.cwd;
    const cwd = agentCwd || localStorage.getItem("lfg_v2_repo") || repos[0]?.cwd || "";
    const owner =
      (userFilter !== "__all" && userFilter !== "__unassigned" ? userFilter : "") ||
      localStorage.getItem("lfg_user") ||
      users[0]?.email ||
      "";
    setOpenFinding(null);
    try {
      await api("/api/sessions/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: cwd || undefined,
          prompt: composed,
          user: owner || undefined,
        }),
      });
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
  function createAutoAgent(idea: string, cwd: string | undefined) {
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

  if (loading) return <AppShellSkeleton />;

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

  return (
    <div ref={rootRef} className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background/90 px-3 backdrop-blur">
        <img src="/icon.svg" alt="lfg" className="size-6 shrink-0" />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold">
          {activeExtTab ? activeExtTab.label : tab === "auto" ? "Auto agents" : tab === "term" ? "Terminal" : tab === "settings" ? "Settings" : ""}
        </div>

        {tab === "live" ? (
          <>
            <ProjectFilterMenu
              value={projectFilter}
              projects={projectOptions}
              onChange={setProjectFilter}
            />
            <UserFilterMenu
              value={userFilter}
              users={users}
              onChange={changeUserFilter}
            />
          </>
        ) : null}
      </header>

      {error ? (
        <div className="mx-3 mt-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <main className={`min-h-0 flex-1 overflow-y-auto px-3 pt-3 ${keyboardOpen ? "pb-3" : "pb-28"}`}>
        {tab === "live" ? (
          <LiveView
            sessions={liveSessions}
            users={users}
            userFilter={userFilter}
            messagesBySid={liveStream.messagesBySid}
            busyBySid={liveStream.busyBySid}
            promptsBySid={liveStream.promptsBySid}
            queuesBySid={liveStream.queuesBySid}
            onOptimisticMessage={liveStream.addOptimisticMessage}
            onRefresh={refreshSessions}
            onRemove={removeSession}
            onNew={() => setNewOpen(true)}
            findings={findings}
            autoAgents={autoAgents}
            onOpenFinding={setOpenFinding}
          />
        ) : tab === "auto" ? (
          <AutoManageView
            autoAgents={autoAgents}
            findings={findings}
            tz={schedTz}
            onEdit={setEditingAgent}
            onRunNow={runAutoNow}
          />
        ) : tab === "term" ? (
          <Suspense fallback={<div className="py-10 text-center text-sm text-muted-foreground">Loading terminal…</div>}>
            <TermView />
          </Suspense>
        ) : tab === "settings" ? (
          <SettingsView
            dark={dark}
            toggleTheme={toggleTheme}
            user={userFilter !== "__all" && userFilter !== "__unassigned" ? userFilter : null}
            onOpenTerminal={() => setTab("term")}
          />
        ) : (
          activeExtTab?.render() ?? null
        )}
      </main>

      {/* floating pill nav + new-session FAB */}
      <div className={`pointer-events-none fixed inset-x-0 bottom-0 z-50 flex items-center justify-center gap-2.5 px-4 pb-[calc(0.875rem+env(safe-area-inset-bottom))] ${keyboardOpen ? "hidden" : ""}`}>
        <div className="pointer-events-auto rounded-full bg-gradient-to-b from-white/70 via-white/25 to-white/10 p-px shadow-[0_8px_28px_rgba(0,0,0,0.18)] dark:from-white/25 dark:via-white/10 dark:to-white/5">
          <nav className="relative flex items-center gap-1 rounded-full bg-background/85 p-1.5 backdrop-blur-xl">
            <span
              aria-hidden
              className="absolute inset-y-1.5 left-1.5 w-[4.5rem] rounded-full bg-primary/12 transition-transform duration-[260ms] ease-ios"
              style={{ transform: `translateX(calc(${tabIndex} * (4.5rem + 0.25rem)))` }}
            />
            <PillTab
              active={tab === "live"}
              onClick={() => setTab("live")}
              icon={<Radio className="size-[18px]" />}
              label="Live"
            />
            <PillTab
              active={tab === "auto"}
              onClick={() => setTab("auto")}
              icon={<CalendarClock className="size-[18px]" />}
              label="Auto"
            />
            {extNavTabs.map((t) => (
              <PillTab
                key={t.id}
                active={tab === t.id}
                onClick={() => setTab(t.id)}
                icon={t.icon ?? <Flag className="size-[18px]" />}
                label={t.label}
              />
            ))}
            <PillTab
              active={tab === "settings"}
              onClick={() => setTab("settings")}
              icon={<Settings className="size-[18px]" />}
              label="Settings"
            />
          </nav>
        </div>
        <NewSessionFab onOpenDialog={() => setNewOpen(true)} onCreateVoice={createVoiceSession} />
      </div>

      <VoiceOrb />

      <AskCenter />

      {openFinding ? (
        <FindingSheet
          finding={openFinding}
          agentName={agentName(openFinding.agentId)}
          onClose={() => setOpenFinding(null)}
          onReply={replyToFinding}
          onDismiss={dismissFinding}
        />
      ) : null}

      {editingAgent === "new" ? (
        <NewAutoAgentComposer
          repos={repos}
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
        onReposChanged={loadCore}
        defaultUser={
          userFilter !== "__all" && userFilter !== "__unassigned" ? userFilter : ""
        }
        onClose={() => setNewOpen(false)}
        onCreated={async () => {
          setNewOpen(false);
          setTab("live");
          await refreshSessions();
        }}
      />

      <Toaster position="bottom-center" />
    </div>
  );
}

function PillTab({
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
        "relative flex w-[4.5rem] flex-col items-center gap-0.5 rounded-full px-4 py-1.5 transition-[color,transform] duration-200 ease-out",
        active ? "text-primary" : "text-muted-foreground hover:text-foreground active:scale-[0.96]",
      )}
    >
      {icon}
      <span className="text-[10.5px] font-medium tracking-[-0.01em]">{label}</span>
    </button>
  );
}

// How long the pointer must stay down before the press becomes a hold-to-talk.
// Below this it's treated as a tap → open the full New Session dialog.
const FAB_LONG_PRESS_MS = 280;
// Drag the finger up past this many px (from where the press started) to arm the
// cancel — release inside the zone discards the recording instead of creating.
const FAB_CANCEL_DY = 90;

// The new-session control that lives next to the bottom nav. A quick tap opens
// the full New Session dialog; a press-and-hold drops straight into voice input
// with a live transcript on screen — release to create a session from what you
// said, or slide up past the cancel line and release to throw it away.
function NewSessionFab({
  onOpenDialog,
  onCreateVoice,
}: {
  onOpenDialog: () => void;
  onCreateVoice: (prompt: string) => Promise<void>;
}) {
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState("");
  const [willCancel, setWillCancel] = useState(false);
  // Refs shadow the state so the window-level pointer handlers (which close over
  // a single render) always read the live value rather than a stale snapshot.
  const recordingRef = useRef(false);
  const cancelRef = useRef(false);
  const startYRef = useRef(0);
  const pressTimerRef = useRef<number | null>(null);

  const { state, supported, level, start, stop } = useDictation({
    onText: (text) => {
      const t = text.trim();
      if (t) void onCreateVoice(t);
    },
    onInterim: (text) => setInterim(text),
  });

  const beginRecord = useCallback(() => {
    recordingRef.current = true;
    cancelRef.current = false;
    setWillCancel(false);
    setInterim("");
    setRecording(true);
    haptic("medium");
    void start();
  }, [start]);

  // Gesture tracking is bound to the button via EXPLICIT pointer capture
  // (setPointerCapture in onDown), not window listeners. The recording overlay
  // mounts on top at z-60 mid-gesture; without explicit capture the browser's
  // implicit touch capture gets disrupted once that element paints over the
  // button, so pointermove/pointerup stop arriving and slide-up/release silently
  // break. Capturing the pointerId to the button guarantees every event for this
  // one touch is delivered here regardless of what's painted above it.
  const onMove = useCallback((e: React.PointerEvent) => {
    if (!recordingRef.current) return;
    const dy = startYRef.current - e.clientY;
    const c = dy > FAB_CANCEL_DY;
    if (c !== cancelRef.current) {
      cancelRef.current = c;
      setWillCancel(c);
      haptic(c ? "warning" : "light");
    }
  }, []);

  const onUp = useCallback(
    (e: React.PointerEvent) => {
      if (pressTimerRef.current !== null) {
        clearTimeout(pressTimerRef.current);
        pressTimerRef.current = null;
      }
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* capture may already be gone (e.g. pointercancel) — fine */
      }
      if (recordingRef.current) {
        recordingRef.current = false;
        setRecording(false);
        const cancel = cancelRef.current;
        cancelRef.current = false;
        setWillCancel(false);
        haptic(cancel ? "light" : "success");
        void stop(false, cancel);
      } else {
        // Released before the hold threshold — treat as a tap.
        onOpenDialog();
      }
    },
    [stop, onOpenDialog],
  );

  const onDown = useCallback(
    (e: React.PointerEvent) => {
      if (state === "transcribing") return;
      startYRef.current = e.clientY;
      // Route all subsequent events for this pointer to the button itself.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* unsupported — falls back to normal target/bubble routing */
      }
      pressTimerRef.current = window.setTimeout(() => {
        pressTimerRef.current = null;
        if (supported) beginRecord();
      }, FAB_LONG_PRESS_MS);
    },
    [state, supported, beginRecord],
  );

  useEffect(
    () => () => {
      if (pressTimerRef.current !== null) clearTimeout(pressTimerRef.current);
    },
    [],
  );

  const transcribing = state === "transcribing";
  const overlayOpen = recording || transcribing;

  return (
    <>
      <div className="pointer-events-auto rounded-full bg-gradient-to-b from-white/70 via-white/25 to-white/10 p-px shadow-[0_8px_28px_rgba(0,0,0,0.18)] dark:from-white/25 dark:via-white/10 dark:to-white/5">
        <button
          type="button"
          aria-label="New session — tap to compose, hold to dictate"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            touchAction: "none",
            ...(recording
              ? {
                  transform: `scale(${(1 + level * 0.14).toFixed(3)})`,
                  boxShadow: `0 0 ${(10 + level * 26).toFixed(1)}px ${(level * 6).toFixed(
                    1,
                  )}px color-mix(in srgb, var(--destructive) ${Math.round(
                    35 + level * 55,
                  )}%, transparent)`,
                  transition: "transform 80ms linear, box-shadow 80ms linear",
                }
              : undefined),
          }}
          className={cn(
            "grid size-[3.25rem] select-none place-items-center rounded-full transition-colors",
            recording
              ? "bg-destructive text-destructive-foreground"
              : "bg-primary text-primary-foreground active:scale-[0.96]",
          )}
        >
          {transcribing ? (
            <Loader2 className="size-5 animate-spin" />
          ) : recording ? (
            <Mic className="size-5" />
          ) : (
            <Plus className="size-5" />
          )}
        </button>
      </div>

      {overlayOpen ? (
        <div className="pointer-events-none fixed inset-0 z-[60] flex flex-col items-center justify-between bg-background/80 px-6 pb-40 pt-[calc(env(safe-area-inset-top)+2rem)] backdrop-blur-md">
          {/* slide-up-to-cancel target */}
          <div
            className={cn(
              "flex flex-col items-center gap-2 transition-colors",
              willCancel ? "text-destructive" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "grid size-12 place-items-center rounded-full border transition-all",
                willCancel
                  ? "scale-110 border-destructive bg-destructive/15 text-destructive"
                  : "border-border bg-card/60",
              )}
            >
              <X className="size-5" />
            </span>
            <span className="text-xs font-medium">
              {willCancel ? "Release to cancel" : "Slide up to cancel"}
            </span>
          </div>

          {/* live transcript */}
          <div className="flex w-full max-w-md flex-1 items-center justify-center py-6">
            {transcribing ? (
              <p className="text-center text-base font-medium text-muted-foreground">
                Transcribing…
              </p>
            ) : interim ? (
              <p
                className={cn(
                  "text-center text-xl font-medium leading-relaxed transition-opacity",
                  willCancel ? "opacity-40" : "opacity-100",
                )}
              >
                {interim}
              </p>
            ) : (
              <p className="text-center text-base text-muted-foreground">Listening…</p>
            )}
          </div>

          {/* mic level pulse sitting above the FAB */}
          <div className="flex flex-col items-center gap-3">
            <span
              aria-hidden
              className="grid place-items-center rounded-full bg-destructive text-destructive-foreground"
              style={{
                width: "3.25rem",
                height: "3.25rem",
                transform: `scale(${(1 + level * 0.18).toFixed(3)})`,
                boxShadow: `0 0 ${(12 + level * 30).toFixed(1)}px ${(level * 7).toFixed(
                  1,
                )}px color-mix(in srgb, var(--destructive) ${Math.round(
                  40 + level * 50,
                )}%, transparent)`,
                transition: "transform 80ms linear, box-shadow 80ms linear",
              }}
            >
              <Mic className="size-5" />
            </span>
            <span className="text-xs text-muted-foreground">Release to create session</span>
          </div>
        </div>
      ) : null}
    </>
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
  return (
    <label
      className={cn(
        "relative inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted/70",
        active ? "text-primary" : "text-foreground",
      )}
      aria-label="Filter live sessions by user"
    >
      <UserRound className="size-4 shrink-0" />
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Filter live sessions by user"
        className="absolute inset-0 cursor-pointer appearance-none bg-transparent text-transparent opacity-0 outline-none"
      >
        <option value="__all">All</option>
        <option value="__unassigned">Unassigned</option>
        {users.map((user) => (
          <option key={user.email} value={user.email}>
            {user.name ?? shortUser(user.email)}
          </option>
        ))}
      </select>
    </label>
  );
}

function ProjectFilterMenu({
  value,
  projects,
  onChange,
}: {
  value: string;
  projects: string[];
  onChange: (value: string) => void;
}) {
  const active = value !== "__all";
  return (
    <label
      className={cn(
        "relative inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted/70",
        active ? "text-primary" : "text-foreground",
      )}
      aria-label="Filter live sessions by project"
      title={active ? shortProject(value) : "All projects"}
    >
      <Folder className="size-4 shrink-0" />
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Filter live sessions by project"
        className="absolute inset-0 cursor-pointer appearance-none bg-transparent text-transparent opacity-0 outline-none"
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
          <img src="/icon.svg" alt="lfg" className="size-7 shrink-0" />
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
      } else if (!(sid in cur)) {
        patch[sid] = false;
      }
    }
    if (Object.keys(patch).length) setStable((p) => ({ ...p, ...patch }));
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
  messagesBySid,
  busyBySid,
  promptsBySid,
  queuesBySid,
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
  messagesBySid: Record<string, Message[]>;
  busyBySid: Record<string, boolean>;
  promptsBySid: Record<string, SessionPrompt | null>;
  queuesBySid: Record<string, QueueMsg[]>;
  onOptimisticMessage: (sid: string, text: string) => void;
  onRefresh: () => Promise<void>;
  onRemove: (sid: string) => void;
  onNew: () => void;
  findings: AutoFinding[];
  autoAgents: AutoAgent[];
  onOpenFinding: (f: AutoFinding) => void;
}) {
  const isWide = useIsWide();
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
  const working = sessions.filter((session) => !!busyBySid[session.sessionId ?? ""]);
  const idle = sessions.filter((session) => !busyBySid[session.sessionId ?? ""]);
  const nameFor = (id: string) => autoAgents.find((a) => a.id === id)?.name ?? id;

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
        prompt={promptsBySid[session.sessionId ?? ""] ?? null}
        queue={queuesBySid[session.sessionId ?? ""] ?? EMPTY_QUEUE}
        onOptimisticMessage={onOptimisticMessage}
        onRefresh={onRefresh}
        onRemove={onRemove}
      />
    </ErrorBoundary>
  );

  if (isWide) {
    return (
      <RailStage
        sessions={sessions}
        users={users}
        messagesBySid={messagesBySid}
        busyBySid={busyBySid}
        promptsBySid={promptsBySid}
        queuesBySid={queuesBySid}
        onOptimisticMessage={onOptimisticMessage}
        onRefresh={onRefresh}
        onRemove={onRemove}
        findings={findings}
        nameFor={nameFor}
        onOpenFinding={onOpenFinding}
      />
    );
  }

  return (
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
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-2">
            {idle.map(renderCard)}
          </div>
        </section>
      ) : null}
    </div>
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
  messagesBySid,
  busyBySid,
  promptsBySid,
  queuesBySid,
  onOptimisticMessage,
  onRefresh,
  onRemove,
  findings = [],
  nameFor,
  onOpenFinding,
}: {
  sessions: Session[];
  users: User[];
  messagesBySid: Record<string, Message[]>;
  busyBySid: Record<string, boolean>;
  promptsBySid: Record<string, SessionPrompt | null>;
  queuesBySid: Record<string, QueueMsg[]>;
  onOptimisticMessage: (sid: string, text: string) => void;
  onRefresh: () => Promise<void>;
  onRemove: (sid: string) => void;
  findings: AutoFinding[];
  nameFor: (id: string) => string;
  onOpenFinding: (f: AutoFinding) => void;
}) {
  const MAX_COLUMNS = 4;
  const [pinned, setPinned] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("lfg_stage_pinned");
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [preview, setPreview] = useState<string | null>(null);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(
    () => localStorage.getItem("lfg_rail_collapsed") === "1",
  );
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

  // Persist the pinned set so the workspace survives reloads.
  useEffect(() => {
    try {
      localStorage.setItem("lfg_stage_pinned", JSON.stringify(pinned));
    } catch {
      /* private mode / quota — non-fatal */
    }
  }, [pinned]);
  useEffect(() => {
    try {
      localStorage.setItem("lfg_rail_collapsed", railCollapsed ? "1" : "0");
    } catch {
      /* non-fatal */
    }
  }, [railCollapsed]);

  const validPinned = useMemo(() => pinned.filter((id) => bySid.has(id)), [pinned, bySid]);
  const columnIds = useMemo(() => {
    const cols = [...validPinned];
    if (preview && bySid.has(preview) && !cols.includes(preview) && cols.length < MAX_COLUMNS) {
      cols.push(preview);
    }
    return cols.slice(0, MAX_COLUMNS);
  }, [validPinned, preview, bySid]);

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

  // Flat rail order the keyboard cursor walks (Working then Idle; findings are
  // not navigable). Keep the cursor pointing at a live session.
  const orderedSids = useMemo(
    () => [...working, ...idle].map((s) => s.sessionId ?? "").filter(Boolean),
    [working, idle],
  );
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

  // Latest values for the global key handler, so it binds once but never reads
  // stale state.
  const kb = useRef({ orderedSids, cursor, preview, columnIds, activate, selectTo, togglePin, closeColumn, setCursor, setPreview, setRailCollapsed, setShowHelp, showHelp, busyBySid, interruptSid });
  kb.current = { orderedSids, cursor, preview, columnIds, activate, selectTo, togglePin, closeColumn, setCursor, setPreview, setRailCollapsed, setShowHelp, showHelp, busyBySid, interruptSid };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = kb.current;
      const order = s.orderedSids;
      const cur = s.cursor && order.includes(s.cursor) ? s.cursor : order[0] ?? null;

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
      const move = (delta: number, shift: boolean) => {
        if (!order.length) return;
        const next = order[Math.max(0, Math.min(order.length - 1, idx + delta))];
        if (!next) return;
        if (shift) {
          // Extend the selection from the anchor and tile it.
          if (!anchorRef.current) anchorRef.current = cur ?? next;
          s.setCursor(next);
          s.selectTo(next);
        } else {
          anchorRef.current = next;
          s.setCursor(next);
        }
      };

      switch (e.key) {
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
        case "j":
        case "ArrowDown":
          e.preventDefault();
          move(1, e.shiftKey);
          return;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          move(-1, e.shiftKey);
          return;
        case "o":
        case "Enter":
          if (cur) {
            e.preventDefault();
            s.activate(cur, e.shiftKey);
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

  return (
    <div className="flex h-full min-h-0 gap-3">
      <aside
        className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card/40 transition-[width] duration-200 ease-ios"
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
          {working.length ? (
            <RailGroup label="Working" count={working.length} collapsed={railCollapsed}>
              {working.map(renderRailItem)}
            </RailGroup>
          ) : null}
          {findings.length && !railCollapsed ? (
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
          ) : null}
          {idle.length ? (
            <RailGroup label="Idle" count={idle.length} collapsed={railCollapsed}>
              {idle.map(renderRailItem)}
            </RailGroup>
          ) : null}
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
              <div key={sid} className="h-full min-h-0 min-w-0">
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
                    prompt={promptsBySid[sid] ?? null}
                    queue={queuesBySid[sid] ?? EMPTY_QUEUE}
                    onOptimisticMessage={onOptimisticMessage}
                    onRefresh={onRefresh}
                    onRemove={onRemove}
                    variant="stage"
                    onClose={() => closeColumn(sid)}
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
    ["j / ↓ · k / ↑", "Move cursor down / up the rail"],
    ["Enter / o", "Open cursored session"],
    ["p", "Pin / unpin cursored session"],
    ["x", "Close cursored column"],
    ["1 – 9", "Open the Nth session"],
    ["\\", "Collapse / expand the rail"],
    ["?", "Toggle this help"],
    ["Esc", "Close help / preview"],
  ];
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-4 shadow-[0_8px_28px_rgba(0,0,0,0.22)]"
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
          "group relative flex cursor-pointer touch-pan-y select-none items-center gap-2 rounded-lg py-1.5 outline-none",
          collapsed ? "justify-center px-0" : "px-2",
          swiping ? "bg-card" : active ? "bg-primary/10" : "hover:bg-muted",
        )}
      >
        {active ? (
          <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" aria-hidden />
        ) : null}
        <span
          aria-label={busy ? "working" : "idle"}
          className={cn(
            "size-2 shrink-0 rounded-full",
            busy ? "animate-pulse bg-warning" : "bg-success/30 ring-1 ring-inset ring-success/20",
          )}
        />
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
}: {
  label: string;
  count: number;
  dotClass: string;
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
  const canSwitch =
    reason === "model_unavailable" && session.agent === "claude" && !!session.tmuxTarget && !!sid;

  async function resumeOnOpus() {
    if (!sid) return;
    setWorking(true);
    setErr(null);
    try {
      await api(`/api/sessions/${sid}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "opus" }),
      });
      await onRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  const title = reason === "out_of_credits" ? "Build paused — out of credits" : "Build paused";
  const detail =
    reason === "out_of_credits"
      ? "This app's build agent ran out of AI credits. Top up the wallet to resume the build."
      : `${session.statusDetail || "The selected model isn't available."} Switch to a working model to pick the build back up.`;

  return (
    <div className="border-b border-warning/30 bg-warning/12 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-warning">⏸ {title}</div>
          <div className="mt-0.5 text-foreground/70">{detail}</div>
          {err ? <div className="mt-1 text-destructive">{err}</div> : null}
        </div>
        {canSwitch ? (
          <button
            type="button"
            onClick={resumeOnOpus}
            disabled={working}
            className="shrink-0 rounded-lg bg-warning px-3 py-1.5 font-medium text-white disabled:opacity-50"
          >
            {working ? "Resuming…" : "Resume on Opus"}
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
  prompt,
  queue,
  error,
  onError,
  onOptimisticMessage,
  onRefresh,
  onCollapse,
}: {
  session: Session;
  messages: Message[];
  busy: boolean;
  prompt: SessionPrompt | null;
  queue: QueueMsg[];
  error: string | null;
  onError: (error: string | null) => void;
  onOptimisticMessage: (sid: string, text: string) => void;
  onRefresh: () => Promise<void>;
  onCollapse?: () => void;
}) {
  const sid = session.sessionId;
  const [messageText, setMessageText] = useState("");
  const [sending, setSending] = useState(false);

  async function sendMessage(e?: FormEvent, overrideText?: string) {
    e?.preventDefault();
    const text = (overrideText ?? messageText).trim();
    if (!sid || !text) return;
    setSending(true);
    onError(null);
    setMessageText("");
    onOptimisticMessage(sid, text);
    onCollapse?.(); // tuck the card away while it works (auto-expands when done)
    try {
      await api(`/api/sessions/${sid}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setMessageText(text);
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
      <ChatStream messages={messages} busy={busy} />

      <PromptPanel prompt={prompt} sid={sid} onError={onError} />
      <QueuePanel queue={queue} sid={sid} messages={messages} />

      {error ? (
        <div className="border-t border-border/70 px-3 py-1.5 text-xs text-destructive">{error}</div>
      ) : null}

      {canDriveSession(session) ? (
        <form onSubmit={sendMessage} className="flex gap-2 border-t border-border/70 bg-muted/35 p-2">
          <input
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Message"
            className="h-11 min-w-0 flex-1 rounded-full border border-input bg-background px-4 text-base outline-none focus:border-primary md:h-9 md:px-3.5 md:text-sm"
          />
          <MicButton
            className="size-11 md:size-9"
            silenceMs={2500}
            baseText={messageText}
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
          <Button
            size="icon"
            className="size-11 md:size-9"
            type="submit"
            disabled={sending || !messageText.trim()}
          >
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </Button>
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

function SessionTitleSheet({
  session,
  messages,
  busy,
  prompt,
  queue,
  origin,
  onOptimisticMessage,
  onRefresh,
  onClose,
}: {
  session: Session;
  messages: Message[];
  busy: boolean;
  prompt: SessionPrompt | null;
  queue: QueueMsg[];
  origin: DOMRect;
  onOptimisticMessage: (sid: string, text: string) => void;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);

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

  // Escape-to-close + lock background scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [requestClose]);

  const title = titleForSession(session);

  return createPortal(
    <div className="fixed inset-0 z-[90]">
      <div
        ref={backdropRef}
        onClick={requestClose}
        className="absolute inset-0 bg-black/50 supports-backdrop-filter:backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ transformOrigin: "top left", willChange: "transform" }}
        className="absolute inset-0 flex flex-col overflow-hidden bg-background text-foreground"
      >
        <div
          className="flex items-center gap-3 border-b border-border px-4 pb-3"
          style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.75rem)" }}
        >
          <img
            src={agentIconSrc(session.agent)}
            alt={agentIconAlt(session.agent)}
            className="size-7 shrink-0 rounded-lg"
          />
          <div className="min-w-0 flex-1 text-[17px] font-semibold leading-tight">
            {title}
          </div>
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
            prompt={prompt}
            queue={queue}
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

// memo'd: an SSE event for one session replaces the messagesBySid/etc. Record
// reference, re-rendering LiveView's map. Without memo every card re-renders;
// with it, only the card whose own message/busy/queue reference changed does —
// so swipe + collapse animations aren't fighting full-list re-renders.
const SessionCard = memo(function SessionCard({
  session,
  users,
  messages,
  busy,
  prompt,
  queue,
  onOptimisticMessage,
  onRefresh,
  onRemove,
  variant = "grid",
  onClose,
}: {
  session: Session;
  users: User[];
  messages: Message[];
  busy: boolean;
  prompt: SessionPrompt | null;
  queue: QueueMsg[];
  onOptimisticMessage: (sid: string, text: string) => void;
  onRefresh: () => Promise<void>;
  onRemove: (sid: string) => void;
  // "stage" = fill the column height and show a close affordance that removes
  // the column (without ending the session). Default "grid" keeps the classic
  // fixed-height card + mobile gestures.
  variant?: "grid" | "stage";
  onClose?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

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

  // ── mobile gestures: tap-header-to-collapse + iOS swipe-to-delete ──────────
  const isMobile = useIsMobile();
  const latest = latestLine(messages);
  const sectionRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  // Collapsed state persists per session so a card stays the way you left it
  // across reloads / re-renders (localStorage, keyed by sid).
  const collapseKey = sid ? `lfg-collapsed:${sid}` : null;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (!collapseKey) return false;
    try {
      return localStorage.getItem(collapseKey) === "1";
    } catch {
      return false;
    }
  });
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
  }, [collapseKey, collapsed]);

  // Auto-expand a card the moment its session stops working (busy true → false),
  // so a finished turn surfaces itself. Pairs with the auto-collapse on send
  // below: collapse while it churns, pop back open when it's done.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) setCollapsed(false);
    wasBusy.current = busy;
  }, [busy]);

  const setX = (px: number) => {
    const el = sectionRef.current;
    if (el) el.style.transform = px ? `translateX(${px}px)` : "";
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
    setX(0);
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
      if (!d.horizontal) {
        d.dragging = false; // vertical intent → release to the scroller
        const el = sectionRef.current;
        if (el) el.style.transition = "";
        return;
      }
      setSwiping(true); // horizontal swipe → reveal the delete action behind it
    }
    let nx = (openRef.current ? -OPEN : 0) + mx;
    if (nx > 0) nx *= 0.3;        // rubber-band past the closed edge
    if (nx < -d.w) nx = -d.w;
    d.x = nx;
    setX(nx);
  };

  const onTouchEnd = () => {
    const d = drag.current;
    if (!d.dragging) return;
    d.dragging = false;
    setSwiping(false);
    const el = sectionRef.current;
    if (el) el.style.transition = "";
    if (!d.horizontal) return;
    d.justSwiped = Math.abs(d.x) > 6;
    if (d.x <= -d.w * COMMIT) {
      commitDelete();
      return;
    }
    const willOpen = d.x <= -OPEN * 0.5;
    if (willOpen && !openRef.current) haptic("selection");
    openRef.current = willOpen;
    setSwipeOpen(willOpen);
    setX(willOpen ? -OPEN : 0);
  };

  // ── long-press the title → morphing full-height sheet ──────────────────────
  const LONG_PRESS_MS = 420;
  const pressTimer = useRef<number | null>(null);
  const pressOrigin = useRef({ x: 0, y: 0 });
  const longPressFired = useRef(false);
  const [sheetOrigin, setSheetOrigin] = useState<DOMRect | null>(null);

  const clearLongPress = () => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const onTitlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!isMobile || sheetOrigin) return;
    longPressFired.current = false;
    pressOrigin.current = { x: e.clientX, y: e.clientY };
    const el = e.currentTarget;
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      if (openRef.current) return; // mid swipe-to-delete — ignore
      longPressFired.current = true;
      haptic("selection");
      setSheetOrigin(el.getBoundingClientRect());
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
      {sheetOrigin ? (
        <SessionTitleSheet
          session={session}
          messages={messages}
          busy={busy}
          prompt={prompt}
          queue={queue}
          origin={sheetOrigin}
          onOptimisticMessage={onOptimisticMessage}
          onRefresh={onRefresh}
          onClose={() => setSheetOrigin(null)}
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
          "live-pane relative z-[1] flex h-[22rem] touch-pan-y flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground transition-[height,transform] duration-300 ease-ios md:static md:transition-none",
          variant === "stage" ? "md:h-full" : "md:h-[clamp(30rem,72vh,46rem)]",
        )}
      >
        <div
          ref={headRef}
          className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2"
        >
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
            <div className="relative flex size-6 shrink-0 items-center justify-center">
              {busy ? (
                <Loader2
                  className="absolute inset-0 size-6 animate-spin text-warning"
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
                  busy ? "size-4" : "size-6",
                )}
              />
            </div>
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
        {!collapsedView && (session.agent !== "codex" && session.tmuxTarget && sid ? (
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
                {(AGENT_MODELS[session.agent as AgentKind] ?? CLAUDE_MODELS).map((item) => (
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
        {!collapsedView && busy && canDriveSession(session) ? (
          <button
            type="button"
            onClick={() => void interrupt()}
            aria-label="Stop (Esc or Ctrl/Cmd+.)"
            title="Stop — Esc or Ctrl/Cmd+."
            className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-foreground/[0.06] px-2 text-[10px] font-medium text-foreground/70 hover:bg-foreground/[0.10] hover:text-foreground"
          >
            <Pause className="size-3.5" />
            Stop
          </button>
        ) : null}
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
          prompt={prompt}
          queue={queue}
          error={error}
          onError={setError}
          onOptimisticMessage={onOptimisticMessage}
          onRefresh={onRefresh}
          onCollapse={() => setCollapsed(true)}
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

const ChatStream = memo(function ChatStream({ messages, busy }: { messages: Message[]; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const items = useMemo(() => buildRenderItems(messages), [messages]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !stick) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy, stick]);

  return (
    <div
      ref={ref}
      onScroll={(event) => {
        const el = event.currentTarget;
        setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 72);
      }}
      className="chat-stream min-h-0 flex-1 overflow-y-auto bg-background px-3 py-3"
    >
      {messages.length ? (
        <div className="flex flex-col gap-3">
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
          {busy && !messages.some((message) => message.kind === "thinking") ? (
            <div className="busy-line">
              <span className="bt">Working...</span>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex h-full min-h-64 items-center justify-center text-center text-sm text-muted-foreground">
          Connecting to live transcript...
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
        message.pending && "opacity-60",
      )}
    >
      {isUser ? (
        // User turns stay on the iOS-blue bubble; their text is plain/escaped,
        // so the pre-rendered html path is fine and avoids re-parsing.
        <div
          className="msg-text markdown max-w-[92%] user-bubble rounded-2xl bg-primary px-3 py-2 text-primary-foreground"
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
  useEffect(() => {
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
    const needles = messages
      .filter((m) => m.role === "user" && m.kind === "text" && !m.pending)
      .map((m) => normText(m.text).slice(0, 48))
      .filter(Boolean);
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
          <article
            className="markdown report-markdown rounded-xl border border-border bg-card p-3"
            dangerouslySetInnerHTML={{ __html: report.html }}
          />
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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSelected([]);
  }, [report.date, agent]);

  if (!report.actions.length) return null;

  async function executeSelected() {
    setBusy(true);
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
      setBusy(false);
    }
  }

  async function executeCombined() {
    setBusy(true);
    try {
      await api("/api/actions/execute-combined", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, date: report.date, ids: selected }),
      });
      await onRefresh();
      setSelected([]);
    } finally {
      setBusy(false);
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
          disabled={!pending.length}
          onClick={() => setSelected(pending.map((action) => action.id))}
        >
          Select ready
        </Button>
        <Button variant="secondary" size="sm" disabled={!selected.length || busy} onClick={executeCombined}>
          1 agent
        </Button>
        <Button variant="brand" size="sm" disabled={!selected.length || busy} onClick={executeSelected}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          Execute
        </Button>
      </div>
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
};

function NewSessionDialog({
  open,
  repos,
  users,
  defaultUser,
  onClose,
  onCreated,
  onReposChanged,
}: {
  open: boolean;
  repos: Repo[];
  users: User[];
  defaultUser: string;
  onClose: () => void;
  onCreated: () => Promise<void>;
  onReposChanged: () => Promise<void>;
}) {
  const [agent, setAgent] = useState<AgentKind>(
    () => (localStorage.getItem("lfg_v2_agent") as AgentKind | null) || "aisdk",
  );
  // Reveal the legacy CLI agents up front only when one is already selected
  // (e.g. restored from localStorage), so a persisted CLI choice stays visible.
  const [showCli, setShowCli] = useState(() => agent === "claude" || agent === "codex");
  const [repo, setRepo] = useState(() => localStorage.getItem("lfg_v2_repo") || "");
  const [model, setModel] = useState(
    () =>
      localStorage.getItem(`lfg_model_${localStorage.getItem("lfg_v2_agent") || "aisdk"}`) ||
      localStorage.getItem("lfg_model") ||
      AGENT_DEFAULT_MODEL[(localStorage.getItem("lfg_v2_agent") as AgentKind | null) || "aisdk"],
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
  const [usage, setUsage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Resumable (closed / rebooted-away) sessions. Fetched lazily when the user
  // expands the section so opening the dialog stays instant; reset on close.
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumable, setResumable] = useState<ResumableSession[] | null>(null);

  useEffect(() => {
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
    const claudeModel = ["fable", "opus", "sonnet", "haiku"].includes(model) ? model : undefined;
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

  const models = AGENT_MODELS[agent];
  const selectedRepo = repo || repos[0]?.cwd || "";
  const selectedIsCustom = repos.some((r) => r.cwd === selectedRepo && r.custom);

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
    if (!open || agent !== "claude") return;
    api<{ ok: true; fiveHour: { pct: number | null }; sevenDay: { pct: number | null } }>(
      "/api/claude/usage",
    )
      .then((payload) =>
        setUsage(`5 hr ${Math.round(payload.fiveHour.pct ?? 0)}% · week ${Math.round(payload.sevenDay.pct ?? 0)}%`),
      )
      .catch(() => setUsage("usage unavailable"));
  }, [open, agent]);

  useEffect(() => {
    if (!models.includes(model)) setModel(models[0]);
  }, [models, model]);

  if (!open) return null;

  function submit(e?: FormEvent, overrideText?: string) {
    e?.preventDefault();
    const taskPrompt = (overrideText ?? prompt).trim();
    setError(null);
    localStorage.setItem("lfg_v2_agent", agent);
    localStorage.setItem("lfg_v2_repo", selectedRepo);
    localStorage.setItem(`lfg_model_${agent}`, model);
    if (agent === "codex-aisdk") localStorage.setItem("lfg_thinking_level", thinkingLevel);
    if (agent === "claude") localStorage.setItem("lfg_model", model);
    if (user) localStorage.setItem("lfg_user", user);
    // Close the drawer immediately — the spawn is slow (tmux + agent boot), so we
    // hand it to a background sonner toast rather than holding the form open on a
    // spinner. The prompt is only cleared on success, so a failed create leaves
    // the typed task intact for a retry when the drawer is reopened.
    onClose();
    toast.promise(
      api("/api/sessions/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: selectedRepo,
          prompt: taskPrompt || undefined,
          user: user || undefined,
          agent,
          model,
          thinkingLevel: agent === "codex-aisdk" ? thinkingLevel : undefined,
        }),
      }).then(() => {
        setPrompt("");
        return onCreated();
      }),
      {
        loading: "Creating session…",
        success: "Session started",
        error: (err) => (err instanceof Error ? err.message : "Couldn't create session"),
      },
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
        <form
          onSubmit={submit}
          className="px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-1"
        >
          <div className="relative">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Describe the task for a new session…"
            className="min-h-40 resize-none border-0 bg-transparent px-1 py-1 pr-10 text-base leading-relaxed shadow-none focus-visible:border-0 focus-visible:ring-0"
          />
          <MicButton
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

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <div className="inline-flex h-8 items-center rounded-full bg-muted p-0.5 text-xs font-semibold">
            {AGENT_OPTIONS.filter((o) => !o.cli).map(({ key, label }) => (
              <button
                key={key}
                type="button"
                title={label}
                aria-label={label}
                onClick={() => {
                  setAgent(key);
                  setModel(
                    localStorage.getItem(`lfg_model_${key}`) || AGENT_DEFAULT_MODEL[key],
                  );
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

          <button
            type="button"
            onClick={() => setShowCli((v) => !v)}
            className="flex h-8 items-center gap-0.5 rounded-full px-2 text-xs font-medium text-muted-foreground transition hover:text-foreground"
          >
            {showCli ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            CLI agents
          </button>

          {showCli && (
            <div className="inline-flex h-8 items-center rounded-full bg-muted p-0.5 text-xs font-semibold">
              {AGENT_OPTIONS.filter((o) => o.cli).map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  title={label}
                  aria-label={label}
                  onClick={() => {
                    setAgent(key);
                    setModel(
                      localStorage.getItem(`lfg_model_${key}`) || AGENT_DEFAULT_MODEL[key],
                    );
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
          )}

          <FieldPill>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
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

          {agent === "codex-aisdk" && (
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
          )}

          <FieldPill icon={<Folder className="size-3.5 text-muted-foreground" />}>
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

          <FieldPill icon={<UserRound className="size-3.5 text-muted-foreground" />}>
            <select
              value={user}
              onChange={(e) => setUser(e.target.value)}
              aria-label="Owner"
              className="max-w-24 appearance-none truncate bg-transparent pr-1 text-xs font-medium outline-none"
            >
              <option value="">Unassigned</option>
              {users.map((item) => (
                <option key={item.email} value={item.email}>
                  {item.name ?? shortUser(item.email)}
                </option>
              ))}
            </select>
          </FieldPill>
        </div>

        <div className="mt-3">
          <button
            type="button"
            onClick={() => setResumeOpen((v) => !v)}
            className="flex h-8 items-center gap-0.5 rounded-full px-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
          >
            {resumeOpen ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            Resume a recent session
          </button>
          {resumeOpen && (
            <div className="mt-1 max-h-56 overflow-y-auto overscroll-contain rounded-xl bg-muted/50 p-1">
              {resumable === null ? (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                  Loading…
                </div>
              ) : resumable.length === 0 ? (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                  No recent sessions to resume
                </div>
              ) : (
                resumable.map((s) => (
                  <button
                    key={s.sessionId}
                    type="button"
                    onClick={() => resume(s.sessionId)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-background"
                  >
                    <RotateCcw className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-foreground">
                        {s.title}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {s.project} · {timeAgo(s.lastActivityAt)}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <span
            className={cn(
              "min-w-0 truncate text-xs",
              error ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {error || (agent === "claude" ? usage : "") || ""}
          </span>
          <Button type="submit" variant="brand" disabled={busy || !selectedRepo}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Start
          </Button>
        </div>
        </form>
      </DrawerContent>
    </Drawer>
  );
}

// A compact iOS-style control pill: optional leading icon, a borderless native
// select, and a trailing chevron — no field label, the value speaks for itself.
function FieldPill({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full bg-muted px-3 text-foreground">
      {icon}
      {children}
      <ChevronDown className="size-3 shrink-0 text-muted-foreground/70" />
    </label>
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
  onClose,
  onReply,
  onDismiss,
}: {
  finding: AutoFinding;
  agentName: string;
  onClose: () => void;
  onReply: (f: AutoFinding, text: string) => Promise<void>;
  onDismiss: (f: AutoFinding) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
      await onReply(finding, t);
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
      await onReply(finding, text.trim() || "Go ahead and implement this fix now.");
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
              {finding.reasoning.map((r, i) => (
                <li key={i} className="flex gap-2 text-[13.5px] text-foreground/90">
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
  onClose,
  onCreate,
}: {
  repos: Repo[];
  onClose: () => void;
  onCreate: (idea: string, cwd: string | undefined) => void;
}) {
  const [idea, setIdea] = useState("");
  const [cwd, setCwd] = useState(repos[0]?.cwd ?? "");

  // Fire-and-close: hand the idea to the parent (which runs compose → save
  // under a loading toast) and dismiss the sheet immediately. The slow,
  // repo-inspecting work happens in the background — nothing blocks here.
  function submit() {
    if (!idea.trim()) return;
    onCreate(idea.trim(), cwd || undefined);
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
  const [busy, setBusy] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceErr, setEnhanceErr] = useState<string | null>(null);
  // Scan only when the schedule changes, not on every keystroke elsewhere.
  const nextPreview = useMemo(() => nextRunAt(schedule, tz), [schedule, tz]);

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
          placeholder="Jot a rough idea of what to watch for, then hit Enhance — it rewrites it into a sharp watch-agent prompt. Runs as a real Claude session with read-only tools and gathers its own context."
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
  const nextRef = useRef<number | null>(null);
  const [, force] = useState(0);
  useEffect(() => {
    nextRef.current = nextRunAt(expr, tz);
    force((n) => n + 1);
  }, [expr, tz]);
  // Tick the relative label; only rescan when the previous run actually passed.
  useEffect(() => {
    const id = setInterval(() => {
      if (nextRef.current != null && Date.now() >= nextRef.current) {
        nextRef.current = nextRunAt(expr, tz);
      }
      force((n) => n + 1);
    }, 30_000);
    return () => clearInterval(id);
  }, [expr, tz]);
  const next = nextRef.current;
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

function SettingsView({
  dark,
  toggleTheme,
  user,
  onOpenTerminal,
}: {
  dark: boolean;
  toggleTheme: () => void;
  user: string | null;
  onOpenTerminal: () => void;
}) {
  return (
    <div className="space-y-1">
      <div className="rounded-2xl border border-border bg-card/40">
        <div className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Display
        </div>
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            {dark ? <Sun className="size-4 text-muted-foreground" /> : <Moon className="size-4 text-muted-foreground" />}
            <span className="text-sm font-medium">Dark mode</span>
          </div>
          <Button
            variant="tint"
            size="icon-sm"
            onClick={toggleTheme}
            aria-label="Toggle dark mode"
          >
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card/40">
        <div className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Notifications
        </div>
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <Bell className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Push notifications</span>
          </div>
          <PushBell user={user} />
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card/40">
        <div className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Terminal
        </div>
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <TerminalSquare className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Open terminal</span>
          </div>
          <Button
            variant="tint"
            size="icon-sm"
            onClick={onOpenTerminal}
            aria-label="Open terminal"
          >
            <TerminalSquare className="size-4" />
          </Button>
        </div>
      </div>
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
            <Button
              size="icon-sm"
              variant="tint"
              className="order-3 shrink-0 sm:order-4"
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
              className="order-4 shrink-0 sm:order-5"
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
