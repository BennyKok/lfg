import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANAGER_PROTOCOL,
  ManagerRoundError,
  createManagerRoundService,
  parseManagerRoundRequest,
} from "./manager-round.ts";

let tempDir = "";

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function request(overrides: Record<string, unknown> = {}) {
  return {
    protocol: MANAGER_PROTOCOL,
    managerId: "imsg:0123456789abcdef",
    turnId: "12345678-abcd",
    round: 0,
    system: "You are helpful.",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        name: "search",
        description: "Search",
        input_schema: { type: "object", properties: {} },
      },
    ],
    ...overrides,
  };
}

describe("manager round protocol", () => {
  test("rejects unknown protocols and unsafe identifiers", () => {
    expect(() => parseManagerRoundRequest(request({ protocol: "future" }))).toThrow(
      "unsupported manager protocol",
    );
    expect(() => parseManagerRoundRequest(request({ managerId: "../escape" }))).toThrow(
      "invalid managerId",
    );
  });

  test("reports whether the Computer has local AI credentials", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lfg-manager-"));
    expect(createManagerRoundService({ dataDir: tempDir, token: () => null }).capabilities()).toEqual({
      protocol: MANAGER_PROTOCOL,
      available: false,
      model: "claude-haiku-4-5",
      reason: "claude_oauth_unavailable",
    });
    expect(
      createManagerRoundService({ dataDir: tempDir, token: () => "token" }).capabilities().available,
    ).toBe(true);
  });

  test("returns one local model round without executing tools", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lfg-manager-"));
    const sent: Record<string, unknown>[] = [];
    const service = createManagerRoundService({
      dataDir: tempDir,
      token: () => "local-token",
      fetch: (async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "tool-1", name: "search", input: { q: "hi" } }],
        });
      }),
    });

    const response = await service.run(request());
    expect(response.stopReason).toBe("tool_use");
    expect(response.content[0]?.type).toBe("tool_use");
    expect(sent[0]?.system).toBe("You are helpful.");
    expect(sent[0]?.tools).toHaveLength(1);
  });

  test("deduplicates concurrent and later delivery retries", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lfg-manager-"));
    let calls = 0;
    const service = createManagerRoundService({
      dataDir: tempDir,
      token: () => "local-token",
      fetch: (async () => {
        calls += 1;
        await Bun.sleep(10);
        return Response.json({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "hello" }],
        });
      }),
    });

    const [first, concurrent] = await Promise.all([service.run(request()), service.run(request())]);
    const later = await service.run(request());
    expect(calls).toBe(1);
    expect(concurrent).toEqual(first);
    expect(later).toEqual(first);
  });

  test("fails closed when local AI is unavailable", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lfg-manager-"));
    const service = createManagerRoundService({ dataDir: tempDir, token: () => null });
    await expect(service.run(request())).rejects.toEqual(
      expect.objectContaining({ status: 503 }),
    );
  });
});
