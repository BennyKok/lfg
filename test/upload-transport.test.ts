import { expect, test } from "bun:test";
import { uploadFile } from "../web/src/lib/upload";

test("uploadFile sends chunks through its runtime transport", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const progress: number[] = [];
  const file = new File(["image bytes"], "image.png", { type: "image/png" });

  const uploaded = await uploadFile<{ path: string; name: string }>(
    async (path, init) => {
      requests.push({ path, init });
      return Response.json({
        path: "/tmp/lfg-uploads/image.png",
        name: "image.png",
      });
    },
    "/api/uploads?filename=image.png",
    file,
    file.type,
    (value) => progress.push(value),
  );

  expect(uploaded).toEqual({
    path: "/tmp/lfg-uploads/image.png",
    name: "image.png",
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.path).toMatch(
    /^\/api\/uploads\?filename=image\.png&uploadId=[0-9a-f-]+&offset=0&total=11$/,
  );
  expect(requests[0]!.init?.method).toBe("POST");
  expect(new Headers(requests[0]!.init?.headers).get("Content-Type")).toBe(
    "image/png",
  );
  expect(requests[0]!.init?.body).toBeInstanceOf(Blob);
  expect(progress).toEqual([100]);
});

test("uploadFile reports byte progress supplied by the runtime transport", async () => {
  const progress: number[] = [];
  const file = new File(["image bytes"], "image.png", { type: "image/png" });

  await uploadFile(
    async (_path, _init, onProgress) => {
      onProgress?.({ loaded: 2, total: file.size, lengthComputable: true });
      onProgress?.({ loaded: 7, total: file.size, lengthComputable: true });
      return Response.json({
        path: "/tmp/lfg-uploads/image.png",
        name: "image.png",
      });
    },
    "/api/uploads?filename=image.png",
    file,
    file.type,
    (value) => progress.push(value),
  );

  expect(progress).toEqual([18, 64, 100]);
});

test("uploadFile never moves progress backward when a transport retries", async () => {
  const progress: number[] = [];
  const file = new File(["image bytes"], "image.png", { type: "image/png" });

  await uploadFile(
    async (_path, _init, onProgress) => {
      onProgress?.({ loaded: 8, total: file.size, lengthComputable: true });
      onProgress?.({ loaded: 3, total: file.size, lengthComputable: true });
      return Response.json({ path: "/tmp/lfg-uploads/image.png" });
    },
    "/api/uploads",
    file,
    file.type,
    (value) => progress.push(value),
  );

  expect(progress).toEqual([73, 100]);
});

test("uploadFile retains the runtime response error", async () => {
  const file = new File(["x"], "x.txt", { type: "text/plain" });

  await expect(
    uploadFile(
      async () => Response.json({ error: "disk is full" }, { status: 507 }),
      "/api/uploads",
      file,
      file.type,
      () => {},
    ),
  ).rejects.toThrow("disk is full");
});
