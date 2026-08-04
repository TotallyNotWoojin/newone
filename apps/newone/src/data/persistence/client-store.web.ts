import type { ClientStore, OutboxCommand } from '@/data/persistence/types';

const DATABASE_NAME = 'newone-secure-client';
const DATABASE_VERSION = 1;
const CRYPTO_VERSION = 1;
const PRIMARY_KEY_ID = 'aes-gcm-v1';
const KEYRING_STORE = 'keyring';
const RECORD_STORE = 'records';
const MAX_CACHE_RECORDS = 128;
const MAX_SENSITIVE_CACHE_BYTES = 5 * 1024 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface KeyRecord {
  id: string;
  key: CryptoKey;
  createdAt: string;
}

interface EncryptedRecord {
  storageKey: string;
  recordIdHash: string;
  kind: 'cache' | 'outbox';
  ownerHash: string;
  organizationHash: string;
  scopeHash: string;
  cryptoVersion: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  iv: number[];
  ciphertext: ArrayBuffer;
}

interface CacheEnvelope {
  key: string;
  value: string;
}

let databasePromise: Promise<IDBDatabase> | null = null;
let keyPromise: Promise<CryptoKey> | null = null;

function storageUnavailable(reason: string) {
  return new Error(`Secure offline storage unavailable: ${reason}`);
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? storageUnavailable('database request failed'));
  });
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? storageUnavailable('database transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? storageUnavailable('database transaction failed'));
  });
}

function database() {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(storageUnavailable('this browser does not support IndexedDB'));
  }

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEYRING_STORE)) {
        db.createObjectStore(KEYRING_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(RECORD_STORE)) {
        const records = db.createObjectStore(RECORD_STORE, { keyPath: 'storageKey' });
        records.createIndex('kind', 'kind', { unique: false });
        records.createIndex('ownerHash', 'ownerHash', { unique: false });
        records.createIndex('scopeHash', 'scopeHash', { unique: false });
        records.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? storageUnavailable('database could not open'));
    request.onblocked = () => reject(storageUnavailable('another app tab is blocking a storage upgrade'));
  }).catch((error) => {
    databasePromise = null;
    throw error;
  });

  return databasePromise;
}

function subtleCrypto() {
  if (!globalThis.crypto?.subtle) {
    throw storageUnavailable('WebCrypto is required');
  }
  return globalThis.crypto.subtle;
}

async function digest(value: string) {
  const bytes = await subtleCrypto().digest('SHA-256', textEncoder.encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readKeyRecord(db: IDBDatabase) {
  const transaction = db.transaction(KEYRING_STORE, 'readonly');
  const complete = transactionComplete(transaction);
  const record = await requestResult<KeyRecord | undefined>(
    transaction.objectStore(KEYRING_STORE).get(PRIMARY_KEY_ID),
  );
  await complete;
  return record;
}

async function encryptionKey() {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    const db = await database();
    const existing = await readKeyRecord(db);
    if (
      existing?.key
      && existing.key.type === 'secret'
      && existing.key.algorithm.name === 'AES-GCM'
      && existing.key.extractable === false
    ) {
      return existing.key;
    }

    // A missing key makes existing ciphertext unrecoverable. Purge it rather than
    // silently retaining undecryptable workplace content under a newly generated key.
    const key = await subtleCrypto().generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    const transaction = db.transaction([KEYRING_STORE, RECORD_STORE], 'readwrite');
    const complete = transactionComplete(transaction);
    transaction.objectStore(RECORD_STORE).clear();
    transaction.objectStore(KEYRING_STORE).put({
      id: PRIMARY_KEY_ID,
      key,
      createdAt: new Date().toISOString(),
    } satisfies KeyRecord);
    await complete;
    return key;
  })().catch((error) => {
    keyPromise = null;
    throw error;
  });
  return keyPromise;
}

function additionalData(record: EncryptedRecord) {
  return textEncoder.encode(JSON.stringify({
    storageKey: record.storageKey,
    recordIdHash: record.recordIdHash,
    kind: record.kind,
    userIdHash: record.ownerHash,
    organizationIdHash: record.organizationHash,
    scopeHash: record.scopeHash,
    cryptoVersion: record.cryptoVersion,
  }));
}

