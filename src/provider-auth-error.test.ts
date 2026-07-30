import { describe, expect, test } from "bun:test";
import { isProviderAuthError } from "./provider-auth-error";

describe("provider auth error classification", () => {
  test("recognizes the Claude expired OAuth failure", () => {
    expect(
      isProviderAuthError(
        "Failed to authenticate: OAuth session expired and could not be refreshed",
      ),
    ).toBe(true);
  });

  test("recognizes common expired-login variants", () => {
    expect(isProviderAuthError("Authentication token has expired")).toBe(true);
    expect(isProviderAuthError("Your sign-in session expired")).toBe(true);
    expect(isProviderAuthError("invalid refresh token")).toBe(true);
  });

  test("does not misclassify model or billing failures", () => {
    expect(isProviderAuthError("The selected model may not exist")).toBe(false);
    expect(isProviderAuthError("Your credit balance is too low")).toBe(false);
  });
});
