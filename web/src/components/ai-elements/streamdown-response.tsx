"use client";

import { useEffect, useMemo, useRef, useState, type AnchorHTMLAttributes, type ComponentProps } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";

import { cn } from "@/lib/utils";

type StreamdownPlugins = NonNullable<ComponentProps<typeof Streamdown>["plugins"]>;
type AnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  node?: unknown;
};

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

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {}

  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function CopyableMarkdownLink({ children, className, href, node: _node, ...props }: AnchorProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  const canCopy = typeof href === "string" && href.length > 0;

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const copyHref = async () => {
    if (!canCopy) return;
    await copyText(href);
    setCopied(true);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1200);
  };

  if (!canCopy) {
    return (
      <a className={className} {...props}>
        {children}
      </a>
    );
  }

  return (
    <span className="inline">
      <a
        className={cn("break-all font-medium text-primary underline underline-offset-4", className)}
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        {...props}
      >
        {children}
        <ExternalLink className="ml-0.5 inline size-3 align-[-0.125em]" aria-hidden="true" />
      </a>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void copyHref();
        }}
        title={copied ? "Copied" : "Copy link"}
        aria-label={copied ? "Copied" : "Copy link"}
        className="ml-1 inline-grid size-5 place-items-center rounded text-muted-foreground align-[-0.25em] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}

export type StreamdownResponseProps = ComponentProps<typeof Streamdown>;
type StreamdownComponents = NonNullable<StreamdownResponseProps["components"]>;

export function StreamdownResponse({ className, mode = "static", children, components, ...props }: StreamdownResponseProps) {
  const plugins = useStreamdownPlugins(children);
  const markdownComponents = useMemo<StreamdownComponents>(
    () => ({ a: CopyableMarkdownLink, ...components }) as StreamdownComponents,
    [components],
  );
  return (
    <Streamdown
      className={cn("markdown msg-text size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      components={markdownComponents}
      mode={mode}
      plugins={plugins}
      {...props}
    >
      {children}
    </Streamdown>
  );
}
