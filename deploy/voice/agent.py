"""
lfg voice agent worker (LiveKit Agents 1.6.x) — high-performance realtime path.

Pipeline (every stage streams + overlaps the next):
  room audio
    -> Silero VAD + semantic end-of-utterance model (fast, accurate turn-taking)
    -> STT: streaming NeMo cache-aware FastConformer over a websocket when
       STT_WS_URL is set (interim + final transcripts); else batch lfg
       /api/voice/stt (faster-whisper) as the safe default.
    -> LLM: Haiku via the Messages API streamed over SSE — text deltas are
       spoken as they arrive (anthropic_stream + LfgLLM).
    -> TTS: lfg /api/voice/tts wrapped in a sentence StreamAdapter, so sentence 1
       synthesizes while the model is still generating sentence 2 (build_tts).
    -> agent audio track back to the room.

Realtime add-ons (VAD, turn-detector, streaming STT, TTS StreamAdapter) are each
optional: if a plugin/model/weight isn't installed the worker logs it and falls
back to the previous batch/default behavior, so it always starts.

Env:
  STT_WS_URL            ws:// endpoint of the streaming-STT server
                        (deploy/streaming-stt); unset = batch STT.
  LIVEKIT_INFERENCE_URL set only if you run a LiveKit inference gateway / Cloud;
                        unset = on-box local turn detection (the self-hosted norm).
Extra deps for the realtime path (install into the lk-agent venv):
  livekit-plugins-turn-detector   (local end-of-utterance model)
  then once: `python agent.py download-files` to fetch its weights.
VAD is AgentSession's bundled Silero default — no separate plugin needed.

Run:  LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
      /home/dev/lk-agent/bin/python agent.py dev
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import time
import warnings
import wave
from pathlib import Path

import aiohttp

from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RoomInputOptions,
    TurnHandlingOptions,
    WorkerOptions,
    cli,
    llm,
    stt,
    tokenize,
    tts,
    utils,
)

LFG = os.environ.get("LFG_BASE", "http://127.0.0.1:8766")
CREDS_FILE = Path.home() / ".claude" / ".credentials.json"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
# The voice brain is Haiku (fast, cheap). When a question is genuinely hard or
# risky it consults ONE advisor: a single Opus hop, in-process, sharing the same
# fleet tools so it can both reason AND act. This replaces the old confusing
# setup — a Haiku→Sonnet→Opus ladder AND a separate slow backend advisor session
# — with one clear, fast escalation the user can actually follow.
HAIKU_MODEL = "claude-haiku-4-5"
OPUS_MODEL = "claude-opus-4-8"
SONNET_MODEL = "claude-sonnet-4-6"
# The advisor is Opus; if it's momentarily unavailable (e.g. rate-limited) fall
# back to Sonnet so a consult still returns something useful. Still ONE advisor
# from the user's view — just resilient, not a recursive ladder.
ADVISOR_MODELS = [OPUS_MODEL, SONNET_MODEL]
# Appended to the system prompt when Opus is answering as the advisor, so it
# knows it may ACT on the fleet, not just hand back advice.
ADVISOR_NOTE = (
    "\n\nYou are the advisor: the stronger model the voice assistant consults "
    "when a question is hard or ambiguous or an action is risky. You have the "
    "SAME fleet tools and may ACT directly — reply to a session, answer a "
    "blocked prompt, close a session — in addition to reasoning. Re-read live "
    "state with get_fleet_status / list_sessions before acting, stay within the "
    "speaking user's sessions, and never touch the voice session itself. Answer "
    "in at most 3 short, plain spoken sentences; it is read aloud."
)
VOICE_PROMPT = (
    "You are a hands-free voice assistant inside lfg, a dashboard for managing "
    "AI coding-agent sessions (Claude Code and similar). Reply in at most 1-2 "
    "short, plain spoken sentences. No markdown, no code blocks, no bullet "
    "lists, no symbols meant to be read aloud. Be direct and conversational.\n"
    "WHO YOU SERVE: you are scoped to ONE person — the user speaking to you. The "
    "snapshot and list_sessions show only THEIR sessions, and you act only on "
    "their fleet. 'My project', 'it', 'this', or 'that session' (with no name) "
    "means their currently focused session — resolve it from the FOCUS line in "
    "your context before acting.\n"
    "CRITICAL for speed and not being annoying:\n"
    "- Answer in ONE short sentence. NEVER narrate or preface — no 'let me "
    "check', 'one moment', 'I'm checking'. Just answer.\n"
    "- NEVER claim an action happened until you have seen its tool result. Say "
    "what you are ABOUT to do (present tense), never that it is already done, "
    "until the result comes back — then confirm it, or say it failed.\n"
    "- Do NOT call a tool unless the user CLEARLY asks about session/fleet "
    "status, asks to act on a specific session, or asks a technical/informative "
    "question that warrants a session (see ANSWERING QUESTIONS below). For "
    "greetings/small talk, just reply — no tools.\n"
    "- If what you heard is short, empty, unclear, or garbled, do NOT guess and "
    "do NOT act — briefly ask the user to repeat.\n"
    "- For a SIMPLE ambiguity (which of two sessions did they mean?), just ASK "
    "the user in one short sentence. Do NOT consult the advisor for that.\n"
    "ANSWERING QUESTIONS: for casual, conversational, or quick factual questions, "
    "just answer in one short sentence. But for any TECHNICAL or INFORMATIVE "
    "question — how something works, what the code/repo/architecture does, why a "
    "bug happens, how to build or fix something, research, or anything needing "
    "real depth or accuracy — do NOT answer it yourself from memory. You are a "
    "fast lightweight voice brain and would likely be shallow or wrong. Instead "
    "create_session to spin up a coding agent that investigates with full repo and "
    "tool access and answers it properly. Say one short conversational hold like "
    "'give me a moment, looking into that' — NEVER say 'advisor', 'session', "
    "'spinning up', or 'let me ask my advisor' — then call create_session with a "
    "clear one-line prompt capturing the question. Only skip the session if the "
    "user explicitly says they just want your quick take.\n\n"
    "You can act on the fleet with tools. ALWAYS resolve a session to its exact "
    "id (from list_sessions or the snapshot) BEFORE reply_to_session, "
    "answer_session_prompt, or close_session — never act on a guessed id.\n"
    "- get_fleet_status — re-read live status of the user's sessions. The "
    "snapshot in your context goes stale fast: ALWAYS call this first whenever "
    "the user asks what's happening now, the current status, whether a session "
    "finished/changed, or anything time-sensitive. Answer from the fresh "
    "result, not the connect-time snapshot.\n"
    "- list_sessions — get session ids + titles, plus agent kind, model, "
    "project, status, and how long each has been idle (needed before acting on "
    "one, and to answer which-session-is-which questions).\n"
    "- search_transcript — search ONE session's full history for a word/phrase "
    "and get matching snippets. Use it when the user asks what a session said, "
    "decided, or worked on — the snapshot only shows its latest line.\n"
    "- list_repos — list the projects/repos a new session can start in (name + "
    "path); use it to resolve the folder when the user names a project.\n"
    "- create_session — start a NEW coding-agent session, either to DO a task or "
    "to GO FIND OUT something the user wants to know (spin up an agent to "
    "investigate, e.g. 'check our analytics' or 'see how the auth fix is "
    "going'). Pass a clear one-line `prompt`. It defaults to the user's focused "
    "project; pass `cwd` (from list_repos) only when they name a different one. "
    "Optionally pass `agent` (`codex-aisdk` for Codex, `opencode` for OpenCode) "
    "and, for any Claude or Codex session, `thinkingLevel` as low, medium, high, "
    "or xhigh to set how hard it reasons. "
    "You CAN create sessions from voice — do it when the user asks, don't tell "
    "them to use the dashboard.\n"
    "- reply_to_session — send an instruction to another session.\n"
    "- answer_session_prompt — pick an option for a session that is BLOCKED on "
    "a permission/plan prompt (use the option index from its snapshot line).\n"
    "- close_session — shut down / end a session the user is done with. Resolve "
    "the exact id first; never close your own voice session.\n"
    "- consult_advisor — hand a genuinely HARD or RISKY question to a stronger "
    "deep-thinking model that has full repo + tool access and can act on the "
    "fleet itself. Use it ONLY when careful reasoning is truly needed, NOT for "
    "simple disambiguation. It takes a while, so first say one short conversational "
    "hold like 'hold on a minute' or 'give me a moment, looking into that' — "
    "NEVER mention the advisor, a model, or that you're escalating.\n"
    "Prefer answer_session_prompt over reply_to_session when a session is "
    "waiting on a choice. Never act on your own voice session."
)

# Module state for the single active voice job (room "voice", one job at a time).
ROOM: rtc.Room | None = None
# The system prompt stays FROZEN at the (large, stable) VOICE_PROMPT so it
# prompt-caches across every turn and every connect. Volatile fleet status does
# NOT live here — it goes in LIVE_CONTEXT and is injected into the message
# stream instead (see seed_system_prompt / run_brain), so refreshing it never
# invalidates the cached system+tools prefix.
SYSTEM_PROMPT: str = VOICE_PROMPT
# Volatile, per-connection context (fleet snapshot + focus + user context),
# refreshed at connect AND on every fleet-completion push. Injected as a leading
# conversation turn, never baked into the cached system prompt.
LIVE_CONTEXT: str = ""
# Set once we've launched the fleet-completion SSE watcher, so reconnects don't
# stack duplicate watchers.
_FLEET_WATCH_STARTED: bool = False
# Rate-limit spoken push heads-ups so a burst of completions can't chatter.
_LAST_PUSH_ANNOUNCE: float = 0.0
PUSH_ANNOUNCE_GAP: float = 8.0
# The live AgentSession (set in entrypoint) so the background advisor can speak
# its answer out-of-band via session.say(), and the in-flight advisor task so a
# consult is single-flight (one Opus pass at a time).
SESSION: "AgentSession | None" = None
_ADVISOR_TASK: "asyncio.Task | None" = None
# The lfg user the current speaker is (set from the human participant's `lfg.user`
# attribute, which the web orb publishes from its chosen user). Empty / "__all"
# means "no scoping" — show the whole fleet, as before. When set, every fleet
# read and action is filtered to this user's sessions so one person never sees
# or touches another's work.
CURRENT_USER: str = ""
# Where LFG persists which session the user is focused on ("it" / "my
# project"). Read fresh each turn so it tracks what they're on.
FOCUS_FILE = Path.home() / ".lfg" / "active-session"


def _oauth_token() -> str | None:
    """Read the current Claude OAuth access token (kept fresh by Claude Code)."""
    try:
        c = json.loads(CREDS_FILE.read_text())
        return (c.get("claudeAiOauth") or {}).get("accessToken")
    except Exception:
        return None


_http: aiohttp.ClientSession | None = None


async def get_http() -> aiohttp.ClientSession:
    global _http
    if _http is None or _http.closed:
        # Bound every request so a stalled Anthropic/LFG call can't pin the voice
        # turn open. Without this the LLM stream never finishes and the orb is
        # stuck narrating "Thinking…" (LiveKit's lk.agent.state stays "thinking"
        # for the whole life of LfgLLMStream). connect/sock_read are short; total
        # leaves headroom for a slow deep-think consult.
        timeout = aiohttp.ClientTimeout(total=60, connect=10, sock_read=45)
        _http = aiohttp.ClientSession(timeout=timeout)
    return _http


def _pcm16_wav(pcm: bytes, rate: int, ch: int) -> bytes:
    buf = io.BytesIO()
    w = wave.open(buf, "wb")
    w.setnchannels(ch)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(pcm)
    w.close()
    return buf.getvalue()


def _wav_to_pcm(data: bytes) -> tuple[int, int, bytes]:
    w = wave.open(io.BytesIO(data), "rb")
    return w.getframerate(), w.getnchannels(), w.readframes(w.getnframes())


# ── transcript gate: kill noise-/crowd-triggered turns ───────────────────────
# The user's main symptom is ambient + crowd babble FALSELY triggering a turn:
# VAD fires on diffuse noise, the clip reaches STT, and the model "transcribes"
# it into a phantom phrase the brain then answers out loud. DTLN + the browser
# noise-canceller cut most of this at the audio layer, and the VAD is tuned so
# crowd babble shouldn't cross it — but anything that slips through still lands as
# an ASR hallucination. Those hallucinations are overwhelmingly a tiny, known set
# of fillers ("you", "thank you", "thanks for watching", "[BLANK_AUDIO]", a bare
# "."). So we gate the COMMITTED transcript: a turn whose text is empty, has no
# real word characters (punctuation/symbols only), or is exactly one known filler
# is dropped — it never becomes a user message and never reaches run_brain.
#
# Deliberately CONSERVATIVE: we gate on "no lexical content" / known-filler-only,
# never on length. Real short commands ("yes", "no", "stop", "go", "wait") have
# word characters and aren't in the filler set, so they always pass.
_NOISE_FILLERS = frozenset(
    {
        "you",
        "you you",
        "thank you",
        "thank you.",
        "thank you very much",
        "thank you so much",
        "thanks",
        "thanks for watching",
        "thanks for watching everyone",
        "thank you for watching",
        "please subscribe",
        "subscribe",
        "bye",
        "bye bye",
        "blank audio",
        "silence",
        "music",
        "uh",
        "um",
        "hmm",
        "mm",
        "mhm",
        # elongated variants of the above — ASR often emits these for crowd
        # murmur / throat noise, and length-collapsing them is riskier than just
        # listing them (so we never swallow a real short word).
        "mhmm",
        "mmhmm",
        "umm",
        "uhm",
        "uhh",
        "mmm",
        "hmmm",
        # backchannels (option B: reject all of them). These are the normalized,
        # space-separated forms ASR emits for "mm-hmm"/"uh-huh"/"mm-mm"/"uh-uh"
        # (the gate lowercases and turns punctuation into spaces before matching).
        "mm hmm",
        "uh huh",
        "mm mm",
        "uh uh",
    }
)


def _normalize_transcript(text: str) -> str:
    """Lowercase, drop every non-alphanumeric char to spaces, collapse runs.
    Leaves only the lexical core, so "[BLANK_AUDIO]" -> "blank audio", "you." ->
    "you", "..." / "♪♪" -> "" (no word chars)."""
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", (text or "").lower())).strip()


def _is_meaningful(text: str) -> bool:
    """True only for a real user utterance. False for empty / punctuation-only /
    known ASR noise-hallucination fillers — those are dropped before the brain.
    Conservative by design: short genuine commands (yes/no/stop/go) pass."""
    core = _normalize_transcript(text)
    if not core:
        return False  # empty, whitespace, or punctuation/symbols only
    return core not in _NOISE_FILLERS


def _speakable(md: str) -> str:
    t = md
    t = re.sub(r"```[\s\S]*?```", " ", t)
    t = re.sub(r"`([^`]+)`", r"\1", t)
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", t)
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"^\s{0,3}#{1,6}\s+", "", t, flags=re.M)
    t = re.sub(r"^\s*[-*+]\s+", "", t, flags=re.M)
    t = re.sub(r"[*_~]{1,3}([^*_~]+)[*_~]{1,3}", r"\1", t)
    return re.sub(r"\s+", " ", t).strip()


# ── STT: lfg /api/voice/stt (faster-whisper) ────────────────────────────────
class LfgSTT(stt.STT):
    def __init__(self) -> None:
        super().__init__(
            capabilities=stt.STTCapabilities(streaming=False, interim_results=False)
        )

    async def _recognize_impl(self, buffer, *, language=None, conn_options=None):
        frame = rtc.combine_audio_frames(buffer)
        wav = _pcm16_wav(bytes(frame.data), frame.sample_rate, frame.num_channels)
        text = ""
        try:
            http = await get_http()
            async with http.post(
                f"{LFG}/api/voice/stt",
                data=wav,
                headers={"Content-Type": "application/octet-stream"},
            ) as r:
                if r.status == 200:
                    j = await r.json()
                    text = (j.get("text") or "").strip()
        except Exception:
            pass
        if text:
            print(f"[voice] user: {text}", flush=True)
        return stt.SpeechEvent(
            type=stt.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives=[stt.SpeechData(language=language or "en", text=text)],
        )


# ── STT (streaming): NeMo cache-aware FastConformer over a websocket ─────────
# Opt-in via STT_WS_URL. When set, audio frames stream to a streaming-ASR server
# that emits interim ("partial") and "final" transcripts as the user speaks, so
# the pipeline can endpoint and react far sooner than batch whisper. When unset,
# make_stt() returns the batch LfgSTT above unchanged (the safe default).
#
# Wire protocol (server side — see deploy/streaming-stt/):
#   client -> server : raw 16 kHz mono int16 PCM as binary ws frames,
#                      then a text frame {"type":"eof"} at end of stream.
#   server -> client : text frames {"type":"partial"|"final","text": "..."}.
STT_WS_URL = os.environ.get("STT_WS_URL", "").strip()
STT_SAMPLE_RATE = 16000


class LfgStreamingSTT(stt.STT):
    def __init__(self, ws_url: str) -> None:
        super().__init__(
            capabilities=stt.STTCapabilities(streaming=True, interim_results=True)
        )
        self._ws_url = ws_url

    async def _recognize_impl(self, buffer, *, language=None, conn_options=None):
        # Batch fallback so .recognize() (non-stream callers) still works: reuse
        # the existing HTTP STT proxy rather than the websocket.
        frame = rtc.combine_audio_frames(buffer)
        wav = _pcm16_wav(bytes(frame.data), frame.sample_rate, frame.num_channels)
        text = ""
        try:
            http = await get_http()
            async with http.post(
                f"{LFG}/api/voice/stt",
                data=wav,
                headers={"Content-Type": "application/octet-stream"},
            ) as r:
                if r.status == 200:
                    text = ((await r.json()).get("text") or "").strip()
        except Exception:
            pass
        return stt.SpeechEvent(
            type=stt.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives=[stt.SpeechData(language=language or "en", text=text)],
        )

    def stream(self, *, language=None, conn_options=None):
        return LfgSpeechStream(stt=self, ws_url=self._ws_url, conn_options=conn_options)


class LfgSpeechStream(stt.SpeechStream):
    def __init__(self, *, stt, ws_url, conn_options=None) -> None:
        # sample_rate makes the base class resample input frames to 16 kHz for us.
        super().__init__(stt=stt, conn_options=conn_options, sample_rate=STT_SAMPLE_RATE)
        self._ws_url = ws_url

    async def _run(self) -> None:
        http = await get_http()
        try:
            ws = await http.ws_connect(self._ws_url)
        except Exception as e:
            print(f"[voice] stt ws connect FAILED ({self._ws_url}): {e}", flush=True)
            raise
        print("[voice] stt ws connected", flush=True)

        async def send_audio() -> None:
            # self._input_ch yields rtc.AudioFrame (already resampled to 16 kHz)
            # interleaved with flush sentinels at utterance boundaries (VAD/turn
            # end). The stream is long-lived across turns: forward PCM bytes, and
            # on a sentinel ask the server to finalize + reset for the next turn.
            # Send a real eof only when the whole stream closes.
            async for frame in self._input_ch:
                if isinstance(frame, rtc.AudioFrame):
                    await ws.send_bytes(bytes(frame.data))
                else:
                    try:
                        await ws.send_str(json.dumps({"type": "flush"}))
                    except Exception:
                        pass
            try:
                await ws.send_str(json.dumps({"type": "eof"}))
            except Exception:
                pass

        async def recv_text() -> None:
            spoke_start = False
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    ev = json.loads(msg.data)
                except Exception:
                    continue
                kind = ev.get("type")
                text = (ev.get("text") or "").strip()
                if kind == "partial":
                    if not spoke_start:
                        spoke_start = True
                        print("[voice] hearing speech…", flush=True)
                        self._event_ch.send_nowait(
                            stt.SpeechEvent(type=stt.SpeechEventType.START_OF_SPEECH)
                        )
                    if text:
                        # Mirror the in-progress transcript to the call UI. Fire
                        # and forget — never await an attribute RPC inside the STT
                        # read loop, or a slow signal round-trip would stall
                        # reading the committed/final message that ends the turn.
                        asyncio.create_task(set_user_transcript(text, False))
                        self._event_ch.send_nowait(
                            stt.SpeechEvent(
                                type=stt.SpeechEventType.INTERIM_TRANSCRIPT,
                                alternatives=[stt.SpeechData(language="en", text=text)],
                            )
                        )
                elif kind == "final":
                    # Transcript gate: only emit a FINAL_TRANSCRIPT (which becomes
                    # a user turn → run_brain) when the committed text is a real
                    # utterance. Empty / punctuation-only / known-filler "turns"
                    # are ambient or crowd noise the ASR hallucinated — drop them.
                    if _is_meaningful(text):
                        print(f"[voice] user: {text}", flush=True)
                        asyncio.create_task(set_user_transcript(text, True))
                        self._event_ch.send_nowait(
                            stt.SpeechEvent(
                                type=stt.SpeechEventType.FINAL_TRANSCRIPT,
                                alternatives=[stt.SpeechData(language="en", text=text)],
                            )
                        )
                    elif text:
                        print(f"[voice] dropped noise turn: {text!r}", flush=True)
                    # Always close the speech segment, even on a dropped turn, so
                    # the VAD/turn state machine never wedges waiting for an end —
                    # the dropped turn simply produced no user message.
                    self._event_ch.send_nowait(
                        stt.SpeechEvent(type=stt.SpeechEventType.END_OF_SPEECH)
                    )
                    spoke_start = False
                    # The STT (server-VAD) just declared the turn over. Force the
                    # session to act on it now instead of waiting on the local VAD,
                    # which under load stays stuck "speaking" and drops the turn.
                    # Only on a real utterance — never resurrect a dropped-noise turn.
                    if _is_meaningful(text):
                        force_commit_turn()

        try:
            await asyncio.gather(send_audio(), recv_text())
        finally:
            try:
                await ws.close()
            except Exception:
                pass


def make_stt():
    """Streaming STT when STT_WS_URL is configured, else batch STT (default)."""
    if STT_WS_URL:
        print(f"[voice] STT: streaming via {STT_WS_URL}", flush=True)
        return LfgStreamingSTT(STT_WS_URL)
    print("[voice] STT: batch (/api/voice/stt)", flush=True)
    return LfgSTT()


# ── fleet tools (Anthropic tool-use, backed by the lfg HTTP API) ─────────────
# The voice brain (Haiku) gets these tools plus consult_advisor; the advisor it
# escalates to is a separate, more powerful backend session — see consult_advisor.
FLEET_TOOLS = [
    {
        "name": "get_fleet_status",
        "description": "Re-read the live status of the user's lfg sessions (blocked / working / idle, with the pending question for blocked ones).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_sessions",
        "description": "List the user's sessions with their ids and titles. Each row also includes `agentFamily` (`opencode`, `codex`, or `claude`) and the raw `agent` kind (so you can tell OpenCode apart from regular Claude/Codex), plus `model`, `project` (repo it's working in), `status` (`ok` or `blocked`, with `blockedReason` when blocked), and `idle` (how long since its last activity, e.g. '3m'). Call this to resolve a session id before acting on one, or to answer questions about which session is which / what each is doing.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_repos",
        "description": "List the repos/projects a new session can be started in (name + path). Call this to resolve the working folder before create_session when the user names a project.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "create_session",
        "description": "Start a NEW coding-agent session to work on a task OR to investigate/find out something the user asked about. Give it a clear one-line instruction in `prompt`. Optionally pass `cwd` (a repo path from list_repos); omit to default to the user's focused project. Optionally pass `agent` (`codex-aisdk` for Codex, `opencode` for OpenCode) and `thinkingLevel` (reasoning effort for any Claude or Codex session). Returns the new session id. Slow (a few seconds) — say a short spoken preamble first.",
        "input_schema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string"},
                "cwd": {"type": "string"},
                "agent": {
                    "type": "string",
                    "enum": ["aisdk", "codex-aisdk", "opencode"],
                },
                "thinkingLevel": {
                    "type": "string",
                    "enum": ["low", "medium", "high", "xhigh"],
                    "description": "Optional reasoning effort for a Claude or Codex session (ignored for OpenCode).",
                },
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "reply_to_session",
        "description": "Send an instruction to another session (queued; it steers that session's next turn).",
        "input_schema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "text": {"type": "string"},
            },
            "required": ["session_id", "text"],
        },
    },
    {
        "name": "answer_session_prompt",
        "description": "Answer a session that is BLOCKED on a permission/plan prompt by picking an option index (0-based) from its snapshot line.",
        "input_schema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "option_index": {"type": "integer"},
            },
            "required": ["session_id", "option_index"],
        },
    },
    {
        "name": "close_session",
        "description": "Close / shut down a session the user is done with. Resolve the exact session id first (via list_sessions or the snapshot) — this is destructive. NEVER close your own voice session.",
        "input_schema": {
            "type": "object",
            "properties": {"session_id": {"type": "string"}},
            "required": ["session_id"],
        },
    },
    {
        "name": "search_transcript",
        "description": "Search the full transcript of ONE session for a word or phrase and get back the matching snippets (with who said it — user/assistant/tool/thinking — and how long ago). Use this to answer 'what did session X say about Y?', 'did it ever mention the database migration?', 'find where it decided to use ElevenLabs', etc. — the snapshot only shows the latest line, this searches the whole history. Resolve the session id first (via list_sessions or the snapshot).",
        "input_schema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "query": {
                    "type": "string",
                    "description": "Word or phrase to look for (case-insensitive substring).",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max snippets to return (default 8, max 50).",
                },
            },
            "required": ["session_id", "query"],
        },
    },
]

# The escalation tool — hands a hard/risky question to the single deep-think
# advisor (a stronger Opus backend session with full repo + tool access).
ESCALATE_TOOL = {
    "name": "consult_advisor",
    "description": "Escalate a genuinely HARD or RISKY question to a deeper thinker with full repo + tool access, so it can both reason carefully AND act on the fleet. Use only when careful reasoning is truly needed, not for simple disambiguation (just ask the user). It runs in the BACKGROUND and answers asynchronously: this returns immediately, and the reply is spoken to the user automatically when ready. Tell the user one short conversational hold like 'hold on a minute' or 'give me a moment, looking into that' — NEVER say 'advisor', 'model', or that you're escalating. Do NOT wait for or invent its answer.",
    "input_schema": {
        "type": "object",
        "properties": {"question": {"type": "string"}},
        "required": ["question"],
    },
}

# The voice brain always has the fleet tools plus the one advisor escalation.
BRAIN_TOOLS = FLEET_TOOLS + [ESCALATE_TOOL]


async def set_activity(state: str) -> None:
    """Publish a custom orb state (consulting / replying / "") to the room."""
    if ROOM is None:
        return
    try:
        await ROOM.local_participant.set_attributes({"lfg.activity": state})
    except Exception:
        pass


# Short, spoken-style labels the orb shows while a tool is running, so the user
# sees WHAT the brain is doing (not just that it's busy). Streamed to the orb
# frontend via the `lfg.tool` participant attribute.
TOOL_LABELS = {
    "get_fleet_status": "Checking fleet status",
    "list_sessions": "Listing sessions",
    "list_repos": "Listing repos",
    "create_session": "Creating a session",
    "reply_to_session": "Messaging a session",
    "answer_session_prompt": "Answering a prompt",
    "close_session": "Closing a session",
    "consult_advisor": "Looking into it",
}

# Spoken-style preambles said the instant a tool call starts, so the user hears
# that work is happening before any (possibly slow) tool runs — never dead air
# through "thinking". Present-tense intent only ("about to" / "one moment"),
# never a completion claim (the result isn't in yet). Used only as a fallback
# when the model didn't already produce its own spoken text on the tool turn.
TOOL_PREAMBLES = {
    "get_fleet_status": "Let me check on the fleet, one moment.",
    "list_sessions": "Let me pull up the sessions, one moment.",
    "list_repos": "Let me look at the repos, one moment.",
    "create_session": "Give me a moment, looking into that.",
    "reply_to_session": "Okay, sending that over.",
    "answer_session_prompt": "Okay, answering that prompt, one moment.",
    "close_session": "One moment, closing that out.",
    "consult_advisor": "Hold on a minute.",
}
# Said when a tool call has no specific preamble above, so every tool call still
# gets spoken acknowledgement.
GENERIC_PREAMBLE = "One moment, let me take care of that."


async def set_tool(label: str) -> None:
    """Publish the current tool/thinking detail (a short label, or "" to clear)
    to the orb via the `lfg.tool` participant attribute."""
    if ROOM is None:
        return
    try:
        await ROOM.local_participant.set_attributes({"lfg.tool": label})
    except Exception:
        pass


async def set_user_transcript(text: str, final: bool) -> None:
    """Publish the speaking user's live transcript to the room so the call UI can
    show it — the user sees their words being recognized in real time (and knows
    the agent is hearing them). `final` marks a committed utterance vs an
    in-progress partial. Merged in with the other lfg.* attributes (set_attributes
    only touches the keys it's given)."""
    if ROOM is None:
        return
    try:
        await ROOM.local_participant.set_attributes(
            {"lfg.user_text": text or "", "lfg.user_final": "1" if final else "0"}
        )
    except Exception:
        pass


# When streaming STT finalizes a turn (ElevenLabs Scribe's OWN server-side VAD
# commits on silence — see ELEVENLABS_STT_COMMIT_STRATEGY in voice-providers.ts),
# that committed transcript IS the end-of-turn signal. But livekit only ends a
# turn off the LOCAL Silero VAD: on an STT FINAL it runs end-of-turn detection
# only when `not self._speaking` (audio_recognition.py). Under box load/crowd
# noise the local VAD stays stuck "speaking", so the final lands but the turn
# never commits — speech transcribed, agent silent (the exact bug). So when our
# STT delivers a real final, force the turn explicitly. Set
# LFG_FORCE_TURN_ON_STT_FINAL=0 to fall back to pure local-VAD endpointing.
_FORCE_TURN_ON_FINAL = bool(STT_WS_URL) and os.environ.get(
    "LFG_FORCE_TURN_ON_STT_FINAL", "1"
) != "0"


def force_commit_turn() -> None:
    """Force the AgentSession to end the user's turn and reply now, driven by the
    STT's server-side-VAD commit rather than the local VAD. No-op if disabled or
    the session isn't running (commit_user_turn raises then)."""
    if not _FORCE_TURN_ON_FINAL:
        return
    sess = SESSION
    if sess is None:
        return
    try:
        sess.commit_user_turn()
    except Exception:
        # RuntimeError("AgentSession isn't running") between turns / on teardown.
        pass


# ── speaker scoping + focus (who is talking, and what project they're on) ─────
def _refresh_current_user() -> None:
    """Read the speaking user from the human participant's `lfg.user` attribute
    (published by the web orb) and make CURRENT_USER authoritative for whoever is
    in the room *right now*.

    This worker is long-lived and the "voice" room is reused across taps, so we
    must CLEAR CURRENT_USER when no human is publishing an `lfg.user` — otherwise
    a new speaker who hasn't chosen a user inherits the previous speaker's
    identity, and any session they create gets assigned to the wrong user. On a
    fresh tap the orb publishes `lfg.user` a beat after connecting, so this may
    momentarily resolve to "" (unscoped → whole fleet, and a create lands
    unassigned rather than mis-assigned); `participant_attributes_changed`
    repopulates it the instant the attribute lands."""
    global CURRENT_USER
    if ROOM is None:
        return
    found = ""
    try:
        for p in ROOM.remote_participants.values():
            u = ((p.attributes or {}).get("lfg.user") or "").strip()
            if u and u != "__all":
                found = u
                break
    except Exception:
        return
    CURRENT_USER = found


def _read_focus() -> str:
    """The user's currently focused session id (what 'it' / 'my project' means)."""
    try:
        return FOCUS_FILE.read_text().strip()
    except Exception:
        return ""


def _user_qs() -> str:
    """Query suffix that scopes a fleet read to the speaking user (or "")."""
    return f"?user={CURRENT_USER}" if CURRENT_USER else ""


async def _lfg_get(path: str) -> dict:
    http = await get_http()
    async with http.get(f"{LFG}{path}") as r:
        return await r.json() if r.status == 200 else {"error": f"http {r.status}"}


async def _lfg_post(path: str, payload: dict) -> dict:
    http = await get_http()
    async with http.post(f"{LFG}{path}", json=payload) as r:
        try:
            j = await r.json()
        except Exception:
            j = {}
        return j if r.status == 200 else {"error": f"http {r.status}", **j}


def _agent_family(agent: str | None) -> str:
    """Collapse the internal harness kind into a model family the voice agent
    reasons about: 'opencode' vs 'codex' vs 'claude'. aisdk == Claude-via-SDK;
    codex-aisdk == Codex-via-SDK. A missing/unknown value defaults to 'claude'."""
    if agent in ("codex", "codex-aisdk"):
        return "codex"
    if agent == "opencode":
        return "opencode"
    return "claude"


def _ago(ms: int | float | None) -> str | None:
    """Compact 'how long ago' for an epoch-ms timestamp ('12s', '5m', '3h',
    '2d'), or None when there's no timestamp. Used to give the brain a sense of
    how stale / active each session is without dumping raw timestamps."""
    if not ms:
        return None
    secs = max(0, int(time.time() - ms / 1000))
    if secs < 60:
        return f"{secs}s"
    mins = secs // 60
    if mins < 60:
        return f"{mins}m"
    hrs = mins // 60
    if hrs < 24:
        return f"{hrs}h"
    return f"{hrs // 24}d"


async def _scoped_sessions() -> list[dict]:
    """Live sessions visible to the speaking user: their own (by assignedUser)
    plus whatever they're focused on. With no CURRENT_USER, the whole fleet."""
    j = await _lfg_get("/api/sessions")
    focus = _read_focus()
    out = []
    for s in j.get("sessions", []):
        if not s.get("sessionId"):
            continue
        if (
            CURRENT_USER
            and s.get("assignedUser") != CURRENT_USER
            and s.get("sessionId") != focus
        ):
            continue
        out.append(s)
    return out


async def run_tool(name: str, args: dict) -> str:
    """Execute one fleet tool; returns a compact string for the tool_result.
    Reads and actions are scoped to the speaking user (CURRENT_USER)."""
    try:
        if name == "get_fleet_status":
            return (
                await _lfg_get(f"/api/voice/snapshot{_user_qs()}")
            ).get("snapshot", "(none)")
        if name == "list_sessions":
            focus = _read_focus()
            rows = []
            for s in await _scoped_sessions():
                row = {
                    "id": s.get("sessionId"),
                    "title": (s.get("title") or "")[:60],
                    "user": s.get("assignedUser"),
                    # Raw harness kind (claude/codex/aisdk/codex-aisdk/opencode)
                    # plus a collapsed family so the voice agent can tell
                    # OpenCode apart from regular Claude/Codex sessions.
                    "agent": s.get("agent"),
                    "agentFamily": _agent_family(s.get("agent")),
                    "model": s.get("model"),
                    "project": s.get("project"),
                    "status": s.get("status"),
                    "idle": _ago(s.get("lastActivityAt")),
                    "last": (s.get("lastUserText") or "")[:60],
                    "focused": s.get("sessionId") == focus,
                }
                # Only surface a reason when actually blocked, to keep rows lean.
                if s.get("status") == "blocked":
                    row["blockedReason"] = s.get("statusDetail") or s.get("statusReason")
                rows.append(row)
            return json.dumps(rows)
        if name == "list_repos":
            j = await _lfg_get("/api/repos")
            rows = [
                {"name": r.get("name"), "cwd": r.get("cwd")}
                for r in j.get("repos", [])
                if r.get("cwd")
            ]
            return json.dumps(rows)
        if name == "create_session":
            prompt = (args.get("prompt") or "").strip()
            if not prompt:
                return "need a task/prompt to start a session"
            payload: dict = {"prompt": prompt}
            cwd = (args.get("cwd") or "").strip()
            # Default the working folder to the user's focused project, so a
            # voice "go check on X" spins up in the right repo without them
            # naming it. Explicit cwd from the model wins.
            if not cwd:
                focus = _read_focus()
                if focus:
                    for s in await _scoped_sessions():
                        if s.get("sessionId") == focus and s.get("cwd"):
                            cwd = s["cwd"]
                            break
            if cwd:
                payload["cwd"] = cwd
            agent = (args.get("agent") or "").strip()
            if agent in ("aisdk", "codex-aisdk", "opencode"):
                payload["agent"] = agent
            # Thinking level applies to any reasoning-capable agent (Claude +
            # Codex, CLI or ai-sdk). The server default agent is Claude (aisdk),
            # which honors it, so don't force Codex just because a level was set —
            # only skip it for opencode, whose provider has no reasoning knob (the
            # server would 400 the request otherwise).
            thinking_level = (args.get("thinkingLevel") or "").strip()
            if (
                thinking_level in ("low", "medium", "high", "xhigh")
                and payload.get("agent", "aisdk") != "opencode"
            ):
                payload["thinkingLevel"] = thinking_level
            if CURRENT_USER:
                payload["user"] = CURRENT_USER
            await set_activity("replying")
            try:
                j = await _lfg_post("/api/sessions/new", payload)
            finally:
                await set_activity("")
            if j.get("ok"):
                sid = j.get("sessionId") or j.get("tmuxName") or ""
                return f"created session {sid}"
            return j.get("error") or "create failed"
        if name == "search_transcript":
            # Read-only, but still scope to the speaking user's visible sessions
            # so voice can't read another person's transcript.
            sid = (args.get("session_id") or "").strip()
            visible = {s.get("sessionId") for s in await _scoped_sessions()}
            if not sid or sid not in visible:
                return (
                    "couldn't find that session for you — call list_sessions to "
                    "resolve the exact id first, then try again"
                )
            query = (args.get("query") or "").strip()
            if not query:
                return "need a word or phrase to search for"
            payload = {"query": query}
            try:
                limit = int(args.get("limit") or 8)
                if limit > 0:
                    payload["limit"] = limit
            except (TypeError, ValueError):
                pass
            j = await _lfg_post(f"/api/sessions/{sid}/transcript/search", payload)
            if j.get("error"):
                return j.get("error") or "search failed"
            results = j.get("results") or []
            if not results:
                return f"no matches for \"{query}\" in that session's transcript"
            hits = [
                {
                    "who": r.get("role"),
                    "kind": r.get("kind"),
                    "ago": _ago(r.get("ts")),
                    "text": r.get("snippet"),
                }
                for r in results
            ]
            return json.dumps(
                {
                    "query": query,
                    "total": j.get("total", len(hits)),
                    "showing": len(hits),
                    "truncated": j.get("truncated", False),
                    "matches": hits,
                }
            )
        if name in ("reply_to_session", "answer_session_prompt", "close_session"):
            # Resolve-before-act: never act on a guessed/blank id, and never reach
            # outside the speaking user's scope. Force the model to list first.
            sid = (args.get("session_id") or "").strip()
            visible = {s.get("sessionId") for s in await _scoped_sessions()}
            if not sid or sid not in visible:
                return (
                    "couldn't find that session for you — call list_sessions to "
                    "resolve the exact id first, then try again"
                )
            if name == "reply_to_session":
                await set_activity("replying")
                try:
                    j = await _lfg_post(
                        f"/api/sessions/{sid}/send",
                        {"text": args.get("text", "")},
                    )
                finally:
                    await set_activity("")
                return "sent" if j.get("ok") else (j.get("error") or "send failed")
            if name == "answer_session_prompt":
                j = await _lfg_post(
                    f"/api/sessions/{sid}/answer",
                    {"index": int(args.get("option_index", 0))},
                )
                return "answered" if j.get("ok") else (j.get("error") or "answer failed")
            if name == "close_session":
                j = await _lfg_post(f"/api/sessions/{sid}/close", {})
                return "closed" if (j.get("ok") or not j.get("error")) else j["error"]
    except Exception as e:
        return f"tool error: {e}"
    return f"unknown tool {name}"


def _as_system(system):
    """Wrap a plain system string into a single cache-controlled block so the
    large, stable instruction prefix is prompt-cached across turns (and across
    connects, since SYSTEM_PROMPT is frozen). A pre-built block list passes
    through untouched. Cache reads cost ~0.1x — a big win on a chatty voice
    loop that re-sends the same multi-KB system prompt every single turn."""
    if isinstance(system, str):
        return [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
    return system


async def anthropic_call(
    messages: list[dict],
    system: str,
    *,
    model: str = HAIKU_MODEL,
    tools: list[dict] | None = None,
    max_tokens: int,
) -> dict | None:
    """One non-streaming Messages API call (OAuth). Returns parsed JSON or None."""
    token = _oauth_token()
    if not token:
        return None
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": _as_system(system),
        "messages": messages,
    }
    if tools:
        body["tools"] = tools
    headers = {
        "Authorization": f"Bearer {token}",
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    http = await get_http()
    try:
        async with http.post(ANTHROPIC_URL, json=body, headers=headers) as resp:
            if resp.status != 200:
                return None
            return await resp.json()
    except Exception:
        return None


async def anthropic_stream(
    messages: list[dict],
    system: str,
    *,
    model: str = HAIKU_MODEL,
    tools: list[dict] | None = None,
    max_tokens: int,
    on_text=None,
) -> tuple[list[dict] | None, str | None]:
    """One STREAMING Messages API call (OAuth, SSE).

    Returns (content_blocks, stop_reason) assembled from the stream — the same
    shape run_brain's tool loop expects from a non-streaming response. As each
    assistant text delta arrives it is handed to on_text(delta) so the caller can
    start speaking sentence 1 while the model is still generating sentence 2 (the
    TTS StreamAdapter downstream segments the delta stream into sentences). Tool
    inputs stream as partial JSON and are assembled + parsed at block stop.

    Returns (None, None) on auth failure / HTTP error / stream error so the caller
    can recover exactly as it did for a None non-streaming response.
    """
    token = _oauth_token()
    if not token:
        return None, None
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": _as_system(system),
        "messages": messages,
        "stream": True,
    }
    if tools:
        body["tools"] = tools
    headers = {
        "Authorization": f"Bearer {token}",
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    http = await get_http()
    blocks: dict[int, dict] = {}      # index -> content block being assembled
    json_bufs: dict[int, str] = {}    # index -> partial tool_use input JSON
    stop_reason: str | None = None
    try:
        async with http.post(ANTHROPIC_URL, json=body, headers=headers) as resp:
            if resp.status != 200:
                return None, None
            # Anthropic SSE: lines are `event: <t>` / `data: <json>` / blank.
            # Every data payload carries its own `type`, so we parse data lines
            # and ignore the event: lines entirely.
            async for raw in resp.content:
                line = raw.decode("utf-8", "ignore").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload:
                    continue
                try:
                    ev = json.loads(payload)
                except Exception:
                    continue
                etype = ev.get("type")
                if etype == "content_block_start":
                    idx = ev.get("index", 0)
                    cb = ev.get("content_block") or {}
                    if cb.get("type") == "text":
                        blocks[idx] = {"type": "text", "text": ""}
                    elif cb.get("type") == "tool_use":
                        blocks[idx] = {
                            "type": "tool_use",
                            "id": cb.get("id"),
                            "name": cb.get("name"),
                            "input": {},
                        }
                        json_bufs[idx] = ""
                elif etype == "content_block_delta":
                    idx = ev.get("index", 0)
                    d = ev.get("delta") or {}
                    dt = d.get("type")
                    if dt == "text_delta":
                        chunk = d.get("text", "")
                        if idx in blocks:
                            blocks[idx]["text"] += chunk
                        if chunk and on_text:
                            on_text(chunk)
                    elif dt == "input_json_delta":
                        json_bufs[idx] = json_bufs.get(idx, "") + d.get("partial_json", "")
                elif etype == "content_block_stop":
                    idx = ev.get("index", 0)
                    if idx in json_bufs:
                        raw_json = json_bufs.get(idx) or ""
                        try:
                            blocks[idx]["input"] = json.loads(raw_json) if raw_json else {}
                        except Exception:
                            blocks[idx]["input"] = {}
                elif etype == "message_delta":
                    sr = (ev.get("delta") or {}).get("stop_reason")
                    if sr:
                        stop_reason = sr
                elif etype == "error":
                    print(f"[voice] anthropic stream error: {ev.get('error')}", flush=True)
                    return None, None
    except Exception as e:
        print(f"[voice] anthropic stream failed: {e}", flush=True)
        return None, None
    ordered = [blocks[i] for i in sorted(blocks)]
    return ordered, stop_reason


# ── the advisor: ONE Opus hop, run in the BACKGROUND ─────────────────────────
# The voice brain (Haiku) handles everything live. When a question is genuinely
# hard or risky, it consults Opus ONCE — same fleet tools, so the advisor can
# both reason and act. The advisor does NOT get consult_advisor itself, so there
# is no recursive escalation and exactly one, fast, legible advisor.
#
# The Opus pass is SLOW (a full reasoning pass, sometimes tens of seconds). It
# used to run INLINE in the live turn, stalling the conversation into dead air.
# Now it runs as a BACKGROUND task: the brain's tool call returns immediately with
# a holding result (so the turn ends fast with a one-line "I'm on it"), and when
# Opus finishes its answer is spoken out-of-band via session.say(). Single-flight:
# a second consult requested while one is in flight is told it's still working.
async def _advisor_pass(question: str) -> str:
    """One Opus pass over a hard/risky question; returns its spoken answer.
    Opus shares the fleet tools (it can act) but cannot escalate further."""
    q = (question or "").strip() or "Please advise."
    for model in ADVISOR_MODELS:
        # Fresh msgs each attempt — run_brain mutates it with the tool loop.
        answer = await run_brain(
            [{"role": "user", "content": q}],
            model=model,
            system=SYSTEM_PROMPT + ADVISOR_NOTE,
            tools=FLEET_TOOLS,  # no consult_advisor → no recursion
            live_context=LIVE_CONTEXT,
        )
        if answer:
            print(f"[voice] advisor ({model}) answered", flush=True)
            return answer
    return "The advisor came up empty on that one — try rephrasing the question."


async def _run_advisor(question: str) -> None:
    """Background runner: do the Opus pass, then speak the answer into the room.
    Always clears the orb 'consulting' state and the in-flight task on the way out,
    so a future consult can start even if this one errors."""
    global _ADVISOR_TASK
    q = (question or "").strip() or "Please advise."
    print(f"[voice] consult advisor (bg): {q[:80]}", flush=True)
    await set_activity("consulting")
    try:
        answer = await _advisor_pass(q)
        # Splice the answer back in out-of-band. The live turn that requested the
        # consult already ended with a short "I'll check"; this is the advisor
        # reporting back a moment later. (If the user happens to be mid-turn,
        # session.say serializes it after the current speech.)
        if SESSION is not None and answer:
            try:
                await SESSION.say(f"About your question — {answer}")
            except Exception as e:
                print(f"[voice] advisor say failed: {e}", flush=True)
        else:
            print(f"[voice] advisor answer (no session to speak): {answer}", flush=True)
    except Exception as e:
        print(f"[voice] advisor bg failed: {e}", flush=True)
    finally:
        await set_activity("")
        _ADVISOR_TASK = None


async def dispatch_advisor(question: str) -> str:
    """Tool entrypoint: kick off the advisor in the BACKGROUND and return a holding
    result immediately so the live turn never stalls. Single-flight — a consult
    requested while one is already running is told to wait."""
    global _ADVISOR_TASK
    if _ADVISOR_TASK is not None and not _ADVISOR_TASK.done():
        return (
            "Still working on the previous question. Tell the user in one short "
            "conversational sentence that you're still looking into it — never say "
            "advisor — and you'll have the answer shortly; do NOT start another consult."
        )
    _ADVISOR_TASK = asyncio.create_task(_run_advisor(question))
    return (
        "Deeper look started in the background. In ONE short conversational sentence "
        "tell the user 'hold on a minute' or 'give me a moment, looking into that' — "
        "NEVER say advisor, model, or that you're escalating — then stop. Do NOT wait "
        "for or invent the answer; it will be spoken automatically when ready."
    )


async def run_brain(
    msgs, *, model: str, system: str, emit=None, tools=None, live_context=None
) -> str:
    """Tool-use loop at `model`. Speaks each text chunk via emit() when given
    (the live voice turn); always returns the final assistant text. `tools`
    defaults to the full brain set (fleet + consult_advisor); the advisor passes
    FLEET_TOOLS so it can act but not escalate again.

    `live_context` (volatile fleet status) is injected as a leading turn rather
    than baked into `system`, so the cached system+tools prefix survives a
    context refresh untouched."""
    # Transcript gate (defense in depth): never run the brain on a noise turn.
    # Streaming STT already suppresses non-lexical finals upstream, but the batch
    # STT path emits them verbatim and a hallucinated filler ("you", "thanks for
    # watching") would otherwise trigger a spoken reply to no one. If the latest
    # real user message has no lexical content, drop the turn silently.
    last_user = next(
        (
            m
            for m in reversed(msgs)
            if m.get("role") == "user" and isinstance(m.get("content"), str)
        ),
        None,
    )
    if last_user is not None and not _is_meaningful(last_user["content"]):
        print(f"[voice] brain: dropping noise turn {last_user['content']!r}", flush=True)
        return ""
    if tools is None:
        tools = BRAIN_TOOLS
    if live_context:
        msgs = [
            {
                "role": "user",
                "content": f"<live_context>\n{live_context}\n</live_context>",
            },
            {"role": "assistant", "content": "Understood — using that current fleet context."},
            *msgs,
        ]
    for _ in range(6):
        # Stream the turn: text deltas are spoken as they arrive (sentence 1
        # starts playing while sentence 2 is still being generated), and the
        # blocks + stop_reason come back assembled so the tool loop is unchanged.
        turn_t0 = time.time()
        spoke = {"any": False, "buf": "", "first": False}

        def on_text(chunk: str) -> None:
            spoke["any"] = True
            if emit:
                emit(chunk)
            # Debug visibility into streaming (live turns only): time-to-first-
            # token and each sentence as it streams out — this is exactly the
            # sentence boundary the TTS StreamAdapter synthesizes on, so these
            # lines evidence the LLM->TTS streaming overlap end to end.
            if not emit:
                return
            if not spoke["first"]:
                spoke["first"] = True
                print(f"[voice] stream: first token +{time.time() - turn_t0:.2f}s", flush=True)
            spoke["buf"] += chunk
            while True:
                m = re.search(r"[.!?](\s|$)", spoke["buf"])
                if not m:
                    break
                cut = m.end()
                sent = spoke["buf"][:cut].strip()
                spoke["buf"] = spoke["buf"][cut:]
                if sent:
                    print(f"[voice] stream sentence +{time.time() - turn_t0:.2f}s: {sent}", flush=True)

        blocks, stop_reason = await anthropic_stream(
            msgs, system, model=model, tools=tools, max_tokens=600, on_text=on_text
        )
        if blocks is None:
            return ""
        if stop_reason == "tool_use":
            msgs.append({"role": "assistant", "content": blocks})
            tool_names = [
                b.get("name", "") for b in blocks if b.get("type") == "tool_use"
            ]
            # Any preamble the model produced alongside the tool call (e.g. "let
            # me check with the advisor") has ALREADY been streamed+spoken via
            # on_text above. If it produced none, speak a canned one so a
            # (possibly slow) tool never runs in silence — present-tense intent
            # ("about to"), never "done" (the model never claims completion
            # before it sees the result).
            if not spoke["any"] and emit:
                first_tool = next((n for n in tool_names if n), "")
                preamble = TOOL_PREAMBLES.get(first_tool, GENERIC_PREAMBLE)
                print(f"[voice] say (preamble): {preamble}", flush=True)
                emit(preamble)
            print(f"[voice] tool_use ({model}): {tool_names}", flush=True)
            results = []
            for b in blocks:
                if b.get("type") != "tool_use":
                    continue
                name = b.get("name", "")
                args = b.get("input") or {}
                # Stream what we're doing to the orb so it can narrate the
                # tool call (and, for a consult, the "thinking" hand-off).
                await set_tool(TOOL_LABELS.get(name, name))
                try:
                    if name == "consult_advisor":
                        out = await dispatch_advisor(args.get("question", ""))
                    else:
                        out = await run_tool(name, args)
                finally:
                    await set_tool("")
                results.append(
                    {"type": "tool_result", "tool_use_id": b.get("id"), "content": out}
                )
            msgs.append({"role": "user", "content": results})
            continue
        # Final answer — the text was already streamed+spoken to emit() during
        # the call (do NOT emit again or the reply is spoken twice). Just return
        # the assembled text for logging and as the advisor's return value.
        text = "".join(
            b.get("text", "") for b in blocks if b.get("type") == "text"
        ).strip()
        if text:
            print(f"[voice] reply ({model}): {text}", flush=True)
        return text
    return ""


class LfgLLMStream(llm.LLMStream):
    async def _run(self) -> None:
        # full conversation history (LiveKit accumulates it across turns)
        msgs: list[dict] = []
        for it in self._chat_ctx.items:
            role = getattr(it, "role", None)
            if role not in ("user", "assistant"):
                continue
            text = (it.text_content or "").strip()
            if text:
                msgs.append({"role": role, "content": text})
        if not msgs or msgs[-1]["role"] != "user":
            return

        def emit(text: str) -> None:
            self._event_ch.send_nowait(
                llm.ChatChunk(
                    id=utils.shortuuid(),
                    delta=llm.ChoiceDelta(role="assistant", content=text),
                )
            )

        # Make sure we know who is speaking before scoping any fleet read.
        _refresh_current_user()

        # The voice brain is Haiku; it consults the advisor when truly unsure.
        #
        # This MUST finish (and the stream close) no matter what: LiveKit holds
        # lk.agent.state at "thinking" for the entire life of this stream, so a
        # hang or an unhandled exception here leaves the orb stuck "Thinking…"
        # forever. Bound the whole turn, speak a graceful fallback on failure,
        # and always clear the orb's activity/tool detail on the way out.
        try:
            await asyncio.wait_for(
                run_brain(
                    msgs,
                    model=HAIKU_MODEL,
                    system=SYSTEM_PROMPT,
                    emit=emit,
                    live_context=LIVE_CONTEXT,
                ),
                timeout=90,
            )
        except asyncio.TimeoutError:
            print("[voice] run_brain timed out — recovering", flush=True)
            emit("Sorry, that took too long. Could you try again?")
        except Exception as e:
            print(f"[voice] run_brain failed: {e} — recovering", flush=True)
            emit("Sorry, I hit a snag there. Could you say that again?")
        finally:
            # Drop any lingering deep-work / tool detail so the orb doesn't keep
            # showing a stale "Consulting…" / tool label after the turn ends.
            await set_activity("")
            await set_tool("")


class LfgLLM(llm.LLM):
    def chat(self, *, chat_ctx, tools=None, conn_options=None, **kwargs):
        return LfgLLMStream(
            self, chat_ctx=chat_ctx, tools=tools or [], conn_options=conn_options
        )


# ── TTS: lfg /api/voice/tts (SuperTonic, 44.1kHz mono WAV) ───────────────────
class LfgTTSStream(tts.ChunkedStream):
    async def _run(self, output_emitter) -> None:
        http = await get_http()
        output_emitter.initialize(
            request_id=utils.shortuuid(),
            sample_rate=24000,  # CosyVoice2 fixed output rate
            num_channels=1,
            mime_type="audio/pcm",
        )
        # Stream raw int16 PCM as the GPU produces each chunk -> the room starts
        # playing at ~first-chunk latency instead of after the full utterance.
        # Debug: one synth per sentence (the StreamAdapter calls this per sentence),
        # with time-to-first-audio — so the logs show the LLM->TTS streaming overlap.
        text = (self._input_text or "").strip()
        t0 = time.time()
        print(f"[voice] tts synth: {text[:70]!r}", flush=True)
        first = True
        total = 0
        carry = b""
        async with http.post(
            f"{LFG}/api/voice/tts", json={"text": self._input_text}
        ) as r:
            async for chunk in r.content.iter_chunked(9600):
                if first and chunk:
                    first = False
                    print(f"[voice] tts first audio +{time.time() - t0:.2f}s", flush=True)
                buf = carry + chunk
                n = len(buf) - (len(buf) % 2)  # keep 16-bit sample alignment
                if n:
                    output_emitter.push(buf[:n])
                    total += n
                carry = buf[n:]
        output_emitter.flush()
        print(
            f"[voice] tts done +{time.time() - t0:.2f}s "
            f"({total} B, ~{total / 2 / 24000:.1f}s audio)",
            flush=True,
        )


class LfgTTS(tts.TTS):
    def __init__(self) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=24000,
            num_channels=1,
        )

    def synthesize(self, text, *, conn_options=None):
        return LfgTTSStream(tts=self, input_text=text, conn_options=conn_options)


def build_tts():
    """Sentence-pipelined TTS.

    LfgTTS itself isn't streaming-input (the GPU engine takes a full text and
    streams the audio back), so wrap it in a StreamAdapter with a sentence
    tokenizer: as the LLM streams its reply, the adapter cuts it into sentences
    and synthesizes each one as soon as it's complete — sentence 1's audio plays
    while sentence 2 is still being generated. Falls back to the bare (whole-
    utterance) TTS if the adapter/tokenizer API differs in this livekit-agents
    build, so the worker always starts."""
    base = LfgTTS()
    try:
        return tts.StreamAdapter(
            tts=base,
            sentence_tokenizer=tokenize.basic.SentenceTokenizer(),
        )
    except Exception as e:  # pragma: no cover
        print(f"[voice] TTS StreamAdapter unavailable ({e}); whole-utterance TTS", flush=True)
        return base


# ── proactive briefing ──────────────────────────────────────────────────────
async def make_briefing(snapshot: str) -> str:
    """Turn the raw snapshot into a <=2 sentence spoken greeting + status."""
    msgs = [
        {
            "role": "user",
            "content": (
                "Greet me in one short, warm sentence and ask how you can help. "
                "Do NOT recite a fleet status or how many sessions are "
                "working/idle — keep the count to yourself. The ONLY exception: "
                "if something is BLOCKED and needs my decision right now, lead "
                "with that one thing in a few words, then ask how you can help. "
                "Plain spoken words only.\n\nSNAPSHOT:\n"
                + (snapshot or "(no sessions)")
            ),
        }
    ]
    resp = await anthropic_call(msgs, VOICE_PROMPT, tools=None, max_tokens=160)
    if resp:
        text = "".join(
            b.get("text", "")
            for b in (resp.get("content") or [])
            if b.get("type") == "text"
        ).strip()
        if text:
            return text
    return "Hey, I'm here — how can I help?"


# ── per-start seeding ───────────────────────────────────────────────────────
async def seed_system_prompt() -> str:
    """Refresh LIVE_CONTEXT from a live, user-scoped fleet snapshot, the user's
    standing context, and their focused session. Returns the raw snapshot (for
    the briefing).

    Note: this deliberately does NOT touch SYSTEM_PROMPT — that stays frozen at
    VOICE_PROMPT so it prompt-caches. The volatile context built here is injected
    into the message stream by run_brain instead, so a refresh (at connect, or on
    a fleet-completion push) costs a small messages-tier cache miss rather than
    re-processing the entire system prompt uncached every time."""
    global LIVE_CONTEXT
    snapshot = ""
    try:
        snap = await _lfg_get(f"/api/voice/snapshot{_user_qs()}")
        snapshot = snap.get("snapshot", "")
        parts: list[str] = []
        focus = _read_focus()
        if focus:
            parts.append(
                "=== FOCUS ===\n"
                f"The user's currently focused session id is {focus}. When they "
                "say 'it', 'this', 'my project', or 'the session' without naming "
                "one, they mean this. New sessions default to its project.\n"
                "=== END FOCUS ==="
            )
        if snapshot:
            parts.append(
                "=== SESSION SNAPSHOT (refreshed live — updated at connect and "
                "whenever a session finishes; still call get_fleet_status before "
                "acting on a specific session to confirm its exact current "
                "state) ===\n"
                + snapshot
                + "\n=== END SNAPSHOT ==="
            )
        if snap.get("context"):
            parts.append("=== USER CONTEXT ===\n" + snap["context"])
        LIVE_CONTEXT = "\n\n".join(parts)
    except Exception:
        # Leave any prior LIVE_CONTEXT in place on a transient failure rather
        # than blanking the assistant's situational awareness.
        pass
    return snapshot


# ── fleet completion PUSH: auto-fresh context + proactive heads-up ───────────
async def _handle_completion(ev: dict) -> None:
    """A session just finished a turn (pushed from lfg). Refresh LIVE_CONTEXT so
    the next user turn is already current, and — debounced — speak a short
    heads-up so the user hears about it hands-free without having to ask."""
    global _LAST_PUSH_ANNOUNCE
    # Always refresh: cheap, and it keeps the assistant's awareness live even if
    # we choose not to announce this particular completion.
    await seed_system_prompt()
    title = (ev.get("title") or "a session").replace("\n", " ").strip()
    if len(title) > 60:
        title = title[:59].rstrip() + "…"
    now = time.time()
    if SESSION is None or now - _LAST_PUSH_ANNOUNCE < PUSH_ANNOUNCE_GAP:
        return
    _LAST_PUSH_ANNOUNCE = now
    try:
        # session.say serializes after any in-flight speech, so this never cuts
        # the user off mid-turn — it lands in the next gap.
        # Conversational, not a status template. Title is the human-readable
        # task prompt the user already knows; keep it short.
        await SESSION.say(f"Quick update — {title} just wrapped up.")
    except Exception as e:
        print(f"[voice] push announce failed: {e}", flush=True)


async def watch_fleet_events() -> None:
    """Hold an SSE connection to lfg's /api/voice/events and react to every
    session-completion push. Scoped to the current speaker; reconnects (with
    backoff) on drop, and re-scopes when the speaking user changes."""
    backoff = 1.0
    while True:
        scoped = CURRENT_USER  # snapshot the scope this connection is bound to
        try:
            http = await get_http()
            url = f"{LFG}/api/voice/events{_user_qs()}"
            async with http.get(url) as resp:
                if resp.status != 200:
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 30)
                    continue
                backoff = 1.0
                event: str | None = None
                async for raw in resp.content:
                    # If the speaker changed, drop this stream so the outer loop
                    # reconnects scoped to the new user.
                    if CURRENT_USER != scoped:
                        break
                    line = raw.decode("utf-8", "ignore").strip()
                    if line.startswith("event:"):
                        event = line[6:].strip()
                    elif line.startswith("data:") and event == "completed":
                        try:
                            ev = json.loads(line[5:].strip())
                        except Exception:
                            continue
                        await _handle_completion(ev)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[voice] fleet watch error: {e}", flush=True)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


