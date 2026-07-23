import { describe, it, expect, beforeEach, vi } from "vitest";
import { createUploadAttachmentAdapter } from "@/features/assistant/model/attachment-adapter";
import type { PendingAttachment } from "@assistant-ui/react";

/**
 * Chat attachment adapter (features/assistant/model/attachment-adapter.ts).
 * Bridges the composer to the upload route:
 *
 *  1. add() → pending attachment tagged image|document, awaiting send.
 *  2. send() → POSTs to /api/upload and emits the right message part:
 *     image/* → { type:'image', image:url }, else → { type:'file', data:url }.
 *  3. send() surfaces upload failures (doesn't silently drop the attachment).
 *
 * We stub global fetch (the adapter is a client module; no real upload route).
 */

function pending(file: File): PendingAttachment {
  return {
    id: file.name,
    type: file.type.startsWith("image/") ? "image" : "document",
    name: file.name,
    contentType: file.type,
    file,
    status: { type: "requires-action", reason: "composer-send" },
  };
}

function mockUploadOk(url: string, contentType: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ url, key: "k", contentType }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("upload attachment adapter", () => {
  it("accepts images and pdf", () => {
    const adapter = createUploadAttachmentAdapter();
    expect(adapter.accept).toContain("image/png");
    expect(adapter.accept).toContain("application/pdf");
  });

  it("add() marks an image as pending, awaiting send", async () => {
    const adapter = createUploadAttachmentAdapter();
    const file = new File([new Uint8Array(4)], "p.png", { type: "image/png" });
    // add() is typed as Promise | AsyncGenerator; this adapter always resolves
    // a single PendingAttachment.
    const result = (await adapter.add({ file })) as PendingAttachment;
    expect(result.type).toBe("image");
    expect(result.status).toEqual({
      type: "requires-action",
      reason: "composer-send",
    });
    expect(result.file).toBe(file);
  });

  it("send() uploads and emits an image part for images", async () => {
    const url = "http://localhost:9200/casper-uploads/uploads/u/k.png";
    mockUploadOk(url, "image/png");
    const adapter = createUploadAttachmentAdapter();
    const file = new File([new Uint8Array(4)], "p.png", { type: "image/png" });

    const complete = await adapter.send(pending(file));

    expect(fetch).toHaveBeenCalledWith("/api/upload", expect.any(Object));
    expect(complete.status).toEqual({ type: "complete" });
    expect(complete.content).toEqual([
      { type: "image", image: url, filename: "p.png" },
    ]);
  });

  it("send() emits a file part for non-images (pdf)", async () => {
    const url = "http://localhost:9200/casper-uploads/uploads/u/k.pdf";
    mockUploadOk(url, "application/pdf");
    const adapter = createUploadAttachmentAdapter();
    const file = new File([new Uint8Array(4)], "doc.pdf", {
      type: "application/pdf",
    });

    const complete = await adapter.send(pending(file));

    expect(complete.content).toEqual([
      {
        type: "file",
        data: url,
        mimeType: "application/pdf",
        filename: "doc.pdf",
      },
    ]);
  });

  it("send() throws when the upload route fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
      ),
    );
    const adapter = createUploadAttachmentAdapter();
    const file = new File([new Uint8Array(4)], "p.png", { type: "image/png" });
    await expect(adapter.send(pending(file))).rejects.toThrow(/Upload failed/);
  });

  it("remove() is a no-op (nothing persisted before send)", async () => {
    const adapter = createUploadAttachmentAdapter();
    const file = new File([new Uint8Array(4)], "p.png", { type: "image/png" });
    await expect(adapter.remove(pending(file))).resolves.toBeUndefined();
  });
});
