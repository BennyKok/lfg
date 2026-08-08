export type TranscriptView = "full" | "user-lfg-output";

export type TranscriptViewMessage = {
  id?: string | null;
  role?: string;
  kind?: string;
  text?: string;
  ts?: number | null;
};

function toolName(text?: string): string {
  return (text || "").split(":")[0].trim().split(/\s+/)[0] || "";
}

export function isOmgOutputTool(message: TranscriptViewMessage): boolean {
  if (message.kind !== "tool_use") return false;
  const name = toolName(message.text);
  return name === "lfg_output" || name.endsWith("__lfg_output");
}

function omgOutputText(message: TranscriptViewMessage): string | null {
  const raw = message.text || "";
  const separator = raw.indexOf(":");
  if (separator < 0) return null;
  try {
    const input = JSON.parse(raw.slice(separator + 1).trim()) as { text?: unknown };
    return typeof input.text === "string" && input.text.trim() ? input.text.trim() : null;
  } catch {
    return null;
  }
}

// The focused experimental view is deliberately a render-only projection. The
// full transcript remains loaded and cached so switching views is instant and
// live tool state/history are never discarded.
export function messagesForTranscriptView<T extends TranscriptViewMessage>(
  messages: T[],
  view: TranscriptView,
): T[] {
  if (view === "full") return messages;

  return messages.flatMap((message) => {
    if (message.role === "user") return [message];
    if (message.kind === "image" || message.kind === "video" || message.kind === "html") {
      return [message];
    }
    if (!isOmgOutputTool(message)) return [];

    const text = omgOutputText(message);
    if (!text) return [];
    return [{
      ...message,
      id: message.id ? `${message.id}:display` : message.id,
      role: "assistant",
      kind: "text",
      text,
    }];
  });
}
