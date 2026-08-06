import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
  authStorage,
  secureStorage,
} from '@/lib/secure-storage.native';

const mockGetItemAsync = jest.fn<(key: string) => Promise<string | null>>();
const mockSetItemAsync = jest.fn<(
  key: string,
  value: string,
  options?: Record<string, unknown>,
) => Promise<void>>();
const mockDeleteItemAsync = jest.fn<(key: string) => Promise<void>>();

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: (key: string) => mockGetItemAsync(key),
  setItemAsync: (key: string, value: string, options?: Record<string, unknown>) => (
    mockSetItemAsync(key, value, options)
  ),
  deleteItemAsync: (key: string) => mockDeleteItemAsync(key),
}));

beforeEach(() => {
  mockGetItemAsync.mockReset();
  mockSetItemAsync.mockReset();
  mockDeleteItemAsync.mockReset();
  mockGetItemAsync.mockResolvedValue(null);
  mockSetItemAsync.mockResolvedValue(undefined);
  mockDeleteItemAsync.mockResolvedValue(undefined);
});

describe('native secure storage adapter', () => {
  test('returns null for absent, corrupt, incomplete, or unbounded chunk metadata', async () => {
    await expect(secureStorage.getItem('valid.key')).resolves.toBeNull();

    for (const count of ['not-a-number', '0', '65', '1.5']) {
      mockGetItemAsync.mockResolvedValueOnce(count);
      await expect(secureStorage.getItem('valid.key')).resolves.toBeNull();
    }

    mockGetItemAsync.mockImplementation(async (key) => ({
      'valid.key__count': '2',
      'valid.key__0': 'first',
      'valid.key__1': null,
    })[key] ?? null);
    await expect(secureStorage.getItem('valid.key')).resolves.toBeNull();
  });

  test('reassembles every committed encrypted chunk in order', async () => {
    mockGetItemAsync.mockImplementation(async (key) => ({
      'session.token__count': '3',
      'session.token__0': 'alpha-',
      'session.token__1': 'beta-',
      'session.token__2': 'gamma',
    })[key] ?? null);

    await expect(secureStorage.getItem('session.token')).resolves.toBe('alpha-beta-gamma');
    expect(mockGetItemAsync.mock.calls.map(([key]) => key)).toEqual([
      'session.token__count',
      'session.token__0',
      'session.token__1',
      'session.token__2',
    ]);
  });

  test('rejects malformed keys before any sensitive value can be addressed', async () => {
    for (const key of ['', 'contains space', 'x'.repeat(201), 'slash/key']) {
      await expect(secureStorage.getItem(key)).rejects.toThrow('Invalid secure-storage key.');
      await expect(secureStorage.setItem(key, 'controlled-value')).rejects.toThrow(
        'Invalid secure-storage key.',
      );
      await expect(secureStorage.removeItem(key)).rejects.toThrow('Invalid secure-storage key.');
    }
    expect(mockSetItemAsync).not.toHaveBeenCalled();
    expect(mockDeleteItemAsync).not.toHaveBeenCalled();
  });

  test('removes the prior commit, writes bounded chunks, and commits metadata last', async () => {
    mockGetItemAsync.mockResolvedValue('2');
    const value = `${'a'.repeat(1_800)}${'b'.repeat(1_800)}tail`;

    await secureStorage.setItem('session.token', value);

    expect(mockDeleteItemAsync.mock.calls.map(([key]) => key)).toEqual([
      'session.token__0',
      'session.token__1',
      'session.token__count',
    ]);
    expect(mockSetItemAsync).toHaveBeenNthCalledWith(
      1,
      'session.token__0',
      'a'.repeat(1_800),
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
    expect(mockSetItemAsync).toHaveBeenNthCalledWith(
      2,
      'session.token__1',
      'b'.repeat(1_800),
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
    expect(mockSetItemAsync).toHaveBeenNthCalledWith(
      3,
      'session.token__2',
      'tail',
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
    expect(mockSetItemAsync).toHaveBeenLastCalledWith(
      'session.token__count',
      '3',
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
  });

  test('stores an empty value as one committed chunk and shares the adapter with auth', async () => {
    expect(authStorage).toBe(secureStorage);
    await secureStorage.setItem('empty.value', '');

    expect(mockSetItemAsync).toHaveBeenCalledWith(
      'empty.value__0',
      '',
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
    expect(mockSetItemAsync).toHaveBeenLastCalledWith(
      'empty.value__count',
      '1',
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
  });

  test('rejects an oversized replacement before removing a previously committed session', async () => {
    const oversized = 'x'.repeat((1_800 * 64) + 1);

    await expect(secureStorage.setItem('session.token', oversized)).rejects.toThrow(
      'Secure-storage value exceeds the bounded credential size.',
    );
    expect(mockGetItemAsync).not.toHaveBeenCalled();
    expect(mockSetItemAsync).not.toHaveBeenCalled();
    expect(mockDeleteItemAsync).not.toHaveBeenCalled();
  });

  test('clears the exact committed namespace and sweeps the bound for missing or corrupt metadata', async () => {
    mockGetItemAsync.mockResolvedValueOnce('3');
    await secureStorage.removeItem('session.token');
    expect(mockDeleteItemAsync.mock.calls.map(([key]) => key)).toEqual([
      'session.token__0',
      'session.token__1',
      'session.token__2',
      'session.token__count',
    ]);

    mockDeleteItemAsync.mockClear();
    mockGetItemAsync.mockResolvedValueOnce('65');
    await secureStorage.removeItem('session.token');
    expect(mockDeleteItemAsync).toHaveBeenCalledTimes(65);
    expect(mockDeleteItemAsync).toHaveBeenCalledWith('session.token__63');
    expect(mockDeleteItemAsync).toHaveBeenLastCalledWith('session.token__count');

    mockDeleteItemAsync.mockClear();
    mockGetItemAsync.mockResolvedValueOnce(null);
    await secureStorage.removeItem('session.token');
    expect(mockDeleteItemAsync).toHaveBeenCalledTimes(65);
  });
});

describe('web secure storage adapter', () => {
  test('keeps values only in memory and supports overwrite and removal', async () => {
    const {
      secureStorage: webStorage,
      authStorage: webAuthStorage,
    } = jest.requireActual<typeof import('@/lib/secure-storage.web')>('@/lib/secure-storage.web');

    expect(webAuthStorage).toBe(webStorage);
    await expect(webStorage.getItem('controlled-web-key')).resolves.toBeNull();
    await webStorage.setItem('controlled-web-key', 'first');
    await webStorage.setItem('controlled-web-key', 'second');
    await expect(webStorage.getItem('controlled-web-key')).resolves.toBe('second');
    await webStorage.removeItem('controlled-web-key');
    await expect(webStorage.getItem('controlled-web-key')).resolves.toBeNull();
  });
});
