import { realpathSync, statSync } from "node:fs";
import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { isAbsolute, relative, resolve } from "node:path";
import {
  deleteArtifact,
  getImageArtifact,
  listAllArtifacts,
  publishHtmlArtifact,
  updateHtmlArtifactRefresh,
  updateHtmlArtifactRefreshStatus,
  type ArtifactRefreshConfig,
  type ImageArtifact,
} from "./artifacts.ts";

export const MIN_ARTIFACT_REFRESH_INTERVAL_MS = 10_000;
export const MAX_ARTIFACT_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_ARTIFACT_REFRESH_TIMEOUT_MS = 30_000;
export const MAX_ARTIFACT_REFRESH_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export type ArtifactRefreshChanges = {
  scriptPath?: string | null;
  argv?: string[];
  intervalMs?: number;
  timeoutMs?: number;
  enabled?: boolean;
};

export type ArtifactRefreshRunResult = {
  ok: boolean;
  started: boolean;
  artifact: ImageArtifact;
  error?: string;
};

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 1_000) || "refresh failed";
}

function pathInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function validateScript(scriptPath: string, scopeRoot: string): { scriptPath: string; scopeRoot: string } {
  if (!isAbsolute(scriptPath)) throw new Error("refresh script path must be absolute");
  const realScope = realpathSync(resolve(scopeRoot));
  const realScript = realpathSync(resolve(scriptPath));
  if (!pathInside(realScript, realScope)) {
    throw new Error("refresh script must be inside the owning session cwd");
  }
  const st = statSync(realScript);
  if (!st.isFile()) throw new Error("refresh script path is not a file");
  if ((st.mode & 0o111) === 0) throw new Error("refresh script must be executable");
  return { scriptPath: realScript, scopeRoot: realScope };
}

function validateArgv(argv: string[]): string[] {
  if (argv.length > 32) throw new Error("refresh argv cannot contain more than 32 arguments");
  return argv.map((arg) => {
    if (typeof arg !== "string") throw new Error("refresh argv entries must be strings");
    if (arg.includes("\0")) throw new Error("refresh argv entries cannot contain NUL bytes");
    if (Buffer.byteLength(arg, "utf8") > 4_096) throw new Error("refresh argv entry is too large");
    return arg;
  });
}

export function validateCompleteHtml(html: string): void {
  if (!html.trim()) throw new Error("refresh script produced empty output");
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
    throw new Error("refresh script output is larger than 2 MB");
  }
  if (!/^\s*<!doctype\s+html(?:\s[^>]*)?>/i.test(html)) {
    throw new Error("refresh script must print a complete HTML document beginning with <!doctype html>");
  }
  if (!/<html(?:\s[^>]*)?>[\s\S]*<\/html>\s*$/i.test(html)) {
    throw new Error("refresh script must print a complete HTML document with a closing </html>");
  }
}

