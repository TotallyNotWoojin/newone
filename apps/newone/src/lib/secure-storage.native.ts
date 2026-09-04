import * as SecureStore from 'expo-secure-store';

const CHUNK_SIZE = 1800;
const MAX_CHUNKS = 64;
const STORAGE_KEY_PATTERN = /^[a-zA-Z0-9._-]{1,200}$/;
const KEYCHAIN_OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

function storageKey(key: string) {
  if (!STORAGE_KEY_PATTERN.test(key)) throw new Error('Invalid secure-storage key.');
  return key;
}

function metadataKey(key: string) {
  return `${storageKey(key)}__count`;
}

// Generation 0 is the original layout (`key__<index>`); later generations
// live under `key__g<generation>__<index>` so a new value is written next to
// the old one instead of over it.
function chunkKey(key: string, generation: number, index: number) {
  return generation === 0
    ? `${storageKey(key)}__${index}`
    : `${storageKey(key)}__g${generation}__${index}`;
}

interface Pointer {
  count: number;
  generation: number;
}

// Metadata is `<count>` (generation 0, the original format) or
// `<count>:<generation>`.
function parsePointer(value: string | null): Pointer | null {
  if (!value) return null;
  const [countText, generationText = '0'] = value.split(':');
  const count = Number(countText);
  const generation = Number(generationText);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CHUNKS) return null;
  if (!Number.isSafeInteger(generation) || generation < 0) return null;
  return { count, generation };
}

async function deleteGeneration(key: string, generation: number, count = MAX_CHUNKS) {
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      SecureStore.deleteItemAsync(chunkKey(key, generation, index))
    ),
  );
}

/**
 * Chunked keychain storage whose writes never leave a reader without a value.
 *
 * The previous version removed the committed value (its count marker first)
 * and then wrote the replacement, so a read that landed in between saw
 * nothing. Supabase reads the persisted session from storage on every
 * getSession(), and every token refresh rewrites it; a request that hit that
 * window got no session, was treated as signed out, and the app ended
 * access: device suite, run-2026-09-04T08-47-04, chat A signed out eight
 * minutes after signing in, at the first refresh.
 *
 * Now a replacement is written under the next generation's keys, the single
 * count marker is switched to it last, and the generation before the one
 * just replaced is cleared afterwards. A concurrent reader sees the old
 * value or the new one, never a partial or missing one.
 */
export const secureStorage = {
  async getItem(key: string) {
    const pointer = parsePointer(await SecureStore.getItemAsync(metadataKey(key)));
    if (!pointer) return null;
    const chunks = await Promise.all(
      Array.from({ length: pointer.count }, (_, index) =>
        SecureStore.getItemAsync(chunkKey(key, pointer.generation, index))
      ),
    );
    if (chunks.some((chunk) => chunk === null)) return null;
    return chunks.join('');
  },
  async setItem(key: string, value: string) {
    storageKey(key);
    const chunks = Array.from(
      { length: Math.max(1, Math.ceil(value.length / CHUNK_SIZE)) },
      (_, index) => value.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
    );
    if (chunks.length > MAX_CHUNKS) {
      throw new Error('Secure-storage value exceeds the bounded credential size.');
    }
    const current = parsePointer(await SecureStore.getItemAsync(metadataKey(key)));
    const generation = (current?.generation ?? 0) + 1;
    await Promise.all(
      chunks.map((chunk, index) =>
        SecureStore.setItemAsync(chunkKey(key, generation, index), chunk, KEYCHAIN_OPTIONS)
      ),
    );
    // The single marker write is the commit point.
    await SecureStore.setItemAsync(metadataKey(key), `${chunks.length}:${generation}`, KEYCHAIN_OPTIONS);
    // Readers that loaded the marker just before the switch may still be
    // reading the replaced generation, so only the one before it is cleared.
    if (generation >= 2) await deleteGeneration(key, generation - 2);
  },
  async removeItem(key: string) {
    const pointer = parsePointer(await SecureStore.getItemAsync(metadataKey(key)));
    await SecureStore.deleteItemAsync(metadataKey(key));
    // Sweep the current generation, the two before it (a write may have
    // crashed before its commit marker), and the original layout, so no
    // sensitive chunk survives sign-out or a later recovery attempt.
    const generations = new Set<number>([0]);
    if (pointer) {
      for (const generation of [pointer.generation, pointer.generation - 1, pointer.generation + 1]) {
        if (generation >= 0) generations.add(generation);
      }
    }
    await Promise.all([...generations].map((generation) => deleteGeneration(key, generation)));
  },
};

export const authStorage = secureStorage;
