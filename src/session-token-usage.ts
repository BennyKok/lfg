import {
  createReadStream,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { PATHS } from "./config.ts";

export type SessionTokenCategory = {
  name: string;
  tokens: number;
  color?: string;
  accuracy: "reported" | "estimated";
};

export type SessionTokenUsage = {
  available: boolean;
  source: "claude-context" | "codex-transcript" | "claude-transcript" | "unavailable";
  accuracy: "reported" | "mixed" | "unavailable";
  updatedAt: number;
  model: string | null;
  context: {
    used: number | null;
    max: number | null;
    free: number | null;
    percent: number | null;
  };
  totals: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    total: number;
    costUsd: number | null;
  } | null;
  categories: SessionTokenCategory[];
  details?: {
    memoryFiles?: Array<{ path: string; type: string; tokens: number }>;
    mcpTools?: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>;
    systemTools?: Array<{ name: string; tokens: number }>;
    systemPromptSections?: Array<{ name: string; tokens: number }>;
    skills?: {
      totalSkills: number;
      includedSkills: number;
      tokens: number;
      items: Array<{ name: string; source: string; tokens: number }>;
    };
    messageBreakdown?: {
      toolCallTokens: number;
      toolResultTokens: number;
      attachmentTokens: number;
      assistantMessageTokens: number;
      userMessageTokens: number;
      redirectedContextTokens: number;
      unattributedTokens: number;
      toolCallsByType: Array<{ name: string; callTokens: number; resultTokens: number }>;
    };
  };
  note: string;
};

export type ClaudeContextUsageSnapshot = {
  categories: Array<{ name: string; tokens: number; color: string; isDeferred?: boolean }>;
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  model: string;
  memoryFiles?: Array<{ path: string; type: string; tokens: number }>;
  mcpTools?: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>;
  systemTools?: Array<{ name: string; tokens: number }>;
  systemPromptSections?: Array<{ name: string; tokens: number }>;
  skills?: {
    totalSkills: number;
    includedSkills: number;
    tokens: number;
    skillFrontmatter: Array<{ name: string; source: string; tokens: number }>;
  };
  messageBreakdown?: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
    redirectedContextTokens: number;
    unattributedTokens: number;
    toolCallsByType: Array<{ name: string; callTokens: number; resultTokens: number }>;
  };
};

export type StoredSessionTokenUsage = {
  updatedAt: number;
  model: string | null;
  context: ClaudeContextUsageSnapshot | null;
  totals: NonNullable<SessionTokenUsage["totals"]>;
};

const COLORS = [
  "#a78bfa",
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#fb7185",
  "#22d3ee",
  "#c084fc",
  "#94a3b8",
];
const transcriptCache = new Map<
  string,
  { mtimeMs: number; size: number; usage: SessionTokenUsage }
>();

function usageDir(): string {
  return join(PATHS.data, "session-usage");
}

function usagePath(sessionId: string): string {
  return join(usageDir(), `${sessionId}.json`);
}

export function readStoredSessionTokenUsage(sessionId: string): StoredSessionTokenUsage | null {
  try {
    return JSON.parse(readFileSync(usagePath(sessionId), "utf8")) as StoredSessionTokenUsage;
  } catch {
    return null;
  }
}

export function writeStoredSessionTokenUsage(
  sessionId: string,
  snapshot: StoredSessionTokenUsage,
): void {
  mkdirSync(usageDir(), { recursive: true });
  const target = usagePath(sessionId);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(snapshot));
  renameSync(temp, target);
}

