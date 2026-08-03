import { describe, expect, test } from "bun:test";

import {
  configuredAgentOptions,
  displayedAgentOption,
} from "../web/src/lib/coding-agent-options";

const catalog = [
  { key: "aisdk", label: "claude" },
  { key: "opencode", label: "opencode" },
];

describe("coding agent options", () => {
  test("the loading placeholder reflects the saved agent", () => {
    expect(displayedAgentOption(catalog, [], "opencode", "opencode")).toEqual(
      catalog[1],
    );
  });

  test("the configured roster remains authoritative after bootstrap", () => {
    const visible = configuredAgentOptions(
      catalog,
      [
        {
          key: "opencode",
          visible: true,
          status: { configured: true, accountConnected: false },
        },
      ],
      "connected-or-opencode",
    );

    expect(displayedAgentOption(catalog, visible, "opencode", "opencode")).toEqual(
      catalog[1],
    );
  });
});
