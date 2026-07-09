// Claude Agent SDK backend for report generation — an alternative to spawning
// `claude -p` directly (see pipeToClaudeCli in ../runner.ts).
//
// This drives the same installed Claude Code CLI + subscription auth as the
// legacy CLI path, but uses the official Agent SDK `query()` surface so report
// generation no longer depends on the Vercel AI SDK Claude Code provider.

export type AiSdkOptions = {
  /** Model id: "opus" | "sonnet" | "haiku" or a full id like "claude-opus-4-8". */
  model?: string;
  /** Tools to allow (mirrors the CLI's --allowedTools). */
  allowedTools?: string[];
  /** Claude Code reasoning effort. */
  thinkingLevel?: string;
};

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Resolve the installed `claude` binary so the SDK drives it directly. */
function resolveClaudePath(): string | undefined {
  try {
    return process.env.LFG_CLAUDE_PATH ?? Bun.which("claude") ?? undefined;
  } catch {
    return undefined;
  }
}

function effortFor(level?: string): Effort | undefined {
  if (!level) return undefined;
  if (level === "none" || level === "minimal") return "low";
  if (["low", "medium", "high", "xhigh", "max"].includes(level)) {
    return level as Effort;
  }
  return undefined;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text"
    ) {
      out += String((block as { text?: unknown }).text ?? "");
    }
  }
  return out;
}

function toolStartsFromContent(content: unknown): Array<{ id?: string; name: string }> {
  if (!Array.isArray(content)) return [];
  const tools: Array<{ id?: string; name: string }> = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "tool_use"
    ) {
      const b = block as { id?: unknown; name?: unknown };
      tools.push({
        id: typeof b.id === "string" ? b.id : undefined,
        name: typeof b.name === "string" ? b.name : "?",
      });
    }
  }
  return tools;
}

export async function pipeToClaudeAiSdk(
  prompt: string,
  log: (s: string) => void,
  opts: AiSdkOptions = {},
): Promise<string> {
  const model = opts.model ?? process.env.LFG_CLAUDE_MODEL ?? "opus";
  const effort = effortFor(opts.thinkingLevel);
  const claudePath = resolveClaudePath();

  log(`[runner] piping ${prompt.length} chars to claude via ai-sdk (${model})`);

  // Lazy import so the package is only required when this backend is selected.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  if (claudePath) log(`[runner] ai-sdk driving installed binary: ${claudePath}`);

  const q = query({
    prompt,
    options: {
      model,
      permissionMode: "bypassPermissions",
      ...(opts.allowedTools !== undefined
        ? { allowedTools: opts.allowedTools, tools: opts.allowedTools }
        : { disallowedTools: ["AskUserQuestion"] }),
      settingSources: ["user", "project"],
      includePartialMessages: true,
      ...(effort ? { effort } : {}),
      // env is intentionally omitted: Agent SDK then inherits process.env,
      // including PATH/HOME/LFG_*/ANTHROPIC_*.
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
    },
  });

  let chars = 0;
  let lastEmit = 0;
  let text = "";
  let resultText = "";
  let sawPartialText = false;
  const loggedTools = new Set<string>();
  const flush = (force = false) => {
    const now = Date.now();
    if (force || now - lastEmit > 800) {
      lastEmit = now;
      const k = chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars);
      log(`[runner] generating report… ${k} chars`);
    }
  };
  const logTool = (name: string, id?: string) => {
    const key = id ?? name;
    if (loggedTools.has(key)) return;
    loggedTools.add(key);
    log(`[runner] claude running tool: ${name}`);
  };

  for await (const msg of q) {
    const m = msg as unknown as Record<string, unknown>;
    const type = m.type as string | undefined;
    if (m.parent_tool_use_id != null) continue;

    if (type === "stream_event") {
      const event = m.event as {
        type?: string;
        delta?: { type?: string; text?: string };
        content_block?: { type?: string; id?: string; name?: string };
      };
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const delta = event.delta.text ?? "";
        if (delta) {
          sawPartialText = true;
          chars += delta.length;
          flush();
        }
      } else if (
        event?.type === "content_block_start" &&
        event.content_block?.type === "tool_use"
      ) {
        logTool(event.content_block.name ?? "?", event.content_block.id);
      }
      continue;
    }

    if (type === "assistant") {
      const message = m.message as { content?: unknown } | undefined;
      for (const tool of toolStartsFromContent(message?.content)) {
        logTool(tool.name, tool.id);
      }
      const t = textFromContent(message?.content);
      if (t) {
        text += t;
        if (!sawPartialText) {
          chars += t.length;
          flush();
        }
      }
      continue;
    }

    if (type === "result") {
      const subtype = (m as { subtype?: unknown }).subtype;
      if (subtype !== "success") {
        const errors = Array.isArray((m as { errors?: unknown }).errors)
          ? ((m as { errors: unknown[] }).errors).map(String).join("; ")
          : "";
        throw new Error(
          `ai-sdk stream error: ${String(errors || subtype || "unknown").slice(0, 800)}`,
        );
      }
      resultText = String((m as { result?: unknown }).result ?? "");
    }
  }

  if (!text && resultText) text = resultText;
  flush(true);
  if (!text || !text.trim()) {
    throw new Error("ai-sdk backend produced empty result");
  }
  log(`[runner] ai-sdk done (${text.length} chars)`);
  return text;
}
