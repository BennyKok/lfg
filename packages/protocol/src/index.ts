export type OmgSessionStatus =
  | "ok"
  | "blocked";

export type OmgSessionStatusReason =
  | "model_unavailable"
  | "out_of_credits"
  | "provider_auth"
  | "provider_error"
  | null;

export interface OmgSession {
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
  status?: OmgSessionStatus;
  statusReason?: OmgSessionStatusReason;
  statusDetail?: string | null;
  busy?: boolean;
}

export interface OmgMessage {
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

export interface OmgAiStreamPart {
  type: "text-delta" | "text-start" | "text-end" | "error" | string;
  id?: string;
  delta?: string;
  text?: string;
  reset?: boolean;
  ts?: number;
}

export interface OmgPromptOption {
  index: number;
  label: string;
  selected?: boolean;
}

export interface OmgSessionPrompt {
  question?: string;
  options: OmgPromptOption[];
}

export interface OmgQueueMessage {
  id: string;
  text: string;
  status: "pending" | "sending" | "queued" | "failed" | "delivered";
  error?: string;
}

export type OmgLiveChannelKind =
  | "transcript"
  | "status"
  | "agent_run";

export interface OmgLiveChannel {
  kind: OmgLiveChannelKind;
  key: string;
  resumeFromSeq?: number;
}

export interface OmgStatusRow {
  sessionId: string | null;
  busy?: boolean;
  title?: string | null;
  lastUserText?: string | null;
  lastActivityAt?: number | null;
  status?: OmgSessionStatus;
  statusReason?: OmgSessionStatusReason;
  statusDetail?: string | null;
  model?: string | null;
}

export type OmgLiveMessage =
  | { t: "batch"; sid: string; messages?: OmgMessage[]; nextBefore?: number | null }
  | { t: "msg"; sid: string; message?: OmgMessage; m?: OmgMessage }
  | { t: "ai_part"; sid: string; part?: OmgAiStreamPart }
  | { t: "queue"; sid: string; queue?: OmgQueueMessage[] }
  | { t: "busy"; sid: string; busy?: boolean }
  | { t: "prompt"; sid: string; prompt?: OmgSessionPrompt | null }
  | {
      t: "snapshot";
      kind: OmgLiveChannelKind;
      key: string;
      sid?: string;
      seq?: number;
      messages?: OmgMessage[];
      nextBefore?: number | null;
    }
  | {
      t: "delta";
      kind: OmgLiveChannelKind;
      key: string;
      seq?: number;
      delta?: {
        t?: string;
        sid?: string;
        message?: OmgMessage;
        m?: OmgMessage;
        part?: OmgAiStreamPart;
        busy?: boolean;
        prompt?: OmgSessionPrompt | null;
        queue?: OmgQueueMessage[];
      };
    }
  | { t: "resumed"; kind: OmgLiveChannelKind; key: string; seq?: number; fromSeq?: number; toSeq?: number; replayed?: number }
  | { t: "gap"; kind: OmgLiveChannelKind; key: string; seq?: number }
  | { t: "status"; rows?: OmgStatusRow[]; kind?: OmgLiveChannelKind; key?: string; seq?: number }
  | { t: "ping"; id?: string }
  | { t: "pong"; id?: string }
  | { t: "error"; sid?: string; kind?: OmgLiveChannelKind; key?: string; seq?: number; message?: string; code?: string };

export interface OmgSessionsResponse {
  sessions: OmgSession[];
}

export interface OmgMessagesResponse {
  messages: OmgMessage[];
  nextBefore?: number | null;
}

export interface OmgSendResponse {
  msg?: OmgQueueMessage;
}

export type OmgTranscriptEvent =
  | { type: "snapshot"; messages: OmgMessage[]; nextBefore: number | null }
  | { type: "message"; message: OmgMessage }
  | { type: "ai_part"; part: OmgAiStreamPart }
  | { type: "busy"; busy: boolean }
  | { type: "prompt"; prompt: OmgSessionPrompt | null }
  | { type: "error"; error: string };
