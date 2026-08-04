import type { AttachmentTransferOptions, AttachmentTransferSource } from '@/data/attachment-upload';

function abortError() {
  return new DOMException('Attachment upload cancelled.', 'AbortError');
}

export function transferAttachment(
  signedUrl: string,
  source: AttachmentTransferSource,
  mimeType: string,
  options: AttachmentTransferOptions = {},
) {
  return new Promise<number>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }
    const request = new XMLHttpRequest();
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
    const onAbort = () => request.abort();
    request.open('PUT', signedUrl, true);
    request.withCredentials = false;
    request.timeout = 120_000;
    request.setRequestHeader('cache-control', 'private, no-store, max-age=0');
    request.setRequestHeader('content-type', mimeType);
    request.setRequestHeader('x-upsert', 'false');
    request.upload.onprogress = (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : source.bytes.byteLength;
      if (total > 0) options.onProgress?.(Math.min(1, Math.max(0, event.loaded / total)));
    };
    request.onload = () => {
      cleanup();
      options.onProgress?.(1);
      resolve(request.status);
    };
    request.onerror = () => {
      cleanup();
      reject(new Error('Attachment upload network failure.'));
    };
    request.ontimeout = () => {
      cleanup();
      reject(new Error('Attachment upload timed out.'));
    };
    request.onabort = () => {
      cleanup();
      reject(abortError());
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    request.send(source.bytes);
  });
}
