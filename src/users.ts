// Lightweight multi-user tagging for sessions. There's no auth — this is a
// personal Tailscale tool — it's just a way to split the session list between
// people sharing the box. The *current* user is a per-browser choice
// (localStorage, picked on first visit); the session→user assignments live here
// server-side so they're shared across tabs/devices.
//
// Assignments are keyed by the tmux session NAME, not the sessionId: the name
// is stable, while /clear rotates the sessionId — keying on the name keeps a
// tag attached to the same terminal across clears.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { PATHS } from "./config.ts";
import { onboardingProfilesSync } from "./onboarding.ts";

// Roster config. Each LFG_USERS entry is `email` or `email:displayname` — the
// optional name is what the UI shows (raw emails are hard to scan). Parse once
// into the email list (USERS, kept as plain strings so USERS[0] / .includes()
// callers stay unchanged) plus an email→name map.
const ROSTER = (process.env.LFG_USERS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const i = entry.indexOf(":");
    return i === -1
      ? { email: entry, name: "" }
      : { email: entry.slice(0, i).trim(), name: entry.slice(i + 1).trim() };
  })
  .filter((u) => u.email);

export const USERS = ROSTER.map((u) => u.email);

const NAMES: Record<string, string> = Object.fromEntries(
  ROSTER.map((u) => [u.email, u.name]),
);

// Full roster: env-configured users plus profiles created through onboarding
// (data/onboarding.json). Env wins on order so USERS[0]-style defaults keep
// pointing at the configured primary user. Read per-call, not cached — the
// onboarding flow adds profiles at runtime.
export function rosterEmails(): string[] {
  return [...new Set([...USERS, ...onboardingProfilesSync().map((p) => p.email)])];
}

// Friendly display name for an email — the configured name, else the
// onboarding-profile name, else the local-part of the address.
export function displayName(email: string): string {
  if (NAMES[email]) return NAMES[email];
  const stored = onboardingProfilesSync().find((p) => p.email === email)?.name;
  return stored || email.split("@")[0];
}

// Gravatar avatar URL for an email — shows the user's real photo if they have a
// Gravatar, else a deterministic per-email identicon. MD5 is computed here
// (the browser has no MD5) and the roster is served with avatars baked in.
export function gravatar(email: string): string {
  const h = createHash("md5").update(email.trim().toLowerCase()).digest("hex");
  // Cache-buster: the base URL is keyed only by the email hash, so when a user
  // swaps their Gravatar photo the URL is unchanged and the browser/CDN keep
  // serving the stale image forever. Rotate a token on a 10-minute bucket so an
  // updated avatar propagates within ~10min instead of being pinned, without
  // hammering Gravatar on every request.
  const bucket = Math.floor(Date.now() / 600_000);
  return `https://www.gravatar.com/avatar/${h}?d=identicon&s=80&_=${bucket}`;
}

export function userRoster(): { email: string; name: string; avatar: string }[] {
  // Photo uploaded during onboarding beats Gravatar; served by
  // GET /api/avatars/<file> out of data/avatars/.
  const uploaded = new Map(
    onboardingProfilesSync()
      .filter((p) => p.avatar)
      .map((p) => [p.email, `/api/avatars/${p.avatar}`]),
  );
  return rosterEmails().map((email) => ({
    email,
    name: displayName(email),
    avatar: uploaded.get(email) ?? gravatar(email),
  }));
}

const FILE = `${PATHS.data}/session-users.json`;

function readAll(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, string>): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(all, null, 2));
}

// tmuxName → userEmail (only assigned names present).
export function userAssignments(): Record<string, string> {
  return readAll();
}

// Assign (or, with user=null, clear) the tag for a tmux session name. Unknown
// emails are rejected so a typo can't strand a session under a phantom user.
export function assignUser(tmuxName: string, user: string | null): boolean {
  if (user && !rosterEmails().includes(user)) return false;
  const all = readAll();
  if (user) all[tmuxName] = user;
  else delete all[tmuxName];
  writeAll(all);
  return true;
}