export function prepareArtifactRefreshConfig(input: {
  changes: ArtifactRefreshChanges;
  existing?: ArtifactRefreshConfig;
  scopeRoot?: string;
  now?: number;
}): ArtifactRefreshConfig | null {
  if (input.changes.scriptPath === null) return null;
  const rawScript = input.changes.scriptPath ?? input.existing?.scriptPath;
  if (!rawScript) throw new Error("refresh script path required");
  const paths = input.existing && input.changes.scriptPath === undefined
    ? { scriptPath: input.existing.scriptPath, scopeRoot: input.existing.scopeRoot }
    : (() => {
      if (!input.scopeRoot) throw new Error("owning session cwd not found");
      return validateScript(rawScript, input.scopeRoot);
    })();
  const argv = validateArgv(input.changes.argv ?? input.existing?.argv ?? []);
  const intervalMs = input.changes.intervalMs ?? input.existing?.intervalMs ?? 5 * 60_000;
  if (!Number.isInteger(intervalMs) || intervalMs < MIN_ARTIFACT_REFRESH_INTERVAL_MS || intervalMs > MAX_ARTIFACT_REFRESH_INTERVAL_MS) {
    throw new Error("refresh interval must be between 10 seconds and 7 days");
  }
  const timeoutMs = input.changes.timeoutMs ?? input.existing?.timeoutMs ?? DEFAULT_ARTIFACT_REFRESH_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_ARTIFACT_REFRESH_TIMEOUT_MS) {
    throw new Error("refresh timeout must be between 1 second and 5 minutes");
  }
  const executionChanged =
    !input.existing ||
    paths.scriptPath !== input.existing.scriptPath ||
    JSON.stringify(argv) !== JSON.stringify(input.existing.argv) ||
    paths.scopeRoot !== input.existing.scopeRoot;
  return {
    scriptPath: paths.scriptPath,
    argv,
    scopeRoot: paths.scopeRoot,
    intervalMs,
    timeoutMs,
    enabled: input.changes.enabled ?? input.existing?.enabled ?? true,
    configuredAt: input.now ?? Date.now(),
    status: executionChanged || input.existing?.status === "running"
      ? "idle"
      : input.existing?.status ?? "idle",
    lastStartedAt: input.existing?.lastStartedAt,
    lastSuccessAt: input.existing?.lastSuccessAt,
    lastError: executionChanged ? undefined : input.existing?.lastError,
  };
}

function sameExecution(a: ArtifactRefreshConfig | undefined, b: ArtifactRefreshConfig): boolean {
  return !!a &&
    a.scriptPath === b.scriptPath &&
    a.scopeRoot === b.scopeRoot &&
    a.configuredAt === b.configuredAt &&
    JSON.stringify(a.argv) === JSON.stringify(b.argv);
}

function assertOwnedHtmlArtifact(id: string, sessionId?: string): ImageArtifact {
  const artifact = getImageArtifact(id);
  if (!artifact || artifact.media !== "html") throw new Error("html artifact not found");
  if (sessionId && artifact.sessionId !== sessionId) {
    throw new Error("artifact belongs to a different session");
  }
  return artifact;
}

