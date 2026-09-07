import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { RepositoryError } from '@/data/repositories/contracts';
import { WebReadRepository } from '@/data/repositories/web-read-repository';

const mockFetch = jest.fn<typeof fetch>();

jest.mock('@/config/runtime', () => ({
  apiUrlFor: (path: string) => `https://api.newone.test${path}`,
  nativeEdgeRequestHeaders: (token?: string | null) => token
    ? { Authorization: `Bearer ${token}`, apikey: 'controlled-publishable-key' }
    : null,
}));
jest.mock('@/lib/web-auth', () => ({
  getWebCsrfToken: () => 'controlled-csrf-token',
}));

const organizationId = '10000000-0000-4000-8000-000000000001';
const conversationId = '40000000-0000-4000-8000-000000000004';
const senderId = '30000000-0000-4000-8000-000000000003';
const attachmentId = '70000000-0000-4000-8000-000000000007';

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

function repository() {
  return new WebReadRepository({
    getSession: async () => ({ access_token: 'controlled-access-token' } as any),
  });
}

function pinRow(overrides: Record<string, unknown> = {}) {
  return {
    conversationId,
    messageId: '90',
    senderUserId: senderId,
    senderDisplayName: 'Ana Torres',
    body: 'Bring the tickets',
    attachmentKind: null,
    sentAt: '2026-09-01T10:00:00.000Z',
    pinnedAt: '2026-09-02T10:00:00.000Z',
    canUnpin: true,
    ...overrides,
  };
}

function mediaRow(overrides: Record<string, unknown> = {}) {
  return {
    attachmentId,
    messageId: '90',
    fileName: 'beach.jpg',
    mimeType: 'image/jpeg',
    byteSize: 2048,
    kind: 'image',
    createdAt: '2026-09-03T10:00:00.000Z',
    senderUserId: senderId,
    senderDisplayName: 'Ana Torres',
    previewUrl: 'https://cdn.test/beach.jpg',
    ...overrides,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
});

