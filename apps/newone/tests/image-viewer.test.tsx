import { describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ImageViewerModal } from '@/features/chat/image-viewer';

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));

describe('ImageViewerModal', () => {
  test('shows the image full screen with close and download controls', async () => {
    const onClose = jest.fn();
    const onDownload = jest.fn();
    await render(<ImageViewerModal name="photo.jpg" onClose={onClose} onDownload={onDownload} uri="https://cdn.test/photo.jpg" visible />);
    expect(screen.getByLabelText('photo.jpg')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('chat.imageViewerDownload'));
    expect(onDownload).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByLabelText('chat.imageViewerClose'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('renders nothing without a source', async () => {
    await render(<ImageViewerModal onClose={() => undefined} uri={null} visible />);
    expect(screen.queryByLabelText('chat.imageViewerClose')).toBeNull();
  });
});
