// The only runtime import of the AI SDK in the app, isolated in its own chunk.
//
// This module exists to be lazily imported. It holds `useChat` and nothing
// else, so `ai`, `@ai-sdk/*` and `zod` — 137 KB minified — load when a session
// is opened rather than before the session list can paint. Everything that
// reads the chat state stays in the main chunk and gets it through
// OmgChatContext.
import { useChat } from "@ai-sdk/react";
import type { ChatTransport } from "ai";
import type { ReactNode } from "react";
import { OmgChatContext } from "./chat-context";
import type { OmgChatMessage } from "./omg-chat-transport";

export default function OmgChatEngine({
  id,
  transport,
  onError,
  children,
}: {
  id: string;
  transport: ChatTransport<OmgChatMessage> | undefined;
  onError: (message: string) => void;
  children: ReactNode;
}) {
  const chat = useChat<OmgChatMessage>({
    id,
    transport,
    onError: (err) => onError(err.message),
  });
  return <OmgChatContext.Provider value={chat}>{children}</OmgChatContext.Provider>;
}
