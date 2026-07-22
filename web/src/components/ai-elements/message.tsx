"use client";

import { lazy, memo, Suspense, type ComponentProps, type HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const StreamdownResponse = lazy(() =>
  import("./streamdown-response").then((m) => ({ default: m.StreamdownResponse })),
);

type MessageRole = "user" | "assistant" | "system" | "data" | string;

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageRole;
};

export function Message({ className, from, ...props }: MessageProps) {
  return (
    <div
      className={cn(
        "group/message flex w-full min-w-0",
        from === "user" ? "justify-end" : "justify-start",
        className,
      )}
      data-role={from}
      {...props}
    />
  );
}

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export function MessageContent({ className, ...props }: MessageContentProps) {
  return (
    <div
      className={cn(
        // Default cap for assistant content that is a direct Message child.
        // User turns cap width on MessageActions instead (so the percentage
        // resolves against Message's definite width and stays right-aligned).
        "min-w-0 max-w-[92%] text-sm leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

export type MessageResponseProps = ComponentProps<typeof StreamdownResponse>;

export const MessageResponse = memo(
  ({ className, mode = "static", ...props }: MessageResponseProps) => {
    return (
      <Suspense
        fallback={
          <div className={cn("markdown msg-text size-full whitespace-pre-wrap", className)}>
            {typeof props.children === "string" ? props.children : null}
          </div>
        }
      >
        <StreamdownResponse className={className} mode={mode} {...props} />
      </Suspense>
    );
  },
  (prev, next) =>
    prev.children === next.children &&
    prev.className === next.className &&
    prev.isAnimating === next.isAnimating &&
    prev.animated === next.animated &&
    prev.mode === next.mode &&
    prev.caret === next.caret,
);

MessageResponse.displayName = "MessageResponse";
