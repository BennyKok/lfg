import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const liveDir = join(webDir, "dist");
const stageDir = mkdtempSync(join(tmpdir(), "lfg-web-build-"));

function publishBuild(): void {
  mkdirSync(liveDir, { recursive: true });

  // Copy every immutable/static file first. The existing index keeps pointing
  // at the previous hashed assets until the replacement bundle is complete.
  for (const entry of readdirSync(stageDir)) {
    if (entry === "index.html") continue;
    cpSync(join(stageDir, entry), join(liveDir, entry), {
      recursive: true,
      force: true,
    });
  }

  // Publish the HTML pointer last and atomically. If a build is interrupted at
  // any earlier point, the live server continues serving the previous bundle.
  const stagedIndex = join(stageDir, "index.html");
  if (!existsSync(stagedIndex)) throw new Error("staged web build has no index.html");
  const pendingIndex = join(liveDir, `.index.html.${process.pid}.tmp`);
  cpSync(stagedIndex, pendingIndex, { force: true });
  renameSync(pendingIndex, join(liveDir, "index.html"));
}

try {
  const build = Bun.spawnSync(
    [
      process.execPath,
      "x",
      "vite",
      "build",
      "--outDir",
      stageDir,
      "--emptyOutDir",
    ],
    {
      cwd: webDir,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (build.exitCode !== 0) process.exit(build.exitCode);
  publishBuild();
  console.log(`Published ${basename(stageDir)} to web/dist without taking the live bundle offline.`);
} finally {
  rmSync(stageDir, { recursive: true, force: true });
}
