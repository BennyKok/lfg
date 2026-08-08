// Getting omg.dev running and reaching it remotely are separate decisions.
//
// Setup used to install the Tailscale daemon on every Linux box regardless, and
// then, finding it not logged in with no TTY to ask on - precisely the case for
// `curl ... | bash` - call die(). A fresh machine ended up with a system daemon
// nobody asked for AND a failed install, because of a feature that is optional.
// Nothing that touches the system beyond the install directory may run, prompt,
// or fail unless it was explicitly requested.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SETUP_SH } from "./setup-script-helpers.ts";

const source = readFileSync(SETUP_SH, "utf8");

/** Evaluate setup.sh's default-resolution prologue under a given environment. */
function defaults(env: Record<string, string> = {}): Record<string, string> {
  const start = source.indexOf("# ---- OMG_* / LFG_* aliasing");
  const end = source.indexOf("say()  {", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const script = [
    "set -euo pipefail",
    'uname() { if [ "${1:-}" = "-m" ]; then printf x86_64; else printf Linux; fi; }',
    source.slice(start, end),
    'for v in LFG_INSTALL_TAILSCALE LFG_TAILSCALE_SERVE LFG_LOCAL_HOSTNAME; do printf "%s=%s\\n" "$v" "${!v-}"; done',
  ].join("\n");
  const result = Bun.spawnSync(["bash", "-c", script], {
    env: { ...process.env, HOME: "/tmp/nonexistent-home", ...env },
  });
  const out = new TextDecoder().decode(result.stdout);
  return Object.fromEntries(
    out.trim().split("\n").filter(Boolean).map(l => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
  );
}

describe("optional steps are off by default", () => {
  test("a plain install neither installs Tailscale nor writes /etc/hosts", () => {
    const d = defaults();
    expect(d.LFG_INSTALL_TAILSCALE).toBe("0");
    expect(d.LFG_TAILSCALE_SERVE).toBe("0");
    expect(d.LFG_LOCAL_HOSTNAME).toBe("");
  });

  test("asking to be served over the tailnet implies installing it", () => {
    expect(defaults({ OMG_TAILSCALE_SERVE: "1" }).LFG_INSTALL_TAILSCALE).toBe("1");
    expect(defaults({ LFG_TAILSCALE_SERVE: "1" }).LFG_INSTALL_TAILSCALE).toBe("1");
  });

  test("each opt-in can be turned on by itself", () => {
    expect(defaults({ OMG_INSTALL_TAILSCALE: "1" }).LFG_INSTALL_TAILSCALE).toBe("1");
    // Installing the daemon is not the same as exposing the UI through it.
    expect(defaults({ OMG_INSTALL_TAILSCALE: "1" }).LFG_TAILSCALE_SERVE).toBe("0");
    expect(defaults({ OMG_LOCAL_HOSTNAME: "omg.local" }).LFG_LOCAL_HOSTNAME).toBe("omg.local");
  });
});

describe("optional steps cannot fail the install", () => {
  // The regression that motivated this: die() on a missing tailnet session.
  test("nothing in the Tailscale section calls die", () => {
    const start = source.indexOf("# ---- 8. Tailscale");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("install_linux_service()", start);
    expect(end).toBeGreaterThan(start);
    // Comments in this section describe the bug by name, so strip them first
    // and assert on what actually executes.
    const code = source
      .slice(start, end)
      .split("\n")
      .filter(line => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/\bdie\b/);
  });

  test("setup never interactively prompts for an auth key", () => {
    // A first install must not stop and demand a secret nobody offered.
    expect(source).not.toContain("read -rsp");
    expect(source).not.toMatch(/read\s+-[a-z]*p\s+"Tailscale/);
  });

  test("the hosts write stays non-fatal when sudo is unavailable", () => {
    const start = source.indexOf("ensure_local_hostname()");
    expect(start).toBeGreaterThanOrEqual(0);
    const section = source.slice(start, source.indexOf("\n}", start));
    expect(section).not.toMatch(/\bdie\b/);
    expect(section).toContain("warn");
  });
});
