// ─────────────────────────────────────────────────────────────────────────────
// One-shot TTS playback for the launcher orb's push-to-talk flow.
//
// `/api/voice/tts` returns raw 24 kHz mono int16 PCM with no container (the API
// key stays server-side). The rest of the app only ever hears the voice agent
// through LiveKit WebRTC tracks, so there's no existing way to just "say this
// sentence" — this is that: POST text, decode the PCM, and play it via the Web
// Audio API. Must be kicked off from a user gesture (the orb release) so the
// AudioContext is allowed to start.
// ─────────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";
import { appPath } from "./lib/base-path";

const TTS_SAMPLE_RATE = 24000; // matches synthesizeTts() output on the server

let sharedCtx: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let currentBuffer: AudioBuffer | null = null;
let startedAt = 0;
let pausedAt = 0;
let currentResolve: (() => void) | null = null;
let suppressEnded = false;

export type SpeechPlayback = {
  status: "idle" | "loading" | "playing" | "paused";
  text: string;
  sessionId: string | null;
  title: string;
  duration: number;
  position: number;
};

const IDLE: SpeechPlayback = {
  status: "idle",
  text: "",
  sessionId: null,
  title: "",
  duration: 0,
  position: 0,
};

let playback: SpeechPlayback = IDLE;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function setPlayback(patch: Partial<SpeechPlayback>) {
  playback = { ...playback, ...patch };
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// `getSnapshot` for useSyncExternalStore MUST return a referentially-stable
// value while the store is unchanged — returning a freshly-spread object on
// every call (as an earlier version did to interpolate `position` live) makes
// React believe the store mutates on every read and re-renders forever, which
// surfaces in prod as "Maximum update depth exceeded" (React error #185). So
// the snapshot is just the stored object; live position interpolation lives in
// `livePosition()`, which consumers read on their own render cadence.
function snapshot() {
  return playback;
}

export function useSpeechPlayback(): SpeechPlayback {
  return useSyncExternalStore(subscribe, snapshot, () => IDLE);
}

/**
 * Current playback position in seconds, interpolated from the AudioContext
 * clock while playing. Not part of the external-store snapshot (that must stay
 * stable) — call this from a component that re-renders on its own timer.
 */
export function livePosition(): number {
  if (playback.status !== "playing") return playback.position;
  const ctx = getCtx();
  const elapsed = ctx ? Math.max(0, ctx.currentTime - startedAt) : 0;
  return Math.min(playback.duration, pausedAt + elapsed);
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx) sharedCtx = new Ctor();
  return sharedCtx;
}

/** Stop any sentence currently playing (e.g. a new hold interrupts the last one). */
export function stopSpeaking(): void {
  const resolve = currentResolve;
  currentResolve = null;
  if (currentSource) {
    try {
      currentSource.onended = null;
      suppressEnded = true;
      currentSource.stop();
    } catch {
      /* already stopped */
    }
    currentSource = null;
  }
  currentBuffer = null;
  startedAt = 0;
  pausedAt = 0;
  suppressEnded = false;
  playback = IDLE;
  emit();
  resolve?.();
}

export function pauseSpeaking(): void {
  const ctx = getCtx();
  if (!ctx || playback.status !== "playing" || !currentSource) return;
  pausedAt = Math.min(playback.duration, pausedAt + Math.max(0, ctx.currentTime - startedAt));
  try {
    currentSource.onended = null;
    suppressEnded = true;
    currentSource.stop();
  } catch {
    /* already stopped */
  }
  currentSource = null;
  suppressEnded = false;
  setPlayback({ status: "paused", position: pausedAt });
}

export async function resumeSpeaking(): Promise<void> {
  if (playback.status !== "paused" || !currentBuffer) return;
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      return;
    }
  }
  startBufferAt(pausedAt);
}

function startBufferAt(offset: number) {
  const ctx = getCtx();
  if (!ctx || !currentBuffer) return;
  if (currentSource) {
    try {
      currentSource.onended = null;
      suppressEnded = true;
      currentSource.stop();
    } catch {}
  }
  suppressEnded = false;
  const src = ctx.createBufferSource();
  src.buffer = currentBuffer;
  src.connect(ctx.destination);
  startedAt = ctx.currentTime;
  pausedAt = Math.max(0, Math.min(offset, currentBuffer.duration));
  src.onended = () => {
    if (suppressEnded || currentSource !== src) return;
    currentSource = null;
    currentBuffer = null;
    pausedAt = 0;
    startedAt = 0;
    const resolve = currentResolve;
    currentResolve = null;
    playback = IDLE;
    emit();
    resolve?.();
  };
  currentSource = src;
  setPlayback({
    status: "playing",
    duration: currentBuffer.duration,
    position: pausedAt,
  });
  try {
    src.start(0, pausedAt);
  } catch {
    stopSpeaking();
  }
}

/**
 * Speak `text` aloud and resolve when playback finishes. Best-effort: returns
 * (resolves) quietly if TTS is unavailable rather than throwing into the caller's
 * one-shot flow — the session has already been created by the time we speak.
 */
export async function speakText(
  text: string,
  opts?: { voice?: string; signal?: AbortSignal; sessionId?: string | null; title?: string },
): Promise<void> {
  const t = text.trim();
  if (!t) return;
  const ctx = getCtx();
  if (!ctx) return;

  stopSpeaking(); // never overlap two confirmations
  playback = {
    status: "loading",
    text: t,
    sessionId: opts?.sessionId ?? null,
    title: opts?.title ?? "",
    duration: 0,
    position: 0,
  };
  emit();

  let buf: ArrayBuffer;
  try {
    const res = await fetch(appPath("/api/voice/tts"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: t, voice: opts?.voice }),
      signal: opts?.signal,
    });
    if (!res.ok) {
      stopSpeaking();
      return;
    }
    buf = await res.arrayBuffer();
  } catch {
    stopSpeaking();
    return; // network/abort — nothing to play
  }
  if (buf.byteLength < 2) {
    stopSpeaking();
    return;
  }

  // int16 LE → float32 [-1, 1]. Int16Array needs an even byte length.
  const evenLen = buf.byteLength - (buf.byteLength % 2);
  const pcm = new Int16Array(buf, 0, evenLen / 2);
  const f32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;

  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* user-gesture rules may still block it — give up quietly */
    }
  }

  const audioBuf = ctx.createBuffer(1, f32.length, TTS_SAMPLE_RATE);
  audioBuf.getChannelData(0).set(f32);
  currentBuffer = audioBuf;

  await new Promise<void>((resolve) => {
    currentResolve = resolve;
    startBufferAt(0);
  });
}