def start_fleet_watch() -> None:
    """Launch the fleet-completion watcher once per worker process."""
    global _FLEET_WATCH_STARTED
    if _FLEET_WATCH_STARTED:
        return
    _FLEET_WATCH_STARTED = True
    asyncio.create_task(watch_fleet_events())


async def start_session(session: AgentSession, *, clear: bool) -> None:
    """Begin a voice interaction: optionally wipe any prior conversation, refresh
    the system prompt, and speak a proactive briefing.

    The room ("voice") is persistent and the agent stays in it, so a reconnect
    reuses the SAME AgentSession — its chat_ctx still holds the previous chat.
    Clearing it here means each fresh start (a tap of the orb) begins clean, with
    no leftover context carried over from the last conversation."""
    if clear:
        try:
            await session.current_agent.update_chat_ctx(llm.ChatContext.empty())
            print("[voice] cleared previous context (new start)", flush=True)
        except Exception:
            pass
    # Resolve who is speaking before scoping the seeded snapshot to them.
    _refresh_current_user()
    snapshot = await seed_system_prompt()
    # Speak a proactive briefing the moment we connect (no user turn needed).
    try:
        await session.say(await make_briefing(snapshot))
    except Exception:
        pass


def _load_turn_detection():
    """Turn-detection mode for AgentSession (self-hosted-correct).

    AgentSession's NEW default turn detector is livekit.agents.inference.
    TurnDetector, which runs end-of-turn inference through LiveKit's HOSTED
    agent-gateway (https://agent-gateway.livekit.cloud by default) authenticated
    with LIVEKIT_API_*. That fits LiveKit Cloud / a self-hosted inference gateway
    — but THIS box runs a local livekit-server with no such gateway, so the hosted
    detector would ship every turn to a remote service we have no account on.

    So, in order:
      1. if an inference gateway is configured (LIVEKIT_INFERENCE_URL), use the
         new hosted inference.TurnDetector;
      2. else use the LOCAL onnx EnglishModel — the plugin is deprecated, but it
         runs on-box and is the right call for self-hosting (weights fetched via
         `python agent.py download-files`);
      3. else fall back to the "vad" string mode (plain VAD endpointing).
    Always returns an explicit value, so AgentSession's hosted-cloud default
    never engages on this self-hosted box.
    """
    if os.environ.get("LIVEKIT_INFERENCE_URL"):
        try:
            from livekit.agents import inference

            print("[voice] turn-detection: hosted inference gateway", flush=True)
            return inference.TurnDetector()
        except Exception as e:
            print(f"[voice] hosted TurnDetector unavailable ({e})", flush=True)
    # The local onnx EOU model needs a LiveKit *inference executor* in the worker.
    # On this self-hosted box predict_end_of_turn fails every turn with
    # "no inference executor", which makes endpointing erratic (turns get cut off
    # mid-sentence -> the agent jumps to "thinking" on a fragment). So the local
    # EOU model is OPT-IN (LFG_LOCAL_EOU=1) until that executor is sorted; the
    # reliable default is plain VAD silence-based endpointing.
    if os.environ.get("LFG_LOCAL_EOU") == "1":
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                from livekit.plugins.turn_detector.english import EnglishModel
            print("[voice] turn-detection: local EnglishModel (on-box, opt-in)", flush=True)
            return EnglishModel()
        except Exception as e:
            print(f"[voice] local EOU unavailable ({e})", flush=True)
    print("[voice] turn-detection: VAD endpointing", flush=True)
    return "vad"


