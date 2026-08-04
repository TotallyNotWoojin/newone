import * as SecureStore from 'expo-secure-store';

const CHUNK_SIZE = 1800;
const MAX_CHUNKS = 64;
const STORAGE_KEY_PATTERN = /^[a-zA-Z0-9._-]{1,200}$/;

function storageKey(key: string) {
  if (!STORAGE_KEY_PATTERN.test(key)) throw new Error('Invalid secure-storage key.');
  return key;
}

function metadataKey(key: string) {
  return `${storageKey(key)}__count`;
}

function chunkKey(key: string, index: number) {
  return `${storageKey(key)}__${index}`;
}

export const secureStorage = {
  async getItem(key: string) {
    const countValue = await SecureStore.getItemAsync(metadataKey(key));
    if (!countValue) return null;
    const count = Number(countValue);
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CHUNKS) return null;
    const chunks = await Promise.all(
      Array.from({ length: count }, (_, index) => SecureStore.getItemAsync(chunkKey(key, index))),
    );
    if (chunks.some((chunk) => chunk === null)) return null;
    return chunks.join('');
  },
  async setItem(key: string, value: string) {
    const chunks = Array.from(
      { length: Math.max(1, Math.ceil(value.length / CHUNK_SIZE)) },
      (_, index) => value.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
    );
    if (chunks.length > MAX_CHUNKS) {
      throw new Error('Secure-storage value exceeds the bounded credential size.');
    }
    // Validate before removing the previously committed value. Oversized or
    // malformed replacement data must not destroy a still-valid session.
    storageKey(key);
    await this.removeItem(key);
    await Promise.all(
      chunks.map((chunk, index) =>
        SecureStore.setItemAsync(chunkKey(key, index), chunk, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }),
      ),
    );
    await SecureStore.setItemAsync(metadataKey(key), String(chunks.length), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  async removeItem(key: string) {
    const countValue = await SecureStore.getItemAsync(metadataKey(key));
    const count = Number(countValue ?? 0);
    // Missing/corrupt metadata can mean a prior chunk write crashed before its
    // commit marker. Sweep the bounded namespace so sensitive orphan chunks do
    // not survive sign-out, overwrite, or a later recovery attempt.
    const chunksToClear = Number.isSafeInteger(count) && count > 0 && count <= MAX_CHUNKS
      ? count
      : MAX_CHUNKS;
    await Promise.all(
      Array.from({ length: chunksToClear }, (_, index) =>
        SecureStore.deleteItemAsync(chunkKey(key, index)),
      ),
    );
    await SecureStore.deleteItemAsync(metadataKey(key));
  },
};

export const authStorage = secureStorage;
