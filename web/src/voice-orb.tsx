import { useCallback, useEffect, useRef, useState } from "react";
import type { Room } from "livekit-client";
import { Phone } from "lucide-react";
import { startElevenVoice, type ElevenHandle } from "./eleven-voice";
import { ensureVoiceConfigured } from "./voice-setup";

// Opt-in fallback: route the launcher through ElevenLabs' managed agent
// (Option B) instead of the self-hosted LiveKit worker when no dedicated phone
// call surface is provided. The brain (fleet tools, scoping) is identical.
// Toggle in the browser console:
//   localStorage.setItem("lfg_voice_eleven","1")  // managed agent
//   localStorage.removeItem("lfg_voice_eleven")    // LiveKit (default)
function readElevenManagedAgent(): boolean {
  try {
    return localStorage.getItem("lfg_voice_eleven") === "1";
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// VoiceOrb — now the compact call launcher in the nav. In the main app it opens
// VoiceCall, which owns the LiveKit room. The inline connection path remains as
// a fallback for standalone use without onOpenCall.
// ───────────────────────────────────────────────────────────────────────────

type Status = "idle" | "connecting" | "connected";
type AgentState = "listening" | "thinking" | "talking" | "consulting" | null;

export function VoiceOrb({
  onOpenCall,
  hidden,
}: {
  // When provided, a single tap on the idle orb opens phone-call mode (which
  // owns the LiveKit connection) instead of connecting inline here — so there is
  // exactly one room at a time.
  onOpenCall?: () => void;
  // Fade the launcher out and make it non-interactive (e.g. while the soft keyboard
  // is up). Kept mounted so the LiveKit/Eleven connection isn't torn down.
  hidden?: boolean;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [agentState, setAgentState] = useState<AgentState>(null);
  const [caption, setCaption] = useState("");
  // What the agent is doing right now (tool call / thinking), streamed from the
  // worker via the `lfg.tool` participant attribute. Persists while non-empty
  // (the backend clears it when the tool finishes), unlike the transient flash.
  const [detail, setDetail] = useState("");

  const roomRef = useRef<Room | null>(null);
  const elevenRef = useRef<ElevenHandle | null>(null);
  const audioElsRef = useRef<HTMLAudioElement[]>([]);
  const captionTimer = useRef<number | null>(null);

  const flash = useCallback((msg: string) => {
    setCaption(msg);
    if (captionTimer.current) clearTimeout(captionTimer.current);
    captionTimer.current = window.setTimeout(() => setCaption(""), 4000);
  }, []);

  const disconnect = useCallback(async () => {
    // ElevenLabs managed-agent session (Option B), if that path is active.
    const eleven = elevenRef.current;
    elevenRef.current = null;
    if (eleven) {
      try {
        await eleven.endSession();
      } catch {}
    }
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
    setStatus("idle");
    setAgentState(null);
    setDetail("");
  }, []);

  // Backstop watchdog: any busy state ("Thinking…"/"Consulting…"/"Talking…")
  // that never transitions leaves the orb wedged with no event to recover it —
  // e.g. the worker turn never clears its state, an attribute update is dropped
  // over the wire, or TTS produces dead air (the agent finished thinking but no
  // audio ever plays, so "talking" never advances to "listening"). If we sit in
  // a busy state with no transition for too long, fall back to listening (and
  // drop any stale tool detail). The window is generous so a legitimately slow
  // consult on the upper ladder — or a long spoken reply — isn't cut short.
  // Client-side only — backend turn handling is owned by the voice worker.
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

  const connect = useCallback(async () => {
    if (!(await ensureVoiceConfigured("call"))) return;
    setStatus("connecting");
    setAgentState("thinking");
    flash("Connecting…");
    try {
      const res = await fetch("/api/livekit/token");
      if (!res.ok) throw new Error(`token ${res.status}`);
      const { url, token } = (await res.json()) as { url: string; token: string };

      const { Room: RoomCls, RoomEvent, Track } = await import("livekit-client");
      // Explicitly turn on the browser's WebRTC audio cleanup for the mic we
      // publish: echo cancellation (so our own TTS coming back through the
      // speakers can't false-trigger barge-in), noise suppression for steady
      // background noise, and AGC. voiceIsolation is Chrome's stronger neural
      // suppressor — when supported it supersedes noiseSuppression. Without
      // audioCaptureDefaults these are left to UA defaults and uncontrolled.
      // NB: livekit-client v2 mutes the mic track on setMicrophoneEnabled(false)
      // WITHOUT stopping the underlying MediaStreamTrack, so unmute never re-runs
      // getUserMedia (no repeat permission prompt in an installed PWA). If you
      // ever bump to a major that reintroduces stop-on-mute, pin it back off.
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
        // Stream the live tool-call / thinking detail.
        // Non-empty while a tool runs; the worker clears it ("") when done.
        setDetail(attrs?.["lfg.tool"] ?? "");
        // A custom "deep work" signal (consulting the advisor / steering another
        // session) overrides the built-in lk.agent.state so the orb can show a
        // distinct transform. Cleared (empty) → fall through to the base state.
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

      room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) =>
        readAgent(p.attributes),
      );
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
        if (roomRef.current === room) void disconnect();
      });

      await room.connect(url, token);
      // Tell the voice agent which lfg user is speaking so it scopes the fleet
      // (snapshot, list, actions) to them. "__all"/unset → no scoping, whole
      // fleet, as before. The agent reads this off our participant attributes.
      try {
        const user = localStorage.getItem("lfg_user");
        if (user && user !== "__all")
          await room.localParticipant.setAttributes({ "lfg.user": user });
      } catch {}
      // Enabling the mic can reject on iOS Safari (permission not yet granted,
      // or blocked by the autoplay/gesture policy). Do NOT let it bubble to the
      // outer catch — that calls disconnect() and drops the orb ~230ms after it
      // connects. Stay connected and surface a hint; the user can retry the mic.
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
      flash("Connected");
    } catch {
      flash("Couldn't connect");
      await disconnect();
    }
  }, [disconnect, flash]);

  // ElevenLabs managed-agent connect (Option B). ElevenLabs owns mic/STT/turn-
  // taking/TTS in the browser; our backend stays the brain via the custom-LLM
  // endpoint. We map the SDK's connect status + turn mode onto the same orb
  // animation states the LiveKit path drives, so the UI is identical.
  const connectEleven = useCallback(async () => {
    if (!(await ensureVoiceConfigured("call"))) return;
    setStatus("connecting");
    setAgentState("thinking");
    flash("Connecting…");
    try {
      elevenRef.current = await startElevenVoice({
        onStatus: (s) => {
          if (s === "connected") {
            setStatus("connected");
            setAgentState((a) => a ?? "listening");
            flash("Connected");
          } else if (s === "connecting") {
            setStatus("connecting");
          } else if (s === "idle") {
            if (elevenRef.current) void disconnect();
          } else if (s === "error") {
            flash("Couldn't connect");
          }
        },
        // No explicit "thinking" mode in the SDK: once the user stops talking the
        // agent is computing (our brain + tools) until it starts speaking, so we
        // show "thinking" on a finalized user turn and clear it when it speaks.
        onUserTranscript: (t) => {
          if (t) setAgentState("thinking");
        },
        onMode: (m) => setAgentState(m === "speaking" ? "talking" : "listening"),
        onAgentReply: (t) => {
          if (t) flash(t);
        },
        onError: () => flash("Voice error"),
      });
    } catch {
      flash("Couldn't connect");
      await disconnect();
    }
  }, [disconnect, flash]);

  const toggle = useCallback(() => {
    if (roomRef.current || elevenRef.current || status !== "idle")
      void disconnect();
    else if (onOpenCall) onOpenCall(); // phone-call mode owns the connection
    else if (readElevenManagedAgent())
      void connectEleven(); // Option B: managed agent, inline on the orb
    else void connect();
  }, [status, connect, connectEleven, disconnect, onOpenCall]);

  useEffect(() => () => void disconnect(), [disconnect]);

  const active = status !== "idle";
  const label =
    status === "connecting"
      ? "Connecting call"
      : active
        ? "End voice call"
        : "Start phone call";

  return (
    <button
      type="button"
      onClick={toggle}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={label}
      aria-pressed={active}
      aria-hidden={hidden}
      tabIndex={hidden ? -1 : undefined}
      title={label}
      className={[
        "pointer-events-auto grid size-8 shrink-0 place-items-center rounded-full outline-none transition duration-200 ease-out active:scale-[0.96]",
        "text-muted-foreground hover:bg-muted/70 hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring/20",
        active ? "text-destructive hover:text-destructive" : "",
      ].join(" ")}
      style={{
        // While hidden, fade out, drop below the (now keyboard-covered) edge,
        // and stop catching taps — but stay mounted to keep the voice session.
        // NOTE: Tailwind v4's `-translate-x-1/2` uses the CSS `translate`
        // property, so we override that (not `transform`) to keep the button
        // horizontally centered — setting `transform` here would stack a second
        // -50% shift and yank the button to the left.
        opacity: hidden ? 0 : 1,
        pointerEvents: hidden ? "none" : "auto",
        translate: hidden ? "-50% 120%" : undefined,
      }}
    >
      <Phone className="size-[18px]" strokeWidth={2.2} aria-hidden="true" />
    </button>
  );
}
