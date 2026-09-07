import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { ImageViewerModal } from '@/features/chat/image-viewer';

// Stepping between photos lives in its own file: pressing inside the viewer's
// modal leaves the test renderer unable to mount another one, so the pressing
// case comes last and the quiet cases come first.
jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));

const globalScope = globalThis as unknown as {
  addEventListener?: unknown;
  removeEventListener?: unknown;
};

afterEach(() => {
  delete globalScope.addEventListener;
  delete globalScope.removeEventListener;
});

describe('stepping between photos', () => {
  test('a single photo in a bubble offers no way to step off it', async () => {
    const view = await render(
      <ImageViewerModal
        name="photo.jpg"
        onClose={() => undefined}
        uri="https://cdn.test/photo.jpg"
        visible
      />,
    );
    expect(view.queryByLabelText('chat.imageViewerNext')).toBeNull();
    expect(view.queryByLabelText('chat.imageViewerPrevious')).toBeNull();
  });

  test('a mouse has no swipe, so the arrow keys walk the list on the web', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    globalScope.addEventListener = (type: string, handler: (event: unknown) => void) => {
      listeners.set(type, handler);
    };
    globalScope.removeEventListener = () => undefined;
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    const onNext = jest.fn();
    const onPrevious = jest.fn();
    await render(
      <ImageViewerModal
        name="photo.jpg"
        onClose={() => undefined}
        onNext={onNext}
        onPrevious={onPrevious}
        uri="https://cdn.test/photo.jpg"
        visible
      />,
    );
    const onKey = listeners.get('keydown');
    expect(onKey).toBeTruthy();
    const prevented = jest.fn();
    onKey?.({ key: 'ArrowRight', preventDefault: prevented });
    onKey?.({ key: 'ArrowLeft', preventDefault: prevented });
    // Every other key still belongs to the page.
    onKey?.({ key: 'Enter', preventDefault: prevented });
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(prevented).toHaveBeenCalledTimes(2);
    platform.restore();
  });

  test('the arrow keys are left alone when the viewer shows a lone photo', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    globalScope.addEventListener = (type: string, handler: (event: unknown) => void) => {
      listeners.set(type, handler);
    };
    globalScope.removeEventListener = () => undefined;
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    await render(
      <ImageViewerModal
        name="photo.jpg"
        onClose={() => undefined}
        uri="https://cdn.test/photo.jpg"
        visible
      />,
    );
    const prevented = jest.fn();
    listeners.get('keydown')?.({ key: 'ArrowRight', preventDefault: prevented });
    expect(prevented).not.toHaveBeenCalled();
    platform.restore();
  });

  test('a closed viewer listens for nothing', async () => {
    const listeners: string[] = [];
    globalScope.addEventListener = (type: string) => {
      listeners.push(type);
    };
    globalScope.removeEventListener = () => undefined;
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    await render(
      <ImageViewerModal
        name="photo.jpg"
        onClose={() => undefined}
        onNext={() => undefined}
        uri="https://cdn.test/photo.jpg"
        visible={false}
      />,
    );
    expect(listeners).toEqual([]);
    platform.restore();
  });

  test('a runtime with no window to listen on is left alone', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    const onNext = jest.fn();
    const view = await render(
      <ImageViewerModal
        name="photo.jpg"
        onClose={() => undefined}
        onNext={onNext}
        uri="https://cdn.test/photo.jpg"
        visible
      />,
    );
    // No addEventListener exists here; the viewer must still render.
    expect(view.getByLabelText('chat.imageViewerNext')).toBeTruthy();
    platform.restore();
  });

  test('on a list the chevrons step forwards and back', async () => {
    const onNext = jest.fn();
    const onPrevious = jest.fn();
    const view = await render(
      <ImageViewerModal
        name="photo.jpg"
        onClose={() => undefined}
        onNext={onNext}
        onPrevious={onPrevious}
        uri="https://cdn.test/photo.jpg"
        visible
      />,
    );
    fireEvent.press(view.getByLabelText('chat.imageViewerNext'));
    fireEvent.press(view.getByLabelText('chat.imageViewerPrevious'));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });
});
