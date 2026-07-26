"use client";

import { ShimmerText } from "@/components/ui/shimmer-text";
import { cn } from "@/lib/utils";

/**
 * Live "thinking" label.
 *
 * Delegates to the shared ShimmerText primitive (transitions.dev #15) rather
 * than carrying its own `.think-live` gradient. The old implementation made the
 * text fully transparent and relied on the sweeping gradient to paint it, so at
 * the ends of the sweep the label dimmed toward invisible; ShimmerText keeps a
 * solid base layer and passes the highlight over the top, so the text stays
 * legible for the whole cycle.
 */
export function Shimmer({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return <ShimmerText className={cn(className)}>{children}</ShimmerText>;
}
