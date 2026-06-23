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

const TTS_SAMPLE_RATE = 24000; // matches synthesizeTts() output on the server

let sharedCtx: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;

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
  if (currentSource) {
    try {
      currentSource.onended = null;
      currentSource.stop();
    } catch {
      /* already stopped */
    }
    currentSource = null;
  }
}

/**
 * Speak `text` aloud and resolve when playback finishes. Best-effort: returns
 * (resolves) quietly if TTS is unavailable rather than throwing into the caller's
 * one-shot flow — the session has already been created by the time we speak.
 */
export async function speakText(
  text: string,
  opts?: { voice?: string; signal?: AbortSignal },
): Promise<void> {
  const t = text.trim();
  if (!t) return;
  const ctx = getCtx();
  if (!ctx) return;

  let buf: ArrayBuffer;
  try {
    const res = await fetch("/api/voice/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: t, voice: opts?.voice }),
      signal: opts?.signal,
    });
    if (!res.ok) return;
    buf = await res.arrayBuffer();
  } catch {
    return; // network/abort — nothing to play
  }
  if (buf.byteLength < 2) return;

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

  stopSpeaking(); // never overlap two confirmations
  await new Promise<void>((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    src.onended = () => {
      if (currentSource === src) currentSource = null;
      resolve();
    };
    currentSource = src;
    try {
      src.start();
    } catch {
      resolve();
    }
  });
}
