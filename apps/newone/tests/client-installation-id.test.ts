import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockRandomUUID = jest.fn<() => string>();
const mockSecureStorage = {
  getItem: jest.fn<(key: string) => Promise<string | null>>(),
  setItem: jest.fn<(key: string, value: string) => Promise<void>>(),
};

jest.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
}));

jest.mock('@/lib/secure-storage', () => ({
  secureStorage: mockSecureStorage,
}));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const webCreationCases: Record<string, string>[] = [
  {},
  { 'newone.installation-id': 'invalid-persisted-id' },
];

function removeWindow() {
  Reflect.deleteProperty(globalThis, 'window');
}

function installWindow(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const localStorage = {
    getItem: jest.fn((key: string) => values.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage },
  });
  return localStorage;
}

beforeEach(() => {
  jest.resetModules();
  mockRandomUUID.mockReset();
  mockRandomUUID.mockReturnValue('123e4567-e89b-42d3-a456-426614174000');
  mockSecureStorage.getItem.mockReset();
  mockSecureStorage.setItem.mockReset();
  mockSecureStorage.setItem.mockResolvedValue(undefined);
  removeWindow();
});

afterEach(() => {
  removeWindow();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
});

describe('client and installation identifiers', () => {
  test('delegates client identity generation to the operating-system crypto source', () => {
    mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    const { createClientId } = jest.requireActual<typeof import('@/lib/client-id')>('@/lib/client-id');

    expect(createClientId()).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(mockRandomUUID).toHaveBeenCalledTimes(1);
  });

  test('native installation identity reuses only a valid persisted UUID', async () => {
    mockSecureStorage.getItem.mockResolvedValue('123e4567-e89b-42d3-a456-426614174001');
    const { getInstallationId } = jest.requireActual<typeof import('@/lib/installation-id.native')>(
      '@/lib/installation-id.native',
    );

    await expect(getInstallationId()).resolves.toBe('123e4567-e89b-42d3-a456-426614174001');
    expect(mockSecureStorage.getItem).toHaveBeenCalledWith('newone.device.installation-id');
    expect(mockRandomUUID).not.toHaveBeenCalled();
    expect(mockSecureStorage.setItem).not.toHaveBeenCalled();
  });

  test.each([null, 'not-a-uuid'])('native installation identity replaces missing or invalid data: %s', async (existing) => {
    mockSecureStorage.getItem.mockResolvedValue(existing);
    const { getInstallationId } = jest.requireActual<typeof import('@/lib/installation-id.native')>(
      '@/lib/installation-id.native',
    );

    await expect(getInstallationId()).resolves.toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(mockSecureStorage.setItem).toHaveBeenCalledWith(
      'newone.device.installation-id',
      '123e4567-e89b-42d3-a456-426614174000',
    );
  });

  test('web installation identity reuses valid browser storage and then its in-memory value', async () => {
    const localStorage = installWindow({
      'newone.installation-id': '123e4567-e89b-42d3-a456-426614174002',
    });
    const { getInstallationId } = jest.requireActual<typeof import('@/lib/installation-id.web')>(
      '@/lib/installation-id.web',
    );

    await expect(getInstallationId()).resolves.toBe('123e4567-e89b-42d3-a456-426614174002');
    localStorage.getItem.mockReturnValue(null);
    await expect(getInstallationId()).resolves.toBe('123e4567-e89b-42d3-a456-426614174002');
    expect(localStorage.getItem).toHaveBeenCalledTimes(1);
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(mockRandomUUID).not.toHaveBeenCalled();
  });

  test.each(webCreationCases)(
    'web installation identity creates and persists when browser data is absent or invalid',
    async (initial) => {
      const localStorage = installWindow(initial);
      const { getInstallationId } = jest.requireActual<typeof import('@/lib/installation-id.web')>(
        '@/lib/installation-id.web',
      );

      await expect(getInstallationId()).resolves.toBe('123e4567-e89b-42d3-a456-426614174000');
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'newone.installation-id',
        '123e4567-e89b-42d3-a456-426614174000',
      );
    },
  );

  test('server rendering creates a process-local installation identity without browser storage', async () => {
    const { getInstallationId } = jest.requireActual<typeof import('@/lib/installation-id.web')>(
      '@/lib/installation-id.web',
    );

    await expect(getInstallationId()).resolves.toBe('123e4567-e89b-42d3-a456-426614174000');
    await expect(getInstallationId()).resolves.toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(mockRandomUUID).toHaveBeenCalledTimes(1);
  });
});
