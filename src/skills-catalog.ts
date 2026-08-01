import { readdir } from "node:fs/promises";
import { readFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import type { SkillCatalogItem } from "./agent-catalog.ts";

function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = m[1];
  const field = (name: string) => {
    const line = fm.match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1]?.trim();
    if (!line) return undefined;
    return line.replace(/^["']|["']$/g, "").trim();
  };
  return { name: field("name"), description: field("description") };
}

function skillDescriptionFallback(text: string): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\s*/, "");
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("```"));
  const useLine = lines.find((line) => /^use this skill\b/i.test(line));
  return (useLine || lines[0] || "").replace(/\s+/g, " ").slice(0, 240);
}

function skillSearchKeywords(text: string): string {
  return text
    .replace(/^---\n[\s\S]*?\n---\s*/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#[\](){}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

const SKILL_INDEX_TTL_MS = 60_000;
const SKILL_INDEX_STALE_MS = 5 * 60_000;

type SkillIndex = {
  key: string;
  builtAt: number;
  items: SkillCatalogItem[];
};

let skillIndex: SkillIndex | null = null;
let skillIndexRefresh: Promise<SkillCatalogItem[]> | null = null;
let skillIndexRefreshKey = "";

function cacheKey(repoRoots: string[]): string {
  return [...new Set(repoRoots.map((root) => root.trim()).filter(Boolean))]
    .sort()
    .join("\n");
}

function validSkillItem(item: SkillCatalogItem): boolean {
  return (
    !!item.name.trim() &&
    !!item.trigger.trim() &&
    !/\s/.test(item.trigger) &&
    // SKILL.md for skills, <command>.md for plugin commands.
    item.path.endsWith(".md")
  );
}

async function findSkillFiles(root: string, maxDepth = 6): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      out.push(join(dir, "SKILL.md"));
      return;
    }
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".git"))
        .map((e) => walk(join(dir, e.name), depth + 1)),
    );
  }
  await walk(root, 0);
  return out;
}

/**
 * Plugin *commands* — `<plugin>/<version>/commands/**\/*.md`. The agent offers
 * these exactly like skills (`/ralph-loop:help`), so omitting them left the
 * app's list disagreeing with what could actually be run. Note some plugins
 * ship commands and no skills at all.
 */
async function findPluginCommandFiles(root: string, maxDepth = 8): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number, inCommands: boolean) {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (e) => {
        // AppleDouble sidecars (`._foo.md`) sit next to the real file on
        // anything that has touched a Mac volume; they are not commands.
        if (e.name.startsWith("._")) return;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name.startsWith(".git")) return;
          await walk(full, depth + 1, inCommands || e.name === "commands");
          return;
        }
        if (inCommands && e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(full);
      }),
    );
  }
  await walk(root, 0, false);
  return out;
}

/**
 * "<plugin>:<command>" for a plugin command path, mirroring how the agent
 * addresses it. Nested command dirs namespace with ":" the same way the agent
 * does (commands/tasks/build.md -> notion:tasks:build).
 */
function pluginCommandTrigger(commandPath: string): string | null {
  const parts = commandPath.split(/[\\/]+/);
  const cacheIdx = parts.lastIndexOf("cache");
  const cmdIdx = parts.indexOf("commands", cacheIdx >= 0 ? cacheIdx : 0);
  if (cacheIdx < 0 || cmdIdx < 0 || cacheIdx + 3 > cmdIdx) return null;
  const plugin = parts[cacheIdx + 2];
  const name = parts
    .slice(cmdIdx + 1)
    .join(":")
    .replace(/\.md$/i, "");
  if (!plugin || !name) return null;
  return name.startsWith(`${plugin}:`) ? name : `${plugin}:${name}`;
}

function pluginSkillTrigger(skillPath: string, name: string): string {
  const parts = skillPath.split(/[\\/]+/);
  const skillsIdx = parts.lastIndexOf("skills");
  const cacheIdx = parts.lastIndexOf("cache");
  if (skillsIdx > 1 && cacheIdx >= 0 && cacheIdx + 3 < skillsIdx) {
    const plugin = parts[cacheIdx + 2];
    if (plugin && !name.startsWith(`${plugin}:`)) return `${plugin}:${name}`;
  }
  return name;
}

