// The only runtime import of the AI SDK in the app, isolated in its own chunk.
//
// This module exists to be lazily imported. It holds `useChat` and nothing
// else, so `ai`, `@ai-sdk/*` and `zod` — 137 KB minified — load when a session
// is opened rather than before the session list can paint. Everything that
// reads the chat state stays in the main chunk and gets it through
// LfgChatContext.
import { useChat } from "@ai-sdk/react";
import type { ChatTransport } from "ai";
import type { ReactNode } from "react";
import { LfgChatContext } from "./chat-context";
import type { LfgChatMessage } from "./lfg-chat-transport";

export default function LfgChatEngine({
  id,
  transport,
  onError,
  children,
}: {
  id: string;
  transport: ChatTransport<LfgChatMessage> | undefined;
  onError: (message: string) => void;
  children: ReactNode;
}) {
  const chat = useChat<LfgChatMessage>({
    id,
    transport,
    onError: (err) => onError(err.message),
  });
  return <LfgChatContext.Provider value={chat}>{children}</LfgChatContext.Provider>;
}
