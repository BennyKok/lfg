"use client";

import { memo, useEffect, useState, type ComponentProps, type HTMLAttributes } from "react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";

import { cn } from "@/lib/utils";

// Math (katex, ~585 KB) and mermaid (~712 KB) are heavy and only matter when a
// message actually contains math or a diagram. Keeping them in the first-paint
// bundle roughly doubled it, so we start every message with the lightweight
// cjk+code plugins and dynamically load math+mermaid once, swapping them in when
// ready. A shared module-level promise means all messages trigger a single
// load, and a tiny listener set re-renders mounted messages once it resolves.
// Until then a math/diagram block just renders as its raw fenced source for a
// beat — an acceptable trade for a much faster launch.
type StreamdownPlugins = NonNullable<ComponentProps<typeof Streamdown>["plugins"]>;

let extraPlugins: Partial<StreamdownPlugins> | null = null;
let extraPluginsPromise: Promise<void> | null = null;
const extraPluginsListeners = new Set<() => void>();

function loadExtraPlugins(): Promise<void> {
  if (!extraPluginsPromise) {
    extraPluginsPromise = Promise.all([
      import("@streamdown/math"),
      import("@streamdown/mermaid"),
    ])
      .then(([mathMod, mermaidMod]) => {
        extraPlugins = { math: mathMod.math, mermaid: mermaidMod.mermaid };
        for (const notify of extraPluginsListeners) notify();
      })
      .catch(() => {
        // Load failed (offline / transient) — let a later mount retry.
        extraPluginsPromise = null;
      });
  }
  return extraPluginsPromise;
}

function useStreamdownPlugins(): StreamdownPlugins {
  const [extra, setExtra] = useState<Partial<StreamdownPlugins> | null>(extraPlugins);
  useEffect(() => {
    if (extraPlugins) {
      setExtra(extraPlugins);
      return;
    }
    const notify = () => setExtra(extraPlugins);
    extraPluginsListeners.add(notify);
    void loadExtraPlugins();
    return () => {
      extraPluginsListeners.delete(notify);
    };
  }, []);
  return { cjk, code, ...(extra ?? {}) };
}

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
        "min-w-0 max-w-[92%] text-sm leading-relaxed group-data-[role=user]/message:max-w-[85%]",
        className,
      )}
      {...props}
    />
  );
}

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(
  ({ className, mode = "static", ...props }: MessageResponseProps) => {
    const plugins = useStreamdownPlugins();
    return (
      <Streamdown
        className={cn("markdown msg-text size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
        mode={mode}
        plugins={plugins}
        {...props}
      />
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
