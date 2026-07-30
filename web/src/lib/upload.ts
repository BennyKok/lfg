export type UploadRequest = (
  path: string,
  init: RequestInit,
  onProgress: (progress: {
    loaded: number;
    total: number;
    lengthComputable: boolean;
  }) => void,
) => Promise<Response>;

/**
 * Upload through LFG's configured runtime transport.
 *
 * Standalone LFG configures a same-origin transport; embedded hosts configure
 * their authenticated runtime origin. Keeping uploads behind that same
 * boundary makes it impossible for an embedded composer to accidentally POST
 * file bytes to the host application's origin.
 */
export async function uploadFile<T>(
  upload: UploadRequest,
  path: string,
  file: File,
  contentType: string,
  onProgress: (progress: number) => void,
): Promise<T> {
  const chunkSize = 8 * 1024 * 1024;
  const uploadId = crypto.randomUUID();
  let result: T | undefined;
  let reportedProgress = 0;

  const reportProgress = (next: number) => {
    const progress = Math.min(100, Math.max(reportedProgress, next));
    if (progress === reportedProgress) return;
    reportedProgress = progress;
    onProgress(progress);
  };

  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
    const separator = path.includes("?") ? "&" : "?";
    const response = await upload(
      `${path}${separator}uploadId=${encodeURIComponent(uploadId)}&offset=${offset}&total=${file.size}`,
      {
        method: "POST",
        headers: {
          "Content-Type": contentType || "application/octet-stream",
        },
        body: chunk,
      },
      (progress) => {
        if (!file.size) return;
        const loaded = progress.lengthComputable
          ? Math.min(chunk.size, progress.loaded)
          : 0;
        reportProgress(
          Math.round(((offset + loaded) / file.size) * 100),
        );
      },
    );
    const text = await response.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // Preserve a useful HTTP status when a proxy returns a non-JSON body.
    }
    if (!response.ok) {
      const message =
        typeof data === "object" &&
        data &&
        "error" in data &&
        typeof data.error === "string"
          ? data.error
          : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }

    result = data as T;
    reportProgress(
      Math.min(100, Math.round(((offset + chunk.size) / file.size) * 100)),
    );
  }

  return result as T;
}
