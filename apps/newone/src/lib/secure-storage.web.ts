import { webAuthMode } from '@/config/runtime';
// Metro selects the IndexedDB-backed web client store.
// eslint-disable-next-line import/no-unresolved
import { clientStore } from '@/data/persistence/client-store';
import { createWebSessionStorage } from '@/lib/web-session-storage';

// Production web authentication terminates at the Newone BFF and uses an
// HttpOnly, Secure, SameSite cookie. This in-memory adapter deliberately avoids
// persisting a bearer token in localStorage during the standalone client phase.
const values = new Map<string, string>();

export const secureStorage = {
  async getItem(key: string) {
    return values.get(key) ?? null;
  },
  async setItem(key: string, value: string) {
    values.set(key, value);
  },
  async removeItem(key: string) {
    values.delete(key);
  },
};

// Direct (bearer) web builds hold the Supabase session themselves, so it goes
// to the encrypted IndexedDB client store rather than dying with the tab.
export const authStorage = webAuthMode === 'direct'
  ? createWebSessionStorage(clientStore)
  : secureStorage;
