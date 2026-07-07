"use client";

import { useEffect, useState, type ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";

import { cn } from "@/lib/utils";

type StreamdownPlugins = NonNullable<ComponentProps<typeof Streamdown>["plugins"]>;

let extraPlugins: Partial<StreamdownPlugins> | null = null;
let extraPluginsPromise: Promise<void> | null = null;
const extraPluginsListeners = new Set<() => void>();

function needsExtraPlugins(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /```(?:mermaid|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|xychart|block-beta|architecture-beta|packet-beta)\b/i.test(value)
    || /(^|\n)\s*(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart)\b/.test(value)
    || /(^|[^\\])(\$\$|\\\(|\\\[)/.test(value);
}

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
        extraPluginsPromise = null;
      });
  }
  return extraPluginsPromise;
}

function useStreamdownPlugins(children: unknown): StreamdownPlugins {
  const shouldLoadExtra = needsExtraPlugins(children);
  const [extra, setExtra] = useState<Partial<StreamdownPlugins> | null>(
    shouldLoadExtra ? extraPlugins : null,
  );
  useEffect(() => {
    if (!shouldLoadExtra) {
      setExtra(null);
      return;
    }
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
  }, [shouldLoadExtra]);
  return { cjk, code, ...(extra ?? {}) };
}

export type StreamdownResponseProps = ComponentProps<typeof Streamdown>;

export function StreamdownResponse({ className, mode = "static", children, ...props }: StreamdownResponseProps) {
  const plugins = useStreamdownPlugins(children);
  return (
    <Streamdown
      className={cn("markdown msg-text size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      mode={mode}
      plugins={plugins}
      {...props}
    >
      {children}
    </Streamdown>
  );
}
