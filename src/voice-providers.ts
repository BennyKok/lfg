// Pluggable TTS/STT providers behind the /api/voice/{tts,stt} proxies. Both the
// browser dictation path and the Python LiveKit worker funnel through those two
// endpoints, so switching provider here switches it everywhere — the worker
// (deploy/voice/agent.py) needs no changes. The internal contract every adapter
// honours, which the worker consumes verbatim:
//   TTS  → raw 24 kHz mono int16 PCM byte stream (no container/header)
//   STT  → JSON { text }   (input is octet-stream WAV)
// Secrets (API keys / upstream tokens) stay server-side. Provider choices live
// in data/voice-settings.json; keys entered in the setup dialog are written to
// the server's .env file and are never returned to the browser.

import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "./config.ts";

export type VoiceSettings = {
  ttsProvider: string;
  sttProvider: string;
};

// Streaming-STT bridge. The LiveKit worker (agent.py LfgSpeechStream) holds a
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

const DEFAULTS: VoiceSettings = {
  ttsProvider: "elevenlabs",
  sttProvider: "elevenlabs",
};

const TIMEOUT_MS = 30000;

const jres = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const eres = (status: number, message: string) => jres({ error: message }, status);

// Raw-PCM passthrough: the worker reads bytes verbatim, so the Content-Type is
// cosmetic — we keep the original audio/wav label every consumer already expects.
const pcm = (body: ReadableStream<Uint8Array> | null) =>
  new Response(body, {
    headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
  });

type TtsProvider = {
  id: string;
  label: string;
  envVar: string;
  accountUrl: string;
  available: () => boolean;
  synthesize: (text: string, voice?: string) => Promise<Response>;
};

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

// ---------------------------------------------------------------- TTS adapters

// Transcode an mp3 stream to the worker's contract (raw 24 kHz mono s16le PCM)
// via ffmpeg. We request mp3 rather than ElevenLabs' pcm_* formats because PCM
// output is a paid-tier feature — mp3 works on every tier, and ffmpeg (already
// on the box) normalizes it. ffmpeg reads the mp3 from stdin as chunks arrive
// and we stream its stdout, so PCM starts flowing before the whole clip is
// synthesized (no buffer-the-whole-utterance penalty).
function mp3ToPcm24k(mp3: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const proc = Bun.spawn({
    cmd: [
      "ffmpeg", "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", "24000",
      "pipe:1",
    ],
    stdin: mp3,
    stdout: "pipe",
    stderr: "ignore",
  });
  return proc.stdout;
}

