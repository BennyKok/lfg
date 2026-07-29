import { useEffect, useState } from "react";

import { lfgFetch } from "../lib/lfg-client";
import { cn } from "../lib/utils";
import { ZoomableImage } from "./ImageLightbox";

type ArtifactLoad<T> =
  | { status: "loading"; value: null }
  | { status: "ready"; value: T }
  | { status: "error"; value: null };

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
        "flex min-h-28 items-center justify-center bg-muted/35 px-4 text-center text-xs text-muted-foreground",
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
        src={source.value ?? ""}
        alt={alt}
        className={className}
      />
    );
  }
  return (
    <img
      src={source.value ?? undefined}
      alt={alt}
      className={className}
    />
  );
}
