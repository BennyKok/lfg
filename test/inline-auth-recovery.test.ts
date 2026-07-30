import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync("web/src/App.tsx", "utf8");

describe("inline coding-agent auth recovery", () => {
  test("starts provider login for the blocked session", () => {
    expect(app).toContain("await authFlow.start(reconnectKind as AgentKind, sid)");
    expect(app).toContain("Sign in to ${reconnectLabel}");
  });

  test("reuses the shared auth panel inline instead of opening the dialog", () => {
    expect(app).toContain("<CodingAgentAuthPanel");
    expect(app).toContain("inline\n          onSessionChange={authFlow.setSession}");
    expect(app).toContain("session={codingAgentAuthInlineSid ? null : codingAgentAuth}");
  });

  test("shows a retry handoff after reconnecting", () => {
    expect(app).toContain("Send your message again to resume this session.");
    expect(app).toContain("completedSid: codingAgentAuthCompletedSid");
  });
});
