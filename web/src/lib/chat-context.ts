// The seam between the app shell and the AI SDK.
//
// `useChat` is the only runtime import of @ai-sdk/react in the app, and it
// drags `ai`, `@ai-sdk/*` and `zod` with it — 137 KB minified, 12.5% of the
// entry chunk, none of it needed to paint the session list. Keeping the context
// here, in a module with no runtime dependency on the SDK, is what lets the
// chat surface stay in the entry chunk while the engine that calls the hook
// loads lazily beside it.
//
// The import below is type-only, so it is erased at build time and pulls
// nothing into this chunk.
import { createContext, useContext } from "react";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { OmgChatMessage } from "./omg-chat-transport";

export type OmgChat = UseChatHelpers<OmgChatMessage>;

export const OmgChatContext = createContext<OmgChat | null>(null);

/**
 * The chat state for the surrounding session, from the lazily-loaded engine.
 *
 * Throws rather than returning null: every consumer renders as a child of the
 * engine's Suspense boundary, so a null here means the tree was assembled
 * wrong, and a silent undefined would surface much later as an empty chat.
 */
export function useOmgChat(): OmgChat {
  const chat = useContext(OmgChatContext);
  if (!chat) throw new Error("useOmgChat must be rendered inside the chat engine");
  return chat;
}
