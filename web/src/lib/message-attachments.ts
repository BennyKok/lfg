/**
 * User attachments travel to the agent as text.
 *
 * The composer uploads a file, gets back an absolute path on the server, and
 * appends an "Attached file(s):" block to the message (see
 * `composeAttachmentMessage`) — coding agents read local paths, so that block
 * is the delivery mechanism and has to stay in the text the agent receives.
 *
 * It reads terribly in the transcript, though: a screenshot the user dragged in
 * showed up as a line of `/tmp/lfg-uploads/new-session-…-IMG_0850.png`. This
 * module splits that block back off the message so the bubble can render the
 * images themselves and show only what the user actually typed.
 */

export type MessageAttachment = {
  name: string;
  path: string;
  /** Transcript URL for the persisted bytes, or `null` when not displayable. */
  url: string | null;
};

export type ParsedMessageText = {
  /** The message with the attachment block removed. */
  body: string;
  attachments: MessageAttachment[];
};

// Matches the trailing block `composeAttachmentMessage` appends. Anchored to
// the end so an "Attached files:" the user typed mid-message is left alone.
const ATTACHMENT_BLOCK = /(?:^|\n\n)Attached files?:\n((?:-[^\n]*(?:\n|$))+)$/;

// `- <name>: <path>`. The name is greedy so a colon inside the *name* (rare but
// legal) still splits on the final ": /" that starts the absolute path.
const ATTACHMENT_LINE = /^- (.*): (\/\S.*?)\s*$/;

// The directory `persistUpload` writes into. Only files that live there are
// servable, so anything else (a path the user typed by hand) stays as text.
const UPLOAD_DIR_MARKER = "/lfg-uploads/";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

function fileExtension(path: string): string {
  const leaf = path.split("/").pop() || "";
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(dot + 1).toLowerCase() : "";
}

export function isDisplayableAttachment(path: string): boolean {
  return path.includes(UPLOAD_DIR_MARKER) && IMAGE_EXTENSIONS.has(fileExtension(path));
}

/**
 * The transcript URL for an uploaded file. Uploads live in the server's tmpdir
 * rather than the artifact store, and the browser doesn't know what that
 * directory is, so the endpoint takes the basename and resolves it server-side.
 */
export function uploadRequestPath(path: string): string {
  const name = path.split("/").pop() || "";
  return `/api/uploads/${encodeURIComponent(name)}`;
}

export function parseMessageAttachments(text: string): ParsedMessageText {
  if (!text || !text.includes("Attached file")) return { body: text, attachments: [] };

  const match = text.match(ATTACHMENT_BLOCK);
  if (!match) return { body: text, attachments: [] };

  const lines = match[1]!.split("\n").filter((line) => line.trim().length > 0);
  const attachments: MessageAttachment[] = [];
  for (const line of lines) {
    const parsed = line.match(ATTACHMENT_LINE);
    // A block we can't fully account for is left in the text rather than
    // partially hidden — better a path on screen than a silently dropped line.
    if (!parsed) return { body: text, attachments: [] };
    const name = parsed[1]!.trim();
    const path = parsed[2]!;
    attachments.push({
      name: name || path.split("/").pop() || "attachment",
      path,
      url: isDisplayableAttachment(path) ? uploadRequestPath(path) : null,
    });
  }
  if (!attachments.length) return { body: text, attachments: [] };

  return { body: text.slice(0, match.index).trimEnd(), attachments };
}
