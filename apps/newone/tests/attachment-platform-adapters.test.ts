import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockRevokeObjectURL: any = jest.fn();
const mockDelete: any = jest.fn();
const mockRelease: any = jest.fn();
const mockUploadAsync: any = jest.fn();
const mockCreateUploadTask: any = jest.fn();
const mockFile: any = jest.fn();

jest.mock('expo-file-system', () => ({
  File: function File(...args: unknown[]) { return mockFile(...args); },
  UploadType: { BINARY_CONTENT: 'binary' },
}));

import { removeTemporaryAttachment as removeNativeTemporaryAttachment } from '@/data/attachment-cleanup.native';
import { removeTemporaryAttachment as removeWebTemporaryAttachment } from '@/data/attachment-cleanup.web';
import { transferAttachment as transferNativeAttachment } from '@/data/attachment-upload.native';
import { transferAttachment as transferWebAttachment } from '@/data/attachment-upload.web';

class ControlledXmlHttpRequest {
  static latest: ControlledXmlHttpRequest;

  upload: { onprogress: ((event: { lengthComputable: boolean; total: number; loaded: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 204;
  withCredentials = true;
  timeout = 0;
  open = jest.fn();
  setRequestHeader = jest.fn();
  send = jest.fn();
  abort = jest.fn(() => this.onabort?.());

  constructor() {
    ControlledXmlHttpRequest.latest = this;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFile.mockReturnValue({
    exists: true,
    delete: mockDelete,
    createUploadTask: mockCreateUploadTask,
  });
  mockCreateUploadTask.mockReturnValue({ uploadAsync: mockUploadAsync, release: mockRelease });
  mockUploadAsync.mockResolvedValue({ status: 201 });
  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    writable: true,
    value: ControlledXmlHttpRequest,
  });
  Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: mockRevokeObjectURL,
  });
});