function fromStored(stored: StoredSessionTokenUsage): SessionTokenUsage {
  const rich = stored.context;
  const used = rich?.totalTokens ?? null;
  const max = rich?.maxTokens ?? null;
  return {
    available: true,
    source: "claude-context",
    accuracy: rich ? "reported" : "mixed",
    updatedAt: stored.updatedAt,
    model: rich?.model ?? stored.model,
    context: {
      used,
      max,
      free: used != null && max != null ? Math.max(0, max - used) : null,
      percent: rich?.percentage ?? (used != null && max ? (used / max) * 100 : null),
    },
    totals: stored.totals,
    categories: (rich?.categories ?? []).map((category) => ({
      name: category.name,
      tokens: category.tokens,
      color: category.color,
      accuracy: "reported",
    })),
    details: rich
      ? {
          memoryFiles: rich.memoryFiles,
          mcpTools: rich.mcpTools,
          systemTools: rich.systemTools,
          systemPromptSections: rich.systemPromptSections,
          skills: rich.skills
            ? {
                totalSkills: rich.skills.totalSkills,
                includedSkills: rich.skills.includedSkills,
                tokens: rich.skills.tokens,
                items: rich.skills.skillFrontmatter,
              }
            : undefined,
          messageBreakdown: rich.messageBreakdown,
        }
      : undefined,
    note: rich
      ? "Context categories and token counts are reported by Claude for this session."
      : "Session totals are reported by Claude; a context-category snapshot is not available yet.",
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (!text) return 0;
  // A deliberately conservative display estimate for source attribution. The
  // authoritative context and session totals always come from the provider.
  return Math.max(1, Math.ceil(text.length / 4));
}

function addCategory(map: Map<string, number>, name: string, value: unknown): void {
  const tokens = estimateTokens(value);
  if (tokens) map.set(name, (map.get(name) ?? 0) + tokens);
}

function consumeTagged(
  text: string,
  map: Map<string, number>,
  name: string,
  pattern: RegExp,
): string {
  return text.replace(pattern, (match) => {
    addCategory(map, name, match);
    return "";
  });
}

function classifyPromptText(
  raw: string,
  role: "developer" | "user",
  map: Map<string, number>,
): void {
  let text = raw;
  text = consumeTagged(text, map, "Skills", /<skills_instructions>[\s\S]*?<\/skills_instructions>/gi);
  text = consumeTagged(text, map, "Plugins", /<apps_instructions>[\s\S]*?<\/apps_instructions>/gi);
  text = consumeTagged(text, map, "Plugins", /<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi);
  text = consumeTagged(
    text,
    map,
    "Project instructions",
    /# AGENTS\.md instructions[\s\S]*?(?=\n(?:<environment_context>|=== (?:OMG|LFG) RUNTIME CONTRACT|=== USER TASK ===)|$)/gi,
  );
  // Both spellings: sessions launched before the OMG rename still carry an
  // "LFG RUNTIME CONTRACT" envelope, and they outlive the deploy that renamed it.
  text = consumeTagged(
    text,
    map,
    "Runtime instructions",
    /=== (OMG|LFG) RUNTIME CONTRACT[\s\S]*?=== END \1 RUNTIME CONTRACT ===/gi,
  );
  if (role === "user") {
    const marker = text.indexOf("=== USER TASK ===");
    if (marker >= 0) {
      addCategory(map, "Runtime instructions", text.slice(0, marker));
      text = text.slice(marker + "=== USER TASK ===".length);
    }
  }
  addCategory(map, role === "developer" ? "System prompt" : "User messages", text);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const row = part as Record<string, unknown>;
      return typeof row.text === "string" ? row.text : typeof row.content === "string" ? row.content : "";
    })
    .filter(Boolean)
    .join("\n");
}

async function parseCodexTranscript(path: string): Promise<SessionTokenUsage | null> {
  let latestTokenCount: Record<string, unknown> | null = null;
  let model: string | null = null;
  let updatedAt = 0;
  let sawDeveloperMessage = false;
  let baseInstructions = "";
  const categories = new Map<string, number>();

  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = row.payload as Record<string, unknown> | undefined;
    if (row.type === "session_meta") {
      const base = payload?.base_instructions as Record<string, unknown> | undefined;
      if (typeof base?.text === "string") baseInstructions = base.text;
    }
    if (row.type === "turn_context") {
      if (typeof payload?.model === "string") model = payload.model;
      const summary = payload?.summary;
      if (typeof summary === "string" && summary !== "auto") {
        addCategory(categories, "Compaction summary", summary);
      }
    }
    if (row.type === "event_msg" && payload?.type === "token_count" && payload.info) {
      latestTokenCount = payload.info as Record<string, unknown>;
      const timestamp = Date.parse(String(row.timestamp ?? ""));
      if (Number.isFinite(timestamp)) updatedAt = timestamp;
    }
    if (row.type !== "response_item" || !payload) continue;
    if (payload.type === "message") {
      const role = String(payload.role ?? "");
      const text = contentText(payload.content);
      if (role === "developer") {
        sawDeveloperMessage = true;
        classifyPromptText(text, "developer", categories);
      } else if (role === "user") {
        classifyPromptText(text, "user", categories);
      } else if (role === "assistant") {
        addCategory(categories, "Assistant messages", text);
      }
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      addCategory(categories, "Tool calls", payload.arguments ?? payload.input ?? "");
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      addCategory(categories, "Tool results", payload.output ?? "");
    } else if (payload.type === "reasoning") {
      addCategory(categories, "Reasoning", payload.summary ?? "");
    } else if (payload.type === "tool_search_output") {
      addCategory(categories, "Tool definitions", payload.tools ?? "");
    }
  }

  if (!latestTokenCount) return null;
  // base_instructions is also serialized as a developer response item in newer
  // Codex rollouts. Use it only as a fallback for older transcript versions.
  if (!sawDeveloperMessage && baseInstructions) {
    addCategory(categories, "System prompt", baseInstructions);
  }
  const total = latestTokenCount.total_token_usage as Record<string, unknown> | undefined;
  const last = latestTokenCount.last_token_usage as Record<string, unknown> | undefined;
  const cacheRead = num(total?.cached_input_tokens);
  // Codex reports cached input as a subset of input_tokens. Normalize the
  // cross-provider display so "Input" means newly processed input and the
  // cache row is additive instead of appearing to double-count.
  const input = Math.max(0, num(total?.input_tokens) - cacheRead);
  const output = num(total?.output_tokens);
  const reasoning = num(total?.reasoning_output_tokens);
  const currentInput = num(last?.input_tokens);
  const currentOutput = num(last?.output_tokens);
  const max = num(latestTokenCount.model_context_window) || null;
  const used = currentInput + currentOutput || null;
  const attributed = [...categories.values()].reduce((sum, value) => sum + value, 0);
  if (used != null && attributed > used) {
    // A rollout retains historical items that may have been compacted out of
    // the active prompt. Normalize recorded-source estimates back to the
    // provider-reported current context instead of showing categories whose
    // sum can exceed the window.
    const scale = used / attributed;
    for (const [name, tokens] of categories) {
      categories.set(name, Math.max(1, Math.round(tokens * scale)));
    }
  } else if (used != null && used > attributed) {
    categories.set("Other context", used - attributed);
  }

  return {
    available: true,
    source: "codex-transcript",
    accuracy: "mixed",
    updatedAt: updatedAt || Date.now(),
    model,
    context: {
      used,
      max,
      free: used != null && max != null ? Math.max(0, max - used) : null,
      percent: used != null && max != null ? (used / max) * 100 : null,
    },
    totals: {
      input,
      output,
      cacheRead,
      cacheWrite: 0,
      reasoning,
      total: num(total?.total_tokens) || input + output,
      costUsd: null,
    },
    categories: [...categories.entries()]
      .filter(([, tokens]) => tokens > 0)
      .map(([name, tokens], index) => ({
        name,
        tokens,
        color: COLORS[index % COLORS.length],
        accuracy: "estimated" as const,
      })),
    note:
      "Totals and context size are reported by Codex. Category attribution is estimated from recorded prompt structure and normalized to the current context.",
  };
}