async function encryptRecord(
  metadata: Omit<EncryptedRecord, 'iv' | 'ciphertext' | 'cryptoVersion'>,
  plaintext: string,
): Promise<EncryptedRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const record: EncryptedRecord = {
    ...metadata,
    cryptoVersion: CRYPTO_VERSION,
    iv: [...iv],
    ciphertext: new ArrayBuffer(0),
  };
  record.ciphertext = await subtleCrypto().encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(record), tagLength: 128 },
    await encryptionKey(),
    textEncoder.encode(plaintext),
  );
  return record;
}

async function decryptRecord(record: EncryptedRecord) {
  if (record.cryptoVersion !== CRYPTO_VERSION || record.iv.length !== 12) {
    throw storageUnavailable('stored record uses an unsupported encryption version');
  }
  const plaintext = await subtleCrypto().decrypt(
    {
      name: 'AES-GCM',
      iv: new Uint8Array(record.iv),
      additionalData: additionalData(record),
      tagLength: 128,
    },
    await encryptionKey(),
    record.ciphertext,
  );
  return textDecoder.decode(plaintext);
}

async function getRecord(storageKey: string) {
  const db = await database();
  const transaction = db.transaction(RECORD_STORE, 'readonly');
  const complete = transactionComplete(transaction);
  const record = await requestResult<EncryptedRecord | undefined>(
    transaction.objectStore(RECORD_STORE).get(storageKey),
  );
  await complete;
  return record;
}

async function deleteStorageKeys(storageKeys: string[]) {
  if (!storageKeys.length) return;
  const db = await database();
  const transaction = db.transaction(RECORD_STORE, 'readwrite');
  const complete = transactionComplete(transaction);
  const records = transaction.objectStore(RECORD_STORE);
  storageKeys.forEach((storageKey) => records.delete(storageKey));
  await complete;
}

async function allRecords() {
  const db = await database();
  const transaction = db.transaction(RECORD_STORE, 'readonly');
  const complete = transactionComplete(transaction);
  const records = await requestResult<EncryptedRecord[]>(
    transaction.objectStore(RECORD_STORE).getAll(),
  );
  await complete;
  return records;
}

async function pruneCache(force = false) {
  const records = await allRecords();
  const cacheRecords = records
    .filter((record) => record.kind === 'cache')
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const expired = cacheRecords.filter(
    (record) => record.expiresAt && Date.parse(record.expiresAt) <= Date.now(),
  );
  const expiredKeys = new Set(expired.map((record) => record.storageKey));
  let excess = Math.max(0, cacheRecords.length - expired.length - MAX_CACHE_RECORDS);

  if (!force && typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      if (estimate.quota && estimate.usage && estimate.usage / estimate.quota >= 0.8) {
        excess = Math.max(excess, Math.ceil(cacheRecords.length / 2));
      }
    } catch {
      // Storage estimation is advisory. Encryption and bounded-record cleanup remain enforced.
    }
  }

  const removable = force
    ? cacheRecords
    : cacheRecords.filter((record) => !expiredKeys.has(record.storageKey)).slice(0, excess);
  await deleteStorageKeys([
    ...expiredKeys,
    ...removable.map((record) => record.storageKey),
  ]);
}

