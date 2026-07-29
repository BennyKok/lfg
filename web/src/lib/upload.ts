export type UploadFetch = (
  path: string,
  init?: RequestInit,
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
  fetchImpl: UploadFetch,
  path: string,
  file: File,
  contentType: string,
  onProgress: (progress: number) => void,
): Promise<T> {
  const chunkSize = 8 * 1024 * 1024;
  const uploadId = crypto.randomUUID();
  let result: T | undefined;

  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
    const separator = path.includes("?") ? "&" : "?";
    const response = await fetchImpl(
      `${path}${separator}uploadId=${encodeURIComponent(uploadId)}&offset=${offset}&total=${file.size}`,
      {
        method: "POST",
        headers: {
          "Content-Type": contentType || "application/octet-stream",
        },
        body: chunk,
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
    onProgress(
      Math.min(100, Math.round(((offset + chunk.size) / file.size) * 100)),
    );
  }

  return result as T;
}
