// ─────────────────────────────────────────────────────────────────────────────
// ElevenLabs managed-agent brain — OpenAI-compatible custom-LLM endpoint.
//
// This is "Option B": ElevenLabs' managed agent owns STT / TTS / turn-taking,
// but OUR backend stays the brain. ElevenLabs is configured with a custom LLM
// pointing at  POST {public}/v1/chat/completions  (this handler). For every user
// turn ElevenLabs sends us an OpenAI chat-completions request; we run the same
// Haiku brain + fleet tools the LiveKit worker (deploy/voice/agent.py) ran —
// looping tool calls against our own /api endpoints — and stream the final
// spoken reply back as OpenAI SSE chunks. Tools never leave this box, so all the
// per-user scoping and fleet wiring we already trust is preserved verbatim.
//
// Why this kills the duplicate-session bug: there is no persistent shared
// LiveKit "voice" room and no participant_connected handler here. ElevenLabs
// owns one conversation per call; we are a stateless request/response brain.
//
// Per-user scoping: the browser passes `user_id` at session start (see the
// frontend connect path). ElevenLabs forwards it to us inside
// `elevenlabs_extra_body` (custom_llm_extra_body) — and we also accept the
// OpenAI `user` / top-level `user_id` fields as fallbacks. Every fleet read and
// action is scoped to that user, exactly like CURRENT_USER in agent.py.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeOauthToken } from "./claude-creds.ts";

const PORT = Number(process.env.LFG_PORT ?? 8766);
const LFG = `http://127.0.0.1:${PORT}`;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const HAIKU_MODEL = process.env.LFG_VOICE_MODEL || "claude-haiku-4-5";
const MAX_TOOL_HOPS = 6;

// ── Claude subscription OAuth, same source the rest of serve.ts uses ─────────
function oauthToken(): string | null {
  return claudeOauthToken();
}

// ── system prompt — ported verbatim from agent.py VOICE_PROMPT so spoken
// behaviour (one short sentence, resolve-before-act, escalate, etc.) is
// identical to the LiveKit brain. Kept as one stable string so Anthropic
// prompt-caches the prefix across turns. ────────────────────────────────────
const VOICE_PROMPT = `You are a hands-free voice assistant inside lfg, a dashboard for managing AI coding-agent sessions (Claude Code and similar). Reply in at most 1-2 short, plain spoken sentences. No markdown, no code blocks, no bullet lists, no symbols meant to be read aloud. Be direct and conversational.
WHO YOU SERVE: you are scoped to ONE person — the user speaking to you. The snapshot and list_sessions show only THEIR sessions, and you act only on their fleet. 'My project', 'it', 'this', or 'that session' (with no name) means their currently focused session — resolve it from the FOCUS line in your context before acting.
CRITICAL for speed and not being annoying:
- Answer in ONE short sentence. NEVER narrate or preface — no 'let me check', 'one moment', 'I'm checking'. Just answer.
- NEVER claim an action happened until you have seen its tool result. Say what you are ABOUT to do (present tense), never that it is already done, until the result comes back — then confirm it, or say it failed.
- Do NOT call a tool unless the user CLEARLY asks about session/fleet status, asks to act on a specific session, or asks a technical/informative question that warrants a session (see ANSWERING QUESTIONS below). For greetings/small talk, just reply — no tools.
- If what you heard is short, empty, unclear, or garbled, do NOT guess and do NOT act — briefly ask the user to repeat.
- For a SIMPLE ambiguity (which of two sessions did they mean?), just ASK the user in one short sentence. Do NOT consult the advisor for that.
ANSWERING QUESTIONS: for casual, conversational, or quick factual questions, just answer in one short sentence. But for any TECHNICAL or INFORMATIVE question — how something works, what the code/repo/architecture does, why a bug happens, how to build or fix something, research, or anything needing real depth or accuracy — do NOT answer it yourself from memory. You are a fast lightweight voice brain and would likely be shallow or wrong. Instead create_session to spin up a coding agent that investigates with full repo and tool access and answers it properly. Say one short conversational sentence like "give me a moment, looking into that" — NEVER say "advisor", "session", "spinning up", or "let me ask my advisor". Then call create_session with a clear one-line prompt capturing the question. Only skip the session if the user explicitly says they just want your quick take.

You can act on the fleet with tools. ALWAYS resolve a session to its exact id (from list_sessions or the snapshot) BEFORE reply_to_session, answer_session_prompt, or close_session — never act on a guessed id.
- get_fleet_status — re-read live status of the user's sessions. The snapshot in your context goes stale fast: ALWAYS call this first whenever the user asks what's happening now, the current status, whether a session finished/changed, or anything time-sensitive.
- list_sessions — get session ids + titles, plus agent kind, model, project, status, and how long each has been idle.
- search_transcript — search ONE session's full history for a word/phrase and get matching snippets.
- list_repos — list the projects/repos a new session can start in (name + path).
- create_session — start a NEW coding-agent session, either to DO a task or to GO FIND OUT something. Pass a clear one-line prompt. Defaults to the user's focused project; pass cwd (from list_repos) only when they name a different one. Optionally pass agent (codex-aisdk for Codex, opencode for OpenCode) and thinkingLevel (low/medium/high/xhigh).
- reply_to_session — send an instruction to another session.
- answer_session_prompt — pick an option for a session BLOCKED on a permission/plan prompt (use the option index from its snapshot line).
- close_session — shut down a session the user is done with. Resolve the exact id first; never close your own voice session.
- consult_advisor — hand a genuinely HARD or RISKY question to a stronger deep-thinking model with full repo + tool access. Use ONLY when careful reasoning is truly needed. It takes a while, so first say one short conversational hold like "hold on a minute" or "give me a moment, looking into that" — NEVER mention the advisor, a model, or that you're escalating.
Prefer answer_session_prompt over reply_to_session when a session is waiting on a choice. Never act on your own voice session.`;

