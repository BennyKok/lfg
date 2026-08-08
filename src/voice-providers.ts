// Pluggable STT providers behind the /api/voice/{stt,stt-stream} proxies, so
// switching provider here switches dictation everywhere. The internal contract
// every adapter honours:
//   STT  → JSON { text }   (input is octet-stream WAV)
// Secrets (API keys) stay server-side. Provider choices live in
// data/voice-settings.json; keys entered in the setup dialog are written to the
// server's .env file and are never returned to the browser.
// NOTE: text-to-speech was removed, so there is no TTS adapter here any more.
// The self-hosted GPU stacks under deploy/*-stt are NOT reachable from here —
// nothing reads STT_UPSTREAM/STT_WS_URL. Wiring one up means adding an adapter.

import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "./config.ts";

export type VoiceSettings = {
  sttProvider: string;
};

// Streaming-STT bridge. The browser dictation path holds a
// long-lived websocket to /api/voice/stt-stream and speaks a tiny protocol:
//   client→server : raw 16 kHz mono int16 PCM as BINARY frames; text frames
//                   {"type":"flush"} at each utterance boundary and
//                   {"type":"eof"} when the whole stream closes.
//   server→client : text frames {"type":"partial"|"final","text":"…"}.
// A provider that supports realtime STT exposes openStream(): it returns a bridge
// that proxies that protocol to its upstream realtime API. The upstream key never
// leaves this module — same as the batch adapters.
export type SttStreamHandlers = {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onClose?: () => void;
};

export type SttStreamBridge = {
  pushPcm: (pcm: Uint8Array) => void; // raw 16 kHz mono int16 PCM
  flush: () => void; // utterance boundary → finalize the current utterance
  close: () => void; // stream end → tear down the upstream
};

// On a hosted omg workspace there is no ElevenLabs key to enter — the platform
// relays transcription for us — so the default has to follow the environment
// rather than being a fixed string. A local install is unchanged.
const DEFAULTS = (): VoiceSettings => ({
  sttProvider: sttOmg.available() && !sttElevenLabs.available() ? "omg" : "elevenlabs",
});

const TIMEOUT_MS = 30000;

const jres = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const eres = (status: number, message: string) => jres({ error: message }, status);

type SttProvider = {
  id: string;
  label: string;
  envVar: string;
  accountUrl: string;
  available: () => boolean;
  transcribe: (audio: ArrayBuffer) => Promise<Response>;
  // Optional realtime path: open a streaming bridge for /api/voice/stt-stream.
  // Providers without realtime STT omit this and the proxy closes the socket.
  openStream?: (handlers: SttStreamHandlers) => SttStreamBridge | null;
};

// ---------------------------------------------------------------- STT adapters