function isQuotaError(error: unknown) {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

async function putEncryptedRecord(record: EncryptedRecord) {
  const write = async () => {
    const db = await database();
    const transaction = db.transaction(RECORD_STORE, 'readwrite');
    const complete = transactionComplete(transaction);
    transaction.objectStore(RECORD_STORE).put(record);
    await complete;
  };
  try {
    await write();
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    // Cached cursors and preferences are replaceable; queued messages are not.
    await pruneCache(true);
    await write();
  }
}

function cacheOwner(key: string) {
  return /^cursor\.([^.]+)\./.exec(key)?.[1]
    ?? /^workspace-snapshot\.([^.]+)$/.exec(key)?.[1]
    ?? '';
}

async function cacheStorageKey(key: string) {
  return `cache:${await digest(key)}`;
}

async function outboxStorageKey(id: string) {
  return `outbox:${await digest(id)}`;
}

async function writeCommand(command: OutboxCommand) {
  const [recordIdHash, ownerHash, organizationHash, scopeHash] = await Promise.all([
    digest(command.id),
    digest(command.userId),
    digest(command.organizationId),
    digest(`${command.userId}\u0000${command.organizationId}`),
  ]);
  const now = new Date().toISOString();
  const storageKey = `outbox:${recordIdHash}`;
  const existing = await getRecord(storageKey);
  const record = await encryptRecord({
    storageKey,
    recordIdHash,
    kind: 'outbox',
    ownerHash,
    organizationHash,
    scopeHash,
    createdAt: existing?.createdAt ?? command.createdAt,
    updatedAt: now,
  }, JSON.stringify(command));
  await putEncryptedRecord(record);
}

async function parseCommand(record: EncryptedRecord) {
  const parsed = JSON.parse(await decryptRecord(record)) as Partial<OutboxCommand>;
  if (
    typeof parsed.id !== 'string'
    || typeof parsed.userId !== 'string'
    || typeof parsed.organizationId !== 'string'
    || typeof parsed.createdAt !== 'string'
    || !['send_message', 'message_receipt', 'acknowledge_update', 'register_device'].includes(parsed.kind ?? '')
    || !['queued', 'sending', 'failed'].includes(parsed.state ?? '')
    || typeof parsed.attempts !== 'number'
  ) {
    throw storageUnavailable('queued command failed validation');
  }
  return parsed as OutboxCommand;
}

export const clientStore: ClientStore = {
  async initialize() {
    await database();
    await encryptionKey();
    await pruneCache();
  },
  async putCache(key, value, expiresAt) {
    if (textEncoder.encode(JSON.stringify({ key, value })).byteLength > MAX_SENSITIVE_CACHE_BYTES) {
      throw storageUnavailable('cache entry exceeds the bounded storage limit');
    }
    const ownerId = cacheOwner(key);
    const [recordIdHash, ownerHash] = await Promise.all([
      digest(key),
      digest(ownerId),
    ]);
    const storageKey = `cache:${recordIdHash}`;
    const existing = await getRecord(storageKey);
    const now = new Date().toISOString();
    const record = await encryptRecord({
      storageKey,
      recordIdHash,
      kind: 'cache',
      ownerHash,
      organizationHash: await digest(''),
      scopeHash: ownerHash,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(expiresAt ? { expiresAt } : {}),
    }, JSON.stringify({ key, value } satisfies CacheEnvelope));
    await putEncryptedRecord(record);
    await pruneCache();
  },
  async getCache(key) {
    const storageKey = await cacheStorageKey(key);
    const record = await getRecord(storageKey);
    if (!record || record.kind !== 'cache') return null;
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
      await deleteStorageKeys([storageKey]);
      return null;
    }
    try {
      const envelope = JSON.parse(await decryptRecord(record)) as Partial<CacheEnvelope>;
      if (envelope.key !== key || typeof envelope.value !== 'string') throw new Error('invalid cache record');
      return envelope.value;
    } catch {
      await deleteStorageKeys([storageKey]);
      return null;
    }
  },
  async removeCache(key) {
    await deleteStorageKeys([await cacheStorageKey(key)]);
  },
  enqueue: writeCommand,
  async listOutbox(userId, organizationId) {
    const scopeHash = await digest(`${userId}\u0000${organizationId}`);
    const db = await database();
    const transaction = db.transaction(RECORD_STORE, 'readonly');
    const complete = transactionComplete(transaction);
    const records = await requestResult<EncryptedRecord[]>(
      transaction.objectStore(RECORD_STORE).index('scopeHash').getAll(scopeHash),
    );
    await complete;
    const commands = await Promise.all(records
      .filter((record) => record.kind === 'outbox')
      .map(async (record) => {
        try {
          const command = await parseCommand(record);
          if (command.userId !== userId || command.organizationId !== organizationId) {
            throw new Error('queued command scope mismatch');
          }
          return command;
        } catch {
          await deleteStorageKeys([record.storageKey]);
          return null;
        }
      }));
    return commands
      .filter((command): command is OutboxCommand => command !== null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  },
  updateOutbox: writeCommand,
  async removeOutbox(id) {
    await deleteStorageKeys([await outboxStorageKey(id)]);
  },
  async purgeUser(userId) {
    const ownerHash = await digest(userId);
    const db = await database();
    const readTransaction = db.transaction(RECORD_STORE, 'readonly');
    const readComplete = transactionComplete(readTransaction);
    const records = await requestResult<EncryptedRecord[]>(
      readTransaction.objectStore(RECORD_STORE).index('ownerHash').getAll(ownerHash),
    );
    await readComplete;
    await deleteStorageKeys(records.map((record) => record.storageKey));
  },
};