// ── tool schemas (Anthropic tool-use), ported from agent.py BRAIN_TOOLS ──────
type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const FLEET_TOOLS: AnthropicTool[] = [
  {
    name: "get_fleet_status",
    description:
      "Re-read the live status of the user's lfg sessions (blocked / working / idle, with the pending question for blocked ones).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_sessions",
    description:
      "List the user's sessions with ids, titles, agentFamily (opencode/codex/claude), raw agent kind, model, project, status (ok/blocked with blockedReason), and idle time. Call this to resolve a session id before acting on one.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_repos",
    description:
      "List the repos/projects a new session can be started in (name + path). Resolve the working folder before create_session when the user names a project.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_session",
    description:
      "Start a NEW coding-agent session to work on a task OR to investigate something. Give a clear one-line instruction in prompt. Optionally cwd (a repo path from list_repos; omit to default to the user's focused project), agent (codex-aisdk/opencode), thinkingLevel (low/medium/high/xhigh). Returns the new session id. Slow — say a short spoken preamble first.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        cwd: { type: "string" },
        agent: { type: "string", enum: ["aisdk", "codex-aisdk", "opencode"] },
        thinkingLevel: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh"],
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "reply_to_session",
    description:
      "Send an instruction to another session (queued; it steers that session's next turn).",
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        text: { type: "string" },
      },
      required: ["session_id", "text"],
    },
  },
  {
    name: "answer_session_prompt",
    description:
      "Answer a session BLOCKED on a permission/plan prompt by picking an option index (0-based) from its snapshot line.",
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        option_index: { type: "integer" },
      },
      required: ["session_id", "option_index"],
    },
  },
  {
    name: "close_session",
    description:
      "Close / shut down a session the user is done with. Resolve the exact id first — destructive. NEVER close your own voice session.",
    input_schema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "search_transcript",
    description:
      "Search the full transcript of ONE session for a word or phrase and get back matching snippets (who said it + how long ago). Resolve the session id first.",
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["session_id", "query"],
    },
  },
];

const ESCALATE_TOOL: AnthropicTool = {
  name: "consult_advisor",
  description:
    "Escalate a genuinely HARD or RISKY question to a deeper thinker with full repo + tool access. It runs in the BACKGROUND and answers asynchronously — this returns immediately. Tell the user one short conversational hold like 'hold on a minute' or 'give me a moment looking into that'; NEVER say 'advisor', 'model', or that you're escalating; do NOT wait for or invent its answer.",
  input_schema: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  },
};

const BRAIN_TOOLS = [...FLEET_TOOLS, ESCALATE_TOOL];

