import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockRequest: any = jest.fn();
const mockSaveToLibrary: any = jest.fn();
const mockShare: any = jest.fn();
const mockDownload: any = jest.fn();
const mockDelete: any = jest.fn();

jest.mock('expo-media-library', () => ({
  requestPermissionsAsync: (...args: unknown[]) => mockRequest(...args),
  Asset: { create: (...args: unknown[]) => mockSaveToLibrary(...args) },
}));
jest.mock('expo-sharing', () => ({
  shareAsync: (...args: unknown[]) => mockShare(...args),
}));
jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    exists = false;
    constructor(_directory: unknown, name: string) {
      this.uri = `file:///cache/${name}`;
    }
    delete() {
      mockDelete(this.uri);
    }
    static downloadFileAsync(url: string, target: { uri: string }) {
      return mockDownload(url, target);
    }
  }
  return { File, Paths: { cache: 'cache' } };
});

import { saveAttachment } from '@/features/chat/attachment-save.native';
import { saveAttachment as saveOnWeb } from '@/features/chat/attachment-save.web';

beforeEach(() => {
  mockRequest.mockResolvedValue({ granted: true });
  mockDownload.mockImplementation(async (_url: string, target: unknown) => target);
  mockSaveToLibrary.mockResolvedValue(undefined);
  mockShare.mockResolvedValue(undefined);
});

describe('saving a downloaded file on a phone', () => {
  test('a photo goes into the photo library, asking only to add, and the copy in the cache is removed', async () => {
    // Owner, Oct 1 2026: "downloaded photos should go into the camera roll, not files".
    await expect(saveAttachment({
      url: 'https://storage.example/photo', fileName: 'IMG_0005.jpg', mimeType: 'image/jpeg',
    })).resolves.toBe('photos');
    expect(mockRequest).toHaveBeenCalledWith(true);
    expect(mockDownload).toHaveBeenCalledWith('https://storage.example/photo', expect.anything());
    const saved = mockSaveToLibrary.mock.calls[0]?.[0] as string;
    expect(saved).toMatch(/IMG_0005\.jpg$/);
    expect(mockDelete).toHaveBeenCalledWith(saved);
    expect(mockShare).not.toHaveBeenCalled();
  });

  test('a video goes to the photo library too', async () => {
    await expect(saveAttachment({
      url: 'https://storage.example/clip', fileName: 'clip.mov', mimeType: 'video/quicktime',
    })).resolves.toBe('photos');
  });

  test('without permission to add photos nothing is downloaded, and the reader is told', async () => {
    mockRequest.mockResolvedValue({ granted: false });
    await expect(saveAttachment({
      url: 'https://storage.example/photo', fileName: 'IMG.jpg', mimeType: 'image/png',
    })).resolves.toBe('denied');
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockSaveToLibrary).not.toHaveBeenCalled();
  });

  test('any other file goes to the share sheet, without asking for photo access', async () => {
    await expect(saveAttachment({
      url: 'https://storage.example/report', fileName: 'Survey: V-117.pdf', mimeType: 'application/pdf',
    })).resolves.toBe('shared');
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockShare).toHaveBeenCalledWith(
      expect.stringMatching(/Survey V-117\.pdf$/),
      expect.objectContaining({ mimeType: 'application/pdf' }),
    );
  });

  test('the browser keeps downloading through the signed link', async () => {
    const { Linking } = jest.requireActual('react-native') as typeof import('react-native');
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await expect(saveOnWeb({ url: 'https://storage.example/photo', fileName: 'a.jpg', mimeType: 'image/jpeg' }))
      .resolves.toBe('opened');
    expect(open).toHaveBeenCalledWith('https://storage.example/photo');
  });
});
