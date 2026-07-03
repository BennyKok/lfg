import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, SessionMsg } from "../sessions.ts";
import type { SessionBrainDecisionAction } from "./store.ts";

export type SessionFeatures = {
  sessionId: string;
  title: string;
  agent: string;
  cwd: string | null;
  project: string;
  busy: boolean;
  blocked: boolean;
  statusDetail: string | null;
  lastActivityAt: number | null;
  idleMinutes: number | null;
  lastUser: string | null;
  lastAssistant: string | null;
  transcript: string;
  pendingPrompt: boolean;
};

export type ClassifiedSession = {
  action: SessionBrainDecisionAction;
  reason: string;
  confidence: number;
  summary: string;
  nextActions: string[];
  blockers: string[];
  resumePrompt: string;
};

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

function oauthToken(): string | null {
  try {
    const raw = readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8");
    const creds = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function modelName(override?: string): string {
  return override || process.env.LFG_SESSION_BRAIN_MODEL || process.env.LFG_SESSION_SUMMARY_MODEL || "claude-sonnet-5";
}

function timeoutMs(): number {
  const raw = Number(process.env.LFG_SESSION_BRAIN_TIMEOUT_MS || "");
  return Number.isFinite(raw) && raw > 0 ? Math.max(1_000, Math.min(30_000, raw)) : 8_000;
}

function oneLine(text: string, max = 900): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trim()}...`;
}

function parseJsonObject(text: string): any | null {
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const parsed = tryParse(fence[1].trim());
    if (parsed) return parsed;
  }
  const obj = text.match(/\{[\s\S]*\}/);
  return obj ? tryParse(obj[0]) : null;
}

function normalizeStringArray(v: unknown, max = 6): string[] {
  return Array.isArray(v)
    ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, max)
    : [];
}

function normalizeAction(v: unknown): SessionBrainDecisionAction {
  const s = String(v ?? "");
  if (s === "needs_input" || s === "archive_and_close" || s === "close_no_note")
    return s;
  return "keep_live";
}

function validClassification(j: any): ClassifiedSession | null {
  if (!j || typeof j !== "object") return null;
  const action = normalizeAction(j.action);
  const reason = String(j.reason ?? "").trim();
  const summary = String(j.summary ?? "").trim();
  const confidenceRaw = Number(j.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0.5;
  const nextActions = normalizeStringArray(j.nextActions);
  const blockers = normalizeStringArray(j.blockers);
  const resumePrompt = String(j.resumePrompt ?? "").trim();
  if (!reason || !summary) return null;
  return {
    action,
    reason,
    confidence,
    summary,
    nextActions,
    blockers,
    resumePrompt: resumePrompt || fallbackResumePrompt(summary, nextActions, blockers),
  };
}

function fallbackResumePrompt(summary: string, nextActions: string[], blockers: string[]): string {
  const lines = [
    "Resume this archived LFG session from its compact notepad record.",
    "",
    `Summary: ${summary}`,
  ];
  if (nextActions.length) {
    lines.push("", "Next actions:");
    for (const a of nextActions) lines.push(`- ${a}`);
  }
  if (blockers.length) {
    lines.push("", "Known blockers:");
    for (const b of blockers) lines.push(`- ${b}`);
  }
  return lines.join("\n");
}

export function featuresForSession(
  session: Session,
  messages: SessionMsg[],
  pendingPrompt: boolean,
): SessionFeatures {
  const textMessages = messages.filter(
    (m) => m.kind === "text" && m.text.trim() && (m.role === "user" || m.role === "assistant"),
  );
  const lastUser = [...textMessages].reverse().find((m) => m.role === "user")?.text ?? null;
  const lastAssistant = [...textMessages].reverse().find((m) => m.role === "assistant")?.text ?? null;
  const transcript = textMessages
    .slice(-30)
    .map((m) => `${m.role}: ${oneLine(m.text, 700)}`)
    .join("\n");
  const now = Date.now();
  return {
    sessionId: session.sessionId ?? "",
    title: session.title || session.lastUserText || session.tmuxName || session.sessionId?.slice(0, 8) || "session",
    agent: session.agent,
    cwd: session.cwd,
    project: session.project,
    busy: !!session.busy,
    blocked: session.status === "blocked",
    statusDetail: session.statusDetail,
    lastActivityAt: session.lastActivityAt,
    idleMinutes: session.lastActivityAt ? Math.floor((now - session.lastActivityAt) / 60_000) : null,
    lastUser: lastUser ? oneLine(lastUser, 700) : null,
    lastAssistant: lastAssistant ? oneLine(lastAssistant, 900) : null,
    transcript,
    pendingPrompt,
  };
}

function heuristicClassify(features: SessionFeatures): ClassifiedSession {
  const idle = features.idleMinutes ?? 0;
  const lastAssistant = features.lastAssistant ?? "";
  const lastUser = features.lastUser ?? "";
  const combined = `${lastUser}\n${lastAssistant}`.toLowerCase();

  if (features.busy) {
    return {
      action: "keep_live",
      reason: "Session is currently working.",
      confidence: 0.95,
      summary: oneLine(lastAssistant || lastUser || `${features.title} is active.`),
      nextActions: [],
      blockers: [],
      resumePrompt: "",
    };
  }
  if (features.pendingPrompt || features.blocked) {
    return {
      action: "needs_input",
      reason: features.blocked
        ? `Session is blocked: ${features.statusDetail || "needs attention"}.`
        : "Session appears to be waiting for human input.",
      confidence: 0.85,
      summary: oneLine(lastAssistant || lastUser || `${features.title} needs input.`),
      nextActions: ["Review the pending question or blocker and decide the next step."],
      blockers: [features.statusDetail || "Needs human input"],
      resumePrompt: "",
    };
  }

  const hasFutureWork =
    /\b(todo|next|follow[- ]?up|remaining|blocked|blocker|not done|still need|need to|should|later|afterward|resume)\b/i.test(
      combined,
    );
  const looksComplete =
    /\b(done|complete|completed|fixed|implemented|shipped|verified|tests? pass|build passed|ready)\b/i.test(
      combined,
    );

  if (idle >= 90 && hasFutureWork) {
    const next = lastAssistant || lastUser || "Continue from the archived context.";
    const summary = oneLine(next, 500);
    return {
      action: "archive_and_close",
      reason: "Session has been idle and contains future work worth preserving.",
      confidence: 0.72,
      summary,
      nextActions: [oneLine(next, 220)],
      blockers: [],
      resumePrompt: fallbackResumePrompt(summary, [oneLine(next, 220)], []),
    };
  }
  if (idle >= 180 && looksComplete) {
    const summary = oneLine(lastAssistant || lastUser || `${features.title} appears complete.`, 500);
    return {
      action: "close_no_note",
      reason: "Session has been idle for a long time and appears complete.",
      confidence: 0.7,
      summary,
      nextActions: [],
      blockers: [],
      resumePrompt: "",
    };
  }
  return {
    action: "keep_live",
    reason: idle >= 60 ? "Session is idle, but the next step is not clear enough to archive automatically." : "Session is recent.",
    confidence: 0.6,
    summary: oneLine(lastAssistant || lastUser || `${features.title} has no clear closure signal.`),
    nextActions: hasFutureWork ? ["Clarify whether this session should be resumed later or marked done."] : [],
    blockers: [],
    resumePrompt: "",
  };
}

export async function classifySession(features: SessionFeatures, model?: string): Promise<{
  classification: ClassifiedSession;
  generated: boolean;
  error?: string;
}> {
  const fallback = heuristicClassify(features);
  const token = oauthToken();
  if (!token) {
    return {
      classification: fallback,
      generated: false,
      error: "no OAuth token in ~/.claude/.credentials.json",
    };
  }

  const system = `You are LFG's central session steward.
Classify one coding-agent session for lifecycle management.
Prefer fewer live sessions. Preserve future work as a compact notepad record.
Never recommend closing a working session or a session waiting for human input.

Return ONLY JSON:
{
  "action": "keep_live" | "needs_input" | "archive_and_close" | "close_no_note",
  "reason": "one sentence",
  "confidence": 0.0,
  "summary": "compact durable summary",
  "nextActions": ["future task", "..."],
  "blockers": ["blocker", "..."],
  "resumePrompt": "prompt to paste when resuming later"
}`;

  try {
    const r = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelName(model),
        max_tokens: 900,
        system,
        messages: [
          {
            role: "user",
            content: `Session features:\n${JSON.stringify(features, null, 2)}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return {
        classification: fallback,
        generated: false,
        error: `Anthropic API ${r.status}${body ? `: ${oneLine(body, 160)}` : ""}`,
      };
    }
    const data = (await r.json().catch(() => null)) as { content?: Array<{ type?: string; text?: string }> } | null;
    const text = data?.content
      ?.filter((b) => b?.type === "text")
      .map((b) => b.text || "")
      .join("")
      .trim();
    const parsed = text ? validClassification(parseJsonObject(text)) : null;
    if (!parsed) {
      return {
        classification: fallback,
        generated: false,
        error: "model response was empty or not valid classification JSON",
      };
    }
    return { classification: parsed, generated: true };
  } catch (e) {
    return {
      classification: fallback,
      generated: false,
      error: `classify request failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function suggestPromptImprovements(input: {
  notes: Array<{ title: string; summary: string; nextActions: string[]; blockers: string[] }>;
  decisions: Array<{ action: string; reason: string; title: string }>;
}, model?: string): Promise<Array<{
  key: string;
  title: string;
  reasoning: string;
  recommendation: string;
  evidence: string[];
}>> {
  const heuristic = heuristicSuggestions(input);
  const token = oauthToken();
  if (!token || input.notes.length + input.decisions.length < 3) return heuristic;
  try {
    const r = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelName(model),
        max_tokens: 1_000,
        system:
          "Analyze recurring patterns in LFG coding-agent sessions. Suggest concrete improvements to system prompts or run instructions. Return ONLY JSON array with key,title,reasoning,recommendation,evidence[].",
        messages: [{ role: "user", content: JSON.stringify(input, null, 2) }],
      }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!r.ok) return heuristic;
    const data = (await r.json().catch(() => null)) as { content?: Array<{ type?: string; text?: string }> } | null;
    const text = data?.content
      ?.filter((b) => b?.type === "text")
      .map((b) => b.text || "")
      .join("")
      .trim();
    const parsed = text ? parseJsonObject(text) : null;
    const arr = Array.isArray(parsed) ? parsed : [];
    const normalized = arr
      .map((x) => ({
        key: String(x?.key ?? "").trim(),
        title: String(x?.title ?? "").trim(),
        reasoning: String(x?.reasoning ?? "").trim(),
        recommendation: String(x?.recommendation ?? "").trim(),
        evidence: normalizeStringArray(x?.evidence, 6),
      }))
      .filter((x) => x.key && x.title && x.recommendation)
      .slice(0, 5);
    return normalized.length ? normalized : heuristic;
  } catch {
    return heuristic;
  }
}

function heuristicSuggestions(input: {
  notes: Array<{ title: string; summary: string; nextActions: string[]; blockers: string[] }>;
  decisions: Array<{ action: string; reason: string; title: string }>;
}) {
  const out: Array<{
    key: string;
    title: string;
    reasoning: string;
    recommendation: string;
    evidence: string[];
  }> = [];
  const needsInput = input.decisions.filter((d) => d.action === "needs_input");
  if (needsInput.length >= 2) {
    out.push({
      key: "surface-blockers-earlier",
      title: "Ask agents to surface blockers earlier",
      reasoning: "Multiple sessions ended in a state that needed human input.",
      recommendation:
        "Add a prompt rule: when blocked, stop and ask one explicit question with the exact decision needed, instead of continuing to explore.",
      evidence: needsInput.slice(0, 5).map((d) => d.title),
    });
  }
  const notesWithActions = input.notes.filter((n) => n.nextActions.length);
  if (notesWithActions.length >= 2) {
    out.push({
      key: "end-turn-next-actions",
      title: "Standardize end-of-turn next actions",
      reasoning: "Archived sessions often contain follow-up work that had to be reconstructed.",
      recommendation:
        "Add a prompt rule: final responses should include a short 'Next actions' line whenever work is incomplete or intentionally deferred.",
      evidence: notesWithActions.slice(0, 5).map((n) => n.title),
    });
  }
  const blockerNotes = input.notes.filter((n) => n.blockers.length);
  if (blockerNotes.length >= 2) {
    out.push({
      key: "blocker-format",
      title: "Use a consistent blocker format",
      reasoning: "Repeated blockers are easier to triage when they are explicit and machine-readable.",
      recommendation:
        "Ask agents to separate blockers from completed work and include owner, missing input, and smallest next step.",
      evidence: blockerNotes.slice(0, 5).map((n) => n.title),
    });
  }
  return out;
}