// ── tiny HTTP helpers against our own /api (mirror agent.py _lfg_get/_lfg_post)
async function lfgGet(path: string): Promise<any> {
  try {
    const r = await fetch(`${LFG}${path}`);
    return r.ok ? await r.json() : { error: `http ${r.status}` };
  } catch (e) {
    return { error: String(e) };
  }
}
async function lfgPost(path: string, payload: unknown): Promise<any> {
  try {
    const r = await fetch(`${LFG}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    let j: any = {};
    try {
      j = await r.json();
    } catch {
      /* empty body */
    }
    return r.ok ? j : { error: `http ${r.status}`, ...j };
  } catch (e) {
    return { error: String(e) };
  }
}

function userQs(user: string): string {
  return user ? `?user=${encodeURIComponent(user)}` : "";
}

function agentFamily(agent: string | null | undefined): string {
  if (agent === "codex" || agent === "codex-aisdk") return "codex";
  if (agent === "opencode") return "opencode";
  if (agent === "hermes") return "hermes";
  return "claude";
}

function ago(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// Sessions visible to the speaking user: their own (by assignedUser). With no
// user we expose the whole fleet (matches agent.py's unscoped fallback).
async function scopedSessions(user: string): Promise<any[]> {
  const j = await lfgGet("/api/sessions");
  const out: any[] = [];
  for (const s of j?.sessions ?? []) {
    if (!s?.sessionId) continue;
    if (user && s.assignedUser !== user) continue;
    out.push(s);
  }
  return out;
}

// ── execute one fleet tool; returns a compact string for the tool_result.
// Ported 1:1 from agent.py run_tool, scoped to `user`. ───────────────────────
async function runTool(
  name: string,
  args: Record<string, any>,
  user: string,
): Promise<string> {
  try {
    if (name === "get_fleet_status") {
      const j = await lfgGet(`/api/voice/snapshot${userQs(user)}`);
      return j?.snapshot ?? "(none)";
    }
    if (name === "list_sessions") {
      const rows = (await scopedSessions(user)).map((s) => {
        const row: Record<string, unknown> = {
          id: s.sessionId,
          title: (s.title || "").slice(0, 60),
          user: s.assignedUser,
          agent: s.agent,
          agentFamily: agentFamily(s.agent),
          model: s.model,
          project: s.project,
          status: s.status,
          idle: ago(s.lastActivityAt),
          last: (s.lastUserText || "").slice(0, 60),
        };
        if (s.status === "blocked")
          row.blockedReason = s.statusDetail || s.statusReason;
        return row;
      });
      return JSON.stringify(rows);
    }
    if (name === "list_repos") {
      const j = await lfgGet("/api/repos");
      const rows = (j?.repos ?? [])
        .filter((r: any) => r?.cwd)
        .map((r: any) => ({ name: r.name, cwd: r.cwd }));
      return JSON.stringify(rows);
    }
    if (name === "create_session") {
      const prompt = (args.prompt || "").trim();
      if (!prompt) return "need a task/prompt to start a session";
      const payload: Record<string, unknown> = { prompt };
      const cwd = (args.cwd || "").trim();
      if (cwd) payload.cwd = cwd;
      const agent = (args.agent || "").trim();
      if (["aisdk", "codex-aisdk", "opencode"].includes(agent))
        payload.agent = agent;
      const tl = (args.thinkingLevel || "").trim();
      if (["low", "medium", "high", "xhigh"].includes(tl))
        payload.thinkingLevel = tl;
      if (user) payload.user = user; // assign the new session to the speaker
      const j = await lfgPost("/api/sessions/new", payload);
      const sid = j?.sessionId || j?.id;
      if (sid) return `created session ${sid}`;
      return j?.error || "create failed";
    }
    if (name === "search_transcript") {
      const sid = (args.session_id || "").trim();
      const query = (args.query || "").trim();
      if (!query) return "need a word or phrase to search for";
      const visible = new Set((await scopedSessions(user)).map((s) => s.sessionId));
      if (!sid || !visible.has(sid))
        return "couldn't find that session — call list_sessions to resolve the exact id first";
      const j = await lfgPost(`/api/sessions/${sid}/transcript/search`, {
        query,
        limit: Math.min(Number(args.limit) || 8, 50),
      });
      if (j?.error) return j.error || "search failed";
      const matches = j?.matches ?? [];
      if (!matches.length) return `no matches for "${query}" in that session's transcript`;
      return JSON.stringify(
        matches.slice(0, 50).map((m: any) => ({
          who: m.role,
          ago: ago(m.at),
          text: (m.text || "").slice(0, 200),
        })),
      );
    }
    if (["reply_to_session", "answer_session_prompt", "close_session"].includes(name)) {
      const sid = (args.session_id || "").trim();
      const visible = new Set((await scopedSessions(user)).map((s) => s.sessionId));
      if (!sid || !visible.has(sid))
        return "couldn't find that session for you — call list_sessions to resolve the exact id first, then try again";
      if (name === "reply_to_session") {
        const j = await lfgPost(`/api/sessions/${sid}/send`, { text: args.text || "" });
        return j?.ok ? "sent" : j?.error || "send failed";
      }
      if (name === "answer_session_prompt") {
        const j = await lfgPost(`/api/sessions/${sid}/answer`, {
          index: Number(args.option_index) || 0,
        });
        return j?.ok ? "answered" : j?.error || "answer failed";
      }
      if (name === "close_session") {
        const j = await lfgPost(`/api/sessions/${sid}/close`, { source: "voice_tool_close_session" });
        return j?.ok || !j?.error ? "closed" : j.error;
      }
    }
    if (name === "consult_advisor") {
      // The advisor (Opus) is slow and answers out-of-band in the LiveKit
      // worker. ElevenLabs custom-LLM is request/response and can't push
      // unsolicited audio mid-call, so v1 fires the consult in the background
      // and returns a holding line. LiveKit path speaks the answer via
      // session.say when ready; ElevenLabs still needs contextual-update
      // wiring for unsolicited push (OPTION-B.md) — but the hold the user
      // hears must stay conversational and never name the advisor.
      const question = (args.question || "").trim();
      void lfgPost("/api/voice/consult", { question }).catch(() => {});
      return "deeper look started in the background; tell the user 'hold on a minute' or 'give me a moment, looking into that' — never say advisor — then stop. do not invent the answer";
    }
    return `unknown tool ${name}`;
  } catch (e) {
    return `tool error: ${e}`;
  }
}

