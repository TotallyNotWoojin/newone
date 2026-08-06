import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { RepositoryError } from '@/data/repositories/contracts';

const mockManipulateAsync: any = jest.fn();
const mockDigest: any = jest.fn();
const mockTransferAttachment: any = jest.fn();
const mockRemoveTemporaryAttachment: any = jest.fn();

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: (...args: unknown[]) => mockManipulateAsync(...args),
  SaveFormat: { PNG: 'png', JPEG: 'jpeg' },
}));

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: (...args: unknown[]) => mockDigest(...args),
}));

jest.mock('@/data/attachment-upload', () => ({
  transferAttachment: (...args: unknown[]) => mockTransferAttachment(...args),
}));

jest.mock('@/data/attachment-cleanup', () => ({
  removeTemporaryAttachment: (...args: unknown[]) => mockRemoveTemporaryAttachment(...args),
}));

import {
  attachmentByteLimit,
  cleanupPreparedAttachment,
  optimizeImageAttachment,
  prepareAttachment,
  uploadAttachment,
} from '@/data/attachments';

const grant = {
  action: 'upload' as const,
  attachmentId: 'attachment-controlled',
  bucket: 'message-attachments' as const,
  path: 'controlled/object',
  signedUrl: 'https://coverage-project.supabase.co/storage/v1/object/upload/sign/message-attachments/path?token=controlled-token-123456',
  token: 'controlled-token-123456',
  expiresInSeconds: 60,
};

beforeEach(() => {
  mockManipulateAsync.mockReset();
  mockDigest.mockReset();
  mockTransferAttachment.mockReset();
  mockRemoveTemporaryAttachment.mockReset();
  jest.restoreAllMocks();
});

function repositoryError(error: unknown, code: string, retryable: boolean) {
  expect(error).toBeInstanceOf(RepositoryError);
  expect(error).toMatchObject({ code, retryable });
}

describe('attachment image preparation', () => {
  test('leaves non-images untouched', async () => {
    const selected = { uri: 'file:///report.pdf', name: 'report.pdf', mimeType: 'application/pdf' };
    await expect(optimizeImageAttachment(selected)).resolves.toBe(selected);
    expect(mockManipulateAsync).not.toHaveBeenCalled();
  });

  test.each([
    [{ size: 9 * 1024 * 1024, width: 2400 }, [{ resize: { width: 1280 } }], 0.62],
    [{ size: 4 * 1024 * 1024, width: 1200 }, [], 0.72],
    [{ size: 1024, width: 2000 }, [{ resize: { width: 1600 } }], 0.82],
    [{ size: undefined, width: undefined }, [], 0.82],
  ])('optimizes JPEG metadata and dimensions for %j', async (shape, actions, compress) => {
    mockManipulateAsync.mockResolvedValue({ uri: 'file:///optimized.jpg', width: 1200, height: 800 });
    const result = await optimizeImageAttachment({
      uri: 'file:///photo.heic',
      name: 'shift.photo.heic',
      mimeType: 'image/heic',
      ...shape,
    });
    expect(mockManipulateAsync).toHaveBeenCalledWith('file:///photo.heic', actions, {
      compress,
      format: 'jpeg',
    });
    expect(result).toMatchObject({
      uri: 'file:///optimized.jpg',
      name: 'shift.photo.jpg',
      mimeType: 'image/jpeg',
      width: 1200,
      height: 800,
      temporary: true,
    });
    expect(result.size).toBeUndefined();
  });

  test('re-encodes original-dimension PNG files without resizing', async () => {
    mockManipulateAsync.mockResolvedValue({ uri: 'file:///clean.png', width: 4096, height: 2048 });
    const result = await optimizeImageAttachment({
      uri: 'file:///map.png',
      name: 'map.png',
      mimeType: 'image/png',
      size: 12 * 1024 * 1024,
      width: 4096,
      imageMode: 'original',
    });
    expect(mockManipulateAsync).toHaveBeenCalledWith('file:///map.png', [], {
      compress: 1,
      format: 'png',
    });
    expect(result).toMatchObject({ name: 'map.png', mimeType: 'image/png', width: 4096 });
  });

  test('fails closed when the device cannot decode an image', async () => {
    mockManipulateAsync.mockRejectedValue(new Error('decoder unavailable'));
    await optimizeImageAttachment({ uri: 'file:///bad.heic', name: 'bad.heic', mimeType: 'image/heic' })
      .then(() => { throw new Error('expected rejection'); }, (error) => repositoryError(error, 'image_optimization_failed', false));
  });
});

