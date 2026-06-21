"""
lfg voice agent worker (LiveKit Agents 1.6.x).

Pipeline: LiveKit room audio -> (bundled Silero VAD) -> custom STT (lfg
/api/voice/stt, faster-whisper) -> custom LLM (bridges to a dedicated Haiku
Claude Code session via /api/sessions/<id>/send + /stream) -> custom TTS
(lfg /api/voice/tts) -> agent audio track back to the room.

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
import wave
from pathlib import Path

import aiohttp

from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    WorkerOptions,
    cli,
    llm,
    stt,
    tts,
    utils,
)

LFG = os.environ.get("LFG_BASE", "http://127.0.0.1:8766")
CREDS_FILE = Path.home() / ".claude" / ".credentials.json"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
# The voice brain is Haiku (fast, cheap). When it isn't confident it escalates
# up the ladder — Sonnet, then Opus — and each stronger model gets the SAME
# fleet tools, so it can both reason AND act, not just advise.
HAIKU_MODEL = "claude-haiku-4-5"
SONNET_MODEL = "claude-sonnet-4-6"
OPUS_MODEL = "claude-opus-4-8"
VOICE_PROMPT = (
    "You are a hands-free voice assistant inside lfg, a dashboard for managing "
    "AI coding-agent sessions (Claude Code and similar). Reply in at most 1-2 "
    "short, plain spoken sentences. No markdown, no code blocks, no bullet "
    "lists, no symbols meant to be read aloud. Be direct and conversational.\n"
    "CRITICAL for speed and not being annoying:\n"
    "- Answer in ONE short sentence. NEVER narrate or preface — no 'let me "
    "check', 'one moment', 'I'm checking'. Just answer.\n"
    "- Do NOT call a tool unless the user CLEARLY asks about session/fleet "
    "status or to act on a specific session. For greetings/small talk, just "
    "reply — no tools.\n"
    "- If what you heard is short, empty, unclear, or garbled, do NOT guess and "
    "do NOT act — briefly ask the user to repeat.\n"
    "If something needs a long answer or code, give a one-sentence summary and "
    "offer to open it in a session.\n\n"
    "You can act on the fleet with tools. Resolve a session the user names "
    "against the snapshot/list, then:\n"
    "- get_fleet_status — re-read live status of every session. The snapshot in "
    "your context was captured when you connected and goes stale fast: ALWAYS "
    "call this first whenever the user asks what's happening now, the current "
    "status, whether a session finished/changed, or anything time-sensitive. "
    "Answer from the fresh result, not the connect-time snapshot.\n"
    "- list_sessions — get session ids + titles (needed before replying).\n"
    "- list_repos — list the projects/repos a new session can start in (name + "
    "path); use it to resolve the folder when the user names a project.\n"
    "- create_session — start a NEW coding-agent session to work on a task. Pass "
    "a clear one-line `prompt`; when the user names a project, first call "
    "list_repos and pass that repo's path as `cwd`. You CAN create sessions from "
    "voice — do it when the user asks, don't tell them to use the dashboard.\n"
    "- reply_to_session — send an instruction to another session.\n"
    "- answer_session_prompt — pick an option for a session that is BLOCKED on "
    "a permission/plan prompt (use the option index from its snapshot line).\n"
    "- close_session — shut down / end a session the user is done with. Make "
    "sure you have the right session id (resolve it first); never close your "
    "own voice session.\n"
    "- consult_advisor — escalate to a STRONGER, smarter model. Use this "
    "WHENEVER you are not confident: a hard or ambiguous question, a risky or "
    "destructive action (like closing the wrong session), unsure which tool to "
    "call, or anything that needs careful reasoning. The advisor has the same "
    "fleet tools and can act on the fleet itself, so prefer escalating over "
    "guessing. It takes a moment, so BEFORE you call it say one short spoken "
    "sentence telling the user you're checking with the advisor.\n"
    "Prefer answer_session_prompt over reply_to_session when a session is "
    "waiting on a choice. Never act on your own voice session."
)
# Appended to the system prompt when a stronger model is handling an escalation,
# so it knows it can act on the fleet — not just hand back advice.
ESCALATION_NOTE = (
    "\n\nYou are the escalation advisor: a stronger model the voice assistant "
    "consults when it is unsure, a question is hard or ambiguous, or an action "
    "is risky. You have the SAME fleet tools and may ACT directly — reply to a "
    "session, answer a blocked prompt, close a session — in addition to "
    "reasoning. Re-read live state with get_fleet_status / list_sessions before "
    "acting, and never touch the voice session itself. If the question is still "
    "beyond you, you may escalate once more. Answer in at most 3 short, plain "
    "spoken sentences; it is read aloud."
)

# Module state for the single active voice job (room "voice", one job at a time).
ROOM: rtc.Room | None = None
SYSTEM_PROMPT: str = VOICE_PROMPT


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
        _http = aiohttp.ClientSession()
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


# ── fleet tools (Anthropic tool-use, backed by the lfg HTTP API) ─────────────
# Every brain in the ladder (Haiku, Sonnet, Opus) gets these same fleet tools,
# so a stronger model can act on the fleet exactly like the voice brain can.
FLEET_TOOLS = [
    {
        "name": "get_fleet_status",
        "description": "Re-read the live status of every lfg session (blocked / working / idle, with the pending question for blocked ones).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_sessions",
        "description": "List sessions with their ids and titles. Call this to resolve a session id before reply_to_session, answer_session_prompt, or close_session.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_repos",
        "description": "List the repos/projects a new session can be started in (name + path). Call this to resolve the working folder before create_session when the user names a project.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "create_session",
        "description": "Start a NEW coding-agent session to work on a task. Give it a clear one-line instruction in `prompt`. Optionally pass `cwd` (a repo path from list_repos) to start it in a specific project; omit to use the default lfg repo. Returns the new session id. Slow (a few seconds) — say a short spoken preamble first.",
        "input_schema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string"},
                "cwd": {"type": "string"},
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
]

# The escalation tool — hands a hard/uncertain decision up to a stronger model.
ESCALATE_TOOL = {
    "name": "consult_advisor",
    "description": "Escalate to a stronger, smarter model when you are NOT confident: a hard or ambiguous question, a risky/destructive action, unsure which tool to call, or anything needing careful reasoning. The advisor shares your fleet tools and can act on the fleet itself. Returns a short spoken answer.",
    "input_schema": {
        "type": "object",
        "properties": {"question": {"type": "string"}},
        "required": ["question"],
    },
}


def tools_for(model: str) -> list[dict]:
    """Tools available to each rung of the ladder. Opus is the top — no further
    escalation — everyone below it can escalate."""
    if model == OPUS_MODEL:
        return FLEET_TOOLS
    return FLEET_TOOLS + [ESCALATE_TOOL]


async def set_activity(state: str) -> None:
    """Publish a custom orb state (consulting / replying / "") to the room."""
    if ROOM is None:
        return
    try:
        await ROOM.local_participant.set_attributes({"lfg.activity": state})
    except Exception:
        pass


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


async def run_tool(name: str, args: dict) -> str:
    """Execute one fleet tool; returns a compact string for the tool_result."""
    try:
        if name == "get_fleet_status":
            return (await _lfg_get("/api/voice/snapshot")).get("snapshot", "(none)")
        if name == "list_sessions":
            j = await _lfg_get("/api/sessions")
            rows = []
            for s in j.get("sessions", []):
                if not s.get("sessionId"):
                    continue
                rows.append(
                    {
                        "id": s.get("sessionId"),
                        "title": (s.get("title") or "")[:60],
                        "user": s.get("assignedUser"),
                        "last": (s.get("lastUserText") or "")[:60],
                    }
                )
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
            if cwd:
                payload["cwd"] = cwd
            await set_activity("replying")
            try:
                j = await _lfg_post("/api/sessions/new", payload)
            finally:
                await set_activity("")
            if j.get("ok"):
                sid = j.get("sessionId") or j.get("tmuxName") or ""
                return f"created session {sid}"
            return j.get("error") or "create failed"
        if name == "reply_to_session":
            await set_activity("replying")
            try:
                j = await _lfg_post(
                    f"/api/sessions/{args.get('session_id')}/send",
                    {"text": args.get("text", "")},
                )
            finally:
                await set_activity("")
            return "sent" if j.get("ok") else (j.get("error") or "send failed")
        if name == "answer_session_prompt":
            j = await _lfg_post(
                f"/api/sessions/{args.get('session_id')}/answer",
                {"index": int(args.get("option_index", 0))},
            )
            return "answered" if j.get("ok") else (j.get("error") or "answer failed")
        if name == "close_session":
            j = await _lfg_post(
                f"/api/sessions/{args.get('session_id')}/close", {}
            )
            return j.get("error") or "closed"
    except Exception as e:
        return f"tool error: {e}"
    return f"unknown tool {name}"


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
        "system": system,
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


# ── LLM: the brain ladder (Haiku → Sonnet → Opus), all sharing fleet tools ───
# One tool-use loop, parameterized by model. The voice brain (Haiku) runs it
# live and speaks via `emit`; an escalation runs the SAME loop on a stronger
# model with the SAME tools and just hands its answer back up the ladder.
async def escalate(from_model: str, question: str) -> str:
    """Hand a hard/uncertain decision to the next model up. Returns its answer."""
    target = SONNET_MODEL if from_model == HAIKU_MODEL else OPUS_MODEL
    print(f"[voice] escalate {from_model} -> {target}: {question[:80]}", flush=True)
    await set_activity("consulting")
    try:
        msgs: list[dict] = [{"role": "user", "content": question or "Please advise."}]
        answer = await run_brain(
            msgs, model=target, system=SYSTEM_PROMPT + ESCALATION_NOTE
        )
    finally:
        await set_activity("")
    return answer or "(no answer from the advisor)"


async def run_brain(msgs, *, model: str, system: str, emit=None) -> str:
    """Tool-use loop at `model`. Speaks each text chunk via emit() when given
    (the live voice turn); always returns the final assistant text (so an
    escalation can hand it back to the caller)."""
    tools = tools_for(model)
    for _ in range(6):
        resp = await anthropic_call(
            msgs, system, model=model, tools=tools, max_tokens=600
        )
        if not resp:
            return ""
        blocks = resp.get("content") or []
        if resp.get("stop_reason") == "tool_use":
            msgs.append({"role": "assistant", "content": blocks})
            tool_names = [
                b.get("name", "") for b in blocks if b.get("type") == "tool_use"
            ]
            # Speak any preamble the model produced alongside the tool call (e.g.
            # "let me check with the advisor"). Without this, text blocks on a
            # tool-use turn are dropped and the user hears dead air through a
            # slow consult. Guarantee a "hold on" even with no preamble.
            preamble = "".join(
                b.get("text", "") for b in blocks if b.get("type") == "text"
            ).strip()
            if not preamble:
                if "consult_advisor" in tool_names:
                    preamble = "Let me check with a stronger model, one moment."
                elif "reply_to_session" in tool_names:
                    preamble = "Okay, sending that over now."
                elif "close_session" in tool_names:
                    preamble = "Okay, closing that session now."
                elif "create_session" in tool_names:
                    preamble = "Okay, spinning up a new session for that, one moment."
            if preamble and emit:
                print(f"[voice] say (preamble): {preamble}", flush=True)
                emit(preamble)
            print(f"[voice] tool_use ({model}): {tool_names}", flush=True)
            results = []
            for b in blocks:
                if b.get("type") != "tool_use":
                    continue
                name = b.get("name", "")
                args = b.get("input") or {}
                if name == "consult_advisor":
                    out = await escalate(model, args.get("question", ""))
                else:
                    out = await run_tool(name, args)
                results.append(
                    {"type": "tool_result", "tool_use_id": b.get("id"), "content": out}
                )
            msgs.append({"role": "user", "content": results})
            continue
        # final answer
        text = "".join(
            b.get("text", "") for b in blocks if b.get("type") == "text"
        ).strip()
        if text and emit:
            print(f"[voice] reply ({model}): {text}", flush=True)
            emit(text)
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

        # The voice brain is Haiku; it escalates up the ladder when unsure.
        await run_brain(msgs, model=HAIKU_MODEL, system=SYSTEM_PROMPT, emit=emit)


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
        carry = b""
        async with http.post(
            f"{LFG}/api/voice/tts", json={"text": self._input_text}
        ) as r:
            async for chunk in r.content.iter_chunked(9600):
                buf = carry + chunk
                n = len(buf) - (len(buf) % 2)  # keep 16-bit sample alignment
                if n:
                    output_emitter.push(buf[:n])
                carry = buf[n:]
        output_emitter.flush()


class LfgTTS(tts.TTS):
    def __init__(self) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=24000,
            num_channels=1,
        )

    def synthesize(self, text, *, conn_options=None):
        return LfgTTSStream(tts=self, input_text=text, conn_options=conn_options)


# ── proactive briefing ──────────────────────────────────────────────────────
async def make_briefing(snapshot: str) -> str:
    """Turn the raw snapshot into a <=2 sentence spoken greeting + status."""
    msgs = [
        {
            "role": "user",
            "content": (
                "Greet me in one short sentence, then brief me on the fleet in "
                "at most one more sentence — lead with anything BLOCKED that "
                "needs my decision, else say how many are working/idle. Plain "
                "spoken words only.\n\nSNAPSHOT:\n" + (snapshot or "(no sessions)")
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
    return "Hey, I'm online. Tap to ask me anything about your sessions."


# ── worker entrypoint ───────────────────────────────────────────────────────
async def entrypoint(ctx: JobContext) -> None:
    global ROOM, SYSTEM_PROMPT
    await ctx.connect()
    ROOM = ctx.room

    # Seed the system prompt with live fleet status + the user's standing context
    # so every reply is fleet-aware from turn one.
    snapshot = ""
    try:
        snap = await _lfg_get("/api/voice/snapshot")
        snapshot = snap.get("snapshot", "")
        parts = [VOICE_PROMPT]
        if snapshot:
            parts.append(
                "=== SESSION SNAPSHOT (point-in-time, captured when you "
                "connected — treat as STALE; call get_fleet_status for current "
                "status before answering status questions) ===\n"
                + snapshot
                + "\n=== END SNAPSHOT ==="
            )
        if snap.get("context"):
            parts.append("=== USER CONTEXT ===\n" + snap["context"])
        SYSTEM_PROMPT = "\n\n".join(parts)
    except Exception:
        SYSTEM_PROMPT = VOICE_PROMPT

    session = AgentSession(stt=LfgSTT(), llm=LfgLLM(), tts=LfgTTS())
    await session.start(Agent(instructions="lfg voice assistant."), room=ctx.room)

    # Speak a proactive briefing the moment we connect (no user turn needed).
    try:
        await session.say(await make_briefing(snapshot))
    except Exception:
        pass


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