function killProcessTree(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export class ArtifactRefreshManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly running = new Map<string, ChildProcess>();

  configure(input: {
    id: string;
    sessionId: string;
    scopeRoot?: string;
    changes: ArtifactRefreshChanges;
    now?: number;
  }): ImageArtifact {
    const artifact = assertOwnedHtmlArtifact(input.id, input.sessionId);
    const refresh = prepareArtifactRefreshConfig({
      changes: input.changes,
      existing: artifact.refresh,
      scopeRoot: input.scopeRoot,
      now: input.now,
    });
    if (!refresh || !refresh.enabled) this.cancel(input.id);
    return updateHtmlArtifactRefresh({ id: input.id, sessionId: input.sessionId, refresh });
  }

  delete(id: string, sessionId: string): ImageArtifact {
    assertOwnedHtmlArtifact(id, sessionId);
    this.cancel(id);
    return deleteArtifact({ id, sessionId });
  }

  cancel(id: string): void {
    const child = this.running.get(id);
    if (child) killProcessTree(child);
  }

  async refreshNow(id: string, sessionId?: string): Promise<ArtifactRefreshRunResult> {
    let artifact = assertOwnedHtmlArtifact(id, sessionId);
    const config = artifact.refresh;
    if (!config) throw new Error("artifact has no refresh script configured");
    if (this.running.has(id)) {
      return { ok: false, started: false, artifact, error: "artifact refresh already running" };
    }

    // Re-check the real paths on every invocation. A symlink or script may have
    // changed since configuration was persisted across a restart.
    let validated: { scriptPath: string; scopeRoot: string };
    try {
      validated = validateScript(config.scriptPath, config.scopeRoot);
    } catch (error) {
      const message = cleanError(error);
      artifact = updateHtmlArtifactRefreshStatus({
        id,
        patch: { status: "error", lastStartedAt: Date.now(), lastError: message },
      }) ?? artifact;
      return { ok: false, started: false, artifact, error: message };
    }

    const startedAt = Date.now();
    artifact = updateHtmlArtifactRefreshStatus({
      id,
      patch: { status: "running", lastStartedAt: startedAt },
    }) ?? artifact;

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(validated.scriptPath, config.argv, {
        cwd: validated.scopeRoot,
        env: process.env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const message = cleanError(error);
      artifact = updateHtmlArtifactRefreshStatus({ id, patch: { status: "error", lastError: message } }) ?? artifact;
      return { ok: false, started: true, artifact, error: message };
    }
    this.running.set(id, child);

    const output = await new Promise<{ ok: boolean; stdout: string; error?: string }>((done) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let forcedError: string | undefined;
      const finish = (value: { ok: boolean; stdout: string; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        done(value);
      };
      const timeout = setTimeout(() => {
        forcedError = `refresh script timed out after ${config.timeoutMs}ms`;
        killProcessTree(child);
      }, config.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_HTML_BYTES) {
          forcedError = "refresh script output is larger than 2 MB";
          killProcessTree(child);
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes >= MAX_STDERR_BYTES) return;
        const keep = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
        stderrBytes += keep.length;
        stderr.push(keep);
      });
      child.once("error", (error) => finish({ ok: false, stdout: "", error: cleanError(error) }));
      child.once("close", (code, signal) => {
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8").trim();
        if (forcedError) finish({ ok: false, stdout: out, error: forcedError });
        else if (code !== 0) finish({ ok: false, stdout: out, error: err || `refresh script exited ${code ?? signal ?? "unknown"}` });
        else finish({ ok: true, stdout: out });
      });
    });
    this.running.delete(id);

    const current = getImageArtifact(id);
    if (!current) {
      return { ok: false, started: true, artifact, error: "artifact deleted while refresh was running" };
    }
    if (sessionId && current.sessionId !== sessionId) {
      return { ok: false, started: true, artifact: current, error: "artifact owner changed while refresh was running" };
    }
    if (!sameExecution(current.refresh, config)) {
      return { ok: false, started: true, artifact: current, error: "refresh configuration changed while script was running" };
    }
    if (!output.ok) {
      const message = cleanError(output.error);
      artifact = updateHtmlArtifactRefreshStatus({ id, patch: { status: "error", lastError: message } }) ?? current;
      return { ok: false, started: true, artifact, error: message };
    }

    try {
      validateCompleteHtml(output.stdout);
      artifact = publishHtmlArtifact({
        sessionId: current.sessionId,
        id: current.id,
        html: output.stdout,
        title: current.title,
        caption: current.caption,
        bumpVersion: false,
      });
      artifact = updateHtmlArtifactRefreshStatus({
        id,
        patch: { status: "success", lastSuccessAt: Date.now(), lastError: undefined },
      }) ?? artifact;
      return { ok: true, started: true, artifact };
    } catch (error) {
      const message = cleanError(error);
      artifact = updateHtmlArtifactRefreshStatus({ id, patch: { status: "error", lastError: message } }) ?? current;
      return { ok: false, started: true, artifact, error: message };
    }
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = listAllArtifacts().filter((artifact) => {
        const refresh = artifact.media === "html" ? artifact.refresh : undefined;
        if (!refresh?.enabled || this.running.has(artifact.id)) return false;
        return now >= (refresh.lastStartedAt ?? refresh.configuredAt) + refresh.intervalMs;
      });
      await Promise.all(due.map((artifact) => this.refreshNow(artifact.id, artifact.sessionId)));
    } finally {
      this.ticking = false;
    }
  }

  start(tickMs = 1_000): () => void {
    if (!this.timer) {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), tickMs);
      this.timer.unref?.();
    }
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const child of this.running.values()) killProcessTree(child);
    this.running.clear();
  }
}

export const artifactRefreshManager = new ArtifactRefreshManager();

export function startArtifactRefreshScheduler(onLog: (message: string) => void = () => {}): () => void {
  onLog("[artifact-refresh] scheduler started");
  const stop = artifactRefreshManager.start();
  return () => {
    stop();
    onLog("[artifact-refresh] scheduler stopped");
  };
}