describe('attachment byte preparation', () => {
  test.each([
    ['application/octet-stream', 1, 'file_type_blocked'],
    ['text/plain', attachmentByteLimit + 1, 'file_too_large'],
  ])('rejects policy-invalid selection %s', async (mimeType, size, code) => {
    const selected = { uri: 'file:///controlled', name: 'controlled', mimeType, size };
    await prepareAttachment(selected)
      .then(() => { throw new Error('expected rejection'); }, (error) => repositoryError(error, code, false));
  });

  test('maps transport and non-success reads to a stable repository error', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('unreachable'));
    const selected = { uri: 'file:///controlled.txt', name: 'controlled.txt', mimeType: 'text/plain' };
    await prepareAttachment(selected)
      .then(() => { throw new Error('expected rejection'); }, (error) => repositoryError(error, 'file_read_failed', false));

    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));
    await prepareAttachment(selected)
      .then(() => { throw new Error('expected rejection'); }, (error) => repositoryError(error, 'file_read_failed', false));
  });

  test.each([0, attachmentByteLimit + 1])('rejects fetched byte length %i', async (byteLength) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(byteLength),
    } as Response);
    await prepareAttachment({ uri: 'file:///controlled.txt', name: 'controlled.txt', mimeType: 'text/plain' })
      .then(() => { throw new Error('expected rejection'); }, (error) => repositoryError(error, 'file_size_invalid', false));
  });

  test.each([
    ['  unsafe\\path/name.txt  ', 'unsafe-path-name.txt', true],
    [' / ', '-', false],
    ['', 'attachment', false],
    [`${'a'.repeat(300)}.txt`, 'a'.repeat(255), false],
  ])('hashes bytes and normalizes file name %j', async (name, expectedName, temporary) => {
    const bytes = Uint8Array.from([1, 2, 3]).buffer;
    const digest = Uint8Array.from([0, 1, 15, 16, 255]).buffer;
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: async () => bytes,
    } as Response);
    mockDigest.mockResolvedValue(digest);
    await expect(prepareAttachment({
      uri: 'blob:controlled',
      name,
      mimeType: 'text/plain',
      temporary,
    })).resolves.toEqual({
      uri: 'blob:controlled',
      bytes,
      byteSize: 3,
      sha256Hex: '00010f10ff',
      name: expectedName,
      mimeType: 'text/plain',
      temporary,
    });
    expect(mockDigest).toHaveBeenCalledWith('SHA-256', bytes);
  });
});

describe('attachment lifecycle and transfer errors', () => {
  test('cleans only temporary prepared files', async () => {
    await cleanupPreparedAttachment({ uri: 'file:///permanent', temporary: false });
    await cleanupPreparedAttachment({ uri: 'file:///temporary', temporary: true });
    expect(mockRemoveTemporaryAttachment).toHaveBeenCalledTimes(1);
    expect(mockRemoveTemporaryAttachment).toHaveBeenCalledWith('file:///temporary');
  });

  test.each([200, 204, 299])('accepts upload HTTP status %i', async (status) => {
    const bytes = new ArrayBuffer(2);
    const options = { onProgress: jest.fn() };
    mockTransferAttachment.mockResolvedValue(status);
    await expect(uploadAttachment(grant, { uri: 'file:///controlled', bytes }, 'text/plain', options))
      .resolves.toBeUndefined();
    expect(mockTransferAttachment).toHaveBeenCalledWith(grant.signedUrl, { uri: 'file:///controlled', bytes }, 'text/plain', options);
  });

  test.each([
    [199, false],
    [300, false],
    [499, false],
    [500, true],
    [599, true],
  ])('maps rejected HTTP status %i', async (status, retryable) => {
    mockTransferAttachment.mockResolvedValue(status);
    await uploadAttachment(grant, { uri: 'file:///controlled', bytes: new ArrayBuffer(1) }, 'text/plain')
      .then(() => { throw new Error('expected rejection'); }, (error) => repositoryError(error, `upload_http_${status}`, retryable));
  });

  test('distinguishes cancellation from retryable network failure', async () => {
    const aborted = new Error('cancelled');
    aborted.name = 'AbortError';
    mockTransferAttachment.mockRejectedValueOnce(aborted);
    await uploadAttachment(grant, { uri: 'file:///controlled', bytes: new ArrayBuffer(1) }, 'text/plain')
      .then(() => { throw new Error('expected rejection'); }, (error) => repositoryError(error, 'upload_cancelled', false));

    mockTransferAttachment.mockRejectedValueOnce('socket unavailable');
    await uploadAttachment(grant, { uri: 'file:///controlled', bytes: new ArrayBuffer(1) }, 'text/plain')
      .then(() => { throw new Error('expected rejection'); }, (error) => repositoryError(error, 'upload_unavailable', true));
  });
});
