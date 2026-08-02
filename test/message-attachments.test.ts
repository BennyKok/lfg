import { expect, test } from "bun:test";
import {
  isDisplayableAttachment,
  parseMessageAttachments,
  uploadRequestPath,
} from "../web/src/lib/message-attachments";

const UPLOAD = "/tmp/lfg-uploads/new-session-3effbb22-4b4b-49a6-CleanShot.png";

test("splits a single attachment off the typed message", () => {
  const parsed = parseMessageAttachments(
    `can you spot my user complains?\n\nAttached file:\n- CleanShot 2026-08-02 at 18.59.11.png: ${UPLOAD}`,
  );
  expect(parsed.body).toBe("can you spot my user complains?");
  expect(parsed.attachments).toEqual([
    {
      name: "CleanShot 2026-08-02 at 18.59.11.png",
      path: UPLOAD,
      url: "/api/uploads/new-session-3effbb22-4b4b-49a6-CleanShot.png",
    },
  ]);
});

test("splits multiple attachments and an empty body", () => {
  const parsed = parseMessageAttachments(
    `Attached files:\n- a.png: /tmp/lfg-uploads/s-a.png\n- b.png: /tmp/lfg-uploads/s-b.png\n`,
  );
  expect(parsed.body).toBe("");
  expect(parsed.attachments.map((a) => a.name)).toEqual(["a.png", "b.png"]);
  expect(parsed.attachments.every((a) => a.url)).toBe(true);
});

test("keeps non-displayable attachments listed but without a url", () => {
  const parsed = parseMessageAttachments(
    "here\n\nAttached file:\n- notes.pdf: /tmp/lfg-uploads/s-notes.pdf",
  );
  expect(parsed.body).toBe("here");
  expect(parsed.attachments[0]).toEqual({
    name: "notes.pdf",
    path: "/tmp/lfg-uploads/s-notes.pdf",
    url: null,
  });
});

test("a path outside the uploads dir is not servable", () => {
  const parsed = parseMessageAttachments(
    "look\n\nAttached file:\n- shot.png: /home/dev/secrets/shot.png",
  );
  expect(parsed.attachments[0]!.url).toBeNull();
  expect(isDisplayableAttachment("/etc/passwd.png")).toBe(false);
});

test("leaves prose that merely mentions attachments untouched", () => {
  const text = "Attached files: are broken, see the Attached file: note above";
  expect(parseMessageAttachments(text)).toEqual({ body: text, attachments: [] });
});

test("leaves a block it cannot fully parse as text", () => {
  const text = "hi\n\nAttached files:\n- a.png: /tmp/lfg-uploads/s-a.png\n- mystery line";
  expect(parseMessageAttachments(text)).toEqual({ body: text, attachments: [] });
});

test("only strips a trailing block, not one the user quoted mid-message", () => {
  const text = `Attached file:\n- a.png: /tmp/lfg-uploads/s-a.png\n\nwhat is this?`;
  expect(parseMessageAttachments(text)).toEqual({ body: text, attachments: [] });
});

test("upload request path url-encodes the basename", () => {
  expect(uploadRequestPath("/tmp/lfg-uploads/a b.png")).toBe("/api/uploads/a%20b.png");
});
