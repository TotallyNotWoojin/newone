import { describe, expect, jest, test } from '@jest/globals';

import { createWebSessionStorage } from '@/lib/web-session-storage';

type Store = Parameters<typeof createWebSessionStorage>[0];

function controlledStore(overrides: Partial<Store> = {}) {
  const records = new Map<string, string>();
  const store: Store = {
    initialize: jest.fn(async () => undefined),
    getCache: jest.fn(async (key: string) => records.get(key) ?? null),
    putCache: jest.fn(async (key: string, value: string) => {
      records.set(key, value);
    }),
    removeCache: jest.fn(async (key: string) => {
      records.delete(key);
    }),
    ...overrides,
  };
  return { records, store };
}

describe('direct web session storage', () => {
  test('keeps the Supabase session in the encrypted client store under a namespaced key', async () => {
    const { records, store } = controlledStore();
    const storage = createWebSessionStorage(store);

    await expect(storage.getItem('sb-project-auth-token')).resolves.toBeNull();
    await storage.setItem('sb-project-auth-token', '{"access_token":"controlled"}');
    expect([...records.keys()]).toEqual(['web-session.sb-project-auth-token']);
    await expect(storage.getItem('sb-project-auth-token')).resolves.toBe('{"access_token":"controlled"}');

    await storage.removeItem('sb-project-auth-token');
    expect(records.size).toBe(0);
    await expect(storage.getItem('sb-project-auth-token')).resolves.toBeNull();
    // The store is opened once and reused.
    expect(store.initialize).toHaveBeenCalledTimes(1);
  });

  test('degrades to tab memory when IndexedDB cannot be opened', async () => {
    const { store } = controlledStore({
      initialize: jest.fn(async () => {
        throw new Error('Secure offline storage unavailable: private mode');
      }),
    });
    const storage = createWebSessionStorage(store);

    await storage.setItem('sb-project-auth-token', 'memory-only');
    await expect(storage.getItem('sb-project-auth-token')).resolves.toBe('memory-only');
    expect(store.putCache).not.toHaveBeenCalled();
    expect(store.getCache).not.toHaveBeenCalled();

    await storage.removeItem('sb-project-auth-token');
    await expect(storage.getItem('sb-project-auth-token')).resolves.toBeNull();
  });

  test('a failing read or write does not sign the tab out', async () => {
    const { store } = controlledStore({
      getCache: jest.fn(async () => {
        throw new Error('database request failed');
      }),
      putCache: jest.fn(async () => {
        throw new Error('cache entry exceeds the bounded storage limit');
      }),
      removeCache: jest.fn(async () => {
        throw new Error('database transaction aborted');
      }),
    });
    const storage = createWebSessionStorage(store);

    await expect(storage.setItem('key', 'value')).resolves.toBeUndefined();
    await expect(storage.getItem('key')).resolves.toBe('value');
    await expect(storage.removeItem('key')).resolves.toBeUndefined();
    await expect(storage.getItem('key')).resolves.toBeNull();
  });
});