// ElevenLabs TTS over the stream-input websocket (lower time-to-first-audio than
// the batch /stream endpoint). We request native pcm_24000 — verified usable on
// this account — so the worker gets raw 24 kHz mono int16 PCM directly, no ffmpeg
// transcode in the hot path. Protocol:
//   URL  : wss://…/v1/text-to-speech/{voice}/stream-input?model_id=…&output_format=pcm_24000
//   auth : xi-api-key header
//   c→s  : BOS {text:" ",voice_settings,generation_config} → {text:"<sentence>"} → EOS {text:""}
//   s→c  : {audio:"<base64 pcm>"} chunks, then {isFinal:true}
// The StreamAdapter in the worker calls /api/voice/tts once per sentence, so each
// call streams one sentence and closes. Returns a ReadableStream that enqueues
// decoded PCM as it arrives, so the Response body flows to the worker live.
function elevenLabsStreamInputPcm(text: string, voiceId: string, model: string, key: string): ReadableStream<Uint8Array> {
  const fmt = process.env.ELEVENLABS_TTS_OUTPUT_FORMAT || "pcm_24000";
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input` +
    `?model_id=${encodeURIComponent(model)}&output_format=${encodeURIComponent(fmt)}`;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          controller.close();
        } catch {}
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, { headers: { "xi-api-key": key } } as unknown as string[]);
      } catch {
        finish();
        return;
      }
      // Bound the call so a stalled synth can't pin the worker's TTS turn open.
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        finish();
      }, TIMEOUT_MS);
      ws.addEventListener("open", () => {
        try {
          // BOS — initialize the stream; a low first chunk_length_schedule value
          // makes generation start after few characters → faster first audio.
          ws.send(
            JSON.stringify({
              text: " ",
              voice_settings: { stability: 0.5, similarity_boost: 0.8 },
              generation_config: { chunk_length_schedule: [50, 160, 250, 290] },
            }),
          );
          ws.send(JSON.stringify({ text: `${text} ` }));
          ws.send(JSON.stringify({ text: "" })); // EOS → flush + finish
        } catch {
          finish();
        }
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        let d: { audio?: string | null; isFinal?: boolean; error?: unknown };
        try {
          d = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        } catch {
          return;
        }
        if (d.audio) {
          try {
            controller.enqueue(new Uint8Array(Buffer.from(d.audio, "base64")));
          } catch {}
        }
        if (d.isFinal || d.error) {
          try {
            ws.close();
          } catch {}
        }
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        finish();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        finish();
      });
    },
  });
}

const ttsElevenLabs: TtsProvider = {
  id: "elevenlabs",
  label: "ElevenLabs",
  envVar: "ELEVENLABS_API_KEY",
  accountUrl: "https://elevenlabs.io/app/developers/api-keys",
  available: () => !!process.env.ELEVENLABS_API_KEY,
  async synthesize(text) {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return eres(503, "elevenlabs not configured");
    // Sarah — a premade voice confirmed usable on the free API tier. (Some
    // library voices 402 for free accounts; override via ELEVENLABS_VOICE_ID.)
    const voiceId = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
    const model = process.env.ELEVENLABS_TTS_MODEL || "eleven_turbo_v2_5";
    try {
      // Primary: stream-input websocket → native PCM, lowest first-audio latency.
      return pcm(elevenLabsStreamInputPcm(text, voiceId, model, key));
    } catch {
      // Fallback: batch /stream mp3 piped through ffmpeg (every-tier safe), in
      // case the websocket path can't be constructed in this runtime.
      try {
        const r = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`,
          {
            method: "POST",
            headers: { "xi-api-key": key, "Content-Type": "application/json" },
            body: JSON.stringify({ text, model_id: model }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          },
        );
        if (!r.ok || !r.body) {
          const detail = await r.text().catch(() => "");
          return eres(502, `elevenlabs tts ${r.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
        }
        return pcm(mp3ToPcm24k(r.body));
      } catch {
        return eres(502, "elevenlabs unreachable");
      }
    }
  },
};

const ttsOpenAI: TtsProvider = {
  id: "openai",
  label: "OpenAI",
  envVar: "OPENAI_API_KEY",
  accountUrl: "https://platform.openai.com/api-keys",
  available: () => !!process.env.OPENAI_API_KEY,
  async synthesize(text) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return eres(503, "openai not configured");
    const voice = process.env.OPENAI_TTS_VOICE || "alloy";
    const model = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
    try {
      // response_format pcm → raw 24 kHz mono s16le.
      const r = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, voice, input: text, response_format: "pcm" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) return eres(502, `openai tts ${r.status}`);
      return pcm(r.body);
    } catch {
      return eres(502, "openai unreachable");
    }
  },
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
  // Commit strategy decides WHO finalizes (commits) a turn:
  //   "vad"    — ElevenLabs' own server-side VAD commits on detected silence.
  //              This is load-immune: it does NOT depend on the voice worker's
  //              local Silero VAD producing an end-of-turn "flush", which lagged
  //              under box load and left turns transcribed-but-never-submitted
  //              (you'd see the caption fill in, but the agent never replied).
  //   "manual" — legacy: only the worker's flush commits a turn.
  // Tunables map to the realtime API query params (silence to wait before a
  // commit, and the speech/silence probability bar).
  const commitStrategy = process.env.ELEVENLABS_STT_COMMIT_STRATEGY || "vad";
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
      if (doCommit) sendChunk("", true);
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

const TTS: Record<string, TtsProvider> = {
  [ttsElevenLabs.id]: ttsElevenLabs,
  [ttsOpenAI.id]: ttsOpenAI,
};

const STT: Record<string, SttProvider> = {
  [sttElevenLabs.id]: sttElevenLabs,
  [sttOpenAI.id]: sttOpenAI,
};

function providerById(id: string): TtsProvider | SttProvider | undefined {
  return TTS[id] ?? STT[id];
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

export async function getVoiceSettings(): Promise<VoiceSettings> {
  const f = Bun.file(filePath());
  if (!(await f.exists())) return { ...DEFAULTS };
  try {
    const p = JSON.parse(await f.text()) as Partial<VoiceSettings>;
    return {
      ttsProvider: p.ttsProvider && TTS[p.ttsProvider] ? p.ttsProvider : DEFAULTS.ttsProvider,
      sttProvider: p.sttProvider && STT[p.sttProvider] ? p.sttProvider : DEFAULTS.sttProvider,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// Synchronous settings read for the websocket open() path, which can't await
// (a frame may arrive before an async read resolves). Same validation/fallback
// as getVoiceSettings; any error → DEFAULTS.
function getVoiceSettingsSync(): VoiceSettings {
  try {
    const p = JSON.parse(readFileSync(filePath(), "utf8")) as Partial<VoiceSettings>;
    return {
      ttsProvider: p.ttsProvider && TTS[p.ttsProvider] ? p.ttsProvider : DEFAULTS.ttsProvider,
      sttProvider: p.sttProvider && STT[p.sttProvider] ? p.sttProvider : DEFAULTS.sttProvider,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function setVoiceSettings(patch: Partial<VoiceSettings>): Promise<VoiceSettings> {
  const cur = await getVoiceSettings();
  const next: VoiceSettings = {
    ttsProvider: patch.ttsProvider && TTS[patch.ttsProvider] ? patch.ttsProvider : cur.ttsProvider,
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
    },
  ) => ({
    id: p.id,
    label: p.label,
    envVar: p.envVar,
    accountUrl: p.accountUrl,
    available: p.available(),
  });
  return {
    tts: Object.values(TTS).map(map),
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

function pickTts(id: string): TtsProvider {
  const p = TTS[id];
  if (p && p.available()) return p;
  return ttsElevenLabs; // safe fallback: never break voice on a mis-set provider
}

function pickStt(id: string): SttProvider {
  const p = STT[id];
  if (p && p.available()) return p;
  return sttElevenLabs;
}

export async function synthesizeTts(text: string, voice?: string): Promise<Response> {
  const s = await getVoiceSettings();
  return pickTts(s.ttsProvider).synthesize(text, voice);
}

export async function transcribeStt(audio: ArrayBuffer): Promise<Response> {
  const s = await getVoiceSettings();
  return pickStt(s.sttProvider).transcribe(audio);
}

// Open a realtime STT bridge for the /api/voice/stt-stream websocket. Picks the
// configured provider; if it has no realtime path, falls back to ElevenLabs when
// available, else returns null so the proxy closes the socket (the worker then
// has no interim transcripts and the operator should unset STT_WS_URL). Sync so
// the websocket open() handler can build it without racing the first frame.
export function openSttStream(handlers: SttStreamHandlers): SttStreamBridge | null {
  const s = getVoiceSettingsSync();
  const chosen = STT[s.sttProvider];
  if (chosen?.available() && chosen.openStream) return chosen.openStream(handlers);
  if (sttElevenLabs.available() && sttElevenLabs.openStream)
    return sttElevenLabs.openStream(handlers);
  return null;
}
