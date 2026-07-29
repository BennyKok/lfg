export const PROMPT_STASH_STORAGE_KEY = "lfg_prompt_stash_v1";
export const PROMPT_STASH_EVENT = "lfg:prompt-stash-change";

const MAX_STASH_ITEMS = 80;

export type PromptStashStatus = "draft" | "sending" | "sent" | "failed";
export type PromptStashSource = "new-session" | "session";

export type PromptStashEntry = {
  id: string;
  contextKey: string;
  source: PromptStashSource;
  text: string;
  status: PromptStashStatus;
  sessionId?: string;
  sessionTitle?: string;
  project?: string;
  createdAt: number;
  updatedAt: number;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

type PromptStashInput = {
  contextKey: string;
  source: PromptStashSource;
  text: string;
  sessionId?: string;
  sessionTitle?: string;
  project?: string;
};

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function notifyChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PROMPT_STASH_EVENT));
}

function validEntry(value: unknown): value is PromptStashEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PromptStashEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.contextKey === "string" &&
    (entry.source === "new-session" || entry.source === "session") &&
    typeof entry.text === "string" &&
    ["draft", "sending", "sent", "failed"].includes(entry.status ?? "") &&
    typeof entry.createdAt === "number" &&
    typeof entry.updatedAt === "number"
  );
}

function writePromptStash(entries: PromptStashEntry[], storage: StorageLike | null) {
  if (!storage) return;
  try {
    storage.setItem(
      PROMPT_STASH_STORAGE_KEY,
      JSON.stringify(
        entries
          .filter((entry) => entry.text.trim())
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, MAX_STASH_ITEMS),
      ),
    );
    notifyChanged();
  } catch {
    // Draft recovery is best-effort. A full/disabled localStorage must never
    // prevent the composer itself from accepting or sending a prompt.
  }
}

function makeId(now: number) {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `stash-${now}-${random}`;
}

export function readPromptStash(
  storage: StorageLike | null = browserStorage(),
): PromptStashEntry[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(PROMPT_STASH_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validEntry).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function readPromptDraft(
  contextKey: string,
  storage: StorageLike | null = browserStorage(),
): PromptStashEntry | null {
  return (
    readPromptStash(storage).find(
      (entry) => entry.contextKey === contextKey && entry.status === "draft",
    ) ?? null
  );
}

export function stashPromptDraft(
  input: PromptStashInput,
  storage: StorageLike | null = browserStorage(),
): PromptStashEntry | null {
  if (!storage) return null;
  const text = input.text;
  const entries = readPromptStash(storage);
  const existingIndex = entries.findIndex(
    (entry) => entry.contextKey === input.contextKey && entry.status === "draft",
  );

  if (!text.trim()) {
    if (existingIndex >= 0) {
      entries.splice(existingIndex, 1);
      writePromptStash(entries, storage);
    }
    return null;
  }

  const now = Date.now();
  const existing = existingIndex >= 0 ? entries[existingIndex] : null;
  const next: PromptStashEntry = {
    id: existing?.id ?? makeId(now),
    contextKey: input.contextKey,
    source: input.source,
    text,
    status: "draft",
    sessionId: input.sessionId,
    sessionTitle: input.sessionTitle,
    project: input.project,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existingIndex >= 0) entries[existingIndex] = next;
  else entries.unshift(next);
  writePromptStash(entries, storage);
  return next;
}

export function stagePromptSend(
  input: PromptStashInput,
  storage: StorageLike | null = browserStorage(),
): PromptStashEntry | null {
  if (!storage || !input.text.trim()) return null;
  const entries = readPromptStash(storage);
  const draftIndex = entries.findIndex(
    (entry) => entry.contextKey === input.contextKey && entry.status === "draft",
  );
  const now = Date.now();
  const draft = draftIndex >= 0 ? entries[draftIndex] : null;
  const next: PromptStashEntry = {
    id: draft?.id ?? makeId(now),
    contextKey: input.contextKey,
    source: input.source,
    text: input.text,
    status: "sending",
    sessionId: input.sessionId,
    sessionTitle: input.sessionTitle,
    project: input.project,
    createdAt: draft?.createdAt ?? now,
    updatedAt: now,
  };
  if (draftIndex >= 0) entries[draftIndex] = next;
  else entries.unshift(next);
  writePromptStash(entries, storage);
  return next;
}

export function setPromptStashStatus(
  id: string | undefined,
  status: PromptStashStatus,
  storage: StorageLike | null = browserStorage(),
) {
  if (!id || !storage) return;
  const entries = readPromptStash(storage);
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  entries[index] = { ...entries[index], status, updatedAt: Date.now() };
  writePromptStash(entries, storage);
}

export function removePromptStash(
  id: string,
  storage: StorageLike | null = browserStorage(),
) {
  if (!storage) return;
  writePromptStash(
    readPromptStash(storage).filter((entry) => entry.id !== id),
    storage,
  );
}

export function clearPromptStash(storage: StorageLike | null = browserStorage()) {
  if (!storage) return;
  writePromptStash([], storage);
}
