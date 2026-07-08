// ─────────────────────────────────────────────────────────────────────────────
// Streaming TTS playback.
//
// `/api/voice/tts` returns raw 24 kHz mono int16 PCM with no container, and the
// server streams it as it synthesizes (see elevenLabsStreamInputPcm). So we do
// ONE call with the whole text and play the audio progressively: each PCM chunk
// is decoded and scheduled back-to-back on a shared AudioContext clock, so sound
// starts as soon as the first bytes land and plays gaplessly — no waiting for the
// full clip, no per-sentence chopping.
//
// Pause/resume just suspend/resume the AudioContext (there's only ever one active
// playback), which freezes ctx.currentTime and therefore the position clock too.
// Must be kicked off from a user gesture so the AudioContext is allowed to start.
// ─────────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";

const TTS_SAMPLE_RATE = 24000; // matches synthesizeTts() output on the server
const START_LEAD = 0.06; // small lead so the first chunk schedules cleanly

let sharedCtx: AudioContext | null = null;

// Active-playback state. Only one playback runs at a time.
let scheduled = new Set<AudioBufferSourceNode>();
let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let startClock = 0; // ctx.currentTime at position 0 (frozen while suspended)
let nextStartTime = 0; // ctx time the next chunk should start at
let streamEnded = false; // upstream body fully read
let currentResolve: (() => void) | null = null;
let generation = 0; // bumped on every stop so stale async work bails

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

// getSnapshot for useSyncExternalStore MUST be referentially stable while the
// store is unchanged — see React error #185. Live position interpolation lives in
// livePosition(), read by consumers on their own render cadence.
function snapshot() {
  return playback;
}

export function useSpeechPlayback(): SpeechPlayback {
  return useSyncExternalStore(subscribe, snapshot, () => IDLE);
}

/** Current playback position in seconds, interpolated from the (suspend-frozen)
 *  AudioContext clock while playing. */
export function livePosition(): number {
  if (playback.status !== "playing") return playback.position;
  const ctx = getCtx();
  if (!ctx) return playback.position;
  return Math.min(playback.duration, Math.max(0, ctx.currentTime - startClock));
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx) sharedCtx = new Ctor();
  return sharedCtx;
}

/** Stop playback: cancel the stream, kill scheduled audio, reset to idle. */
export function stopSpeaking(): void {
  generation++;
  const resolve = currentResolve;
  currentResolve = null;

  const reader = activeReader;
  activeReader = null;
  if (reader) {
    try {
      void reader.cancel();
    } catch {
      /* already closed */
    }
  }

  for (const src of scheduled) {
    try {
      src.onended = null;
      src.stop();
    } catch {
      /* already stopped */
    }
  }
  scheduled = new Set();

  // If we were paused (ctx suspended), resume the context so it's usable next
  // time — otherwise a fresh playback would schedule into a frozen clock.
  const ctx = sharedCtx;
  if (ctx && ctx.state === "suspended") {
    try {
      void ctx.resume();
    } catch {}
  }

  streamEnded = false;
  startClock = 0;
  nextStartTime = 0;
  playback = IDLE;
  emit();
  resolve?.();
}

export function pauseSpeaking(): void {
  const ctx = getCtx();
  if (!ctx || playback.status !== "playing") return;
  // Freeze everything scheduled; ctx.currentTime stops advancing while suspended.
  setPlayback({ status: "paused", position: livePosition() });
  try {
    void ctx.suspend();
  } catch {}
}

export async function resumeSpeaking(): Promise<void> {
  const ctx = getCtx();
  if (!ctx || playback.status !== "paused") return;
  try {
    await ctx.resume();
  } catch {
    return;
  }
  setPlayback({ status: "playing" });
}

function finish() {
  const resolve = currentResolve;
  currentResolve = null;
  activeReader = null;
  scheduled = new Set();
  streamEnded = false;
  startClock = 0;
  nextStartTime = 0;
  playback = IDLE;
  emit();
  resolve?.();
}

// Decode a run of int16 LE PCM bytes → an AudioBuffer. Copies into a fresh buffer
// so Int16Array alignment is guaranteed regardless of the chunk's byteOffset.
function pcmToBuffer(ctx: AudioContext, bytes: Uint8Array): AudioBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const i16 = new Int16Array(copy.buffer);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  const buf = ctx.createBuffer(1, f32.length, TTS_SAMPLE_RATE);
  buf.getChannelData(0).set(f32);
  return buf;
}

/**
 * Speak `text` aloud, streaming: one request, audio starts as soon as the first
 * PCM bytes arrive and plays gaplessly to the end. Resolves when playback
 * finishes. Best-effort — resolves quietly if TTS is unavailable.
 */
export async function speakText(
  text: string,
  opts?: { voice?: string; signal?: AbortSignal; sessionId?: string | null; title?: string },
): Promise<void> {
  const t = text.trim();
  if (!t) return;
  const ctx = getCtx();
  if (!ctx) return;

  stopSpeaking(); // never overlap two playbacks
  const gen = ++generation;

  playback = {
    status: "loading",
    text: t,
    sessionId: opts?.sessionId ?? null,
    title: opts?.title ?? "",
    duration: 0,
    position: 0,
  };
  emit();

  let res: Response;
  try {
    res = await fetch("/api/voice/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: t, voice: opts?.voice }),
      signal: opts?.signal,
    });
  } catch {
    if (gen === generation) finish();
    return;
  }
  if (gen !== generation) return; // superseded while awaiting
  if (!res.ok || !res.body) {
    finish();
    return;
  }

  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* user-gesture rules may still block it — give up quietly */
    }
  }
  if (gen !== generation) return;

  const reader = res.body.getReader();
  activeReader = reader;
  streamEnded = false;
  startClock = ctx.currentTime + START_LEAD;
  nextStartTime = startClock;
  let leftover = new Uint8Array(0);
  let started = false;

  await new Promise<void>((resolve) => {
    currentResolve = resolve;

    const maybeDone = () => {
      if (gen === generation && streamEnded && scheduled.size === 0) finish();
    };

    const scheduleChunk = (bytes: Uint8Array) => {
      // Carry an odd trailing byte to the next chunk (int16 needs even length).
      let merged = bytes;
      if (leftover.length) {
        merged = new Uint8Array(leftover.length + bytes.length);
        merged.set(leftover);
        merged.set(bytes, leftover.length);
        leftover = new Uint8Array(0);
      }
      const usable = merged.length - (merged.length % 2);
      if (usable < merged.length) leftover = merged.slice(usable);
      if (usable === 0) return;

      const buf = pcmToBuffer(ctx, merged.subarray(0, usable));
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      // Never schedule in the past (first-audio jitter / underrun).
      if (nextStartTime < ctx.currentTime) nextStartTime = ctx.currentTime + 0.02;
      const at = nextStartTime;
      nextStartTime += buf.duration;
      src.onended = () => {
        scheduled.delete(src);
        maybeDone();
      };
      scheduled.add(src);
      try {
        src.start(at);
      } catch {
        scheduled.delete(src);
      }
      if (!started) {
        started = true;
        setPlayback({ status: "playing", position: 0 });
      }
      setPlayback({ duration: Math.max(0, nextStartTime - startClock) });
    };

    const pump = async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (gen !== generation) return; // stopped/superseded
          if (done) break;
          if (value && value.length) scheduleChunk(value);
        }
      } catch {
        /* network/abort — fall through to finish what's scheduled */
      }
      streamEnded = true;
      if (gen === generation) maybeDone();
    };

    void pump();
  });
}
