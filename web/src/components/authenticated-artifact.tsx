import { useEffect, useState } from "react";

import { artifactRequestPath } from "../lib/artifact-document";
import { lfgFetch } from "../lib/lfg-client";
import { cn } from "../lib/utils";
import { ImageLightbox } from "./ImageLightbox";

type ArtifactLoad<T> =
  | { status: "loading"; value: null }
  | { status: "ready"; value: T }
  | { status: "error"; value: null };

/** @param path `null` defers the fetch entirely (used to load full-size bytes only on zoom). */
function useArtifactBlobUrl(path: string | null): ArtifactLoad<string> {
  const [state, setState] = useState<ArtifactLoad<string>>({
    status: "loading",
    value: null,
  });

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ status: "loading", value: null });
    void lfgFetch(path, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`artifact ${response.status}`);
        objectUrl = URL.createObjectURL(await response.blob());
        if (controller.signal.aborted) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
          return;
        }
        setState({ status: "ready", value: objectUrl });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ status: "error", value: null });
        }
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  return state;
}

function ArtifactLoadError({ className }: { className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        "flex min-h-28 min-w-40 items-center justify-center bg-muted/35 px-4 text-center text-xs text-muted-foreground",
        className,
      )}
    >
      Artifact couldn’t load.
    </div>
  );
}

function ArtifactLoading({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("min-h-28 min-w-40 animate-pulse bg-muted/35", className)}
    />
  );
}

/**
 * A zoomable authenticated image that does NOT download the original to show a
 * thumbnail.
 *
 * `ZoomableImage` appends `?preview=1` to get the server's ~1200px webp, but it
 * has to skip that for `blob:` URLs — and every authenticated image is a blob,
 * because the bytes arrive through the transport rather than the `<img>` element.
 * So the feed was rendering 176px tiles out of full-size originals (up to 25 MB
 * each, several per post). Fetch the preview for the tile and the original only
 * once someone actually zooms in.
 */
function AuthenticatedZoomableImage({
  path,
  alt,
  className,
}: {
  path: string;
  alt: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const preview = useArtifactBlobUrl(artifactRequestPath(path, { preview: 1 }));
  const full = useArtifactBlobUrl(open ? path : null);

  if (preview.status === "error") return <ArtifactLoadError className={className} />;
  if (preview.status === "loading") return <ArtifactLoading className={className} />;

  return (
    <>
      <img
        src={preview.value}
        alt={alt}
        loading="lazy"
        decoding="async"
        onClick={() => setOpen(true)}
        className={cn("cursor-zoom-in", className)}
      />
      {/* Falls back to the preview until the original arrives, so opening the
          lightbox never shows an empty frame. */}
      <ImageLightbox
        src={full.value ?? preview.value}
        alt={alt}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export function AuthenticatedArtifactImage({
  path,
  alt,
  zoomable = false,
  className,
}: {
  path: string;
  alt: string;
  zoomable?: boolean;
  className?: string;
}) {
  if (zoomable) {
    return <AuthenticatedZoomableImage path={path} alt={alt} className={className} />;
  }
  return <AuthenticatedPlainImage path={path} alt={alt} className={className} />;
}

function AuthenticatedPlainImage({
  path,
  alt,
  className,
}: {
  path: string;
  alt: string;
  className?: string;
}) {
  const source = useArtifactBlobUrl(path);
  if (source.status === "error") {
    return <ArtifactLoadError className={className} />;
  }
  if (source.status === "loading") {
    return <ArtifactLoading className={className} />;
  }
  return <img src={source.value} alt={alt} className={className} />;
}

/**
 * Authenticated video.
 *
 * `preload="metadata"` is a lie here: the bytes arrive through the transport as a
 * blob, so by the time the `<video>` exists the whole file is already in memory.
 * On the Shipped feed that meant one 2 MB clip was downloaded just to paint a
 * thumbnail nobody had pressed play on — more than every image on the page
 * combined. So unless the caller actually wants playback now (`autoPlay`, i.e.
 * the full-page viewer), wait for the tap.
 */
export function AuthenticatedArtifactVideo({
  path,
  label,
  controls = true,
  autoPlay = false,
  className,
}: {
  path: string;
  label?: string;
  controls?: boolean;
  autoPlay?: boolean;
  className?: string;
}) {
  const [requested, setRequested] = useState(autoPlay);
  const source = useArtifactBlobUrl(requested ? path : null);

  if (!requested) {
    return (
      <button
        type="button"
        onClick={() => setRequested(true)}
        aria-label={label ? `Play ${label}` : "Play video"}
        className={cn(
          "group relative flex items-center justify-center bg-black/90",
          className,
        )}
      >
        <span className="flex size-11 items-center justify-center rounded-full bg-white/15 backdrop-blur transition-transform group-hover:scale-105 group-active:scale-95">
          {/* Inline so this component keeps no icon-library dependency. */}
          <svg viewBox="0 0 24 24" aria-hidden className="size-5 translate-x-[1px] fill-white">
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      </button>
    );
  }
  if (source.status === "error") {
    return <ArtifactLoadError className={className} />;
  }
  if (source.status === "loading") {
    return <ArtifactLoading className={className} />;
  }
  return (
    <video
      src={source.value}
      controls={controls}
      // Requested by an explicit tap, so start playing rather than making the
      // user press play a second time.
      autoPlay
      playsInline
      aria-label={label}
      className={className}
    />
  );
}
