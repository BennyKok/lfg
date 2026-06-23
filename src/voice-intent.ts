// ─────────────────────────────────────────────────────────────────────────────
// Voice intent resolver — turn a dictated one-shot request into a session config.
//
// The launcher orb supports push-to-talk: hold, speak, release. On release the
// browser sends the raw transcript here together with the user's CURRENT saved
// settings (agent/model/repo/thinking) and the menus of what's available. We ask
// a fast Haiku brain to (a) clean the transcript into a task prompt, (b) honor
// any overrides the user SPOKE ("use codex in the web repo", "with opus") on top
// of their base config, and (c) write one short spoken confirmation sentence.
//
// Base config wins unless the words clearly override it. Everything is best-effort:
// on any model/parse failure we fall back to the base config and a deterministic
// confirmation, so the orb never fails to create a session because the brain hiccuped.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Latency-critical voice path: reuse the same fast Haiku brain the rest of the
// voice stack runs on (overridable via LFG_VOICE_MODEL), not a heavy Opus call.
const INTENT_MODEL = process.env.LFG_VOICE_MODEL || "claude-haiku-4-5";

function oauthToken(): string | null {
  try {
    const raw = readFileSync(
      join(homedir(), ".claude", ".credentials.json"),
      "utf8",
    );
    const creds = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string };
    };
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

export type VoiceIntentBase = {
  agent: string;
  model: string;
  cwd: string;
  thinkingLevel?: string | null;
};

export type VoiceIntentRequest = {
  transcript: string;
  base: VoiceIntentBase;
  // Menus of what the user could pick, so overrides resolve to real values.
  repos: Array<{ name: string; cwd: string }>;
  agents: Array<{ key: string; label: string }>;
  models?: string[];
  thinkingLevels?: string[];
};

export type VoiceIntentResult = {
  prompt: string;
  agent: string;
  model: string;
  cwd: string;
  thinkingLevel?: string | null;
  confirmation: string;
};

const SYSTEM = `You convert a person's spoken, dictated request into a config for launching a new AI coding-agent session, plus a short spoken confirmation.

You are given: the raw transcript, the user's CURRENT default settings (agent, model, repo, thinking level), and the menus of available agents, models, and repos.

Rules:
- The user's current settings are the defaults. Keep them UNLESS the transcript clearly asks for something different (e.g. "use codex", "with opus", "in the web repo", "think hard"). Spoken intent overrides the defaults; otherwise echo the defaults back.
- Only ever choose an agent/model/repo/thinkingLevel that appears in the provided menus. If the user names something not in a menu, ignore that override and keep the default. Match repos loosely by name (case-insensitive, partial is fine).
- "prompt" is the actual task to hand the coding agent: clean up the transcript into a clear instruction. Strip out the meta config words (which agent/model/repo to use) — those belong in the config fields, not the prompt. Fix obvious dictation errors. Do not add scope the user didn't ask for.
- "confirmation" is ONE short, natural spoken sentence (no markdown, no lists) confirming what you're about to start — mention the task briefly and, only if they differ from the defaults or are worth surfacing, the agent/model/repo. Example: "Starting a Codex session in web to add dark mode." Keep it under ~20 words.

Respond with ONLY a JSON object, no prose and no code fences:
{"prompt": string, "agent": string, "model": string, "repo": string, "thinkingLevel": string|null, "confirmation": string}
"agent" is an agent key from the menu, "model" a model from the menu, "repo" a repo NAME from the menu.`;

function buildUserMsg(req: VoiceIntentRequest): string {
  const baseRepoName =
    req.repos.find((r) => r.cwd === req.base.cwd)?.name ?? req.base.cwd;
  return JSON.stringify(
    {
      transcript: req.transcript,
      current_defaults: {
        agent: req.base.agent,
        model: req.base.model,
        repo: baseRepoName,
        thinkingLevel: req.base.thinkingLevel ?? null,
      },
      available: {
        agents: req.agents,
        models: req.models ?? [],
        repos: req.repos.map((r) => r.name),
        thinkingLevels: req.thinkingLevels ?? [],
      },
    },
    null,
    2,
  );
}

function deterministicFallback(req: VoiceIntentRequest): VoiceIntentResult {
  const repoName =
    req.repos.find((r) => r.cwd === req.base.cwd)?.name ?? "your project";
  return {
    prompt: req.transcript.trim(),
    agent: req.base.agent,
    model: req.base.model,
    cwd: req.base.cwd,
    thinkingLevel: req.base.thinkingLevel ?? null,
    confirmation: `Starting a session in ${repoName}.`,
  };
}

// Pull the first balanced JSON object out of the model text (defensive against
// the model wrapping it in prose or a code fence despite instructions).
function extractJson(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function resolveVoiceIntent(
  req: VoiceIntentRequest,
): Promise<VoiceIntentResult> {
  const fallback = deterministicFallback(req);
  const transcript = (req.transcript ?? "").trim();
  if (!transcript) return fallback;

  const token = oauthToken();
  if (!token) return fallback;

  let parsed: any = null;
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
        model: INTENT_MODEL,
        max_tokens: 600,
        system: SYSTEM,
        messages: [{ role: "user", content: buildUserMsg(req) }],
      }),
    });
    if (!r.ok) return fallback;
    const data = (await r.json()) as any;
    const text = Array.isArray(data?.content)
      ? data.content
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b.text)
          .join("")
      : "";
    parsed = extractJson(text);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== "object") return fallback;

  // Validate every field against the menus — the model only proposes, we decide.
  const agentKeys = new Set(req.agents.map((a) => a.key));
  const agent = agentKeys.has(parsed.agent) ? parsed.agent : req.base.agent;

  const models = new Set(req.models ?? []);
  const model = models.has(parsed.model) ? parsed.model : req.base.model;

  let cwd = req.base.cwd;
  if (typeof parsed.repo === "string" && parsed.repo.trim()) {
    const want = parsed.repo.trim().toLowerCase();
    const hit =
      req.repos.find((r) => r.name.toLowerCase() === want) ??
      req.repos.find((r) => r.name.toLowerCase().includes(want)) ??
      req.repos.find((r) => want.includes(r.name.toLowerCase()));
    if (hit) cwd = hit.cwd;
  }

  const levels = new Set(req.thinkingLevels ?? []);
  const thinkingLevel =
    parsed.thinkingLevel && levels.has(parsed.thinkingLevel)
      ? parsed.thinkingLevel
      : (req.base.thinkingLevel ?? null);

  const prompt =
    typeof parsed.prompt === "string" && parsed.prompt.trim()
      ? parsed.prompt.trim()
      : transcript;
  const confirmation =
    typeof parsed.confirmation === "string" && parsed.confirmation.trim()
      ? parsed.confirmation.trim()
      : fallback.confirmation;

  return { prompt, agent, model, cwd, thinkingLevel, confirmation };
}
