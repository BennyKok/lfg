export type LfgSessionStatus =
  | "ok"
  | "blocked";

export type LfgSessionStatusReason =
  | "model_unavailable"
  | "out_of_credits"
  | "provider_auth"
  | "provider_error"
  | null;

export interface LfgSession {
  agent?: string;
  agentLabel?: string | null;
  pid?: number;
  cmd?: string;
  cwd?: string;
  project?: string;
  title?: string | null;
  lastUserText?: string | null;
  sessionId: string | null;
  nativeSessionId?: string | null;
  startedAt?: number | null;
  lastActivityAt?: number | null;
  last?: { role?: string; kind?: string; text?: string; ts?: number };
  tmuxTarget?: string | null;
  tmuxName?: string | null;
  managed?: boolean;
  assignedUser?: string | null;
  model?: string | null;
  parentSessionId?: string | null;
  parentNativeSessionId?: string | null;
  parentAgent?: string | null;
  spawnedBy?: string | null;
  capabilityVersion?: string | null;
  capabilitiesStale?: boolean;
  status?: LfgSessionStatus;
  statusReason?: LfgSessionStatusReason;
  statusDetail?: string | null;
  busy?: boolean;
}

export interface LfgMessage {
  id?: string;
  role?: string;
  kind?: string;
  text?: string;
  html?: string;
  ts?: number;
  url?: string;
  artifactId?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  caption?: string;
  alt?: string;
  version?: number;
  title?: string;
  pending?: boolean;
  seed?: boolean;
  catchUp?: boolean;
}

export interface LfgAiStreamPart {
  type: "text-delta" | "text-start" | "text-end" | "error" | string;
  id?: string;
  delta?: string;
  text?: string;
  reset?: boolean;
  ts?: number;
}

export interface LfgPromptOption {
  index: number;
  label: string;
  selected?: boolean;
}

export interface LfgSessionPrompt {
  question?: string;
  options: LfgPromptOption[];
}

export interface LfgQueueMessage {
  id: string;
  text: string;
  status: "pending" | "sending" | "queued" | "failed" | "delivered";
  error?: string;
}

export type LfgLiveChannelKind =
  | "transcript"
  | "status"
  | "agent_run";

export interface LfgLiveChannel {
  kind: LfgLiveChannelKind;
  key: string;
  resumeFromSeq?: number;
}

export interface LfgStatusRow {
  sessionId: string | null;
  busy?: boolean;
  title?: string | null;
  lastUserText?: string | null;
  lastActivityAt?: number | null;
  status?: LfgSessionStatus;
  statusReason?: LfgSessionStatusReason;
  statusDetail?: string | null;
  model?: string | null;
}

export type LfgLiveMessage =
  | { t: "batch"; sid: string; messages?: LfgMessage[]; nextBefore?: number | null }
  | { t: "msg"; sid: string; message?: LfgMessage; m?: LfgMessage }
  | { t: "ai_part"; sid: string; part?: LfgAiStreamPart }
  | { t: "queue"; sid: string; queue?: LfgQueueMessage[] }
  | { t: "busy"; sid: string; busy?: boolean }
  | { t: "prompt"; sid: string; prompt?: LfgSessionPrompt | null }
  | {
      t: "snapshot";
      kind: LfgLiveChannelKind;
      key: string;
      sid?: string;
      seq?: number;
      messages?: LfgMessage[];
      nextBefore?: number | null;
    }
  | {
      t: "delta";
      kind: LfgLiveChannelKind;
      key: string;
      seq?: number;
      delta?: {
        t?: string;
        sid?: string;
        message?: LfgMessage;
        m?: LfgMessage;
        part?: LfgAiStreamPart;
        busy?: boolean;
        prompt?: LfgSessionPrompt | null;
        queue?: LfgQueueMessage[];
      };
    }
  | { t: "resumed"; kind: LfgLiveChannelKind; key: string; seq?: number; fromSeq?: number; toSeq?: number; replayed?: number }
  | { t: "gap"; kind: LfgLiveChannelKind; key: string; seq?: number }
  | { t: "status"; rows?: LfgStatusRow[]; kind?: LfgLiveChannelKind; key?: string; seq?: number }
  | { t: "ping"; id?: string }
  | { t: "pong"; id?: string }
  | { t: "error"; sid?: string; kind?: LfgLiveChannelKind; key?: string; seq?: number; message?: string; code?: string };

export interface LfgSessionsResponse {
  sessions: LfgSession[];
}

export interface LfgMessagesResponse {
  messages: LfgMessage[];
  nextBefore?: number | null;
}

export interface LfgSendResponse {
  msg?: LfgQueueMessage;
}

export type LfgTranscriptEvent =
  | { type: "snapshot"; messages: LfgMessage[]; nextBefore: number | null }
  | { type: "message"; message: LfgMessage }
  | { type: "ai_part"; part: LfgAiStreamPart }
  | { type: "busy"; busy: boolean }
  | { type: "prompt"; prompt: LfgSessionPrompt | null }
  | { type: "error"; error: string };
