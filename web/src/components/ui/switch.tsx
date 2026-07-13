import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";
import { feedback } from "@/lib/feedback";

// iOS-style toggle. The track turns system-green when on (matching the
// --success token, which is iOS #34c759 / dark #30d158), the thumb is a
// white puck with a soft drop shadow that slides on the apple curve. Used
// for on/off settings rows where a tap flips a boolean — anything that
// *navigates* should use a row + chevron instead.
function Switch({
  className,
  onCheckedChange,
  ...props
}: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      onCheckedChange={(checked, event) => {
        // Distinct pitch for on vs off, plus a matching haptic.
        feedback.toggle(checked);
        onCheckedChange?.(checked, event);
      }}
      className={cn(
        "relative inline-flex h-[31px] w-[51px] shrink-0 items-center rounded-full p-0.5",
        "bg-foreground/[0.12] transition-colors duration-200 ease-apple",
        "data-[checked]:bg-success",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none size-[27px] rounded-full bg-white",
          "shadow-[0_1px_1px_rgba(0,0,0,0.08),0_3px_8px_rgba(0,0,0,0.18)]",
          "transition-transform duration-200 ease-apple",
          "data-[checked]:translate-x-[20px]",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
