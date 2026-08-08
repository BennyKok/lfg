export type OmgPromptEnvelope = {
  instructions: string;
  task: string;
  version: string | null;
};

// The envelope was branded "LFG" before the rename. Both spellings must parse
// forever: every transcript recorded before the rebrand still opens with the old
// header, and those messages are re-rendered every time the session is opened.
// Recognising only the new one would regress them to showing the raw contract.
const CONTRACT_HEADERS = ["=== OMG RUNTIME CONTRACT", "=== LFG RUNTIME CONTRACT"] as const;
const CONTRACT_ENDS = ["=== END OMG RUNTIME CONTRACT ===", "=== END LFG RUNTIME CONTRACT ==="] as const;
const USER_TASK = "=== USER TASK ===";

/**
 * Splits OMG's agent-facing launch envelope for presentation only.
 *
 * The complete text remains in the transcript and is still sent to the agent;
 * callers use this projection to keep the user's actual first message readable.
 */
export function parseOmgPromptEnvelope(text: string): OmgPromptEnvelope | null {
  const header = CONTRACT_HEADERS.find((candidate) => text.startsWith(candidate));
  if (!header) return null;

  const headerEnd = text.indexOf("\n");
  if (headerEnd < 0) return null;

  // Pair the end marker to whichever spelling opened the envelope, but accept
  // either: a prompt resumed across the rename can legitimately be mixed.
  let contractEnd = -1;
  let endMarker = "";
  for (const candidate of CONTRACT_ENDS) {
    const at = text.indexOf(candidate, headerEnd + 1);
    if (at < 0) continue;
    if (contractEnd < 0 || at < contractEnd) {
      contractEnd = at;
      endMarker = candidate;
    }
  }
  if (contractEnd < 0) return null;

  const taskMarker = text.indexOf(USER_TASK, contractEnd + endMarker.length);
  if (taskMarker < 0) return null;

  const headerLine = text.slice(0, headerEnd);
  const version = headerLine.match(/\(capability version ([^)]+)\)/)?.[1] ?? null;
  const instructions = text.slice(headerEnd + 1, contractEnd).trim();
  const task = text.slice(taskMarker + USER_TASK.length).replace(/^\s*\n?/, "").trim();

  if (!instructions || !task) return null;
  return { instructions, task, version };
}
