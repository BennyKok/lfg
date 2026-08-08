// `omg update` exists because the capability was reachable twice and obvious
// neither time: a button in the web UI, and `omg setup`, which reads like it
// might reconfigure the machine. From a terminal there was no answer to "how do
// I just update?".
//
// It deliberately drives the same code path the UI button does, so there is one
// update mechanism rather than a second that drifts out of step with it.
import { describe, expect, test } from "bun:test";
import { cmdUpdate } from "./update.ts";

function harness(channel: string) {
  const output: string[] = [];
  return {
    output,
    deps: {
      root: "/opt/omg",
      install: { channel, repoSlug: "BennyKok/omg.dev" } as never,
      output: (message: string) => output.push(message),
    },
  };
}

describe("argument handling", () => {
  test("help is read-only and names the flag", async () => {
    const h = harness("release");
    await cmdUpdate(["--help"], h.deps);
    expect(h.output[0]).toContain("omg update");
    expect(h.output.join("\n")).toContain("--check");
  });

  test("an unknown option is rejected rather than ignored", async () => {
    const h = harness("release");
    await expect(cmdUpdate(["--forse"], h.deps)).rejects.toThrow("Unknown update option");
  });
});

describe("installs that cannot update themselves", () => {
  // A container image is rebuilt and redeployed. Saying so beats failing
  // halfway through swapping files in a filesystem that will not persist.
  test("a container install explains itself instead of trying", async () => {
    const h = harness("container");
    await expect(cmdUpdate([], h.deps)).rejects.toThrow("container install");
    expect(h.output).toEqual([]);
  });

  test("an unrecognised channel does not attempt an update", async () => {
    const h = harness("unknown");
    await expect(cmdUpdate([], h.deps)).rejects.toThrow("Update it through the deployment");
  });
});