// ── one non-streaming Anthropic Messages call (OAuth), tool-loop friendly ────
async function anthropicCall(
  messages: any[],
  system: any,
  tools: AnthropicTool[],
): Promise<any | null> {
  const token = oauthToken();
  if (!token) return null;
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 1024,
        system,
        messages,
        tools,
      }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// System prompt with a fresh fleet snapshot injected (matches agent.py: stable
// VOICE_PROMPT is cached, volatile context rides in a second uncached block).
async function buildSystem(user: string): Promise<any[]> {
  const snap = await lfgGet(`/api/voice/snapshot${userQs(user)}`);
  const context = snap?.snapshot
    ? `LIVE FLEET SNAPSHOT (may be stale; re-read with get_fleet_status):\n${snap.snapshot}`
    : "";
  return [
    { type: "text", text: VOICE_PROMPT, cache_control: { type: "ephemeral" } },
    ...(context ? [{ type: "text", text: context }] : []),
  ];
}

// Run the Haiku brain with the fleet tool loop; returns the final spoken text.
async function runBrain(messages: any[], user: string): Promise<string> {
  const system = await buildSystem(user);
  const convo = [...messages];
  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const resp = await anthropicCall(convo, system, BRAIN_TOOLS);
    if (!resp) return "Sorry, I had trouble reaching my brain just now.";
    const blocks: any[] = resp.content ?? [];
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    const toolUses = blocks.filter((b) => b.type === "tool_use");
    if (resp.stop_reason !== "tool_use" || toolUses.length === 0) {
      return text || "Okay.";
    }
    // Execute every requested tool, append assistant turn + tool results, loop.
    convo.push({ role: "assistant", content: blocks });
    const results: any[] = [];
    for (const tu of toolUses) {
      const out = await runTool(tu.name, tu.input ?? {}, user);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
    }
    convo.push({ role: "user", content: results });
  }
  return "I wasn't able to finish that — can you say it again?";
}

// ── OpenAI-compatible request parsing ────────────────────────────────────────
function extractUser(body: any): string {
  const extra = body?.elevenlabs_extra_body ?? body?.elevenlabsExtraBody ?? {};
  return String(
    extra.user_id ?? extra.userId ?? body?.user_id ?? body?.user ?? "",
  ).trim();
}