def _build_noise_cancellation():
    """On-box input denoiser: DTLN (livekit-plugins-dtln), wired as a
    RoomInputOptions FrameProcessor so it sits BEFORE VAD/STT — the VAD and the
    ElevenLabs streaming STT both see cleaned audio.

    Krisp BVC (LiveKit's built-in noise_cancellation.BVC) is LiveKit-Cloud-only —
    it round-trips audio through LiveKit's hosted inference, which this
    self-hosted box has no account on — so we use DTLN, a small on-box ONNX
    speech-enhancement model that runs locally. DTLNNoiseSuppressor is an
    rtc.FrameProcessor[rtc.AudioFrame]; it lazily resamples whatever input rate
    the room delivers (24 kHz here) down to its 16 kHz model and back, so it slots
    in regardless of RoomInputOptions.audio_sample_rate. Returns None on any
    failure (plugin missing / model load error) so the worker still starts — just
    without denoising — rather than crashing the voice pipeline."""
    try:
        from livekit.plugins import dtln
        nc = dtln.noise_suppression()
        print("[voice] noise cancellation: DTLN (on-box, pre-VAD/STT)", flush=True)
        return nc
    except Exception as e:
        print(f"[voice] DTLN unavailable ({e}); no input denoising", flush=True)
        return None


