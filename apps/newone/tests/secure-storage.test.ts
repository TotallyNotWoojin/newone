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
const mockClientStore = {
  initialize: jest.fn(async () => undefined),
  getCache: jest.fn(async () => null as string | null),
  putCache: jest.fn(async () => undefined),
  removeCache: jest.fn(async () => undefined),
};

// The web adapter reaches for the encrypted client store only in direct mode;
// Jest resolves the native store here, which must not load.
jest.mock('@/data/persistence/client-store', () => ({ clientStore: mockClientStore }));

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

  test('writes the replacement under the next generation and switches the marker last', async () => {
    mockGetItemAsync.mockResolvedValue('2:4');
    const value = `${'a'.repeat(1_800)}${'b'.repeat(1_800)}tail`;

    await secureStorage.setItem('session.token', value);

    expect(mockSetItemAsync).toHaveBeenNthCalledWith(
      1,
      'session.token__g5__0',
      'a'.repeat(1_800),
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
    expect(mockSetItemAsync).toHaveBeenNthCalledWith(
      2,
      'session.token__g5__1',
      'b'.repeat(1_800),
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
    expect(mockSetItemAsync).toHaveBeenNthCalledWith(
      3,
      'session.token__g5__2',
      'tail',
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
    expect(mockSetItemAsync).toHaveBeenLastCalledWith(
      'session.token__count',
      '3:5',
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
    // The generation being replaced (4) stays for in-flight readers; the one
    // before it (3) is swept.
    const deleted = mockDeleteItemAsync.mock.calls.map(([key]) => key);
    expect(deleted).toHaveLength(64);
    expect(deleted[0]).toBe('session.token__g3__0');
    expect(deleted.some((key) => key.startsWith('session.token__g4__'))).toBe(false);
    expect(deleted).not.toContain('session.token__count');
  });

  test('a read that overlaps a rewrite sees the previous or the new session, never nothing', async () => {
    // A small in-memory keychain with a slow chunk write so the read can land
    // in the middle of the rewrite, the window that signed a device out.
    const keychain = new Map<string, string>();
    let releaseSlowWrite: () => void = () => undefined;
    const slowWrite = new Promise<void>((resolve) => {
      releaseSlowWrite = resolve;
    });
    mockGetItemAsync.mockImplementation(async (key) => keychain.get(key) ?? null);
    mockSetItemAsync.mockImplementation(async (key, value) => {
      if (key === 'session.token__count' && value === '1:2') await slowWrite;
      keychain.set(key, value);
    });
    mockDeleteItemAsync.mockImplementation(async (key) => {
      keychain.delete(key);
    });

    await secureStorage.setItem('session.token', 'old-session');
    const rewrite = secureStorage.setItem('session.token', 'new-session');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The new chunk exists but the marker has not switched: the old value is
    // still what a reader gets.
    await expect(secureStorage.getItem('session.token')).resolves.toBe('old-session');
    releaseSlowWrite();
    await rewrite;
    await expect(secureStorage.getItem('session.token')).resolves.toBe('new-session');
    expect(keychain.has('session.token__g1__0')).toBe(true);

    await secureStorage.setItem('session.token', 'third-session');
    await expect(secureStorage.getItem('session.token')).resolves.toBe('third-session');
    expect(keychain.has('session.token__g1__0')).toBe(false);
  });

  test('reads the original single-generation layout and migrates it on the next write', async () => {
    mockGetItemAsync.mockImplementation(async (key) => ({
      'session.token__count': '2',
      'session.token__0': 'legacy-',
      'session.token__1': 'value',
    })[key] ?? null);
    await expect(secureStorage.getItem('session.token')).resolves.toBe('legacy-value');

    await secureStorage.setItem('session.token', 'fresh');
    expect(mockSetItemAsync).toHaveBeenNthCalledWith(
      1,
      'session.token__g1__0',
      'fresh',
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
    expect(mockSetItemAsync).toHaveBeenLastCalledWith(
      'session.token__count',
      '1:1',
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
  });

  test('stores an empty value as one committed chunk and shares the adapter with auth', async () => {
    expect(authStorage).toBe(secureStorage);
    await secureStorage.setItem('empty.value', '');

    expect(mockSetItemAsync).toHaveBeenCalledWith(
      'empty.value__g1__0',
      '',
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
    expect(mockSetItemAsync).toHaveBeenLastCalledWith(
      'empty.value__count',
      '1:1',
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
  });

  test('rejects an oversized replacement before touching a previously committed session', async () => {
    const oversized = 'x'.repeat((1_800 * 64) + 1);

    await expect(secureStorage.setItem('session.token', oversized)).rejects.toThrow(
      'Secure-storage value exceeds the bounded credential size.',
    );
    expect(mockGetItemAsync).not.toHaveBeenCalled();
    expect(mockSetItemAsync).not.toHaveBeenCalled();
    expect(mockDeleteItemAsync).not.toHaveBeenCalled();
  });

  test('removal drops the marker first, then sweeps the live, neighbouring, and original generations', async () => {
    mockGetItemAsync.mockResolvedValueOnce('3:4');
    await secureStorage.removeItem('session.token');
    const deleted = mockDeleteItemAsync.mock.calls.map(([key]) => key);
    expect(deleted[0]).toBe('session.token__count');
    for (const generation of ['__0', '__g3__0', '__g4__0', '__g5__0']) {
      expect(deleted).toContain(`session.token${generation}`);
    }
    expect(deleted).toHaveLength(1 + 64 * 4);

    mockDeleteItemAsync.mockClear();
    mockGetItemAsync.mockResolvedValueOnce(null);
    await secureStorage.removeItem('session.token');
    expect(mockDeleteItemAsync).toHaveBeenCalledTimes(1 + 64);
    expect(mockDeleteItemAsync).toHaveBeenCalledWith('session.token__63');
  });
});

describe('web secure storage adapter', () => {
  test('keeps values only in memory and supports overwrite and removal', async () => {
    const {
      secureStorage: webStorage,
      authStorage: webAuthStorage,
    } = jest.requireActual<typeof import('@/lib/secure-storage.web')>('@/lib/secure-storage.web');

    // Cookie-gateway web (the default) never persists a bearer token.
    expect(webAuthStorage).toBe(webStorage);
    await expect(webStorage.getItem('controlled-web-key')).resolves.toBeNull();
    await webStorage.setItem('controlled-web-key', 'first');
    await webStorage.setItem('controlled-web-key', 'second');
    await expect(webStorage.getItem('controlled-web-key')).resolves.toBe('second');
    await webStorage.removeItem('controlled-web-key');
    await expect(webStorage.getItem('controlled-web-key')).resolves.toBeNull();
  });

  test('direct (bearer) web keeps the auth session in the encrypted client store instead', async () => {
    let webModule: typeof import('@/lib/secure-storage.web') | null = null;
    jest.isolateModules(() => {
      jest.doMock('@/config/runtime', () => ({ webAuthMode: 'direct' }));
      webModule = jest.requireActual<typeof import('@/lib/secure-storage.web')>('@/lib/secure-storage.web');
    });
    jest.dontMock('@/config/runtime');
    const { authStorage: directAuthStorage, secureStorage: memoryStorage } = webModule!;

    expect(directAuthStorage).not.toBe(memoryStorage);
    await directAuthStorage.setItem('sb-controlled-auth-token', 'session-json');
    expect(mockClientStore.initialize).toHaveBeenCalledTimes(1);
    expect(mockClientStore.putCache).toHaveBeenCalledWith('web-session.sb-controlled-auth-token', 'session-json');
    await expect(memoryStorage.getItem('sb-controlled-auth-token')).resolves.toBeNull();
  });
});