async function buildSkillCatalog(repoRoots: string[] = []): Promise<SkillCatalogItem[]> {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const claudeHome = process.env.CLAUDE_HOME || join(homedir(), ".claude");
  const selfRepo = PATHS.root;
  // Installed-plugin caches. Skills found under these get a "plugin:name"
  // trigger (see pluginSkillTrigger); everything else is addressed by bare name.
  // These are also the only roots scanned for plugin commands.
  const pluginRoots: { root: string; source: SkillCatalogItem["source"] }[] = [
    { root: join(codexHome, "plugins", "cache"), source: "codex" },
    { root: join(claudeHome, "plugins", "cache"), source: "claude" },
  ];
  const pluginCacheRoots = pluginRoots.map((r) => r.root);
  const roots: { root: string; source: SkillCatalogItem["source"] }[] = [
    { root: join(codexHome, "skills"), source: "codex" },
    { root: join(codexHome, "plugins", "cache"), source: "codex" },
    { root: join(claudeHome, "skills"), source: "claude" },
    // Claude Code plugin skills, the mirror of the codex plugin cache above.
    // Without this every plugin-provided skill was invisible to the catalog even
    // though the agent could invoke it. Only `cache/` (what is actually
    // installed) is scanned — `plugins/marketplaces/` is a marketplace checkout
    // that also contains plugins the user never installed, so indexing it would
    // advertise skills that aren't available. The layout matches codex's
    // (<marketplace>/<plugin>/<version>/skills/...), so pluginSkillTrigger
    // already resolves the "plugin:name" trigger correctly.
    { root: join(claudeHome, "plugins", "cache"), source: "claude" },
    { root: join(selfRepo, ".claude", "skills"), source: "claude" },
    { root: join(selfRepo, ".codex", "skills"), source: "codex" },
    { root: join(selfRepo, ".agents", "skills"), source: "agent" },
    { root: join(selfRepo, "skills"), source: "agent" },
    { root: join(selfRepo, "packages", "skills", "skills"), source: "agent" },
  ];
  for (const cwd of repoRoots) {
    roots.push({ root: join(cwd, ".claude", "skills"), source: "claude" });
    roots.push({ root: join(cwd, ".codex", "skills"), source: "codex" });
    roots.push({ root: join(cwd, ".agents", "skills"), source: "agent" });
    roots.push({ root: join(cwd, "skills"), source: "agent" });
    roots.push({ root: join(cwd, "packages", "skills", "skills"), source: "agent" });
  }
  const skillFiles = (
    await Promise.all(
      [...new Map(roots.map((r) => [`${r.source}:${r.root}`, r])).values()].map(async (r) =>
        (await findSkillFiles(r.root)).map((path) => ({ ...r, path, command: false })),
      ),
    )
  ).flat();
  // Commands come second so a plugin that ships both a skill and a command of
  // the same name keeps the skill — it carries the richer frontmatter.
  const commandFiles = (
    await Promise.all(
      pluginRoots.map(async (r) =>
        (await findPluginCommandFiles(r.root)).map((path) => ({ ...r, path, command: true })),
      ),
    )
  ).flat();
  const files = [...skillFiles, ...commandFiles];
  const seen = new Set<string>();
  const items: SkillCatalogItem[] = [];
  for (const file of files) {
    let raw = "";
    try {
      raw = readFileSync(file.path, "utf8");
    } catch {
      continue;
    }
    const fm = parseSkillFrontmatter(raw);
    let name: string;
    let trigger: string;
    if (file.command) {
      // A command's identity is its path — the frontmatter carries only a
      // description, never a name.
      const commandTrigger = pluginCommandTrigger(file.path);
      if (!commandTrigger) continue;
      trigger = commandTrigger;
      name = commandTrigger.slice(commandTrigger.indexOf(":") + 1);
    } else {
      name = fm.name || file.path.split(/[\\/]+/).at(-2) || "skill";
      // Namespace every plugin-provided skill as "plugin:name", whichever
      // agent's cache it came from. Beyond matching how the agent addresses
      // them, this is what keeps two plugins that ship the same skill name from
      // colliding on `key` below and having one silently dropped.
      trigger = pluginCacheRoots.some((root) => file.path.startsWith(root))
        ? pluginSkillTrigger(file.path, name)
        : name;
    }
    // Dedup also collapses a plugin installed at two versions (the cache keeps
    // the old directory around), which would otherwise list the same command twice.
    const key = `${file.source}:${trigger}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item: SkillCatalogItem = {
      name,
      trigger,
      description: fm.description || skillDescriptionFallback(raw),
      keywords: skillSearchKeywords(raw),
      source: file.source,
      path: file.path,
    };
    if (validSkillItem(item)) items.push(item);
  }
  return items.sort((a, b) => a.trigger.localeCompare(b.trigger));
}

export async function listSkillCatalog(repoRoots: string[] = []): Promise<SkillCatalogItem[]> {
  const key = cacheKey(repoRoots);
  const now = Date.now();
  if (skillIndex?.key === key) {
    const age = now - skillIndex.builtAt;
    if (age < SKILL_INDEX_TTL_MS) return skillIndex.items;
    if (age < SKILL_INDEX_STALE_MS) {
      if (!skillIndexRefresh || skillIndexRefreshKey !== key) {
        skillIndexRefreshKey = key;
        skillIndexRefresh = buildSkillCatalog(repoRoots)
          .then((items) => {
            skillIndex = { key, builtAt: Date.now(), items };
            return items;
          })
          .finally(() => {
            skillIndexRefresh = null;
            skillIndexRefreshKey = "";
          });
      }
      return skillIndex.items;
    }
  }
  if (!skillIndexRefresh || skillIndexRefreshKey !== key) {
    skillIndexRefreshKey = key;
    skillIndexRefresh = buildSkillCatalog(repoRoots)
      .then((items) => {
        skillIndex = { key, builtAt: Date.now(), items };
        return items;
      })
      .finally(() => {
        skillIndexRefresh = null;
        skillIndexRefreshKey = "";
      });
  }
  return skillIndexRefresh;
}