def _build_vad():
    """Silero VAD, tuned for the CROWD-BABBLE case on DTLN-cleaned input.

    The user's main symptom is ambient + crowd babble (diffuse, many overlapping
    voices — NOT one distinct background speaker) FALSELY triggering a turn. The
    first line of defence is to keep that babble from crossing the VAD at all, so
    it never even reaches STT.

    DTLN (see _build_noise_cancellation) plus the browser noise-canceller strip
    most steady noise before the VAD, which both cleans real speech AND pushes
    diffuse babble down to a low, smeared speech-probability. That headroom lets
    us hold the activation bar HIGH without hurting genuine close-mic speech
    (which stays high-probability after denoising):
      - activation_threshold = 0.6      : a frame needs a clearly speech-like
        probability to START a turn. Diffuse crowd babble — even when the denoiser
        leaves a little — sits below this, so it doesn't open a turn; a real user
        talking into the mic crosses it easily.
      - deactivation_threshold = 0.35   : keep the wide hysteresis band (0.6 to
        start, 0.35 to stop) so once a real turn is open, brief dips don't chatter
        it on/off — and babble riding near the bar can't toggle speech.
      - min_speech_duration = 0.08      : a short floor so a transient babble peak
        or click can't open a turn, while still catching quick real onsets.
    Whatever still slips through the VAD is caught downstream by the transcript
    gate (_is_meaningful), which drops ASR hallucinations like "thanks for
    watching" before they reach the brain. VAD here = don't even listen to babble;
    gate = don't act on babble that got transcribed anyway.
    NB: we use the (deprecated-in-2.0 but proven-LOCAL) silero loader on purpose —
    it loads the on-box ONNX model directly. The inference.* path routes through a
    LiveKit inference executor this self-hosted box doesn't have (the same reason
    the local EOU turn-detector is disabled above). Returns None on any failure so
    the caller omits vad= and AgentSession falls back to its bundled default —
    never vad=None, which would disable VAD entirely."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            from livekit.plugins import silero
        vad = silero.VAD.load(
            activation_threshold=0.6,
            deactivation_threshold=0.35,
            min_speech_duration=0.08,
        )
        print("[voice] VAD: silero, crowd-tuned (act=0.6/deact=0.35/min=0.08)", flush=True)
        return vad
    except Exception as e:
        print(f"[voice] tuned VAD unavailable ({e}); bundled default", flush=True)
        return None


# ── worker entrypoint ───────────────────────────────────────────────────────
async def entrypoint(ctx: JobContext) -> None:
    global ROOM, SESSION
    await ctx.connect()
    ROOM = ctx.room

    # High-performance realtime pipeline:
    #   - STT: streaming (NeMo) when STT_WS_URL is set, else batch (make_stt).
    #   - LLM: Haiku, streamed token-by-token (LfgLLM/anthropic_stream).
    #   - TTS: sentence-pipelined off the LLM stream (build_tts/StreamAdapter).
    #   - Turn-taking: a semantic end-of-utterance model (on-box) over the bundled
    #     Silero VAD, so a turn endpoints in ~200-300ms vs a fixed silence timeout.
    # turn_handling is the current API (replaces the deprecated vad=/turn_detection=
    # kwargs); we pass turn_detection explicitly because the default is the hosted
    # cloud detector. VAD is AgentSession's bundled Silero default — no vad= needed.
    #
    # Barge-in / endpointing tuning (the fix for "the agent gets cut off
    # mid-sentence"). With plain-VAD turn detection the library defaults are very
    # trigger-happy — interruption.min_duration=0.5s, min_words=0, endpointing
    # min_delay=0.5s — so a cough, a breath, a back-channel "mm-hm", or TTS echo
    # bleeding into the mic interrupts the agent or ends the user's turn on a
    # fragment. We keep barge-in ENABLED (so the user can always cut in) but raise
    # the bar a little:
    #   - interruption.enabled=True            → barge-in stays on (the non-deprecated
    #                                             spelling of allow_interruptions=True)
    #   - interruption.min_duration=0.6        → ~0.6s of speech before it counts as
    #                                             a real interruption (was 0.5)
    #   - endpointing.min_delay=0.6            → a bit more silence before the user's
    #                                             turn ends, so a brief mid-sentence
    #                                             pause doesn't ship a fragment (was 0.5)
    # min_words further filters non-speech blips, but it gates on the LIVE transcript
    # (agent_activity: skip interruption while current_transcript has < min_words).
    # That only has a transcript to read when streaming STT is feeding interim
    # results; with batch STT there's no mid-speech transcript, so a >0 value would
    # suppress voice barge-in entirely. So only enable it when STT_WS_URL is set.
    # These are partial dicts — TurnHandlingOptions/Endpointing/Interruption are
    # TypedDicts and the library merges missing keys over its defaults.
    interruption: dict = {"enabled": True, "min_duration": 0.6}
    if STT_WS_URL:
        interruption["min_words"] = 1
    # A noise-tuned Silero VAD (see _build_vad) so background noise doesn't trip
    # speech detection. Pass vad= only when it loaded — None would DISABLE VAD,
    # so on failure we omit the kwarg and AgentSession uses its bundled default.
    session_kwargs = dict(
        stt=make_stt(),
        llm=LfgLLM(),
        tts=build_tts(),
        turn_handling=TurnHandlingOptions(
            turn_detection=_load_turn_detection(),
            endpointing={"min_delay": 0.6},
            interruption=interruption,
        ),
    )
    _vad = _build_vad()
    if _vad is not None:
        session_kwargs["vad"] = _vad
    session = AgentSession(**session_kwargs)
    # Expose the session so the background advisor can speak its answer out-of-band.
    SESSION = session

    # Push, not poll: hold an SSE stream to lfg and react the instant another
    # session finishes — refresh live context + (debounced) speak a heads-up.
    start_fleet_watch()

    # A fresh tap of the orb shows up here as a participant (re)joining the
    # persistent "voice" room. Clear the prior conversation and re-brief so each
    # start is a clean slate — this fires on reconnects, where the job/session
    # (and its accumulated chat_ctx) outlived the previous browser disconnect.
    @ctx.room.on("participant_connected")
    def _on_participant(_p: rtc.RemoteParticipant) -> None:
        asyncio.create_task(start_session(session, clear=True))

    # The web orb publishes the speaking user as the `lfg.user` attribute,
    # sometimes a beat after connecting — keep CURRENT_USER in step with it.
    @ctx.room.on("participant_attributes_changed")
    def _on_attrs(_changed, _p) -> None:
        _refresh_current_user()

    # On-box DTLN denoiser as an input FrameProcessor (before VAD/STT). Build the
    # start kwargs conditionally so a missing/broken plugin just omits denoising
    # rather than failing session.start — the worker must always come up.
    start_kwargs: dict = {"room": ctx.room}
    _nc = _build_noise_cancellation()
    if _nc is not None:
        start_kwargs["room_input_options"] = RoomInputOptions(noise_cancellation=_nc)
    await session.start(Agent(instructions="lfg voice assistant."), **start_kwargs)

    # Every start clears prior context. A normal reconnect dispatches a fresh job
    # (this entrypoint) with an already-empty session, so the clear is a no-op
    # there — but it makes "each start begins clean" an explicit invariant that
    # also holds if the session is ever kept warm across disconnects
    # (close_on_disconnect=False), where the participant handler above clears it.
    await start_session(session, clear=True)


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            ws_url=os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880"),
            api_key=os.environ.get("LIVEKIT_API_KEY"),
            api_secret=os.environ.get("LIVEKIT_API_SECRET"),
            num_idle_processes=1,
        )
    )