// ElevenLabs "Scribe v2 Realtime": a websocket that streams interim
// (partial_transcript) and committed (committed_transcript) results as PCM
// arrives. Wire protocol (verified live):
//   URL  : wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=…
//   auth : xi-api-key header
//   c→s  : {message_type:"input_audio_chunk", audio_base_64, commit, sample_rate}
//   s→c  : session_started → partial_transcript* → committed_transcript
// We buffer ~100 ms of PCM per upstream message (fewer, fatter frames than the
// worker's tiny audio frames) and translate flush→commit:true. The upstream
// socket may still be connecting when the first audio arrives, so outbound
// messages queue until "open"; PCM frames are copied because Bun may reuse the
// underlying buffer after the handler returns.
function elevenLabsRealtimeStream(handlers: SttStreamHandlers): SttStreamBridge | null {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return null;
  const model = process.env.ELEVENLABS_STT_REALTIME_MODEL || "scribe_v2_realtime";
  // Commit strategy decides WHO finalizes (commits) a turn. Dictation now has a
  // reliable browser-owned boundary (tap/release or its local silence timer), so
  // manual is the deterministic default: realtime partials still stream while
  // speaking, then exactly one explicit flush finalizes the take. Server VAD is
  // retained as an opt-in for older/external streaming clients.
  // Tunables map to the realtime API query params (silence to wait before a
  // commit, and the speech/silence probability bar).
  const commitStrategy = process.env.ELEVENLABS_STT_COMMIT_STRATEGY || "manual";
  const serverVad = commitStrategy === "vad";
  const qs = new URLSearchParams({ model_id: model });
  if (serverVad) {
    qs.set("commit_strategy", "vad");
    qs.set(
      "vad_silence_threshold_secs",
      process.env.ELEVENLABS_STT_VAD_SILENCE_SECS || "0.6",
    );
    qs.set("vad_threshold", process.env.ELEVENLABS_STT_VAD_THRESHOLD || "0.4");
  }
  const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${qs.toString()}`;
  let up: WebSocket;
  try {
    up = new WebSocket(url, { headers: { "xi-api-key": key } } as unknown as string[]);
  } catch {
    return null;
  }
  let open = false;
  let closed = false;
  const outbox: string[] = [];
  let buf: Uint8Array[] = [];
  let bufBytes = 0;
  // Audio is normally drained upstream every ~100ms without committing. Track
  // whether any of it still needs a boundary so flush()+close() cannot emit two
  // commits for one take (close follows every successful browser flush).
  let uncommittedAudio = false;
  const FLUSH_BYTES = 3200; // ~100 ms @ 16 kHz mono s16le

  const sendRaw = (s: string) => {
    if (closed) return;
    if (open) {
      try {
        up.send(s);
      } catch {}
    } else outbox.push(s);
  };
  const sendChunk = (b64: string, commit: boolean) =>
    sendRaw(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: b64,
        commit,
        sample_rate: 16000,
      }),
    );
  const drain = (commit: boolean) => {
    // Under server-side VAD the engine owns commits; never force a mid-stream
    // commit from the worker's flush or we'd double-finalize one utterance.
    const doCommit = commit && !serverVad;
    if (bufBytes === 0) {
      if (doCommit && uncommittedAudio) {
        sendChunk("", true);
        uncommittedAudio = false;
      }
      return;
    }
    const merged = new Uint8Array(bufBytes);
    let off = 0;
    for (const c of buf) {
      merged.set(c, off);
      off += c.length;
    }
    buf = [];
    bufBytes = 0;
    sendChunk(Buffer.from(merged).toString("base64"), doCommit);
    uncommittedAudio = !doCommit;
  };

  up.addEventListener("open", () => {
    open = true;
    console.log(
      `[voice] scribe realtime open (commit=${commitStrategy}${serverVad ? `, silence=${process.env.ELEVENLABS_STT_VAD_SILENCE_SECS || "0.6"}s` : ""})`,
    );
    for (const s of outbox) {
      try {
        up.send(s);
      } catch {}
    }
    outbox.length = 0;
  });
  up.addEventListener("message", (ev: MessageEvent) => {
    let d: { message_type?: string; text?: string };
    try {
      d = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    const mt = d?.message_type;
    if (mt === "partial_transcript") handlers.onPartial((d.text || "").trim());
    else if (mt === "committed_transcript" || mt === "committed_transcript_with_timestamps")
      handlers.onFinal((d.text || "").trim());
    // Surface upstream errors instead of swallowing them (auth, quota, rate
    // limits, throttling) — silent failures here looked like "STT just stopped".
    else if (mt && mt.includes("error"))
      console.log(`[voice] scribe realtime ${mt}: ${JSON.stringify(d).slice(0, 200)}`);
  });
  up.addEventListener("close", () => {
    closed = true;
    handlers.onClose?.();
  });
  up.addEventListener("error", (e: unknown) => {
    // A close event follows; teardown happens there. Log so a failed upstream
    // handshake (bad key, network) is visible rather than silent.
    console.log(`[voice] scribe realtime ws error: ${(e as { message?: string })?.message || e}`);
  });

  return {
    pushPcm: (pcm) => {
      const copy = new Uint8Array(pcm.length);
      copy.set(pcm);
      buf.push(copy);
      bufBytes += copy.length;
      if (bufBytes >= FLUSH_BYTES) drain(false);
    },
    flush: () => drain(true),
    close: () => {
      if (closed) return;
      drain(true);
      closed = true;
      try {
        up.close();
      } catch {}
    },
  };
}

// ---------------------------------------------------------------- omg relay
//
// On a hosted omg workspace the platform runs the realtime STT upstream for us:
// the sandbox holds no provider key, and OMG_MEDIA_URL points at the per-sandbox
// media proxy. Its /realtime/transcribe websocket speaks the SAME neutral
// protocol this module already defines, so the bridge is a straight pipe:
//
//   we send  : binary PCM frames, {"type":"flush"}, {"type":"eof"}
//   we get   : {"type":"ready"|"partial"|"final"|"error"}
//
// Auth is ambient — reaching the proxy at all proves which sandbox you are — so
// there is no key to configure and nothing to put in the setup dialog.
function omgRelayURL(): string | null {
  const base = process.env.OMG_MEDIA_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, "").replace(/^http/, "ws")}/realtime/transcribe`;
}

