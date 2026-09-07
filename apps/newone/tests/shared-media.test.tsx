import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { SharedMediaItem } from '@/data/repositories/contracts';
import {
  isThumbnail,
  mediaKindKey,
  mediaSizeLabel,
  sharedMediaSections,
  SharedMediaModal,
} from '@/features/chat/shared-media';

let mockWorkspace: Record<string, any>;

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));
jest.mock('react-native-safe-area-context', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: ({ children, ...props }: { children: ReactNode }) => (
      <ReactNative.View {...props}>{children}</ReactNative.View>
    ),
    SafeAreaInsetsContext: null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

function item(overrides: Partial<SharedMediaItem> = {}): SharedMediaItem {
  return {
    attachmentId: 'attachment-1',
    messageId: '10',
    name: 'beach.jpg',
    mimeType: 'image/jpeg',
    byteSize: 2048,
    kind: 'image',
    createdAt: '2026-09-03T10:00:00.000Z',
    senderId: 'user-other',
    senderName: 'Ana Torres',
    previewUrl: 'https://cdn.test/beach.jpg',
    ...overrides,
  };
}

beforeEach(() => {
  mockWorkspace = {
    loadSharedMedia: jest.fn(async () => ({ items: [item()], cursor: null })),
  };
});

describe('shared media shapes', () => {
  test('a thumbnail needs both a viewable kind and a preview', () => {
    expect(isThumbnail(item())).toBe(true);
    expect(isThumbnail(item({ kind: 'video' }))).toBe(true);
    expect(isThumbnail(item({ previewUrl: null }))).toBe(false);
    expect(isThumbnail(item({ kind: 'file' }))).toBe(false);
    expect(isThumbnail(item({ kind: 'voice' }))).toBe(false);
  });

  test('runs of photos become one grid and files keep their place', () => {
    const sections = sharedMediaSections([
      item({ attachmentId: 'a' }),
      item({ attachmentId: 'b', kind: 'video' }),
      item({ attachmentId: 'c', kind: 'file', previewUrl: null }),
      item({ attachmentId: 'd' }),
    ]);
    expect(sections.map((section) => section.kind)).toEqual(['thumbnails', 'file', 'thumbnails']);
    expect(sections[0].kind === 'thumbnails' && sections[0].items.map((entry) => entry.attachmentId))
      .toEqual(['a', 'b']);
    expect(sections[1].kind === 'file' && sections[1].item.attachmentId).toBe('c');
  });

  test('sizes and kind words stay compact', () => {
    expect(mediaSizeLabel(512)).toBe('512 B');
    expect(mediaSizeLabel(2048)).toBe('2 KB');
    expect(mediaSizeLabel(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(mediaKindKey('image')).toBe('chat.attachmentPhoto');
    expect(mediaKindKey('video')).toBe('chat.attachmentVideo');
    expect(mediaKindKey('voice')).toBe('chat.attachmentVoice');
    expect(mediaKindKey('file')).toBe('chat.attachmentFile');
  });
});

describe('SharedMediaModal', () => {
  test('photos are thumbnails and other files are rows', async () => {
    mockWorkspace.loadSharedMedia = jest.fn(async () => ({
      items: [
        item({ attachmentId: 'a', name: 'beach.jpg' }),
        item({
          attachmentId: 'b',
          name: 'tickets.pdf',
          kind: 'file',
          mimeType: 'application/pdf',
          previewUrl: null,
          byteSize: 1024 * 1024,
        }),
      ],
      cursor: null,
    }));
    await render(
      <SharedMediaModal conversationId="chat-a" onClose={() => undefined} visible />,
    );
    await waitFor(() => expect(screen.getByLabelText('beach.jpg')).toBeTruthy());
    expect(mockWorkspace.loadSharedMedia).toHaveBeenCalledWith('chat-a');
    // The file has a row, not a tile: no image button to press.
    expect(screen.queryByLabelText('tickets.pdf')).toBeNull();
    expect(screen.getByText('tickets.pdf')).toBeTruthy();
    expect(screen.getByText('Ana Torres · 1.0 MB')).toBeTruthy();
  });

  test('nothing shared says so', async () => {
    mockWorkspace.loadSharedMedia = jest.fn(async () => ({ items: [], cursor: null }));
    await render(
      <SharedMediaModal conversationId="chat-a" onClose={() => undefined} visible />,
    );
    await waitFor(() => expect(screen.getByText('chat.sharedMediaEmpty')).toBeTruthy());
  });

  test('the next page appends and the control disappears when the list ends', async () => {
    const cursor = { beforeCreatedAt: '2026-09-03T10:00:00.000Z', beforeAttachmentId: 'a' };
    mockWorkspace.loadSharedMedia = jest.fn(async (_id: string, page?: unknown) => (
      page
        ? { items: [item({ attachmentId: 'b', name: 'hike.jpg' })], cursor: null }
        : { items: [item({ attachmentId: 'a', name: 'beach.jpg' })], cursor }
    ));
    await render(
      <SharedMediaModal conversationId="chat-a" onClose={() => undefined} visible />,
    );
    await waitFor(() => expect(screen.getByLabelText('chat.sharedMediaMore')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('chat.sharedMediaMore'));
    await waitFor(() => expect(screen.getByLabelText('hike.jpg')).toBeTruthy());
    expect(mockWorkspace.loadSharedMedia).toHaveBeenLastCalledWith('chat-a', cursor);
    expect(screen.getByLabelText('beach.jpg')).toBeTruthy();
    expect(screen.queryByLabelText('chat.sharedMediaMore')).toBeNull();
  });

  test('a video is marked as one and a voice note gets its own row', async () => {
    mockWorkspace.loadSharedMedia = jest.fn(async () => ({
      items: [
        item({ attachmentId: 'a', name: 'clip.mp4', kind: 'video', mimeType: 'video/mp4' }),
        item({
          attachmentId: 'b',
          name: '',
          kind: 'voice',
          mimeType: 'audio/mpeg',
          previewUrl: null,
          byteSize: 400,
        }),
      ],
      cursor: null,
    }));
    await render(
      <SharedMediaModal conversationId="chat-a" onClose={() => undefined} visible />,
    );
    await waitFor(() => expect(screen.getByLabelText('clip.mp4')).toBeTruthy());
    // A voice note has no thumbnail, so it falls back to its kind on a row.
    expect(screen.getByText('chat.attachmentVoice')).toBeTruthy();
    expect(screen.getByText('Ana Torres · 400 B')).toBeTruthy();
  });

  test('a read the server refuses is an empty grid, not a stuck spinner', async () => {
    mockWorkspace.loadSharedMedia = jest.fn(async () => null);
    await render(
      <SharedMediaModal conversationId="chat-a" onClose={() => undefined} visible />,
    );
    await waitFor(() => expect(screen.getByText('chat.sharedMediaEmpty')).toBeTruthy());
  });

  test('a refused next page leaves the grid and its control alone', async () => {
    const cursor = { beforeCreatedAt: '2026-09-03T10:00:00.000Z', beforeAttachmentId: 'a' };
    mockWorkspace.loadSharedMedia = jest.fn(async (_id: string, page?: unknown) => (
      page ? null : { items: [item({ attachmentId: 'a', name: 'beach.jpg' })], cursor }
    ));
    await render(
      <SharedMediaModal conversationId="chat-a" onClose={() => undefined} visible />,
    );
    await waitFor(() => expect(screen.getByLabelText('chat.sharedMediaMore')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('chat.sharedMediaMore'));
    await waitFor(() => expect(mockWorkspace.loadSharedMedia).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('beach.jpg')).toBeTruthy();
    expect(screen.getByLabelText('chat.sharedMediaMore')).toBeTruthy();
  });

  test('a photo opens the viewer and the chevrons walk the grid', async () => {
    mockWorkspace.loadSharedMedia = jest.fn(async () => ({
      items: [
        item({ attachmentId: 'a', name: 'beach.jpg', previewUrl: 'https://cdn.test/a.jpg' }),
        item({ attachmentId: 'b', name: 'hike.jpg', previewUrl: 'https://cdn.test/b.jpg' }),
        item({ attachmentId: 'c', name: 'notes.pdf', kind: 'file', previewUrl: null }),
      ],
      cursor: null,
    }));
    await render(
      <SharedMediaModal conversationId="chat-a" onClose={() => undefined} visible />,
    );
    await waitFor(() => expect(screen.getByLabelText('beach.jpg')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('beach.jpg'));
    await waitFor(() => expect(screen.getByLabelText('chat.imageViewerClose')).toBeTruthy());
    // The first photo has somewhere to go forwards but not backwards.
    expect(screen.queryByLabelText('chat.imageViewerPrevious')).toBeNull();
    fireEvent.press(screen.getByLabelText('chat.imageViewerNext'));
    await waitFor(() => expect(screen.getByLabelText('chat.imageViewerPrevious')).toBeTruthy());
    // The file is not part of the walk, so the last photo ends it.
    expect(screen.queryByLabelText('chat.imageViewerNext')).toBeNull();
    fireEvent.press(screen.getByLabelText('chat.imageViewerPrevious'));
    await waitFor(() => expect(screen.queryByLabelText('chat.imageViewerPrevious')).toBeNull());
    fireEvent.press(screen.getByLabelText('chat.imageViewerClose'));
    await waitFor(() => expect(screen.queryByLabelText('chat.imageViewerClose')).toBeNull());
  });
});
