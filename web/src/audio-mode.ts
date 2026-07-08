// ─────────────────────────────────────────────────────────────────────────────
// Audio mode — the lightweight replacement for the old LiveKit "phone call".
//
// Instead of a separate voice agent inside a WebRTC room, audio mode is just a
// behavior layer on the CURRENT session:
//   1. When you send a message with audio mode on, the target session is primed
//      ONCE with a short instruction to stay conversational and delegate heavy
//      work to an lfg subagent (so a mis-heard phrase can't silently misexecute —
//      execution shows up as a normal, visible subagent session).
//   2. That session's replies are spoken aloud, streaming sentence-by-sentence as
//      the text arrives (see feedSpeech), reusing the one-shot TTS in voice-tts.
//
// No LiveKit, no second brain, no persistent room. State lives here as a tiny
// module store so the send path, the live-stream delta tap, and the settings
// toggle can all reach it without threading props through App.tsx.
// ─────────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";
import { speakText, stopSpeaking } from "./voice-tts";

const LS_KEY = "lfg_audio_mode";

function loadEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(LS_KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = loadEnabled();
// The one session we're currently having a spoken conversation with. Only this
// session's replies are spoken (multiple sessions can stream at once — we don't
// want them talking over each other).
let activeSid: string | null = null;

const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function isAudioModeEnabled(): boolean {
  return enabled;
}

export function setAudioModeEnabled(value: boolean): void {
  enabled = value;
  try {
    localStorage.setItem(LS_KEY, value ? "1" : "0");
  } catch {
    /* private mode / disabled storage — in-memory only */
  }
  if (!value) {
    activeSid = null;
    resetSpeech();
    stopSpeaking();
  }
  emit();
}

export function useAudioMode(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => enabled,
    () => false,
  );
}

export function getAudioActiveSid(): string | null {
  return activeSid;
}

export function setAudioActiveSid(sid: string | null): void {
  activeSid = sid;
}

// Short, honest, speakable priming turn. Sent once per session (per page load)
// the first time you talk to it in audio mode. Deliberately compact — it's a
// behavior nudge, not a full system prompt.
export const AUDIO_MODE_PRIMER =
  "Heads up: we're in voice mode now, so I'll hear your replies read aloud. " +
  "Keep answers short, natural, and speakable — a sentence or two, no code blocks or markdown. " +
  "For anything heavy or multi-step (editing files, running commands, longer research), " +
  "spin up an lfg subagent to do it and just tell me what you kicked off and what came back. " +
  "Stay conversational and quick.";

// Sessions already primed this page load — avoids re-sending the primer on every
// message. In-memory on purpose: a fresh load re-primes, which is harmless.
const primed = new Set<string>();

/** True (and marks primed) the first time a session needs the voice primer. */
export function takePrimeToken(sid: string): boolean {
  if (primed.has(sid)) return false;
  primed.add(sid);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming sentence speaker. Fed raw text deltas from the live assistant stream;
// emits complete sentences to TTS as soon as they form, so audio starts while the
// reply is still being written. Serialized through a single promise chain so
// sentences play in order and never overlap. Sentence-splitting mirrors the
// per-session summary speaker in App.tsx.
// ─────────────────────────────────────────────────────────────────────────────

let curSid: string | null = null;
let curId: string | null = null;
let pending = "";
let chain: Promise<void> = Promise.resolve();

function resetSpeech(): void {
  curSid = null;
  curId = null;
  pending = "";
}

function enqueue(sid: string, text: string): void {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return;
  chain = chain.then(() => speakText(t, { sessionId: sid }));
}

function drain(sid: string, force = false): void {
  for (;;) {
    const m = pending.match(/^([\s\S]*?[.!?])(?:\s+|$)/);
    if (!m) break;
    enqueue(sid, m[1]);
    pending = pending.slice(m[0].length);
  }
  // Long clause with no terminal punctuation — break at a comma/semicolon/space
  // so we don't sit silent through a run-on sentence.
  if (pending.length > 220) {
    const cut = Math.max(
      pending.lastIndexOf(",", 220),
      pending.lastIndexOf(";", 220),
      pending.lastIndexOf(" ", 220),
    );
    if (cut > 80) {
      enqueue(sid, pending.slice(0, cut));
      pending = pending.slice(cut + 1);
    }
  }
  if (force && pending.trim()) {
    enqueue(sid, pending);
    pending = "";
  }
}

/**
 * Feed an incremental chunk of an assistant reply. `reset` marks a snapshot of a
 * draft joined mid-stream (a catch-up blob) — we drop it rather than suddenly
 * blurting a wall of already-written text. No-op unless audio mode is on and this
 * is the active spoken session.
 */
export function feedSpeech(sid: string, id: string, chunk: string, reset = false): void {
  if (!enabled || sid !== activeSid) return;
  if (sid !== curSid || id !== curId) {
    // New assistant turn — flush the tail of the previous one first.
    if (curSid && pending) drain(curSid, true);
    curSid = sid;
    curId = id;
    pending = "";
  }
  if (reset) {
    pending = "";
    return;
  }
  pending += chunk ?? "";
  drain(sid);
}

/** The active turn finished — speak whatever's left in the buffer. */
export function endSpeech(sid: string, id: string): void {
  if (sid !== curSid || id !== curId) return;
  drain(sid, true);
  curSid = null;
  curId = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual per-message speaker (the speaker button on each reply). Speaks a whole,
// already-complete message but STILL streams: it splits into sentences and plays
// them one at a time, so the first sentence starts almost immediately instead of
// waiting for the entire message to synthesize. Exposes which message is
// currently speaking (useSpeakingMessageId) so the button can show instant
// feedback and act as a toggle/stop.
// ─────────────────────────────────────────────────────────────────────────────

let speakingId: string | null = null;
let speakGen = 0; // bumped on every stop/new-speak so a stale chain bails out
const speakListeners = new Set<() => void>();
const emitSpeak = () => {
  for (const l of speakListeners) l();
};

export function useSpeakingMessageId(): string | null {
  return useSyncExternalStore(
    (l) => {
      speakListeners.add(l);
      return () => speakListeners.delete(l);
    },
    () => speakingId,
    () => null,
  );
}

/** Stop all playback and clear the per-message speaking indicator. */
export function stopSpeakingAll(): void {
  speakGen++;
  if (speakingId !== null) {
    speakingId = null;
    emitSpeak();
  }
  stopSpeaking();
}

// Light markdown strip so TTS doesn't read out asterisks/backticks/heading marks.
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_#>~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Speak a message aloud on demand. The whole text goes to TTS in a single
 * streaming call (speakText plays PCM as it arrives), so audio starts fast and
 * plays gaplessly — no per-sentence chopping. Pressing the same message again
 * stops it (toggle). `speakingId` is set synchronously so the button shows
 * feedback the instant it's pressed, before any audio loads.
 */
export async function speakMessage(id: string, text: string, sid?: string | null): Promise<void> {
  if (speakingId === id) {
    stopSpeakingAll();
    return;
  }
  const clean = stripMarkdown(text);
  if (!clean) return;
  speakGen++;
  const myGen = speakGen;
  speakingId = id;
  emitSpeak();
  try {
    await speakText(clean, { sessionId: sid ?? undefined });
  } finally {
    if (myGen === speakGen && speakingId === id) {
      speakingId = null;
      emitSpeak();
    }
  }
}