// ElevenLabs sends OpenAI chat messages. Anthropic wants {role, content}; we
// map system→(merged into our own prompt, dropped here), user/assistant pass
// through. Content may be a string or OpenAI content-parts; normalise to text.
function toAnthropicMessages(oaiMessages: any[]): any[] {
  const out: any[] = [];
  for (const m of oaiMessages ?? []) {
    if (!m || m.role === "system") continue; // our VOICE_PROMPT is the system
    const role = m.role === "assistant" ? "assistant" : "user";
    let content = m.content;
    if (Array.isArray(content)) {
      content = content
        .map((p: any) => (typeof p === "string" ? p : p?.text ?? ""))
        .join("");
    }
    content = String(content ?? "").trim();
    if (!content) continue;
    out.push({ role, content });
  }
  // Anthropic requires the first message to be from the user.
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

// ── SSE encoding of the final reply as OpenAI chat.completion.chunk events ───
function sseChunk(id: string, delta: Record<string, unknown>, finish: string | null): string {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: HAIKU_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// ── frontend bootstrap: mint a per-connect WebRTC token server-side so the
// browser never sees the ElevenLabs API key. Returns { token, agentId } for the
// @elevenlabs/client startSession({ conversationToken }) call. ───────────────
function elevenAgentId(): string {
  if (process.env.LFG_ELEVEN_AGENT_ID) return process.env.LFG_ELEVEN_AGENT_ID;
  try {
    const rec = JSON.parse(
      readFileSync(join(process.cwd(), "data", "eleven-agent.json"), "utf8"),
    );
    return rec.agent_id || "";
  } catch {
    return "";
  }
}

export async function handleElevenToken(_req: Request): Promise<Response> {
  const key = process.env.ELEVENLABS_API_KEY;
  const agentId = elevenAgentId();
  if (!key || !agentId)
    return new Response(JSON.stringify({ error: "eleven agent not configured" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { "xi-api-key": key } },
    );
    if (!r.ok)
      return new Response(JSON.stringify({ error: `token ${r.status}` }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    const j = (await r.json()) as { token?: string };
    return new Response(JSON.stringify({ token: j.token, agentId }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}

/**
 * Handle  POST /v1/chat/completions  from ElevenLabs' managed agent.
 * Returns an SSE stream (text/event-stream) of OpenAI chunks ending in [DONE].
 */
export async function handleElevenLlm(req: Request): Promise<Response> {
  // Shared-secret gate. This endpoint is reachable from the public internet (via
  // Tailscale Funnel) so ElevenLabs' cloud can call it — which means it can
  // drive fleet tools (create/close sessions). ElevenLabs sends the secret
  // configured in the agent's custom_llm.api_key as a bearer token; reject
  // anything that doesn't match. If LFG_ELEVEN_LLM_SECRET is unset the endpoint
  // is disabled (fail closed) rather than open.
  const secret = process.env.LFG_ELEVEN_LLM_SECRET;
  if (!secret) return new Response("disabled", { status: 503 });
  const auth = req.headers.get("authorization") || "";
  const presented = auth.replace(/^Bearer\s+/i, "").trim();
  if (presented !== secret) return new Response("unauthorized", { status: 401 });

  const body: any = await req.json().catch(() => null);
  if (!body) return new Response("bad request", { status: 400 });

  const user = extractUser(body);
  const messages = toAnthropicMessages(body.messages);
  const id = `chatcmpl-${Math.random().toString(36).slice(2)}`;

  // Compute the reply first (the tool loop must finish before we know the
  // spoken text), then stream it out. Latency is dominated by Haiku + any tool
  // hops, same as the LiveKit brain.
  const reply = messages.length
    ? await runBrain(messages, user)
    : "I didn't catch that — could you say it again?";

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(sseChunk(id, { role: "assistant" }, null)));
      // Emit in sentence-ish chunks so ElevenLabs' TTS can start segmenting
      // immediately rather than waiting on one big blob.
      for (const piece of reply.match(/[^.!?]+[.!?]*\s*/g) ?? [reply]) {
        controller.enqueue(enc.encode(sseChunk(id, { content: piece }, null)));
      }
      controller.enqueue(enc.encode(sseChunk(id, {}, "stop")));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
