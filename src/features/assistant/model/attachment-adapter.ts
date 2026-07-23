import type {
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";

/**
 * Attachment adapter that uploads images/PDFs to object storage (MinIO/S3 via
 * `/api/upload`) and emits a message part pointing at the returned public URL.
 *
 * Why backend upload (not inline base64): keeps the conversation payload small
 * (a URL, not megabytes of data URL), lets the vision model fetch the image by
 * URL, and gives a persistent link. `send()` runs when the user hits send, so
 * the upload happens once the message is actually committed.
 *
 * Contract (assistant-ui `AttachmentAdapter`): `add` registers the pending
 * file, `send` finalizes it into a `CompleteAttachment` whose `content` is the
 * user message part the agent receives, `remove` is a no-op (nothing persisted
 * until send).
 */

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/pdf";

type UploadResponse = { url: string; key: string; contentType: string };

async function uploadFile(file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(
      `Upload failed (${res.status})${detail?.error ? `: ${detail.error}` : ""}`,
    );
  }
  return (await res.json()) as UploadResponse;
}

export function createUploadAttachmentAdapter(): AttachmentAdapter {
  return {
    accept: ACCEPT,

    async add({ file }): Promise<PendingAttachment> {
      return {
        id: file.name,
        type: file.type.startsWith("image/") ? "image" : "document",
        name: file.name,
        contentType: file.type,
        file,
        status: { type: "requires-action", reason: "composer-send" },
      };
    },

    async send(attachment): Promise<CompleteAttachment> {
      const { url, contentType } = await uploadFile(attachment.file);
      const isImage = contentType.startsWith("image/");
      return {
        ...attachment,
        status: { type: "complete" },
        content: [
          isImage
            ? { type: "image", image: url, filename: attachment.name }
            : {
                type: "file",
                data: url,
                mimeType: contentType,
                filename: attachment.name,
              },
        ],
      };
    },

    async remove() {
      // Nothing to clean up: uploads only happen in `send`, so a pending
      // attachment removed before send never reached storage.
    },
  };
}