describe('pinned message reads', () => {
  test('asks for one chat or for all of them, and parses the rows', async () => {
    mockFetch.mockImplementation(async () => response({ data: {
      schemaVersion: 1,
      conversationId: null,
      pins: [pinRow(), pinRow({ messageId: '80', body: '', attachmentKind: 'image' })],
    } }));
    const pins = await repository().loadPinnedMessages({ organizationId });
    expect(JSON.parse(String((mockFetch.mock.calls[0]![1] as RequestInit).body))).toEqual({
      organizationId,
      conversationId: null,
      limit: 50,
    });
    expect(String(mockFetch.mock.calls[0]![0])).toBe('https://api.newone.test/v2/pins/query');
    expect(pins).toHaveLength(2);
    expect(pins[0]).toMatchObject({
      conversationId,
      messageId: '90',
      senderName: 'Ana Torres',
      text: 'Bring the tickets',
      attachmentKind: null,
      canUnpin: true,
    });
    expect(pins[1].attachmentKind).toBe('image');

    await repository().loadPinnedMessages({ organizationId, conversationId, limit: 5 });
    expect(JSON.parse(String((mockFetch.mock.calls[1]![1] as RequestInit).body))).toEqual({
      organizationId,
      conversationId,
      limit: 5,
    });
  });

  test('an unrecognised attachment word is simply no word', async () => {
    mockFetch.mockImplementation(async () => response({ data: {
      schemaVersion: 1,
      conversationId,
      pins: [pinRow({ attachmentKind: 'hologram' })],
    } }));
    const pins = await repository().loadPinnedMessages({ organizationId, conversationId });
    expect(pins[0].attachmentKind).toBeNull();
  });

  test('a payload longer than asked for, or of the wrong shape, is rejected', async () => {
    mockFetch.mockImplementationOnce(async () => response({ data: {
      schemaVersion: 1,
      pins: [pinRow(), pinRow({ messageId: '80' })],
    } }));
    await expect(repository().loadPinnedMessages({ organizationId, limit: 1 }))
      .rejects.toBeInstanceOf(RepositoryError);
    mockFetch.mockImplementationOnce(async () => response({ data: { schemaVersion: 2, pins: [] } }));
    await expect(repository().loadPinnedMessages({ organizationId }))
      .rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('shared media reads', () => {
  test('sends no keyset on the first page and the whole keyset on the next', async () => {
    mockFetch.mockImplementationOnce(async () => response({ data: {
      schemaVersion: 1,
      conversationId,
      items: [mediaRow()],
      hasMore: true,
      nextBeforeCreatedAt: '2026-09-03T10:00:00.000Z',
      nextBeforeAttachmentId: attachmentId,
    } }));
    const first = await repository().loadSharedMedia({ organizationId, conversationId });
    expect(String(mockFetch.mock.calls[0]![0]))
      .toBe(`https://api.newone.test/v2/conversations/${conversationId}/media/query`);
    expect(JSON.parse(String((mockFetch.mock.calls[0]![1] as RequestInit).body))).toEqual({
      organizationId,
      beforeCreatedAt: null,
      beforeAttachmentId: null,
      limit: 30,
    });
    expect(first.items[0]).toMatchObject({
      attachmentId,
      name: 'beach.jpg',
      kind: 'image',
      byteSize: 2048,
      senderName: 'Ana Torres',
      previewUrl: 'https://cdn.test/beach.jpg',
    });
    expect(first.cursor).toEqual({
      beforeCreatedAt: '2026-09-03T10:00:00.000Z',
      beforeAttachmentId: attachmentId,
    });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      schemaVersion: 1,
      conversationId,
      items: [],
      hasMore: false,
      nextBeforeCreatedAt: null,
      nextBeforeAttachmentId: null,
    } }));
    const next = await repository().loadSharedMedia({
      organizationId,
      conversationId,
      cursor: first.cursor,
    });
    expect(JSON.parse(String((mockFetch.mock.calls[1]![1] as RequestInit).body))).toEqual({
      organizationId,
      beforeCreatedAt: '2026-09-03T10:00:00.000Z',
      beforeAttachmentId: attachmentId,
      limit: 30,
    });
    expect(next.cursor).toBeNull();
  });

  test('a preview that is not a signed https address is dropped, not shown', async () => {
    mockFetch.mockImplementationOnce(async () => response({ data: {
      schemaVersion: 1,
      conversationId,
      items: [
        mediaRow({ previewUrl: 'javascript:alert(1)' }),
        mediaRow({ attachmentId: '70000000-0000-4000-8000-000000000008', previewUrl: null }),
      ],
      hasMore: false,
      nextBeforeCreatedAt: null,
      nextBeforeAttachmentId: null,
    } }));
    const page = await repository().loadSharedMedia({ organizationId, conversationId });
    expect(page.items.map((entry) => entry.previewUrl)).toEqual([null, null]);
  });

  test('an unknown kind falls back to a file row rather than a broken tile', async () => {
    mockFetch.mockImplementationOnce(async () => response({ data: {
      schemaVersion: 1,
      conversationId,
      items: [mediaRow({ kind: 'hologram', mimeType: undefined })],
      hasMore: false,
      nextBeforeCreatedAt: null,
      nextBeforeAttachmentId: null,
    } }));
    const page = await repository().loadSharedMedia({ organizationId, conversationId });
    expect(page.items[0].kind).toBe('file');
    expect(page.items[0].mimeType).toBe('application/octet-stream');
  });

  test('a page that promises more without a whole keyset is rejected', async () => {
    mockFetch.mockImplementationOnce(async () => response({ data: {
      schemaVersion: 1,
      conversationId,
      items: [mediaRow()],
      hasMore: true,
      nextBeforeCreatedAt: '2026-09-03T10:00:00.000Z',
      nextBeforeAttachmentId: null,
    } }));
    await expect(repository().loadSharedMedia({ organizationId, conversationId }))
      .rejects.toBeInstanceOf(RepositoryError);
  });

  test('a page from another chat, or one that walks backwards, is rejected', async () => {
    mockFetch.mockImplementationOnce(async () => response({ data: {
      schemaVersion: 1,
      conversationId: '40000000-0000-4000-8000-00000000000f',
      items: [],
      hasMore: false,
    } }));
    await expect(repository().loadSharedMedia({ organizationId, conversationId }))
      .rejects.toBeInstanceOf(RepositoryError);

    mockFetch.mockImplementationOnce(async () => response({ data: {
      schemaVersion: 1,
      conversationId,
      items: [mediaRow({ createdAt: '2026-09-09T10:00:00.000Z' })],
      hasMore: false,
      nextBeforeCreatedAt: null,
      nextBeforeAttachmentId: null,
    } }));
    await expect(repository().loadSharedMedia({
      organizationId,
      conversationId,
      cursor: { beforeCreatedAt: '2026-09-03T10:00:00.000Z', beforeAttachmentId: attachmentId },
    })).rejects.toBeInstanceOf(RepositoryError);
  });
});
