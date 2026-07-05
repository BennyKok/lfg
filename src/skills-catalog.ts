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
    item.path.endsWith("SKILL.md")
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
  const roots: { root: string; source: SkillCatalogItem["source"] }[] = [
    { root: join(codexHome, "skills"), source: "codex" },
    { root: join(codexHome, "plugins", "cache"), source: "codex" },
    { root: join(claudeHome, "skills"), source: "claude" },
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
  const files = (
    await Promise.all(
      [...new Map(roots.map((r) => [`${r.source}:${r.root}`, r])).values()].map(async (r) =>
        (await findSkillFiles(r.root)).map((path) => ({ ...r, path })),
      ),
    )
  ).flat();
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
    const name = fm.name || file.path.split(/[\\/]+/).at(-2) || "skill";
    const trigger = file.path.includes(`${codexHome}/plugins/cache`)
      ? pluginSkillTrigger(file.path, name)
      : name;
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
