import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Room } from "livekit-client";
import {
  Mic,
  MicOff,
  Plus,
  PhoneOff,
  Phone,
  Volume2,
  ChevronDown,
} from "lucide-react";
import { lazyWithReload } from "./lib/lazy-with-reload";
import { appPath } from "./lib/base-path";

// ───────────────────────────────────────────────────────────────────────────
// VoiceCall — "phone call mode" for the voice orb. A focused, fullscreen call
// screen where the orb is the hero and the whole backdrop is a living, state-
// tinted aura. It owns the LiveKit connection while open (the floating orb is
// only the launcher), so there is exactly one room at a time. Mounting places
// the call (connects); End / Escape hangs up and closes.
//
// Surfaces what a real call needs that the floating orb can't: a call timer,
// who the agent is scoped to, an explicit Mute, and the live agent state + tool
// detail as the closest thing we have to a transcript today.
//
// Earpiece (handset) mode: the agent audio is attached straight from the live
// WebRTC MediaStream, which iOS Safari routes to the receiver/earpiece while
// the mic is live — so holding the phone to your ear Just Works. The toggle
// also releases the screen wake-lock and dims to black after a few idle
// seconds (tap to wake), so the phone behaves like a real held-to-ear call
// instead of a speakerphone you have to stare at. (True proximity screen-off
// is not a web capability, so the dim is the closest honest approximation.)
// ───────────────────────────────────────────────────────────────────────────

const Orb = lazyWithReload("Orb", () =>
  import("./eleven-orb").then((m) => ({ default: m.Orb })),
);

class OrbBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

type Status = "idle" | "connecting" | "connected";
type AgentState = "listening" | "thinking" | "talking" | "consulting" | null;

// State → orb gradient, echoing voice-orb.tsx so the call screen and the
// floating orb speak the same color language.
const STATE_COLORS: Record<NonNullable<AgentState> | "idle", [string, string]> = {
  idle: ["#9aa7b8", "#7c8a9c"],
  listening: ["#CADCFC", "#A0B9D1"],
  thinking: ["#cfc2ff", "#9f8be6"],
  talking: ["#bfe3ff", "#7fb4e6"],
  consulting: ["#ffd79a", "#e6a23c"],
};

const STATE_LABEL: Record<NonNullable<AgentState>, string> = {
  listening: "Listening",
  thinking: "Thinking",
  talking: "Speaking",
  consulting: "Consulting the advisor",
};