async function parseClaudeTranscript(path: string): Promise<SessionTokenUsage | null> {
  const seen = new Set<string>();
  let latest: Record<string, unknown> | null = null;
  let model: string | null = null;
  let updatedAt = 0;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = row.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    const key = String(row.requestId ?? message?.id ?? row.uuid ?? "");
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    totals.input += num(usage.input_tokens);
    totals.output += num(usage.output_tokens);
    totals.cacheRead += num(usage.cache_read_input_tokens);
    totals.cacheWrite += num(usage.cache_creation_input_tokens);
    latest = usage;
    if (typeof message?.model === "string") model = message.model;
    const timestamp = Date.parse(String(row.timestamp ?? ""));
    if (Number.isFinite(timestamp)) updatedAt = timestamp;
  }
  if (!latest) return null;
  const currentInput =
    num(latest.input_tokens) +
    num(latest.cache_read_input_tokens) +
    num(latest.cache_creation_input_tokens);
  const currentOutput = num(latest.output_tokens);
  return {
    available: true,
    source: "claude-transcript",
    accuracy: "mixed",
    updatedAt: updatedAt || Date.now(),
    model,
    context: { used: currentInput + currentOutput, max: null, free: null, percent: null },
    totals: {
      ...totals,
      reasoning: 0,
      total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
      costUsd: null,
    },
    categories: [],
    note:
      "Token totals are reported by Claude. Detailed context categories are available for LFG-managed Claude SDK sessions.",
  };
}

export async function sessionTokenUsage(
  sessionId: string,
  transcriptPath: string | null,
): Promise<SessionTokenUsage> {
  const stored = readStoredSessionTokenUsage(sessionId);
  if (stored) return fromStored(stored);
  if (transcriptPath && !transcriptPath.startsWith("lfg://")) {
    let fingerprint: { mtimeMs: number; size: number } | null = null;
    try {
      const stat = statSync(transcriptPath);
      fingerprint = { mtimeMs: stat.mtimeMs, size: stat.size };
      const cached = transcriptCache.get(transcriptPath);
      if (
        cached &&
        cached.mtimeMs === fingerprint.mtimeMs &&
        cached.size === fingerprint.size
      ) {
        return cached.usage;
      }
    } catch {}
    const parsed = transcriptPath.includes("/.codex/")
      ? await parseCodexTranscript(transcriptPath)
      : await parseClaudeTranscript(transcriptPath);
    if (parsed) {
      if (fingerprint) {
        if (transcriptCache.size >= 100) {
          const oldest = transcriptCache.keys().next().value;
          if (oldest) transcriptCache.delete(oldest);
        }
        transcriptCache.set(transcriptPath, { ...fingerprint, usage: parsed });
      }
      return parsed;
    }
  }
  return {
    available: false,
    source: "unavailable",
    accuracy: "unavailable",
    updatedAt: Date.now(),
    model: null,
    context: { used: null, max: null, free: null, percent: null },
    totals: null,
    categories: [],
    note: "This agent does not record token usage in a format LFG can read yet.",
  };
}
