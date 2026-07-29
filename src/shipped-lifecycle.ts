// Publishing a result and closing its source session are separate lifecycle
// decisions. MCP callers must choose explicitly; older/direct HTTP callers
// that omit the field get the safe behavior and leave the session running.

const REQUIRED_DECISION_ERROR =
  "Choose whether to close the session after posting: pass closeSession: true only when the conversation is genuinely finished, or false to keep it open.";

export function shippedCloseDecision(
  value: unknown,
  options: { required?: boolean } = {},
): boolean {
  if (value === true || value === false) return value;
  if (options.required) throw new Error(REQUIRED_DECISION_ERROR);
  return false;
}