const CALL_CSS = `
@keyframes lfg-call-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes lfg-call-orb-in { from { opacity: 0; transform: scale(.86) } to { opacity: 1; transform: scale(1) } }
@keyframes lfg-call-breathe { 0%, 100% { transform: scale(1); opacity: .85 } 50% { transform: scale(1.12); opacity: 1 } }
@keyframes lfg-call-dot { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }
.lfg-call-root { animation: lfg-call-fade 240ms ease-out both; }
@keyframes lfg-call-scrim-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes lfg-call-win-in { from { opacity: 0; transform: translateY(8px) scale(.98) } to { opacity: 1; transform: translateY(0) scale(1) } }
.lfg-call-scrim { animation: lfg-call-scrim-in 200ms ease-out both; }
.lfg-call-win { animation: lfg-call-win-in 260ms cubic-bezier(.2,.8,.2,1) both; }
.lfg-call-aura { animation: lfg-call-breathe 7s ease-in-out infinite; transition: background 900ms ease; }
.lfg-call-orb { animation: lfg-call-orb-in 420ms cubic-bezier(.2,.8,.2,1) both; }
.lfg-call-livedot { animation: lfg-call-dot 1.6s ease-in-out infinite; }
@keyframes lfg-call-dim-in { from { opacity: 0 } to { opacity: 1 } }
.lfg-call-dim { animation: lfg-call-dim-in 700ms ease both; }
@media (prefers-reduced-motion: reduce) {
  .lfg-call-aura, .lfg-call-livedot, .lfg-call-dim, .lfg-call-scrim, .lfg-call-win { animation: none; }
}
`;

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function VoiceCall({
  onClose,
  onCompose,
}: {
  onClose: () => void;
  onCompose?: () => void;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [agentState, setAgentState] = useState<AgentState>(null);
  const [detail, setDetail] = useState(""); // live tool-call detail (lfg.tool)
  const [userText, setUserText] = useState(""); // live transcript of what you say
  const [userFinal, setUserFinal] = useState(false); // committed vs in-progress
  const [hint, setHint] = useState(""); // transient status line (errors, mic)
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [scope, setScope] = useState("All sessions");
  // Earpiece (handset) mode — persisted, so it sticks across calls.
  const [earpiece, setEarpiece] = useState<boolean>(() => {
    try {
      return localStorage.getItem("lfg_voice_earpiece") === "1";
    } catch {
      return false;
    }
  });
  const [screenDim, setScreenDim] = useState(false);
  // Collapsed (minimized) — keeps the call live but shrinks the fullscreen
  // overlay to a small floating pill so the rest of the app stays navigable.
  const [collapsed, setCollapsed] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const audioElsRef = useRef<HTMLAudioElement[]>([]);
  const hintTimer = useRef<number | null>(null);
  const dimTimer = useRef<number | null>(null);

  const toggleEarpiece = useCallback(() => {
    setEarpiece((v) => {
      const next = !v;
      try {
        localStorage.setItem("lfg_voice_earpiece", next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  const flash = useCallback((msg: string) => {
    setHint(msg);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(""), 4000);
  }, []);

  const disconnect = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    for (const el of audioElsRef.current) {
      try {
        el.pause();
        el.remove();
      } catch {}
    }
    audioElsRef.current = [];
    if (room) {
      try {
        await room.disconnect();
      } catch {}
    }
  }, []);

  // ── connect on mount (placing the call) ────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    // Show who the agent will act for, read the same way the worker scopes it.
    try {
      const user = localStorage.getItem("lfg_user");
      setScope(user && user !== "__all" ? user : "All sessions");
    } catch {}

    void (async () => {
      setStatus("connecting");
      setAgentState("thinking");
      try {
        const res = await fetch(appPath("/api/livekit/token"));
        if (!res.ok) throw new Error(`token ${res.status}`);
        const { url, token } = (await res.json()) as {
          url: string;
          token: string;
        };

        const { Room: RoomCls, RoomEvent, Track } = await import("livekit-client");
        if (cancelled) return;
        // Turn on the browser's mic audio cleanup: echo cancellation (stops our
        // own TTS playback from false-triggering barge-in), noise suppression for
        // steady background noise, AGC, and Chrome's stronger neural
        // voiceIsolation when available. Left uncontrolled without this.
        const room = new RoomCls({
          adaptiveStream: true,
          audioCaptureDefaults: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            voiceIsolation: true,
          },
        });
        roomRef.current = room;

        const readAgent = (attrs?: Record<string, string>) => {
          // Live transcript of the human's speech, mirrored by the worker so you
          // can see your words being recognized. Only update when the key is
          // present, so unrelated attribute changes don't wipe the caption.
          const ut = attrs?.["lfg.user_text"];
          if (ut !== undefined) {
            setUserText(ut);
            setUserFinal(attrs?.["lfg.user_final"] === "1");
          }
          setDetail(attrs?.["lfg.tool"] ?? "");
          const activity = attrs?.["lfg.activity"];
          if (activity === "consulting" || activity === "replying") {
            setAgentState("consulting");
            return;
          }
          const s = attrs?.["lk.agent.state"];
          if (s === "speaking") setAgentState("talking");
          else if (s === "listening") setAgentState("listening");
          else if (s === "thinking") setAgentState("thinking");
        };

        // Only the agent (a remote participant) carries lk.agent.state and the
        // lfg.* attributes; skip our own local participant so its attribute
        // changes (e.g. lfg.user) don't clobber the caption/state.
        room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
          if (p.isLocal) return;
          readAgent(p.attributes);
        });
        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Audio) {
            const el = track.attach() as HTMLAudioElement;
            el.autoplay = true;
            el.style.display = "none";
            document.body.appendChild(el);
            audioElsRef.current.push(el);
          }
        });
        room.on(RoomEvent.Disconnected, () => {
          if (roomRef.current === room) {
            roomRef.current = null;
            onClose();
          }
        });

        await room.connect(url, token);
        if (cancelled) {
          try {
            await room.disconnect();
          } catch {}
          return;
        }
        try {
          const user = localStorage.getItem("lfg_user");
          if (user && user !== "__all")
            await room.localParticipant.setAttributes({ "lfg.user": user });
        } catch {}
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
        } catch {
          flash("Mic blocked — check permission");
        }
        try {
          await room.startAudio();
        } catch {}
        room.remoteParticipants.forEach((p) => readAgent(p.attributes));

        setStatus("connected");
        setAgentState((s) => s ?? "listening");
      } catch {
        if (!cancelled) {
          flash("Couldn't connect");
          window.setTimeout(onClose, 1200);
        }
      }
    })();

    return () => {
      cancelled = true;
      void disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── call timer (runs once connected) ───────────────────────────────────────
  useEffect(() => {
    if (status !== "connected") return;
    const t = window.setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  // ── screen wake-lock ───────────────────────────────────────────────────────
  // Speaker mode: keep the screen awake (you're looking at the orb). Earpiece
  // mode: don't hold the lock, so the phone can sleep against your ear.
  useEffect(() => {
    if (status !== "connected" || earpiece) return;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: "screen") => Promise<{ release?: () => void }> };
    };
    if (!nav.wakeLock?.request) return;
    let lock: { release?: () => void } | null = null;
    let released = false;
    nav.wakeLock
      .request("screen")
      .then((l) => {
        if (released) l.release?.();
        else lock = l;
      })
      .catch(() => {});
    return () => {
      released = true;
      try {
        lock?.release?.();
      } catch {}
    };
  }, [status, earpiece]);

  // ── earpiece idle-dim ──────────────────────────────────────────────────────
  // After a few idle seconds on an earpiece call, fade the screen to black
  // (battery + cheek). Any touch re-arms and reveals; tapping the black overlay
  // bubbles a pointerdown to this same handler, which wakes it.
  useEffect(() => {
    if (!earpiece || status !== "connected") {
      setScreenDim(false);
      if (dimTimer.current) clearTimeout(dimTimer.current);
      return;
    }
    const arm = () => {
      if (dimTimer.current) clearTimeout(dimTimer.current);
      setScreenDim(false);
      dimTimer.current = window.setTimeout(() => setScreenDim(true), 3500);
    };
    arm();
    window.addEventListener("pointerdown", arm);
    return () => {
      window.removeEventListener("pointerdown", arm);
      if (dimTimer.current) clearTimeout(dimTimer.current);
    };
  }, [earpiece, status]);

  // ── watchdog: never leave a busy state wedged forever ──────────────────────
  useEffect(() => {
    const busy =
      agentState === "thinking" ||
      agentState === "consulting" ||
      agentState === "talking";
    if (!busy) return;
    const t = window.setTimeout(() => {
      setAgentState((s) =>
        s === "thinking" || s === "consulting" || s === "talking"
          ? "listening"
          : s,
      );
      setDetail("");
    }, 100_000);
    return () => clearTimeout(t);
  }, [agentState, detail]);

  const endCall = useCallback(() => {
    void disconnect();
    onClose();
  }, [disconnect, onClose]);

  // Escape tucks the expanded window into the floating pill (non-destructive —
  // keeps the call live). The window no longer blocks the app, so the user may
  // be navigating elsewhere; Escape must never silently drop the call.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !collapsed) setCollapsed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed]);

  useEffect(
    () => () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
      if (dimTimer.current) clearTimeout(dimTimer.current);
    },
    [],
  );

  const toggleMute = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !muted;
    try {
      await room.localParticipant.setMicrophoneEnabled(!next);
      setMuted(next);
    } catch {
      flash("Couldn't change the mic");
    }
  }, [muted, flash]);

  // ── derived view state ─────────────────────────────────────────────────────
  const orbState: AgentState =
    status === "connecting" ? "thinking" : agentState ?? "listening";
  const colors = STATE_COLORS[orbState ?? "idle"];

  const bigLabel =
    status === "connecting"
      ? "Calling…"
      : orbState
        ? STATE_LABEL[orbState]
        : "Listening";

  // Secondary line: live tool detail → transient hint → warming → quiet default.
  const sub =
    detail ||
    hint ||
    (orbState === "thinking" ? "Working on it…" : "");

  const auraBg = `radial-gradient(120% 80% at 50% 38%, ${colors[0]}55 0%, ${colors[1]}22 38%, transparent 70%)`;

  const orbFallback = (
    <div
      className="lfg-call-orb rounded-full"
      style={{
        width: "min(64vw, 300px)",
        height: "min(64vw, 300px)",
        background: `conic-gradient(from 0deg, ${colors[0]}, ${colors[1]}, ${colors[0]})`,
        filter: "blur(12px)",
        opacity: 0.7,
      }}
    />
  );

  // ── collapsed: a small floating pill, app stays navigable underneath ───────
  if (collapsed) {
    return (
      <div
        role="dialog"
        aria-label="Voice call (minimized)"
        className="lfg-call-root fixed z-[80] flex items-center gap-2 rounded-full border bg-background/95 py-1.5 pl-1.5 pr-2 shadow-lg backdrop-blur"
        style={{
          right: "calc(env(safe-area-inset-right) + 0.75rem)",
          bottom: "calc(env(safe-area-inset-bottom) + 0.75rem)",
          borderColor: "color-mix(in srgb, var(--foreground) 12%, transparent)",
        }}
      >
        <style>{CALL_CSS}</style>
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Expand voice call"
          className="flex items-center gap-2 outline-none"
        >
          <span
            className="grid size-9 place-items-center rounded-full"
            style={{
              background: `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`,
            }}
          >
            <span
              className="lfg-call-livedot inline-block size-2.5 rounded-full bg-white/90"
            />
          </span>
          <span className="flex flex-col items-start pr-1 leading-tight">
            <span className="text-xs font-medium">
              {status === "connected" ? bigLabel : "Connecting…"}
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {status === "connected"
                ? `On a call · ${fmtElapsed(elapsed)}`
                : "…"}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={endCall}
          aria-label="End call"
          className="flex size-9 items-center justify-center rounded-full bg-destructive text-white shadow outline-none transition active:scale-95 focus-visible:ring-4 focus-visible:ring-destructive/40"
        >
          <PhoneOff className="size-4" />
        </button>
      </div>
    );
  }

  return (
    // Floating-window layer: NON-blocking. The container is click-through
    // (pointer-events-none) and there is no dimming scrim, so the rest of the
    // app stays fully navigable while the call is up. Only the window itself is
    // interactive. It pops out into a corner as a half-screen window that the
    // user can minimize to a pill (header chevron / Escape) or expand again —
    // it never takes over the whole screen.
    <div className="pointer-events-none fixed inset-0 z-[90] flex items-end justify-center p-0 sm:items-end sm:justify-center sm:p-4">
      <style>{CALL_CSS}</style>

      <div
        role="dialog"
        aria-modal="false"
        aria-label="Voice call"
        className="lfg-call-root lfg-call-win pointer-events-auto relative flex h-[72vh] max-h-[760px] w-full flex-col overflow-hidden rounded-t-3xl border bg-background text-foreground shadow-2xl sm:h-[min(80vh,720px)] sm:w-[min(46vw,520px)] sm:min-w-[380px] sm:rounded-3xl"
        style={{
          paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)",
          paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)",
          borderColor: "color-mix(in srgb, var(--foreground) 12%, transparent)",
        }}
      >

      {/* Signature: the ambient state aura — the whole screen takes on the
          orb's current mood, crossfading hue as the agent's state changes. */}
      <div
        className="lfg-call-aura pointer-events-none absolute inset-0"
        style={{ background: auraBg }}
      />

      {/* Top bar: live dot + state, call timer, and who the agent is acting for. */}
      <header className="relative flex items-center justify-between px-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span
            className="lfg-call-livedot inline-block size-2 rounded-full"
            style={{ background: colors[1] }}
          />
          <span>{status === "connected" ? "On a call" : "Connecting…"}</span>
          {status === "connected" ? (
            <span className="tabular-nums text-muted-foreground">
              · {fmtElapsed(elapsed)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <span className="max-w-[40vw] truncate text-xs text-muted-foreground">
            {scope}
          </span>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-label="Minimize call"
            title="Minimize — keep the call going while you navigate"
            className="flex size-8 items-center justify-center rounded-full border outline-none transition active:scale-95 focus-visible:ring-4 focus-visible:ring-primary/30"
            style={{
              borderColor: "color-mix(in srgb, var(--foreground) 12%, transparent)",
            }}
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
      </header>

      {/* Hero: the orb, the state word, and the live detail line. The orb is
          the centered anchor of the call area; the label and live transcript
          float beneath it (absolutely positioned) so they never push the orb
          off-center as text appears and disappears while you talk. */}
      <main className="relative flex flex-1 flex-col items-center justify-center px-6">
        <div
          className="lfg-call-orb flex items-center justify-center"
          style={{ width: "min(54vw, 244px)", height: "min(54vw, 244px)" }}
        >
          <OrbBoundary fallback={orbFallback}>
            <Suspense fallback={orbFallback}>
              <Orb
                className="h-full w-full min-w-0"
                colors={colors}
                agentState={orbState}
                volumeMode="auto"
              />
            </Suspense>
          </OrbBoundary>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 px-6 pb-2">
          <div className="flex min-h-[3.5rem] flex-col items-center gap-1.5 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">{bigLabel}</h1>
            {sub ? (
              <p className="max-w-[78vw] truncate text-sm text-muted-foreground">
                {sub}
              </p>
            ) : null}
          </div>

          {/* Live transcript of what you're saying — so you can see in real time
              whether the agent is hearing you. In-progress text is dimmed/italic;
              it firms up once your turn is committed. */}
          {userText ? (
            <div
              className="flex max-w-[80vw] flex-col items-center gap-1 text-center"
              aria-live="polite"
            >
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                You
              </span>
              <p
                className={`text-base leading-snug transition-opacity ${
                  userFinal ? "opacity-100" : "italic opacity-60"
                }`}
              >
                {userText}
              </p>
            </div>
          ) : null}
        </div>
      </main>

      {/* Controls: one compact row — Mute · Speaker · New · End. */}
      <footer className="relative flex items-end justify-center gap-6 px-6">
        <CallButton
          label={muted ? "Unmute" : "Mute"}
          active={muted}
          onClick={() => void toggleMute()}
          icon={muted ? <MicOff className="size-6" /> : <Mic className="size-6" />}
        />
        <CallButton
          label={earpiece ? "Earpiece" : "Speaker"}
          active={earpiece}
          onClick={toggleEarpiece}
          icon={earpiece ? <Phone className="size-6" /> : <Volume2 className="size-6" />}
        />
        <CallButton
          label="New"
          onClick={() => onCompose?.()}
          icon={<Plus className="size-6" />}
        />
        <CallButton
          label="End"
          danger
          onClick={endCall}
          icon={<PhoneOff className="size-6" />}
        />
      </footer>

      {/* Earpiece handset: once idle, the screen goes near-black so the phone
          behaves like a held-to-ear call. The tap that wakes it bubbles a
          pointerdown to the idle-dim handler (which clears the dim), so this
          overlay deliberately does not stop propagation. */}
      {screenDim ? (
        <div
          aria-hidden
          className="lfg-call-dim absolute inset-0 z-[95] flex items-center justify-center bg-black"
        >
          <div className="flex flex-col items-center gap-1 text-center">
            <span
              className="text-sm"
              style={{ color: "rgba(255,255,255,0.30)" }}
            >
              On a call · {fmtElapsed(elapsed)}
            </span>
            <span
              className="text-xs"
              style={{ color: "rgba(255,255,255,0.18)" }}
            >
              Tap to wake
            </span>
          </div>
        </div>
      ) : null}
      </div>
    </div>
  );
}

function CallButton({
  label,
  icon,
  onClick,
  active,
  tint,
  danger,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  active?: boolean;
  tint?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={danger ? undefined : active}
      className="group flex flex-col items-center gap-1.5 outline-none"
    >
      <span
        className={`flex size-14 items-center justify-center rounded-full border shadow-sm transition active:scale-95 group-focus-visible:ring-4 ${
          danger ? "group-focus-visible:ring-destructive/40" : "group-focus-visible:ring-primary/30"
        }`}
        style={
          danger
            ? ({
                background: "var(--destructive)",
                color: "#fff",
                borderColor: "transparent",
              } as CSSProperties)
            : ({
                background: active
                  ? tint
                    ? `color-mix(in srgb, ${tint} 22%, transparent)`
                    : "var(--foreground)"
                  : "color-mix(in srgb, var(--foreground) 8%, transparent)",
                color:
                  active && !tint ? "var(--background)" : tint || "var(--foreground)",
                borderColor: "color-mix(in srgb, var(--foreground) 12%, transparent)",
              } as CSSProperties)
        }
      >
        {icon}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </button>
  );
}
