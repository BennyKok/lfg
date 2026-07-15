export type ChatRenderMessage = {
  id?: string | null;
  kind?: string;
  text?: string;
  ts?: number | null;
};

export type ChatRenderItem<T extends ChatRenderMessage> =
  | { type: "msg"; message: T; key: string }
  | { type: "tools"; items: T[]; key: string }
  | { type: "artifact_tool"; tool: T; message: T; key: string };

export function toolName(text?: string): string {
  // tool_use text is "Name" or "Name: <input>" — the first token is the tool.
  return (text || "").split(":")[0].trim().split(/\s+/)[0] || "tool";
}

export function toolGroupLabel(items: ChatRenderMessage[]): string {
  const counts = new Map<string, number>();
  let results = 0;
  for (const message of items) {
    if (message.kind === "tool_use") {
      const name = toolName(message.text);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    } else {
      results += 1;
    }
  }
  const parts = [...counts].map(([name, count]) => `${count} ${name}`);
  if (results) parts.push(`${results} result${results === 1 ? "" : "s"}`);
  return parts.join(" · ") || `${items.length} step${items.length === 1 ? "" : "s"}`;
}

function artifactKindForTool(message: ChatRenderMessage): "image" | "video" | "html" | null {
  if (message.kind !== "tool_use") return null;
  const name = toolName(message.text);
  if (name === "lfg_display_image" || name.endsWith("__lfg_display_image")) return "image";
  if (name === "lfg_display_video" || name.endsWith("__lfg_display_video")) return "video";
  if (name === "lfg_publish_artifact" || name.endsWith("__lfg_publish_artifact")) return "html";
  return null;
}

function messageKey(message: ChatRenderMessage, index: number): string {
  return message.id ?? `${message.kind}-${message.ts}-${index}`;
}

// Display/publish tools already have a purpose-built visual result. Pair the
// synthetic artifact message with its immediately preceding LFG tool call so
// the generic tool pill does not render separately from (or drift away from)
// the image/video/dashboard it produced. Standalone artifacts remain ordinary
// messages, which is important for old transcripts and live artifact updates.
export function buildChatRenderItems<T extends ChatRenderMessage>(messages: T[]): ChatRenderItem<T>[] {
  const items: ChatRenderItem<T>[] = [];
  messages.forEach((message, index) => {
    const isTool = message.kind === "tool_use" || message.kind === "tool_result";
    if (isTool) {
      const last = items[items.length - 1];
      if (last?.type === "tools") {
        last.items.push(message);
        return;
      }
      items.push({ type: "tools", items: [message], key: messageKey(message, index) });
      return;
    }

    if (message.kind === "image" || message.kind === "video" || message.kind === "html") {
      const last = items[items.length - 1];
      if (last?.type === "tools") {
        const tool = last.items[last.items.length - 1];
        if (artifactKindForTool(tool) === message.kind) {
          last.items.pop();
          if (!last.items.length) items.pop();
          items.push({
            type: "artifact_tool",
            tool,
            message,
            key: message.id ?? tool.id ?? `artifact-tool-${message.ts}-${index}`,
          });
          return;
        }
      }
    }

    items.push({ type: "msg", message, key: messageKey(message, index) });
  });
  return items;
}
