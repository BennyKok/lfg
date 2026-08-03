type TranscriptStatusMessage = {
  role?: string;
  kind?: string;
  text?: string;
};

// Claude records steering as a synthetic user turn. Keep that row in the
// transcript for ordering, but let the UI distinguish it from something the
// human actually typed.
export function isRequestInterruptedMessage(message: TranscriptStatusMessage): boolean {
  if (message.role !== "user" || message.kind !== "text") return false;
  return /^\[Request interrupted by user(?: for tool use)?\]$/i.test(message.text?.trim() || "");
}
