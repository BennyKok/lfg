// Renders an HTML artifact in the host document, picking the renderer that is
// faithful to the artifact rather than applying one everywhere.
//
// MOST artifacts are a `<style>` block plus static markup, and those render as
// real DOM in a shadow root (see `lib/native-artifact.ts` for the sanitizing
// contract). That buys three things an iframe cannot: no browsing context per
// artifact — which is what made a page of gallery tiles expensive — cacheable
// responses, and real layout, so embeds size themselves and the old postMessage
// height reporter (a `setInterval` forcing a layout every second, per artifact)
// is gone. Shadow DOM is what makes it safe: the artifact's `<style>` cannot leak
// into LFG's UI and LFG's Tailwind reset cannot leak into the artifact.
//
// An artifact whose content is PRODUCED BY SCRIPTS is a different document, and
// rendering it natively would show a hollow version of itself. Those go to a
// sandboxed iframe automatically — not as a fallback, as the right renderer.
// Artifact JavaScript never runs in the host origin either way.

import { useEffect, useMemo, useRef, useState } from "react";

import {
  NATIVE_ARTIFACT_BASE_CSS,
  parseNativeArtifact,
  type NativeArtifactDocument,
} from "../lib/native-artifact";
import {
  artifactRequestPath,
  secureArtifactDocument,
  type ArtifactTheme,
} from "../lib/artifact-document";
import { lfgFetch } from "../lib/lfg-client";
import { THEME_CHANGE_EVENT } from "../lib/theme";
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
/**
 * The parsed document plus the source it came from.
 *
 * The raw text is retained deliberately: an artifact that needs scripting is
 * handed straight to a sandboxed frame as `srcDoc`, and keeping the source means
 * that costs no second request.
 */
type LoadedArtifact = {
  parsed: NativeArtifactDocument;
  source: string;
};

function currentArtifactTheme(): ArtifactTheme {
  return typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

function useArtifactTheme(): ArtifactTheme {
  const [theme, setTheme] = useState<ArtifactTheme>(currentArtifactTheme);

  useEffect(() => {
    const sync = () => setTheme(currentArtifactTheme());
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);

  return theme;
}

function useNativeArtifact(
  path: string,
  cacheKey?: string | number,
): Load<LoadedArtifact> {
  // `native=1` tells the server to skip injecting the height reporter: we would
  // strip the script anyway, and it makes the response cacheable.
  const requestPath = artifactRequestPath(path, { v: cacheKey, native: 1 });
  const [state, setState] = useState<Load<LoadedArtifact>>({
    status: "loading",
    value: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", value: null });
    void lfgFetch(requestPath, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`artifact ${response.status}`);
        const source = await response.text();
        const parsed = parseNativeArtifact(source);
        if (!controller.signal.aborted) setState({ status: "ready", value: { parsed, source } });
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
 * Render an artifact — natively when that is faithful, in a sandboxed frame when
 * it is not.
 *
 * The frame is not a fallback for failure, it is the correct renderer for a
 * document whose content is produced by scripts. Shadow DOM cannot run those
 * (and must not, in the host origin), so an artifact that scripts is handed to
 * `<iframe srcDoc sandbox="allow-scripts">` automatically. The choice is made
 * from the parsed document rather than declared by the caller, and the source is
 * already in hand, so it costs no extra request.
 *
 * @param interactive When false, always render natively. Thumbnails pass this:
 * a tile is a preview, and booting a browsing context per tile is the cost the
 * native path exists to avoid.
 * @param onNeedsFrame Reports that this artifact scripts, so a caller can label
 * a preview that is therefore not the whole picture.
 */
export function NativeArtifact({
  path,
  cacheKey,
  interactive = true,
  className,
  style,
  title,
  onNeedsFrame,
}: {
  path: string;
  cacheKey?: string | number;
  interactive?: boolean;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  onNeedsFrame?: (needsFrame: boolean) => void;
}) {
  const load = useNativeArtifact(path, cacheKey);
  const theme = useArtifactTheme();
  const needsFrame = load.status === "ready" && load.value.parsed.hasScripts;

  // Held in a ref so callers can pass an inline arrow without the effect
  // re-firing (and re-notifying) on every parent render.
  const notifyRef = useRef(onNeedsFrame);
  notifyRef.current = onNeedsFrame;
  useEffect(() => {
    if (load.status === "ready") notifyRef.current?.(needsFrame);
  }, [load.status, needsFrame]);

  if (load.status === "error") {
    return <ArtifactMessage className={className}>Artifact couldn’t load.</ArtifactMessage>;
  }
  if (load.status === "loading") {
    return <div aria-hidden className={cn("min-h-28 animate-pulse bg-muted/35", className)} />;
  }
  if (needsFrame && interactive) {
    return (
      <iframe
        // `secureArtifactDocument` re-applies the server's lockdown as a meta
        // CSP, which an authenticated fetch would otherwise have dropped along
        // with the response headers.
        srcDoc={secureArtifactDocument(load.value.source, theme)}
        sandbox="allow-scripts"
        title={title}
        style={style}
        className={cn("border-0 bg-card", className)}
      />
    );
  }
  return (
    <ArtifactShadowRoot document={load.value.parsed} className={className} style={style} />
  );
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
  const [scripted, setScripted] = useState(false);
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
    <div ref={boxRef} className={cn("relative overflow-hidden bg-card", className)}>
      {visible ? (
        <NativeArtifact
          path={path}
          cacheKey={cacheKey}
          // Always native here, even for a scripted artifact: a tile is a
          // preview, and a browsing context per tile is the cost this path
          // exists to avoid. The badge below keeps that honest.
          interactive={false}
          onNeedsFrame={setScripted}
          className="pointer-events-none h-[200%] w-[200%] origin-top-left scale-50 select-none"
        />
      ) : null}
      {scripted ? (
        <span
          // Without this, a chart that draws itself in JS reads as a broken tile.
          title="Interactive — open to run it"
          className="pointer-events-none absolute right-1 top-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-white/90"
        >
          Interactive
        </span>
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
  title,
  className,
}: {
  path: string;
  cacheKey?: string | number;
  maxHeight?: number;
  title?: string;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // A framed artifact has no intrinsic height — an `<iframe>` defaults to 150px
  // regardless of its document — so it gets a fixed viewport with its own scroll
  // instead of the grow-to-content treatment.
  const [framed, setFramed] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Measure the rendered artifact rather than asking it how tall it is.
  //
  // The measurement is applied on the next frame, NOT inside the observer
  // callback. Flipping `overflows` mounts the "Show more" button, which resizes
  // the observed subtree — mutating layout during delivery is what produces
  // "ResizeObserver loop completed with undelivered notifications", and LFG's
  // client-error reporter surfaces that as a user-visible toast.
  useEffect(() => {
    if (framed) return;
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const obs = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setOverflows(el.scrollHeight > maxHeight + 8);
      });
    });
    obs.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      obs.disconnect();
    };
  }, [maxHeight, framed]);

  const boxStyle = useMemo(
    () => (framed ? { height: maxHeight } : expanded ? undefined : { maxHeight }),
    [framed, expanded, maxHeight],
  );

  return (
    <div className={cn("relative w-full", className)}>
      <div
        ref={wrapRef}
        className="relative w-full overflow-hidden rounded-lg bg-card"
        style={boxStyle}
      >
        <NativeArtifact
          path={path}
          cacheKey={cacheKey}
          title={title}
          onNeedsFrame={setFramed}
          className={cn("block w-full", framed && "h-full")}
        />
        {!framed && !expanded && overflows ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white to-transparent" />
        ) : null}
      </div>
      {!framed && overflows ? (
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
