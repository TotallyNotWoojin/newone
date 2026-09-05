import type { ClientStore } from '@/data/persistence/types';

type SessionStore = Pick<ClientStore, 'initialize' | 'getCache' | 'putCache' | 'removeCache'>;

export interface WebSessionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const KEY_PREFIX = 'web-session.';

/**
 * Supabase auth storage for the direct (bearer) web mode. The session lives in
 * the encrypted IndexedDB client store (AES-GCM under a non-extractable key),
 * so it survives a reload without ever touching localStorage. When the store
 * is unavailable (private mode, blocked storage) the adapter degrades to
 * memory for the life of the tab instead of failing sign-in.
 */
export function createWebSessionStorage(store: SessionStore): WebSessionStorage {
  const memory = new Map<string, string>();
  let ready: Promise<boolean> | null = null;
  const storeReady = () => {
    ready ??= store.initialize().then(() => true, () => false);
    return ready;
  };
  return {
    async getItem(key) {
      if (await storeReady()) {
        try {
          const value = await store.getCache(`${KEY_PREFIX}${key}`);
          if (value !== null) return value;
        } catch {
          // Fall through to the in-memory copy for this tab.
        }
      }
      return memory.get(key) ?? null;
    },
    async setItem(key, value) {
      memory.set(key, value);
      if (!(await storeReady())) return;
      try {
        await store.putCache(`${KEY_PREFIX}${key}`, value);
      } catch {
        // The in-memory copy keeps this tab signed in; the next write retries.
      }
    },
    async removeItem(key) {
      memory.delete(key);
      if (!(await storeReady())) return;
      try {
        await store.removeCache(`${KEY_PREFIX}${key}`);
      } catch {
        // The memory copy is gone; the encrypted record has no live reader.
      }
    },
  };
}
