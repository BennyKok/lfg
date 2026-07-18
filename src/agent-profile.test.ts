import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentProfileCliArgs,
  loadAgentProfile,
  loadAgentProfileFromEnv,
} from "./agent-profile.ts";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lfg-profile-"));
  tempDirs.push(dir);
  return dir;
}

// Build a profile dir with the requested conventional files.
function makeProfile(parts: {
  systemPromptMd?: string;
  systemPromptTxt?: string;
  skill?: { name: string; body: string };
  name?: string;
  profileJson?: string;
  skillsAsFile?: boolean;
}): string {
  const dir = makeDir();
  if (parts.systemPromptMd !== undefined) {
    writeFileSync(join(dir, "system-prompt.md"), parts.systemPromptMd);
  }
  if (parts.systemPromptTxt !== undefined) {
    writeFileSync(join(dir, "system-prompt.txt"), parts.systemPromptTxt);
  }
  if (parts.skillsAsFile) {
    writeFileSync(join(dir, "skills"), "not a dir");
  } else if (parts.skill) {
    const skillDir = join(dir, "skills", parts.skill.name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), parts.skill.body);
  }
  if (parts.name !== undefined) writeFileSync(join(dir, "name"), parts.name);
  if (parts.profileJson !== undefined) writeFileSync(join(dir, "profile.json"), parts.profileJson);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("custom agent profile loading", () => {
  test("unset / blank env value is a no-op (null profile, no args)", () => {
    expect(loadAgentProfile(undefined)).toBeNull();
    expect(loadAgentProfile(null)).toBeNull();
    expect(loadAgentProfile("")).toBeNull();
    expect(loadAgentProfile("   ")).toBeNull();
    expect(agentProfileCliArgs(null)).toEqual([]);
  });

  test("non-existent directory is ignored gracefully", () => {
    expect(loadAgentProfile(join(tmpdir(), "lfg-does-not-exist-xyz-123"))).toBeNull();
  });

  test("a file path (not a directory) is ignored gracefully", () => {
    const dir = makeDir();
    const file = join(dir, "afile");
    writeFileSync(file, "x");
    expect(loadAgentProfile(file)).toBeNull();
  });

  test("a full profile resolves all three parts and builds additive CLI args", () => {
    const dir = makeProfile({
      systemPromptMd: "Be extra helpful.",
      skill: { name: "greet", body: "---\nname: greet\n---\nSay hi." },
      name: "Branded Agent",
    });
    const profile = loadAgentProfile(dir)!;
    expect(profile).not.toBeNull();
    expect(profile.dir).toBe(dir);
    expect(profile.systemPromptPath).toBe(join(dir, "system-prompt.md"));
    expect(profile.skillsDir).toBe(join(dir, "skills"));
    expect(profile.displayName).toBe("Branded Agent");

    expect(agentProfileCliArgs(profile)).toEqual([
      "--append-system-prompt",
      join(dir, "system-prompt.md"),
      "--skill",
      join(dir, "skills"),
    ]);
  });

  test("an empty directory yields a usable profile with no parts and no args", () => {
    const dir = makeDir();
    const profile = loadAgentProfile(dir)!;
    expect(profile.dir).toBe(dir);
    expect(profile.systemPromptPath).toBeUndefined();
    expect(profile.skillsDir).toBeUndefined();
    expect(profile.displayName).toBeUndefined();
    expect(agentProfileCliArgs(profile)).toEqual([]);
  });

  test("system-prompt.txt is used when the .md variant is absent", () => {
    const dir = makeProfile({ systemPromptTxt: "plain text prompt" });
    const profile = loadAgentProfile(dir)!;
    expect(profile.systemPromptPath).toBe(join(dir, "system-prompt.txt"));
  });

  test("system-prompt.md is preferred over .txt when both exist", () => {
    const dir = makeProfile({ systemPromptMd: "md", systemPromptTxt: "txt" });
    const profile = loadAgentProfile(dir)!;
    expect(profile.systemPromptPath).toBe(join(dir, "system-prompt.md"));
  });

  test("profile.json displayName is used when no name file exists", () => {
    const dir = makeProfile({ profileJson: JSON.stringify({ displayName: "JSON Name" }) });
    const profile = loadAgentProfile(dir)!;
    expect(profile.displayName).toBe("JSON Name");
  });

  test("a plain name file wins over profile.json", () => {
    const dir = makeProfile({
      name: "File Name",
      profileJson: JSON.stringify({ displayName: "JSON Name" }),
    });
    const profile = loadAgentProfile(dir)!;
    expect(profile.displayName).toBe("File Name");
  });

  test("a blank name file yields no display name (and no crash)", () => {
    const dir = makeProfile({ name: "   \n" });
    const profile = loadAgentProfile(dir)!;
    expect(profile.displayName).toBeUndefined();
  });

  test("malformed profile.json is ignored, not fatal", () => {
    const dir = makeProfile({ profileJson: "{ this is not json" });
    const profile = loadAgentProfile(dir)!;
    expect(profile).not.toBeNull();
    expect(profile.displayName).toBeUndefined();
  });

  test("a skills path that is a file (not a directory) is skipped", () => {
    const dir = makeProfile({ skillsAsFile: true });
    const profile = loadAgentProfile(dir)!;
    expect(profile.skillsDir).toBeUndefined();
    expect(agentProfileCliArgs(profile)).toEqual([]);
  });

  test("the name is trimmed", () => {
    const dir = makeProfile({ name: "  Padded Name  \n" });
    expect(loadAgentProfile(dir)!.displayName).toBe("Padded Name");
  });

  test("loadAgentProfileFromEnv reads the named env var", () => {
    const dir = makeProfile({ name: "Env Agent" });
    const prev = process.env.LFG_TEST_PROFILE_DIR;
    process.env.LFG_TEST_PROFILE_DIR = dir;
    try {
      expect(loadAgentProfileFromEnv("LFG_TEST_PROFILE_DIR")!.displayName).toBe("Env Agent");
    } finally {
      if (prev === undefined) delete process.env.LFG_TEST_PROFILE_DIR;
      else process.env.LFG_TEST_PROFILE_DIR = prev;
    }
    expect(loadAgentProfileFromEnv("LFG_TEST_PROFILE_UNSET_XYZ")).toBeNull();
  });
});
