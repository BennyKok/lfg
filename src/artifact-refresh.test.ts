import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PATHS } from "./config.ts";
import {
  ArtifactRefreshManager,
  prepareArtifactRefreshConfig,
} from "./artifact-refresh.ts";
import { getImageArtifact, publishHtmlArtifact } from "./artifacts.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const FIRST_HTML = "<!doctype html><html><body>first</body></html>";

describe("script-backed HTML artifact refresh", () => {
  const originalData = PATHS.data;
  let root: string;
  let scope: string;
  let managers: ArtifactRefreshManager[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lfg-artifact-refresh-"));
    scope = join(root, "repo");
    mkdirSync(scope, { recursive: true });
    PATHS.data = join(root, "data");
    managers = [];
  });

  afterEach(() => {
    for (const manager of managers) manager.stop();
    PATHS.data = originalData;
    rmSync(root, { recursive: true, force: true });
  });

  function manager(): ArtifactRefreshManager {
    const value = new ArtifactRefreshManager();
    managers.push(value);
    return value;
  }

  function script(name: string, source: string): string {
    const path = join(scope, name);
    writeFileSync(path, source);
    chmodSync(path, 0o755);
    return path;
  }

  function create(input: {
    id?: string;
    scriptPath: string;
    argv?: string[];
    enabled?: boolean;
    configuredAt?: number;
    intervalMs?: number;
    timeoutMs?: number;
  }) {
    const refresh = prepareArtifactRefreshConfig({
      scopeRoot: scope,
      now: input.configuredAt ?? Date.now(),
      changes: {
        scriptPath: input.scriptPath,
        argv: input.argv,
        enabled: input.enabled,
        intervalMs: input.intervalMs ?? 10_000,
        timeoutMs: input.timeoutMs ?? 2_000,
      },
    });
    if (!refresh) throw new Error("expected refresh config");
    return publishHtmlArtifact({
      sessionId: SESSION,
      id: input.id ?? "live-report",
      html: FIRST_HTML,
      refresh,
    });
  }

  test("success atomically updates the stable artifact and version", async () => {
    const executable = script(
      "success.sh",
      "#!/bin/sh\nprintf '%s' '<!doctype html><html><body>second</body></html>'\n",
    );
    const before = create({ scriptPath: executable });

    const result = await manager().refreshNow(before.id, SESSION);

    expect(result.ok).toBe(true);
    expect(result.artifact.id).toBe(before.id);
    expect(result.artifact.version).toBe(2);
    expect(result.artifact.refresh?.status).toBe("success");
    expect(readFileSync(result.artifact.filePath, "utf8")).toContain("second");
  });

  test("failure and invalid output preserve the last good HTML and version", async () => {
    const executable = script("failure.sh", "#!/bin/sh\nprintf 'not a document'\n");
    const before = create({ scriptPath: executable });

    const result = await manager().refreshNow(before.id, SESSION);

    expect(result.ok).toBe(false);
    const after = getImageArtifact(before.id)!;
    expect(after.version).toBe(1);
    expect(after.refresh?.status).toBe("error");
    expect(after.refresh?.lastError).toContain("complete HTML document");
    expect(readFileSync(after.filePath, "utf8")).toBe(FIRST_HTML);
  });

  test("a non-zero exit records stderr and preserves last-good output", async () => {
    const executable = script("exit-failure.sh", "#!/bin/sh\necho 'upstream unavailable' >&2\nexit 7\n");
    const before = create({ scriptPath: executable });

    const result = await manager().refreshNow(before.id, SESSION);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("upstream unavailable");
    expect(getImageArtifact(before.id)?.version).toBe(1);
    expect(readFileSync(before.filePath, "utf8")).toBe(FIRST_HTML);
  });

  test("prevents overlapping executions for one artifact", async () => {
    const executable = script(
      "slow.sh",
      "#!/bin/sh\nsleep 0.2\nprintf '%s' '<!doctype html><html><body>done</body></html>'\n",
    );
    const artifact = create({ scriptPath: executable });
    const refreshes = manager();

    const first = refreshes.refreshNow(artifact.id, SESSION);
    await Bun.sleep(25);
    const overlap = await refreshes.refreshNow(artifact.id, SESSION);

    expect(overlap.started).toBe(false);
    expect(overlap.error).toContain("already running");
    expect((await first).ok).toBe(true);
    expect(getImageArtifact(artifact.id)?.version).toBe(2);
  });

  test("a new scheduler instance rehydrates persisted due schedules", async () => {
    const executable = script(
      "restart.sh",
      "#!/bin/sh\nprintf '%s' '<!doctype html><html><body>rehydrated</body></html>'\n",
    );
    const artifact = create({ scriptPath: executable, configuredAt: 1_000, intervalMs: 10_000 });

    await manager().tick(11_000);

    expect(getImageArtifact(artifact.id)?.version).toBe(2);
    expect(readFileSync(artifact.filePath, "utf8")).toContain("rehydrated");
  });

  test("updating, disabling, and removing a schedule keeps one owner/config", async () => {
    const executable = script(
      "disabled.sh",
      "#!/bin/sh\nprintf '%s' '<!doctype html><html><body>unexpected</body></html>'\n",
    );
    const artifact = create({ scriptPath: executable });
    const refreshes = manager();

    const updated = refreshes.configure({
      id: artifact.id,
      sessionId: SESSION,
      scopeRoot: scope,
      changes: { intervalMs: 20_000, enabled: false },
      now: 2_000,
    });
    await refreshes.tick(1_000_000);

    expect(updated.id).toBe(artifact.id);
    expect(getImageArtifact(artifact.id)?.refresh?.intervalMs).toBe(20_000);
    expect(getImageArtifact(artifact.id)?.version).toBe(1);
    refreshes.configure({
      id: artifact.id,
      sessionId: SESSION,
      scopeRoot: scope,
      changes: { scriptPath: null },
    });
    expect(getImageArtifact(artifact.id)?.refresh).toBeUndefined();
  });

  test("disabling an active schedule cancels its process and clears running status", async () => {
    const executable = script(
      "cancel.sh",
      "#!/bin/sh\nsleep 2\nprintf '%s' '<!doctype html><html><body>too late</body></html>'\n",
    );
    const artifact = create({ scriptPath: executable });
    const refreshes = manager();
    const running = refreshes.refreshNow(artifact.id, SESSION);
    await Bun.sleep(20);

    refreshes.configure({
      id: artifact.id,
      sessionId: SESSION,
      changes: { enabled: false },
    });
    const result = await running;

    expect(result.ok).toBe(false);
    expect(getImageArtifact(artifact.id)?.refresh?.enabled).toBe(false);
    expect(getImageArtifact(artifact.id)?.refresh?.status).toBe("idle");
    expect(getImageArtifact(artifact.id)?.version).toBe(1);
  });

  test("enforces owner and cwd scope and passes argv without a shell", async () => {
    const marker = join(root, "shell-injection-marker");
    const executable = script(
      "argv.sh",
      "#!/bin/sh\nprintf '<!doctype html><html><body>%s</body></html>' \"$1\"\n",
    );
    const artifact = create({ scriptPath: executable, argv: [`safe; touch ${marker}`] });
    const refreshes = manager();

    await expect(refreshes.refreshNow(artifact.id, OTHER_SESSION)).rejects.toThrow("different session");
    expect((await refreshes.refreshNow(artifact.id, SESSION)).ok).toBe(true);
    expect(Bun.file(marker).size).toBe(0);

    const outside = join(root, "outside.sh");
    writeFileSync(outside, "#!/bin/sh\nexit 0\n");
    chmodSync(outside, 0o755);
    expect(() => prepareArtifactRefreshConfig({
      scopeRoot: scope,
      changes: { scriptPath: outside },
    })).toThrow("inside the owning session cwd");
  });

  test("times out a script without replacing last-good output", async () => {
    const executable = script(
      "timeout.sh",
      "#!/bin/sh\nsleep 2\nprintf '%s' '<!doctype html><html><body>late</body></html>'\n",
    );
    const artifact = create({ scriptPath: executable, timeoutMs: 1_000 });

    const result = await manager().refreshNow(artifact.id, SESSION);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
    expect(getImageArtifact(artifact.id)?.version).toBe(1);
    expect(readFileSync(artifact.filePath, "utf8")).toBe(FIRST_HTML);
  });
});