function omgRelayStream(handlers: SttStreamHandlers): SttStreamBridge | null {
  const url = omgRelayURL();
  if (!url) return null;

  let up: WebSocket;
  try {
    up = new WebSocket(url);
  } catch (e) {
    console.log(`[voice] omg relay could not connect: ${(e as { message?: string })?.message || e}`);
    return null;
  }
  up.binaryType = "arraybuffer";

  let open = false;
  let closed = false;
  // Frames captured before the socket opens. openStream() must construct
  // synchronously (the ws open() handler can't await), so early audio queues
  // here rather than being dropped.
  const outbox: Array<string | Uint8Array> = [];

  const send = (frame: string | Uint8Array) => {
    if (closed) return;
    if (!open) {
      outbox.push(frame);
      return;
    }
    try {
      up.send(frame);
    } catch {}
  };

  up.addEventListener("open", () => {
    open = true;
    for (const frame of outbox) {
      try {
        up.send(frame);
      } catch {}
    }
    outbox.length = 0;
  });

  up.addEventListener("message", (ev) => {
    let d: { type?: string; text?: string; message?: string; status?: string };
    try {
      d = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    if (d.type === "partial") handlers.onPartial((d.text || "").trim());
    else if (d.type === "final") handlers.onFinal((d.text || "").trim());
    else if (d.type === "error") {
      // Fail loud: an exhausted allowance or a missing Computer grant is a real
      // condition the operator needs to see, not a silent downgrade.
      console.log(`[voice] omg relay error (${d.status || "unknown"}): ${d.message || ""}`);
    }
  });

  up.addEventListener("close", () => {
    closed = true;
    handlers.onClose?.();
  });
  up.addEventListener("error", (e) => {
    console.log(`[voice] omg relay ws error: ${(e as { message?: string })?.message || e}`);
  });

  return {
    pushPcm: (pcm) => {
      // Bun may reuse the underlying buffer for the next frame.
      const copy = new Uint8Array(pcm.length);
      copy.set(pcm);
      send(copy);
    },
    flush: () => send(JSON.stringify({ type: "flush" })),
    close: () => {
      if (closed) return;
      send(JSON.stringify({ type: "eof" }));
      closed = true;
      try {
        up.close();
      } catch {}
    },
  };
}

const sttOmg: SttProvider = {
  id: "omg",
  label: "OMG (hosted)",
  envVar: "OMG_MEDIA_URL",
  accountUrl: "https://omg.dev",
  available: () => !!process.env.OMG_MEDIA_URL,
  openStream: (handlers) => omgRelayStream(handlers),
  async transcribe() {
    // The relay is realtime-only: the platform's batch job API takes a public
    // audio URL, not bytes, so there is nothing to POST a clip to. Say so
    // plainly instead of returning an empty transcript the caller would treat
    // as silence.
    return eres(503, "omg relay is realtime-only; batch transcription is unavailable");
  },
};

const sttElevenLabs: SttProvider = {
  id: "elevenlabs",
  label: "ElevenLabs (Scribe)",
  envVar: "ELEVENLABS_API_KEY",
  accountUrl: "https://elevenlabs.io/app/developers/api-keys",
  available: () => !!process.env.ELEVENLABS_API_KEY,
  openStream: (handlers) => elevenLabsRealtimeStream(handlers),
  async transcribe(audio) {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return eres(503, "elevenlabs not configured");
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
    form.append("model_id", process.env.ELEVENLABS_STT_MODEL || "scribe_v1");
    try {
      const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": key },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) return eres(502, `elevenlabs stt ${r.status}`);
      const j = (await r.json().catch(() => ({}))) as { text?: string };
      return jres({ text: (j.text || "").trim() });
    } catch {
      return eres(502, "elevenlabs unreachable");
    }
  },
};

const sttOpenAI: SttProvider = {
  id: "openai",
  label: "OpenAI (Whisper)",
  envVar: "OPENAI_API_KEY",
  accountUrl: "https://platform.openai.com/api-keys",
  available: () => !!process.env.OPENAI_API_KEY,
  async transcribe(audio) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return eres(503, "openai not configured");
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
    form.append("model", process.env.OPENAI_STT_MODEL || "gpt-4o-mini-transcribe");
    try {
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) return eres(502, `openai stt ${r.status}`);
      const j = (await r.json().catch(() => ({}))) as { text?: string };
      return jres({ text: (j.text || "").trim() });
    } catch {
      return eres(502, "openai unreachable");
    }
  },
};

