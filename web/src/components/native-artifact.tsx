// Renders an HTML artifact as real DOM in the host document — no iframe.
//
// See `lib/native-artifact.ts` for why, and for the sanitizing contract. This
// file owns only the React/shadow-root plumbing:
//
//   * one shadow root per artifact, so the artifact's `<style>` cannot leak into
//     LFG's UI and LFG's Tailwind reset cannot leak into the artifact;
//   * `adoptedStyleSheets` when the engine supports constructable stylesheets
//     (one parsed sheet, shared across re-renders) with a `<style>` fallback;
//   * natural height. This is the whole point of going native: layout is real,
//     so embeds size themselves and the old postMessage height reporter — a
//     `setInterval` forcing a layout every second, per artifact — is gone.

import { useEffect, useMemo, useRef, useState } from "react";

import {
  NATIVE_ARTIFACT_BASE_CSS,
  parseNativeArtifact,
  type NativeArtifactDocument,
} from "../lib/native-artifact";
import { artifactRequestPath } from "../lib/artifact-document";
import { lfgFetch } from "../lib/lfg-client";
import { cn } from "../lib/utils";

type Load<T> =
  | { status: "loading"; value: null }
  | { status: "ready"; value: T }
  | { status: "error"; value: null };

/**
 * Fetch + parse an artifact document.
 *
 * Unlike the old frame loader this does NOT pass `cache: "no-store"`. The
 * request carries the artifact's content revision (`v=`), so the URL changes
 * whenever the bytes change and the browser's HTTP cache is free to serve a
 * revisit — and to collapse the duplicate requests a gallery page makes for the
 * same artifact.
 */
function useNativeArtifact(
  path: string,
  cacheKey?: string | number,
): Load<NativeArtifactDocument> {
  // `native=1` tells the server to skip injecting the height reporter: we would
  // strip the script anyway, and it makes the response cacheable.
  const requestPath = artifactRequestPath(path, { v: cacheKey, native: 1 });
  const [state, setState] = useState<Load<NativeArtifactDocument>>({
    status: "loading",
    value: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", value: null });
    void lfgFetch(requestPath, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`artifact ${response.status}`);
        const parsed = parseNativeArtifact(await response.text());
        if (!controller.signal.aborted) setState({ status: "ready", value: parsed });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "error", value: null });
      });
    return () => controller.abort();
  }, [requestPath]);

  return state;
}

/**
 * Mount sanitized artifact markup into a shadow root.
 *
 * The shadow root is created once per host element and then patched in place, so
 * a content refresh does not tear down and rebuild the subtree.
 */
function ArtifactShadowRoot({
  document: parsed,
  className,
  style,
}: {
  document: NativeArtifactDocument;
  className?: string;
  style?: React.CSSProperties;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<ShadowRoot | null>(null);
  const sheetRef = useRef<CSSStyleSheet | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let root = rootRef.current;
    if (!root) {
      // `shadowRoot` may already exist if React reused the node across a remount.
      root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      rootRef.current = root;
    }

    const css = `${NATIVE_ARTIFACT_BASE_CSS}\n${parsed.css}`;
    let adopted = false;
    if (typeof CSSStyleSheet !== "undefined" && "adoptedStyleSheets" in root) {
      try {
        const sheet = sheetRef.current ?? new CSSStyleSheet();
        sheet.replaceSync(css);
        sheetRef.current = sheet;
        root.adoptedStyleSheets = [sheet];
        adopted = true;
      } catch {
        // Fall through to a plain <style> element below.
      }
    }

    // Assigning innerHTML does not execute <script>, and the parser already
    // removed them along with inline handlers — this is the second of two
    // independent reasons artifact JS cannot run in the host origin.
    root.innerHTML = adopted ? parsed.html : `<style>${css}</style>${parsed.html}`;
  }, [parsed]);

  return <div ref={hostRef} className={className} style={style} />;
}

function ArtifactMessage({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex min-h-28 items-center justify-center bg-muted/35 px-4 text-center text-xs text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The native artifact renderer.
 *
 * @param onScriptsDetected Called when the source document contained scripting
 * that was stripped, so a caller can offer the isolated-frame opt-in.
 */
export function NativeArtifact({
  path,
  cacheKey,
  className,
  style,
  onScriptsDetected,
}: {
  path: string;
  cacheKey?: string | number;
  className?: string;
  style?: React.CSSProperties;
  onScriptsDetected?: (hasScripts: boolean) => void;
}) {
  const load = useNativeArtifact(path, cacheKey);
  const hasScripts = load.status === "ready" && load.value.hasScripts;

  // Held in a ref so callers can pass an inline arrow without the effect
  // re-firing (and re-notifying) on every parent render.
  const notifyRef = useRef(onScriptsDetected);
  notifyRef.current = onScriptsDetected;
  useEffect(() => {
    if (load.status === "ready") notifyRef.current?.(hasScripts);
  }, [load.status, hasScripts]);

  if (load.status === "error") {
    return <ArtifactMessage className={className}>Artifact couldn’t load.</ArtifactMessage>;
  }
  if (load.status === "loading") {
    return <div aria-hidden className={cn("min-h-28 animate-pulse bg-muted/35", className)} />;
  }
  return <ArtifactShadowRoot document={load.value} className={className} style={style} />;
}

/**
 * A native artifact clipped to a preview box.
 *
 * Replaces the gallery's live sandboxed frames. The old tile scaled a whole
 * document to 50%; this scales real DOM the same way, so the tile reads the same
 * while costing one fetch and one shadow root instead of a browsing context.
 */
export function NativeArtifactThumbnail({
  path,
  cacheKey,
  className,
}: {
  path: string;
  cacheKey?: string | number;
  className?: string;
}) {
  const [visible, setVisible] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Still gated on visibility: a page of tiles is a page of fetches, and a
  // shadow root for an off-screen tile is layout work nobody asked for.
  useEffect(() => {
    if (visible) return;
    const el = boxRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "300px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [visible]);

  return (
    <div ref={boxRef} className={cn("relative overflow-hidden bg-white", className)}>
      {visible ? (
        <NativeArtifact
          path={path}
          cacheKey={cacheKey}
          className="pointer-events-none h-[200%] w-[200%] origin-top-left scale-50 select-none"
        />
      ) : null}
    </div>
  );
}

/**
 * A native artifact embedded in a scrolling transcript or feed.
 *
 * Grows to the document's real height up to `maxHeight`, then offers an expand
 * affordance instead of trapping a nested scroll region inside the page scroll.
 */
export function NativeArtifactEmbed({
  path,
  cacheKey,
  maxHeight = 560,
  className,
}: {
  path: string;
  cacheKey?: string | number;
  maxHeight?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Measure the rendered artifact rather than asking it how tall it is.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver(() => {
      setOverflows(el.scrollHeight > maxHeight + 8);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [maxHeight]);

  const boxStyle = useMemo(
    () => (expanded ? undefined : { maxHeight }),
    [expanded, maxHeight],
  );

  return (
    <div className={cn("relative w-full", className)}>
      <div
        ref={wrapRef}
        className="relative w-full overflow-hidden rounded-lg bg-white"
        style={boxStyle}
      >
        <NativeArtifact path={path} cacheKey={cacheKey} className="block w-full" />
        {!expanded && overflows ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white to-transparent" />
        ) : null}
      </div>
      {overflows ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
