import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PATHS } from "../config.ts";
import type { Pipeline, PipelineFrontmatter, PipelineStep } from "./types.ts";

export const PIPELINES_DIR = join(PATHS.root, "pipelines");
// Private, gitignored pipelines live under data/ — they take precedence.
export const LOCAL_PIPELINES_DIR = join(PATHS.data, "pipelines");

const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parsePipelineFile(raw: string, filePath: string): Pipeline {
  const m = FM_RE.exec(raw);
  if (!m) throw new Error(`pipeline ${filePath}: missing YAML frontmatter`);

  let fm: PipelineFrontmatter;
  try {
    fm = parseYaml(m[1]) as PipelineFrontmatter;
  } catch (e) {
    throw new Error(
      `pipeline ${filePath}: YAML parse error: ${e instanceof Error ? e.message : e}`,
    );
  }
  if (!fm?.name) throw new Error(`pipeline ${filePath}: missing 'name'`);
  if (!Array.isArray(fm.steps) || fm.steps.length === 0)
    throw new Error(`pipeline ${filePath}: 'steps' must be a non-empty array`);

  const steps: PipelineStep[] = fm.steps.map((s, i) => {
    if ("run" in s) return { kind: "run", command: s.run };
    if ("agent" in s) {
      return {
        kind: "agent",
        agent: s.agent,
        prompt: s.prompt,
        model: s.model,
        context: s.context,
      };
    }
    throw new Error(`pipeline ${filePath}: step[${i}] must have 'agent' or 'run'`);
  });

  return {
    name: fm.name,
    filePath,
    frontmatter: fm,
    description: m[2].trim(),
    steps,
  };
}

async function resolveFilePath(name: string): Promise<string | null> {
  const local = join(LOCAL_PIPELINES_DIR, `${name}.md`);
  if (await Bun.file(local).exists()) return local;
  const tracked = join(PIPELINES_DIR, `${name}.md`);
  if (await Bun.file(tracked).exists()) return tracked;
  return null;
}

export async function loadPipeline(name: string): Promise<Pipeline> {
  const filePath = await resolveFilePath(name);
  if (!filePath)
    throw new Error(`pipeline '${name}' not found in ${LOCAL_PIPELINES_DIR} or ${PIPELINES_DIR}`);
  const raw = await Bun.file(filePath).text();
  return parsePipelineFile(raw, filePath);
}

export async function listPipelines(): Promise<Pipeline[]> {
  const byName = new Map<string, Pipeline>();
  for (const dir of [PIPELINES_DIR, LOCAL_PIPELINES_DIR]) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const filePath = join(dir, f);
      const raw = await Bun.file(filePath).text();
      try {
        const p = parsePipelineFile(raw, filePath);
        byName.set(p.name, p);
      } catch (e) {
        console.error(`[pipeline-registry] skipping ${filePath}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
