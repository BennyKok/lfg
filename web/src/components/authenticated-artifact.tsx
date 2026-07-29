import {
  useEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import { artifactRequestPath, secureArtifactDocument } from "../lib/artifact-document";
import { lfgFetch } from "../lib/lfg-client";
import { cn } from "../lib/utils";
import { ZoomableImage } from "./ImageLightbox";

type ArtifactLoad<T> =
  | { status: "loading"; value: null }
  | { status: "ready"; value: T }
  | { status: "error"; value: null };

function useArtifactHtml(
  path: string,
  query?: Record<string, string | number | undefined>,
): ArtifactLoad<string> {
  const requestPath = artifactRequestPath(path, query);
  const [state, setState] = useState<ArtifactLoad<string>>({
    status: "loading",
    value: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", value: null });
    void lfgFetch(requestPath, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`artifact ${response.status}`);
        const html = secureArtifactDocument(await response.text());
        if (!controller.signal.aborted) {
          setState({ status: "ready", value: html });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ status: "error", value: null });
        }
      });
    return () => controller.abort();
  }, [requestPath]);

  return state;
}

function useArtifactBlobUrl(path: string): ArtifactLoad<string> {
  const [state, setState] = useState<ArtifactLoad<string>>({
    status: "loading",
    value: null,
  });

  useEffect(() => {
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

export function AuthenticatedArtifactFrame({
  path,
  cacheKey,
  thumbnail = false,
  title,
  frameRef,
  style,
  className,
}: {
  path: string;
  cacheKey?: string | number;
  thumbnail?: boolean;
  title?: string;
  frameRef?: RefObject<HTMLIFrameElement | null>;
  style?: CSSProperties;
  className?: string;
}) {
  const document = useArtifactHtml(path, {
    v: cacheKey,
    thumb: thumbnail ? 1 : undefined,
  });

  if (document.status === "error") {
    return <ArtifactLoadError className={className} />;
  }

  return (
    <iframe
      ref={frameRef}
      srcDoc={document.value ?? undefined}
      sandbox="allow-scripts"
      title={title}
      style={style}
      className={className}
    />
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
  const source = useArtifactBlobUrl(path);
  if (source.status === "error") {
    return <ArtifactLoadError className={className} />;
  }
  if (source.status === "loading") {
    return <ArtifactLoading className={className} />;
  }
  if (zoomable) {
    return (
      <ZoomableImage
        src={source.value}
        alt={alt}
        className={className}
      />
    );
  }
  return <img src={source.value} alt={alt} className={className} />;
}

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
  const source = useArtifactBlobUrl(path);
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
      autoPlay={autoPlay}
      playsInline
      preload="metadata"
      aria-label={label}
      className={className}
    />
  );
}
