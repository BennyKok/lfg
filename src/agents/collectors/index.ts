import { join } from "node:path";
import type { InputSpec } from "../registry.ts";
import { collectGitLog } from "./git.ts";
import { collectOpenRouterModels } from "./openrouter.ts";
import { collectOpenRouterDrift } from "./openrouter-drift.ts";
import { collectGithubIssues, collectGithubPrs } from "./github.ts";
import { collectRepoFiles } from "./repo-files.ts";
import { collectSecurityScan } from "./security.ts";

export type CollectorResult = {
  title: string;
  body: string;
  ok: boolean;
  warning?: string;
};

// Optional local (gitignored) plugin of private collectors that live under
// data/agents/collectors/. Absent in a clean open-source checkout; loaded once,
// lazily, if present. Kinds it registers are dispatched here when no built-in
// collector matches. See data/agents/collectors/index.ts.
type LocalPlugin = {
  localCollectors?: Record<string, (spec: any) => Promise<CollectorResult>>;
};
const LOCAL_PLUGIN_PATH = join(
  import.meta.dir,
  "../../../data/agents/collectors/index.ts",
);
let localPluginCache: LocalPlugin | null | undefined;

async function getLocalPlugin(): Promise<LocalPlugin | null> {
  if (localPluginCache !== undefined) return localPluginCache;
  try {
    localPluginCache = (await import(LOCAL_PLUGIN_PATH)) as LocalPlugin;
  } catch {
    localPluginCache = null; // no local plugin in this checkout
  }
  return localPluginCache;
}

async function runLocalCollector(spec: any): Promise<CollectorResult> {
  const plugin = await getLocalPlugin();
  const fn = plugin?.localCollectors?.[spec?.kind];
  if (fn) return await fn(spec);
  throw new Error(`unknown collector: ${JSON.stringify(spec)}`);
}

export async function runCollector(spec: InputSpec): Promise<CollectorResult> {
  try {
    switch (spec.kind) {
      case "git_log":
        return await collectGitLog(spec);
      case "openrouter_models":
        return await collectOpenRouterModels(spec);
      case "openrouter_drift":
        return await collectOpenRouterDrift(spec);
      case "github_issues":
        return await collectGithubIssues(spec);
      case "github_prs":
        return await collectGithubPrs(spec);
      case "repo_files":
        return await collectRepoFiles(spec);
      case "security_scan":
        return await collectSecurityScan(spec);
      default:
        // Not a built-in kind — try the optional local collector plugin.
        return await runLocalCollector(spec);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      title: `Collector failed: ${spec.kind}`,
      body: `(collector ${spec.kind} threw: ${msg})`,
      ok: false,
      warning: msg,
    };
  }
}
