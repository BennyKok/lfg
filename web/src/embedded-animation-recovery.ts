// Foreground recovery for continuous animations inside the omg Computer frame.
//
// WebKit can leave a cross-origin iframe's infinite CSS animations suspended
// after the top-level tab/window returns. The host owns foreground detection
// and forwards this message; LFG owns which animation timelines are safe to
// restart. Finite transitions are deliberately excluded so resume never
// replays entrances or other one-shot motion.

export const COMPUTER_HOST_RESUME_MESSAGE = "omg:computer-host-resume";

type ContinuousAnimation = {
  effect: { getTiming(): { iterations?: number } } | null;
  currentTime: CSSNumberish | null;
  cancel(): void;
  play(): void;
};

export function isComputerHostResumeMessage(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === COMPUTER_HOST_RESUME_MESSAGE
  );
}

export function restartContinuousAnimations(
  animations: Iterable<ContinuousAnimation>,
): number {
  let restarted = 0;
  for (const animation of animations) {
    if (animation.effect?.getTiming().iterations !== Infinity) continue;
    const currentTime = animation.currentTime;
    animation.cancel();
    animation.play();
    if (currentTime !== null) animation.currentTime = currentTime;
    restarted += 1;
  }
  return restarted;
}
