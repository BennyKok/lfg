import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFunctionSource } from "./setup-script-helpers.ts";

/** A tar that behaves like macOS bsdtar: no GNU banner, hard-fails GNU-only long options. */
const FAKE_BSDTAR = `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    --version) echo "bsdtar 3.5.3 - libarchive 3.5.3"; exit 0 ;;
    --overwrite|--touch)
      echo "tar: Option $arg is not supported" >&2
      echo "Usage:" >&2
      exit 1 ;;
  esac
done
exec /usr/bin/env -u PATH_STUB REAL_TAR_PLACEHOLDER "$@"
`;

describe("setup.sh release extraction", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeFixture(): { root: string; archive: string; dest: string } {
    const root = mkdtempSync(join(tmpdir(), "lfg-setup-extract-"));
    roots.push(root);
    // Payload mirrors the release bundle shape: everything under a leading lfg/.
    mkdirSync(join(root, "payload", "lfg", "src"), { recursive: true });
    writeFileSync(join(root, "payload", "lfg", "src", "cli.ts"), "new-release\n");
    const archive = join(root, "bundle.tar.gz");
    const packed = Bun.spawnSync(["tar", "-C", join(root, "payload"), "-czf", archive, "lfg"]);
    expect(packed.exitCode, packed.stderr.toString()).toBe(0);

    // A pre-existing install that must be replaced, plus local state that must survive.
    const dest = join(root, "install");
    mkdirSync(join(dest, "src"), { recursive: true });
    writeFileSync(join(dest, "src", "cli.ts"), "old-release\n");
    writeFileSync(join(dest, ".env"), "LFG_PORT=8766\n");
    return { root, archive, dest };
  }

  function runExtract(
    archive: string,
    dest: string,
    opts: { fakeBsdtar?: string; env?: Record<string, string> } = {},
  ) {
    const script = `set -euo pipefail\n${extractFunctionSource("extract_release_archive")}\nextract_release_archive "$1" "$2"\n`;
    return Bun.spawnSync(["bash", "-c", script, "bash", archive, dest], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...(opts.fakeBsdtar ? { PATH: `${opts.fakeBsdtar}:${process.env.PATH}` } : {}),
        ...(opts.env ?? {}),
      },
    });
  }

  test("extracts over an existing install with the host's real tar", () => {
    const { archive, dest } = makeFixture();
    const result = runExtract(archive, dest);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(join(dest, "src", "cli.ts"), "utf8")).toBe("new-release\n");
    expect(readFileSync(join(dest, ".env"), "utf8")).toBe("LFG_PORT=8766\n");
  });

  test("does not pass GNU-only flags to a bsdtar that rejects them", () => {
    const { root, archive, dest } = makeFixture();
    const realTar = Bun.spawnSync(["bash", "-c", "command -v tar"]).stdout.toString().trim();
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, "tar");
    writeFileSync(shim, FAKE_BSDTAR.replace("/usr/bin/env -u PATH_STUB REAL_TAR_PLACEHOLDER", realTar));
    chmodSync(shim, 0o755);

    const result = runExtract(archive, dest, { fakeBsdtar: bin });
    const stderr = result.stderr.toString();
    expect(stderr).not.toContain("is not supported");
    expect(result.exitCode, stderr).toBe(0);
    expect(readFileSync(join(dest, "src", "cli.ts"), "utf8")).toBe("new-release\n");
  });

  test("neutralises an injected TAR_OPTIONS=--keep-old-files", () => {
    const { archive, dest } = makeFixture();
    const result = runExtract(archive, dest, { env: { TAR_OPTIONS: "--keep-old-files" } });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(join(dest, "src", "cli.ts"), "utf8")).toBe("new-release\n");
  });
});
