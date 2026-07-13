import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { feedback } from "@/lib/feedback"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-4xl border border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap transition-[transform,background-color,box-shadow,color,border-color,filter,opacity] duration-200 ease-apple outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.97] active:transition-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "lfg-gborder bg-primary text-primary-foreground shadow-[0_1px_2px_oklch(0_0_0/15%),0_2px_6px_oklch(0_0_0/10%)] hover:bg-primary/90 hover:shadow-[0_1px_3px_oklch(0_0_0/20%),0_3px_8px_oklch(0_0_0/12%)]",
        // Primary brand CTA — coral gradient with warm halo. Matches the
        // design's "Start building" / FAB / send-arrow treatment exactly.
        brand: "lfg-gborder lfg-gborder--brand bg-brand-gradient hover:brightness-[1.04]",
        // Quiet icon chip — faint foreground tint, used for ghost-style
        // affordances (cog, dismiss X). Different from `ghost` because it
        // shows a visible chip *at rest*, not only on hover.
        tint: "lfg-gborder bg-foreground/[0.06] text-foreground/70 hover:bg-foreground/[0.10] hover:text-foreground",
        // Soft brand tint — a brand-tinted chip at rest, for secondary
        // brand affordances (e.g. "Add sign-in"). Lighter than `brand`'s
        // filled gradient CTA.
        "brand-soft": "lfg-gborder bg-brand/12 text-brand hover:bg-brand/20",
        outline:
          "lfg-gborder bg-input/30 hover:bg-input/50 hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        secondary:
          "lfg-gborder bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-9 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 px-2.5 text-xs has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        lg: "h-10 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  onClick,
  feedbackSilent = false,
  ...props
}: ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /** Opt out of the shared press sound/haptic for this button. */
    feedbackSilent?: boolean
  }) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      onClick={(event) => {
        // `link` reads as text, not a control — keep it silent. Everything else
        // gets a subtle press tick + light haptic (both user-toggleable).
        if (!feedbackSilent && !props.disabled && variant !== "link") {
          feedback.tap()
        }
        onClick?.(event)
      }}
      {...props}
    />
  )
}

export { Button, buttonVariants }