const STT: Record<string, SttProvider> = {
  [sttOmg.id]: sttOmg,
  [sttElevenLabs.id]: sttElevenLabs,
  [sttOpenAI.id]: sttOpenAI,
};

function providerById(id: string): SttProvider | undefined {
  return STT[id];
}

/** Replace or append one environment assignment without disturbing comments. */
export async function writeEnvValue(envFile: string, name: string, value: string): Promise<void> {
  let current = "";
  let mode = 0o600;
  try {
    current = await readFile(envFile, "utf8");
    mode = (await stat(envFile)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const assignment = `${name}=${value}`;
  const lines = current.split(/\r?\n/);
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (!new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line)) return line;
    replaced = true;
    return assignment;
  });
  if (!replaced) {
    if (nextLines.at(-1) === "") nextLines[nextLines.length - 1] = assignment;
    else nextLines.push(assignment);
  }
  const next = nextLines.join("\n");
  const temp = `${envFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, next, { encoding: "utf8", mode, flag: "wx" });
    await chmod(temp, mode);
    await rename(temp, envFile);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export async function saveVoiceProviderKey(providerId: string, apiKey: string): Promise<void> {
  const provider = providerById(providerId);
  if (!provider) throw new Error("unknown voice provider");
  const key = apiKey.trim();
  // Voice-provider keys are opaque, single-token credentials. Keeping the env
  // value to this character set also prevents shell/.env syntax injection.
  if (!key || key.length > 4096 || !/^[A-Za-z0-9._-]+$/.test(key)) {
    throw new Error("invalid API key format");
  }
  await writeEnvValue(join(PATHS.root, ".env"), provider.envVar, key);
  process.env[provider.envVar] = key;
}

// ------------------------------------------------------------ settings store

const filePath = () => join(PATHS.data, "voice-settings.json");

// A saved choice only survives while that provider is actually usable. A stale
// "elevenlabs" from a local install would otherwise pin a hosted workspace to a
// keyless provider and silently downgrade every take to the batch path — the
// exact failure this relay exists to remove.
function resolveSttProvider(saved: string | undefined): string {
  if (saved && STT[saved]?.available()) return saved;
  return DEFAULTS().sttProvider;
}

export async function getVoiceSettings(): Promise<VoiceSettings> {
  const f = Bun.file(filePath());
  if (!(await f.exists())) return DEFAULTS();
  try {
    const p = JSON.parse(await f.text()) as Partial<VoiceSettings>;
    return { sttProvider: resolveSttProvider(p.sttProvider) };
  } catch {
    return DEFAULTS();
  }
}

// Synchronous settings read for the websocket open() path, which can't await
// (a frame may arrive before an async read resolves). Same validation/fallback
// as getVoiceSettings; any error → DEFAULTS.
function getVoiceSettingsSync(): VoiceSettings {
  try {
    const p = JSON.parse(readFileSync(filePath(), "utf8")) as Partial<VoiceSettings>;
    return { sttProvider: resolveSttProvider(p.sttProvider) };
  } catch {
    return DEFAULTS();
  }
}

export async function setVoiceSettings(patch: Partial<VoiceSettings>): Promise<VoiceSettings> {
  const cur = await getVoiceSettings();
  const next: VoiceSettings = {
    sttProvider: patch.sttProvider && STT[patch.sttProvider] ? patch.sttProvider : cur.sttProvider,
  };
  await mkdir(PATHS.data, { recursive: true });
  await Bun.write(filePath(), JSON.stringify(next, null, 2));
  return next;
}

// What the settings UI renders: every provider plus whether its env is wired up
// (so we can grey out the ones that would 503).
export function listProviders() {
  const map = (
    p: {
      id: string;
      label: string;
      envVar: string;
      accountUrl: string;
      available: () => boolean;
      openStream?: unknown;
    },
  ) => ({
    id: p.id,
    label: p.label,
    envVar: p.envVar,
    accountUrl: p.accountUrl,
    available: p.available(),
    // Whether this provider can show words as you speak, rather than only after
    // the take ends.
    streaming: !!p.openStream,
  });
  return {
    stt: Object.values(STT).map(map),
  };
}

export function voiceSetupInfo() {
  return {
    envFile: join(PATHS.root, ".env"),
    restartCommand:
      process.platform === "darwin"
        ? "launchctl kickstart -k gui/$(id -u)/dev.omg.lfg"
        : "systemctl --user restart lfg.service",
  };
}

// ------------------------------------------------------------ dispatch

function pickStt(id: string): SttProvider {
  const p = STT[id];
  if (p && p.available()) return p;
  return firstAvailable((c) => !!c.transcribe) ?? sttElevenLabs;
}

// The configured provider is not always the usable one (a hosted workspace has
// no local key; a local install has no relay). Rather than hardcoding one
// fallback, take the first registered provider that is actually wired up and
// can do the job asked of it.
function firstAvailable(supports: (p: SttProvider) => boolean): SttProvider | null {
  for (const p of Object.values(STT)) {
    if (p.available() && supports(p)) return p;
  }
  return null;
}

export async function transcribeStt(audio: ArrayBuffer): Promise<Response> {
  const s = await getVoiceSettings();
  return pickStt(s.sttProvider).transcribe(audio);
}

// Open a realtime STT bridge for the /api/voice/stt-stream websocket. Picks the
// configured provider; if it has no realtime path, falls back to any other
// provider that does (the omg relay on a hosted workspace, ElevenLabs on a local
// install), else returns null so the proxy closes the socket and the browser
// degrades to the batch path. Sync so the websocket open() handler can build it
// without racing the first frame.
export function openSttStream(handlers: SttStreamHandlers): SttStreamBridge | null {
  const s = getVoiceSettingsSync();
  const chosen = STT[s.sttProvider];
  if (chosen?.available() && chosen.openStream) return chosen.openStream(handlers);
  const fallback = firstAvailable((p) => !!p.openStream);
  return fallback?.openStream?.(handlers) ?? null;
}

/** Whether a live (streaming) transcript is possible right now. Drives the UI's
 * "live vs after-the-fact" indicator, so a silent downgrade becomes visible. */
export function sttStreamingAvailable(): boolean {
  const chosen = STT[getVoiceSettingsSync().sttProvider];
  if (chosen?.available() && chosen.openStream) return true;
  return firstAvailable((p) => !!p.openStream) !== null;
}
