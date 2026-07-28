import { describe, expect, test } from "bun:test";
import {
  COMPUTER_HOST_RESUME_MESSAGE,
  isComputerHostResumeMessage,
  restartContinuousAnimations,
} from "../web/src/embedded-animation-recovery.ts";

function fakeAnimation(iterations: number, currentTime: number | null = 250) {
  const calls: string[] = [];
  return {
    animation: {
      effect: { getTiming: () => ({ iterations }) },
      currentTime,
      cancel() {
        calls.push("cancel");
        this.currentTime = null;
      },
      play() {
        calls.push("play");
      },
    },
    calls,
  };
}

describe("embedded animation foreground recovery", () => {
  test("accepts only the host resume protocol message", () => {
    expect(isComputerHostResumeMessage({ type: COMPUTER_HOST_RESUME_MESSAGE })).toBe(true);
    expect(isComputerHostResumeMessage({ type: "other" })).toBe(false);
    expect(isComputerHostResumeMessage(null)).toBe(false);
  });

  test("restarts infinite animations and preserves their phase", () => {
    const spinner = fakeAnimation(Infinity, 875);
    const transition = fakeAnimation(1, 120);

    expect(
      restartContinuousAnimations([spinner.animation, transition.animation]),
    ).toBe(1);
    expect(spinner.calls).toEqual(["cancel", "play"]);
    expect(spinner.animation.currentTime).toBe(875);
    expect(transition.calls).toEqual([]);
    expect(transition.animation.currentTime).toBe(120);
  });
});
