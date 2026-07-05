// ─────────────────────────────────────────────────────────────────────────────
// ElevenLabs managed-agent voice connector (Option B, frontend side).
//
// Replaces the LiveKit voice path with ElevenLabs' managed agent: ElevenLabs
// owns mic capture, STT (Scribe), turn-taking and TTS in the browser; our box
// stays the brain via the custom-LLM endpoint (src/voice-eleven-llm.ts).
//
// Per-user scoping: we pass the speaking user's id (the `lfg_user` email in
// localStorage, same value the LiveKit orb published as `lfg.user`) through
// `customLlmExtraBody`, which ElevenLabs forwards to our /v1/chat/completions as
// `elevenlabs_extra_body.user_id`. The brain scopes every fleet read/action to
// that user.
//
// This module is intentionally standalone so it can be mounted next to (or in
// place of) the existing VoiceOrb without touching that shared component until
// we cut over.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useRef, useState } from "react";
// Type-only: erased at build time. @elevenlabs/client statically pulls in the
// entire livekit-client SDK (~1 MB), so importing it as a value here dragged
// livekit into the first-paint bundle (and duplicated the copy voice-orb already
// lazy-loads). We import the *value* dynamically inside startElevenVoice below,
// so nothing voice-related loads until a call actually starts.
import type { Conversation } from "@elevenlabs/client";

export type ElevenStatus = "idle" | "connecting" | "connected" | "error";

export type ElevenHandle = Awaited<ReturnType<typeof Conversation.startSession>>;

function currentUser(): string {
  try {
    const u = localStorage.getItem("lfg_user") || "";
    return u && u !== "__all" ? u : "";
  } catch {
    return "";
  }
}

export type StartOpts = {
  onStatus?: (s: ElevenStatus) => void;
  onUserTranscript?: (text: string) => void;
  onAgentReply?: (text: string) => void;
  // SDK turn mode: "speaking" = agent is talking, "listening" = mic is open.
  // Drives the orb animation.
  onMode?: (mode: "speaking" | "listening") => void;
  onError?: (e: unknown) => void;
};

// Open a managed-agent voice session. Returns the live Conversation handle (call
// `.endSession()` to hang up).
export async function startElevenVoice(opts: StartOpts = {}): Promise<ElevenHandle> {
  opts.onStatus?.("connecting");

  // Mint a per-connect WebRTC token server-side (the API key never reaches the
  // browser). Backend reads the agent id from data/eleven-agent.json.
  const res = await fetch("/api/voice/eleven-token");
  if (!res.ok) throw new Error(`token mint failed (${res.status})`);
  const { token, agentId } = (await res.json()) as {
    token?: string;
    agentId?: string;
  };
  if (!token) throw new Error("no conversation token returned");

  const userId = currentUser();

  // Value import happens here (dynamic) so livekit/elevenlabs only download when
  // the user actually starts a voice session.
  const { Conversation } = await import("@elevenlabs/client");

  const conversation = await Conversation.startSession({
    conversationToken: token,
    connectionType: "webrtc",
    // → our custom LLM sees this as elevenlabs_extra_body.user_id and scopes
    // the fleet to the speaking user.
    customLlmExtraBody: { user_id: userId },
    // Also expose it as a dynamic variable (defaults / future server tools).
    dynamicVariables: { user_id: userId },
    onConnect: () => opts.onStatus?.("connected"),
    onDisconnect: () => opts.onStatus?.("idle"),
    onModeChange: (m: { mode: "speaking" | "listening" }) =>
      opts.onMode?.(m.mode),
    onError: (e: unknown) => {
      opts.onStatus?.("error");
      opts.onError?.(e);
    },
    onMessage: (m: { source?: string; message?: string }) => {
      // source 'user' = recognized speech, 'ai' = the agent's spoken reply.
      if (m?.source === "user" && m.message) opts.onUserTranscript?.(m.message);
      if (m?.source === "ai" && m.message) opts.onAgentReply?.(m.message);
    },
  });

  void agentId; // available if a caller wants to display which agent answered
  return conversation;
}

// Thin React hook wrapper: start()/stop() + live status + last transcripts.
export function useElevenVoice() {
  const [status, setStatus] = useState<ElevenStatus>("idle");
  const [userText, setUserText] = useState("");
  const [agentText, setAgentText] = useState("");
  const handleRef = useRef<ElevenHandle | null>(null);

  const start = useCallback(async () => {
    if (handleRef.current) return;
    try {
      handleRef.current = await startElevenVoice({
        onStatus: setStatus,
        onUserTranscript: setUserText,
        onAgentReply: setAgentText,
        onError: (e) => console.error("[eleven-voice]", e),
      });
    } catch (e) {
      console.error("[eleven-voice] start failed", e);
      setStatus("error");
    }
  }, []);

  const stop = useCallback(async () => {
    const h = handleRef.current;
    handleRef.current = null;
    setStatus("idle");
    try {
      await h?.endSession();
    } catch {
      /* already gone */
    }
  }, []);

  return { status, userText, agentText, start, stop };
}
