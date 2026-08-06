import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Pressable, Text, View, Platform } from 'react-native';

import { I18nProvider, useI18n } from '@/i18n/provider';

const mockInitialize = jest.fn<() => Promise<void>>();
const mockGetCache = jest.fn<(key: string) => Promise<string | null>>();
const mockPutCache = jest.fn<(key: string, value: string) => Promise<void>>();

jest.mock('@/data/persistence/client-store', () => ({
  clientStore: {
    initialize: () => mockInitialize(),
    getCache: (key: string) => mockGetCache(key),
    putCache: (key: string, value: string) => mockPutCache(key, value),
  },
}));

let mockDeviceLocale = 'en-US';
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

function removeDocument() {
  Reflect.deleteProperty(globalThis, 'document');
}

function LocaleProbe() {
  const { locale, setLocale, t } = useI18n();
  return (
    <View>
      <Text testID="locale">{locale}</Text>
      <Text testID="translated">{t('nav.chats')}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="set English" onPress={() => setLocale('en')} />
      <Pressable accessibilityRole="button" accessibilityLabel="set Korean" onPress={() => setLocale('ko')} />
      <Pressable accessibilityRole="button" accessibilityLabel="set Spanish" onPress={() => setLocale('es')} />
    </View>
  );
}

function provider() {
  return (
    <I18nProvider>
      <LocaleProbe />
    </I18nProvider>
  );
}

beforeEach(() => {
  mockDeviceLocale = 'en-US';
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  removeDocument();
  mockInitialize.mockReset();
  mockGetCache.mockReset();
  mockPutCache.mockReset();
  mockInitialize.mockResolvedValue(undefined);
  mockGetCache.mockResolvedValue(null);
  mockPutCache.mockResolvedValue(undefined);
  jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(() => ({
    locale: mockDeviceLocale,
    calendar: 'gregory',
    numberingSystem: 'latn',
    timeZone: 'UTC',
  }));
});

afterEach(() => {
  removeDocument();
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
});

describe('internationalization provider', () => {
  test('hydrates web from deterministic English to a saved locale and updates the document language', async () => {
    mockDeviceLocale = 'es-MX';
    mockGetCache.mockResolvedValue('ko');
    const documentElement = { lang: '' };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { documentElement },
    });

    const view = await render(provider());
    await waitFor(() => expect(screen.getByTestId('locale').props.children).toBe('ko'));

    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockGetCache).toHaveBeenCalledWith('preferences.ui-locale');
    expect(documentElement.lang).toBe('ko');
    expect(screen.getByTestId('translated').props.children).toBe('채팅');

    await view.unmount();
  });

  test.each([
    { saved: 'en' as const, translated: 'Chats' },
    { saved: 'es' as const, translated: 'Chats' },
  ])('accepts the other persisted locale $saved', async ({ saved, translated }) => {
    mockGetCache.mockResolvedValue(saved);
    const view = await render(provider());

    await waitFor(() => expect(screen.getByTestId('locale').props.children).toBe(saved));
    expect(screen.getByTestId('translated').props.children).toBe(translated);

    await view.unmount();
  });

  test.each([
    { device: 'es-MX', expected: 'es' },
    { device: 'ko-KR', expected: 'ko' },
    { device: 'fr-FR', expected: 'en' },
  ])(
    'uses the supported base device locale $device when native persisted data is invalid',
    async ({ device, expected }) => {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
      mockDeviceLocale = device;
      mockGetCache.mockResolvedValue('tampered-locale');

      const view = await render(provider());
      await waitFor(() => expect(screen.getByTestId('locale').props.children).toBe(expected));

      await view.unmount();
    },
  );

  test('falls back to the device locale when encrypted preference initialization fails', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockDeviceLocale = 'ko-KR';
    mockInitialize.mockRejectedValue(new Error('controlled secure persistence failure'));

    const view = await render(provider());
    await waitFor(() => expect(screen.getByTestId('locale').props.children).toBe('ko'));
    expect(mockGetCache).not.toHaveBeenCalled();

    await view.unmount();
  });

  test('changes locale immediately and treats encrypted preference write failure as non-fatal', async () => {
    const view = await render(provider());
    await waitFor(() => expect(mockGetCache).toHaveBeenCalled());

    await fireEvent.press(screen.getByRole('button', { name: 'set Korean' }));
    expect(screen.getByTestId('locale').props.children).toBe('ko');
    expect(mockPutCache).toHaveBeenLastCalledWith('preferences.ui-locale', 'ko');

    mockPutCache.mockRejectedValueOnce(new Error('controlled write failure'));
    await fireEvent.press(screen.getByRole('button', { name: 'set Spanish' }));
    expect(screen.getByTestId('locale').props.children).toBe('es');
    expect(mockPutCache).toHaveBeenLastCalledWith('preferences.ui-locale', 'es');

    await fireEvent.press(screen.getByRole('button', { name: 'set English' }));
    expect(screen.getByTestId('locale').props.children).toBe('en');

    await view.unmount();
  });

  test('ignores both late initialization success and late failure after unmount', async () => {
    let resolveInitialization!: () => void;
    mockInitialize.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveInitialization = resolve;
    }));
    const successfulView = await render(provider());
    await successfulView.unmount();
    resolveInitialization();
    await waitFor(() => expect(mockGetCache).toHaveBeenCalledTimes(1));

    let rejectInitialization!: (reason: Error) => void;
    mockInitialize.mockReturnValueOnce(new Promise<void>((_resolve, reject) => {
      rejectInitialization = reject;
    }));
    const failedView = await render(provider());
    await failedView.unmount();
    rejectInitialization(new Error('controlled late failure'));
    await Promise.resolve();

    expect(mockGetCache).toHaveBeenCalledTimes(1);
  });

  test('rejects use outside the provider boundary', async () => {
    function OutsideProvider() {
      useI18n();
      return null;
    }

    await expect(render(<OutsideProvider />)).rejects.toThrow(
      'useI18n must be used inside I18nProvider',
    );
  });
});
