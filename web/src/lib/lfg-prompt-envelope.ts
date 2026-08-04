export type LfgPromptEnvelope = {
  instructions: string;
  task: string;
  version: string | null;
};

const CONTRACT_HEADER = "=== LFG RUNTIME CONTRACT";
const CONTRACT_END = "=== END LFG RUNTIME CONTRACT ===";
const USER_TASK = "=== USER TASK ===";

/**
 * Splits LFG's agent-facing launch envelope for presentation only.
 *
 * The complete text remains in the transcript and is still sent to the agent;
 * callers use this projection to keep the user's actual first message readable.
 */
export function parseLfgPromptEnvelope(text: string): LfgPromptEnvelope | null {
  if (!text.startsWith(CONTRACT_HEADER)) return null;

  const headerEnd = text.indexOf("\n");
  if (headerEnd < 0) return null;
  const contractEnd = text.indexOf(CONTRACT_END, headerEnd + 1);
  if (contractEnd < 0) return null;

  const taskMarker = text.indexOf(USER_TASK, contractEnd + CONTRACT_END.length);
  if (taskMarker < 0) return null;

  const header = text.slice(0, headerEnd);
  const version = header.match(/\(capability version ([^)]+)\)/)?.[1] ?? null;
  const instructions = text.slice(headerEnd + 1, contractEnd).trim();
  const task = text.slice(taskMarker + USER_TASK.length).replace(/^\s*\n?/, "").trim();

  if (!instructions || !task) return null;
  return { instructions, task, version };
}