describe('temporary attachment cleanup adapters', () => {
  test('revokes only browser object URLs', async () => {
    await removeWebTemporaryAttachment('https://newone.test/not-temporary');
    await removeWebTemporaryAttachment('blob:controlled-object');
    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(1);
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:controlled-object');
  });

  test('deletes an existing native temporary file and ignores an absent one', async () => {
    await removeNativeTemporaryAttachment('file:///existing');
    mockFile.mockReturnValueOnce({ exists: false, delete: mockDelete });
    await removeNativeTemporaryAttachment('file:///absent');
    expect(mockFile).toHaveBeenCalledWith('file:///existing');
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  test('keeps cleanup best-effort when native file access throws', async () => {
    mockFile.mockImplementationOnce(() => { throw new Error('filesystem unavailable'); });
    await expect(removeNativeTemporaryAttachment('file:///controlled')).resolves.toBeUndefined();
  });
});

describe('native attachment upload adapter', () => {
  test('uploads with hardened options, clamps progress, and releases the task', async () => {
    const onProgress = jest.fn();
    const controller = new AbortController();
    const bytes = new ArrayBuffer(8);
    const pending = transferNativeAttachment(
      'https://storage.newone.test/signed',
      { uri: 'file:///controlled', bytes },
      'application/pdf',
      { signal: controller.signal, onProgress },
    );
    const options = mockCreateUploadTask.mock.calls[0]![1] as any;
    expect(mockFile).toHaveBeenCalledWith('file:///controlled');
    expect(mockCreateUploadTask).toHaveBeenCalledWith(
      'https://storage.newone.test/signed',
      expect.objectContaining({
        httpMethod: 'PUT',
        uploadType: 'binary',
        mimeType: 'application/pdf',
        sessionType: 'foreground',
        signal: controller.signal,
        headers: {
          'cache-control': 'private, no-store, max-age=0',
          'content-type': 'application/pdf',
          'x-upsert': 'false',
        },
      }),
    );
    options.onProgress({ bytesSent: -5, totalBytes: 10 });
    options.onProgress({ bytesSent: 20, totalBytes: 10 });
    options.onProgress({ bytesSent: 1, totalBytes: 0 });
    await expect(pending).resolves.toBe(201);
    expect(onProgress.mock.calls.map(([value]) => value)).toEqual([0, 1, 1]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test('releases the native task after upload failure without a progress listener', async () => {
    mockUploadAsync.mockRejectedValueOnce(new Error('native network failure'));
    const pending = transferNativeAttachment(
      'https://storage.newone.test/signed',
      { uri: 'file:///controlled', bytes: new ArrayBuffer(1) },
      'text/plain',
    );
    const options = mockCreateUploadTask.mock.calls[0]![1] as any;
    options.onProgress({ bytesSent: 1, totalBytes: 2 });
    await expect(pending).rejects.toThrow('native network failure');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

describe('web attachment upload adapter', () => {
  test('rejects before opening a request when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(transferWebAttachment(
      'https://storage.newone.test/signed',
      { uri: 'blob:controlled', bytes: new ArrayBuffer(1) },
      'text/plain',
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('configures XHR, reports bounded progress, succeeds, and removes the abort listener', async () => {
    const controller = new AbortController();
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
    const onProgress = jest.fn();
    const bytes = new ArrayBuffer(8);
    const pending = transferWebAttachment(
      'https://storage.newone.test/signed',
      { uri: 'blob:controlled', bytes },
      'application/pdf',
      { signal: controller.signal, onProgress },
    );
    const request = ControlledXmlHttpRequest.latest;
    expect(request.open).toHaveBeenCalledWith('PUT', 'https://storage.newone.test/signed', true);
    expect(request.withCredentials).toBe(false);
    expect(request.timeout).toBe(120_000);
    expect(request.setRequestHeader.mock.calls).toEqual([
      ['cache-control', 'private, no-store, max-age=0'],
      ['content-type', 'application/pdf'],
      ['x-upsert', 'false'],
    ]);
    expect(request.send).toHaveBeenCalledWith(bytes);
    request.upload.onprogress?.({ lengthComputable: true, total: 10, loaded: -5 });
    request.upload.onprogress?.({ lengthComputable: true, total: 10, loaded: 15 });
    request.upload.onprogress?.({ lengthComputable: false, total: 0, loaded: 4 });
    request.status = 202;
    request.onload?.();
    await expect(pending).resolves.toBe(202);
    expect(onProgress.mock.calls.map(([value]) => value)).toEqual([0, 1, 0.5, 1]);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  const failures: Array<[
    string,
    'onerror' | 'ontimeout' | 'onabort',
    'AbortError' | null,
  ]> = [
    ['network failure', 'onerror', null],
    ['timeout', 'ontimeout', null],
    ['abort', 'onabort', 'AbortError'],
  ];

  test.each(failures)('rejects an XHR %s and cleans up', async (_label, callback, errorName) => {
    const controller = new AbortController();
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
    const pending = transferWebAttachment(
      'https://storage.newone.test/signed',
      { uri: 'blob:controlled', bytes: new ArrayBuffer(2) },
      'text/plain',
      { signal: controller.signal },
    );
    ControlledXmlHttpRequest.latest[callback]?.();
    if (errorName) await expect(pending).rejects.toMatchObject({ name: errorName });
    else await expect(pending).rejects.toBeInstanceOf(Error);
    expect(removeListener).toHaveBeenCalled();
  });

  test('turns a live AbortSignal into an XHR abort and tolerates omitted options', async () => {
    const controller = new AbortController();
    const pending = transferWebAttachment(
      'https://storage.newone.test/signed',
      { uri: 'blob:controlled', bytes: new ArrayBuffer(0) },
      'text/plain',
      { signal: controller.signal },
    );
    const request = ControlledXmlHttpRequest.latest;
    controller.abort();
    expect(request.abort).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    const withoutOptions = transferWebAttachment(
      'https://storage.newone.test/signed',
      { uri: 'blob:controlled', bytes: new ArrayBuffer(0) },
      'text/plain',
    );
    const second = ControlledXmlHttpRequest.latest;
    second.upload.onprogress?.({ lengthComputable: false, total: 0, loaded: 0 });
    second.onload?.();
    await expect(withoutOptions).resolves.toBe(204);
  });
});
