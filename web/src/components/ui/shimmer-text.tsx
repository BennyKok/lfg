import { cn } from "@/lib/utils"

/**
 * Shimmering "thinking" label (transitions.dev #15) — a live alternative to a
 * spinner for streaming/in-progress copy.
 *
 * The effect needs the string in two places: once as visible text and once in
 * `data-text`, which the ::before layer re-renders to clip the moving gradient
 * onto the same glyphs. Taking `children: string` (rather than ReactNode) keeps
 * those two in sync by construction — a nested element would render into the
 * base layer but leave `data-text` empty, silently killing the shimmer.
 */
function ShimmerText({
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & { children: string }) {
  return (
    <span
      data-slot="shimmer-text"
      data-text={children}
      className={cn("lfg-shimmer-text", className)}
      {...props}
    >
      {children}
    </span>
  )
}

export { ShimmerText }
