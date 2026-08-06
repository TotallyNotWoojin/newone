import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { webcrypto } from 'node:crypto';

import type { ClientStore, OutboxCommand } from '@/data/persistence/types';

interface WebEncryptedRecord {
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

interface WebKeyRecord {
  id: string;
  key: CryptoKey;
  createdAt: string;
}

type TransactionFailure = {
  error: DOMException | Error | null;
  type: 'abort' | 'error';
};

class ControlledRequest<T> {
  error: DOMException | Error | null = null;
  onerror: (() => void) | null = null;
  onsuccess: (() => void) | null = null;
  result!: T;

  succeed(result: T) {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.());
  }

  fail(error: DOMException | Error | null) {
    this.error = error;
    queueMicrotask(() => this.onerror?.());
  }
}

class ControlledOpenRequest extends ControlledRequest<ControlledIdbDatabase> {
  onblocked: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
}

class ControlledTransaction {
  error: DOMException | Error | null = null;
  onabort: (() => void) | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  failure: TransactionFailure | null;

  constructor(
    private readonly database: ControlledIdbDatabase,
    failure: TransactionFailure | null,
  ) {
    this.failure = failure;
    queueMicrotask(() => {
      const terminal = this.failure;
      if (!terminal) {
        this.oncomplete?.();
      } else {
        this.error = terminal.error;
        if (terminal.type === 'abort') this.onabort?.();
        else this.onerror?.();
      }
    });
  }

  objectStore(name: string) {
    return new ControlledObjectStore(this.database, name, this);
  }
}

class ControlledIndex {
  constructor(
    private readonly database: ControlledIdbDatabase,
    private readonly storeName: string,
    private readonly property: string,
  ) {}

  getAll(query?: unknown) {
    const request = new ControlledRequest<unknown[]>();
    const failure = this.database.consumeRequestFailure();
    if (failure !== undefined) {
      request.fail(failure);
      return request;
    }
    request.succeed([...this.database.store(this.storeName).values()].filter((value) => {
      if (query === undefined) return true;
      return (value as Record<string, unknown>)[this.property] === query;
    }));
    return request;
  }
}

class ControlledObjectStore {
  constructor(
    private readonly database: ControlledIdbDatabase,
    private readonly name: string,
    private readonly transaction: ControlledTransaction | null,
  ) {}

  clear() {
    this.database.store(this.name).clear();
    return new ControlledRequest<undefined>();
  }

  createIndex(name: string, property: string) {
    this.database.indexDefinitions.set(`${this.name}:${name}`, property);
    return new ControlledIndex(this.database, this.name, property);
  }

  delete(key: string) {
    this.database.deletedKeys.push(key);
    this.database.store(this.name).delete(key);
    return new ControlledRequest<undefined>();
  }

  get(key: string) {
    const request = new ControlledRequest<unknown>();
    const failure = this.database.consumeRequestFailure();
    if (failure !== undefined) {
      request.fail(failure);
      return request;
    }
    request.succeed(this.database.store(this.name).get(key));
    return request;
  }

  getAll() {
    const request = new ControlledRequest<unknown[]>();
    const failure = this.database.consumeRequestFailure();
    if (failure !== undefined) {
      request.fail(failure);
      return request;
    }
    request.succeed([...this.database.store(this.name).values()]);
    return request;
  }

  index(name: string) {
    const property = this.database.indexDefinitions.get(`${this.name}:${name}`) ?? name;
    return new ControlledIndex(this.database, this.name, property);
  }

  put(value: Record<string, unknown>) {
    if (this.name === 'records' && this.database.nextRecordPutFailure !== undefined) {
      const failure = this.database.nextRecordPutFailure;
      this.database.nextRecordPutFailure = undefined;
      if (this.transaction) this.transaction.failure = { error: failure, type: 'abort' };
      return new ControlledRequest<undefined>();
    }
    const keyPath = this.database.keyPaths.get(this.name) ?? 'id';
    this.database.store(this.name).set(String(value[keyPath]), value);
    return new ControlledRequest<undefined>();
  }
}

class ControlledIdbDatabase {
  readonly stores = new Map<string, Map<string, unknown>>();
  readonly keyPaths = new Map<string, string>();
  readonly indexDefinitions = new Map<string, string>();
  readonly deletedKeys: string[] = [];
  closeCalls = 0;
  initialized = false;
  nextRecordPutFailure: DOMException | Error | null | undefined;
  nextRequestFailure: DOMException | Error | null | undefined;
  nextTransactionFailure: TransactionFailure | null = null;
  onversionchange: (() => void) | null = null;

  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };

  close() {
    this.closeCalls += 1;
  }

  consumeRequestFailure() {
    const failure = this.nextRequestFailure;
    this.nextRequestFailure = undefined;
    return failure;
  }

  createObjectStore(name: string, options: { keyPath: string }) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    this.keyPaths.set(name, options.keyPath);
    return new ControlledObjectStore(this, name, null);
  }

  ensureStores() {
    if (!this.stores.has('keyring')) this.createObjectStore('keyring', { keyPath: 'id' });
    if (!this.stores.has('records')) this.createObjectStore('records', { keyPath: 'storageKey' });
  }

  store(name: string) {
    const store = this.stores.get(name);
    if (!store) throw new Error(`Controlled IndexedDB store is missing: ${name}`);
    return store;
  }

  transaction(_names: string | string[], _mode: IDBTransactionMode) {
    const failure = this.nextTransactionFailure;
    this.nextTransactionFailure = null;
    return new ControlledTransaction(this, failure);
  }
}

class ControlledIndexedDb {
  database = new ControlledIdbDatabase();
  nextOpen: { error: DOMException | Error | null; type: 'blocked' | 'error' } | null = null;

  open(_name: string, _version: number) {
    const request = new ControlledOpenRequest();
    queueMicrotask(() => {
      const failure = this.nextOpen;
      this.nextOpen = null;
      if (failure?.type === 'blocked') {
        request.onblocked?.();
        return;
      }
      if (failure?.type === 'error') {
        request.error = failure.error;
        request.onerror?.();
        return;
      }
      request.result = this.database;
      if (!this.database.initialized) {
        request.onupgradeneeded?.();
        this.database.initialized = true;
      }
      request.onsuccess?.();
    });
    return request;
  }
}

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalIndexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let controlledIndexedDb: ControlledIndexedDb;
const mockEstimate = jest.fn();

function installWebBoundaries(options: { crypto?: boolean; indexedDb?: boolean } = {}) {
  if (options.crypto === false) {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
    });
  } else {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: webcrypto,
    });
  }
  if (options.indexedDb === false) {
    Reflect.deleteProperty(globalThis, 'indexedDB');
  } else {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: controlledIndexedDb as unknown as IDBFactory,
    });
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { estimate: mockEstimate } },
  });
}

function restoreDescriptor(name: 'crypto' | 'indexedDB' | 'navigator', descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

async function digest(value: string) {
  const result = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function command(overrides: Partial<OutboxCommand> = {}): OutboxCommand {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    organizationId: '20000000-0000-4000-8000-000000000002',
    userId: '30000000-0000-4000-8000-000000000003',
    kind: 'send_message',
    payload: { body: 'Controlled encrypted message' },
    createdAt: '2026-08-05T01:00:00.000Z',
    attempts: 0,
    state: 'queued',
    ...overrides,
  };
}

function additionalData(record: WebEncryptedRecord) {
  return new TextEncoder().encode(JSON.stringify({
    storageKey: record.storageKey,
    recordIdHash: record.recordIdHash,
    kind: record.kind,
    userIdHash: record.ownerHash,
    organizationIdHash: record.organizationHash,
    scopeHash: record.scopeHash,
    cryptoVersion: record.cryptoVersion,
  }));
}

async function rawEncryptedRecord(
  input: Omit<WebEncryptedRecord, 'ciphertext' | 'cryptoVersion' | 'iv'>,
  plaintext: string,
) {
  const keyRecord = controlledIndexedDb.database.store('keyring').get('aes-gcm-v1') as WebKeyRecord;
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const record: WebEncryptedRecord = {
    ...input,
    cryptoVersion: 1,
    iv: [...iv],
    ciphertext: new ArrayBuffer(0),
  };
  record.ciphertext = await webcrypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: additionalData(record),
    tagLength: 128,
  }, keyRecord.key, new TextEncoder().encode(plaintext));
  return record;
}

async function rawOutboxRecord(
  id: string,
  plaintext: unknown,
  metadata: Partial<WebEncryptedRecord> = {},
) {
  const recordIdHash = await digest(id);
  const ownerHash = await digest(command().userId);
  const organizationHash = await digest(command().organizationId);
  const scopeHash = await digest(`${command().userId}\u0000${command().organizationId}`);
  return rawEncryptedRecord({
    storageKey: `outbox:${recordIdHash}`,
    recordIdHash,
    kind: 'outbox',
    ownerHash,
    organizationHash,
    scopeHash,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    ...metadata,
  }, typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext));
}

async function loadStore() {
  jest.resetModules();
  return jest.requireActual<{ clientStore: ClientStore }>(
    '@/data/persistence/client-store.web',
  ).clientStore;
}

beforeEach(() => {
  controlledIndexedDb = new ControlledIndexedDb();
  mockEstimate.mockReset();
  mockEstimate.mockImplementation(async () => ({ quota: 10_000_000, usage: 100 }));
  installWebBoundaries();
});

afterAll(() => {
  restoreDescriptor('crypto', originalCryptoDescriptor);
  restoreDescriptor('indexedDB', originalIndexedDbDescriptor);
  restoreDescriptor('navigator', originalNavigatorDescriptor);
});

describe('web encrypted client store', () => {
  test('creates its stores and indexes, keeps a non-extractable key, and closes on version change', async () => {
    const store = await loadStore();
    await store.initialize();
    const db = controlledIndexedDb.database;
    expect(db.stores.has('keyring')).toBe(true);
    expect(db.stores.has('records')).toBe(true);
    expect(db.indexDefinitions).toEqual(new Map([
      ['records:kind', 'kind'],
      ['records:ownerHash', 'ownerHash'],
      ['records:scopeHash', 'scopeHash'],
      ['records:updatedAt', 'updatedAt'],
    ]));
    const key = db.store('keyring').get('aes-gcm-v1') as WebKeyRecord;
    expect(key.key).toMatchObject({
      type: 'secret',
      extractable: false,
      algorithm: { name: 'AES-GCM' },
    });
    db.onversionchange?.();
    expect(db.closeCalls).toBe(1);
  });

  test('round-trips encrypted caches, preserves creation time on update, and reuses its key', async () => {
    const store = await loadStore();
    await store.initialize();
    const key = 'workspace-snapshot.30000000-0000-4000-8000-000000000003';
    await store.putCache(key, 'first-value', '2099-01-01T00:00:00.000Z');
    const storageKey = `cache:${await digest(key)}`;
    const first = controlledIndexedDb.database.store('records').get(storageKey) as WebEncryptedRecord;
    const firstCreatedAt = first.createdAt;
    expect(new TextDecoder().decode(first.ciphertext)).not.toContain('first-value');
    expect(first.ownerHash).toBe(await digest('30000000-0000-4000-8000-000000000003'));
    await expect(store.getCache(key)).resolves.toBe('first-value');

    await store.putCache(key, 'second-value');
    const updated = controlledIndexedDb.database.store('records').get(storageKey) as WebEncryptedRecord;
    expect(updated.createdAt).toBe(firstCreatedAt);
    await expect(store.getCache(key)).resolves.toBe('second-value');

    const keyRecord = controlledIndexedDb.database.store('keyring').get('aes-gcm-v1');
    const secondStore = await loadStore();
    await secondStore.initialize();
    expect(controlledIndexedDb.database.store('keyring').get('aes-gcm-v1')).toBe(keyRecord);
    await expect(secondStore.getCache(key)).resolves.toBe('second-value');
  });

  test('supports cursor and unowned cache scopes and removes explicit cache keys', async () => {
    const store = await loadStore();
    await store.putCache('cursor.user-a.conversation-a', 'cursor-value');
    await store.putCache('preferences.ui-locale', 'en');
    const cursor = controlledIndexedDb.database.store('records').get(
      `cache:${await digest('cursor.user-a.conversation-a')}`,
    ) as WebEncryptedRecord;
    const unowned = controlledIndexedDb.database.store('records').get(
      `cache:${await digest('preferences.ui-locale')}`,
    ) as WebEncryptedRecord;
    expect(cursor.ownerHash).toBe(await digest('user-a'));
    expect(unowned.ownerHash).toBe(await digest(''));
    await store.removeCache('cursor.user-a.conversation-a');
    await expect(store.getCache('cursor.user-a.conversation-a')).resolves.toBeNull();
  });

  test('expires and deletes cache records and rejects wrong-kind or corrupt ciphertext', async () => {
    const store = await loadStore();
    const key = 'workspace-snapshot.user-a';
    const storageKey = `cache:${await digest(key)}`;
    await store.putCache(key, 'expired', '2000-01-01T00:00:00.000Z');
    await expect(store.getCache(key)).resolves.toBeNull();
    expect(controlledIndexedDb.database.store('records').has(storageKey)).toBe(false);

    await store.putCache(key, 'wrong-kind');
    const wrongKind = controlledIndexedDb.database.store('records').get(storageKey) as WebEncryptedRecord;
    wrongKind.kind = 'outbox';
    await expect(store.getCache(key)).resolves.toBeNull();
    wrongKind.kind = 'cache';
    wrongKind.ciphertext = new Uint8Array([1, 2, 3]).buffer;
    await expect(store.getCache(key)).resolves.toBeNull();
    expect(controlledIndexedDb.database.store('records').has(storageKey)).toBe(false);
  });

  test('deletes unsupported and semantically invalid cache envelopes', async () => {
    const store = await loadStore();
    await store.initialize();
    const key = 'workspace-snapshot.user-a';
    const recordIdHash = await digest(key);
    const storageKey = `cache:${recordIdHash}`;
    const base = {
      storageKey,
      recordIdHash,
      kind: 'cache' as const,
      ownerHash: await digest('user-a'),
      organizationHash: await digest(''),
      scopeHash: await digest('user-a'),
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    };
    const unsupported = await rawEncryptedRecord(base, JSON.stringify({ key, value: 'value' }));
    unsupported.cryptoVersion = 2;
    controlledIndexedDb.database.store('records').set(storageKey, unsupported);
    await expect(store.getCache(key)).resolves.toBeNull();

    const badIv = await rawEncryptedRecord(base, JSON.stringify({ key, value: 'value' }));
    badIv.iv = [1, 2];
    controlledIndexedDb.database.store('records').set(storageKey, badIv);
    await expect(store.getCache(key)).resolves.toBeNull();

    for (const envelope of [
      { key: 'different-key', value: 'value' },
      { key, value: 42 },
    ]) {
      const invalid = await rawEncryptedRecord(base, JSON.stringify(envelope));
      controlledIndexedDb.database.store('records').set(storageKey, invalid);
      await expect(store.getCache(key)).resolves.toBeNull();
    }
  });

  test('rejects oversized cache entries before writing plaintext or ciphertext', async () => {
    const store = await loadStore();
    await expect(store.putCache(
      'workspace-snapshot.user-a',
      'x'.repeat(5 * 1024 * 1024 + 1),
    )).rejects.toThrow('cache entry exceeds the bounded storage limit');
    expect(controlledIndexedDb.database.stores.size).toBe(0);
  });

  test('enforces the 128-record cache cap and removes expired entries first', async () => {
    const store = await loadStore();
    for (let index = 0; index < 130; index += 1) {
      await store.putCache(`workspace-snapshot.user-${String(index).padStart(3, '0')}`, `value-${index}`);
    }
    const records = [...controlledIndexedDb.database.store('records').values()] as WebEncryptedRecord[];
    expect(records.filter((record) => record.kind === 'cache')).toHaveLength(128);

    const expiredKey = 'workspace-snapshot.expired-user';
    await store.putCache(expiredKey, 'expired', '2000-01-01T00:00:00.000Z');
    expect(controlledIndexedDb.database.store('records').has(`cache:${await digest(expiredKey)}`)).toBe(false);
  }, 20_000);

  test('uses storage pressure estimates only as advisory pruning signals', async () => {
    const store = await loadStore();
    for (let index = 0; index < 8; index += 1) {
      await store.putCache(`workspace-snapshot.pressure-${index}`, `value-${index}`);
    }
    mockEstimate.mockImplementationOnce(async () => ({ quota: 100, usage: 90 }));
    await store.initialize();
    let caches = [...controlledIndexedDb.database.store('records').values()] as WebEncryptedRecord[];
    expect(caches.filter((record) => record.kind === 'cache')).toHaveLength(4);

    mockEstimate.mockImplementationOnce(async () => {
      throw new Error('controlled estimate failure');
    });
    await expect(store.initialize()).resolves.toBeUndefined();
    mockEstimate.mockImplementationOnce(async () => ({ quota: 0, usage: 0 }));
    await expect(store.initialize()).resolves.toBeUndefined();
    caches = [...controlledIndexedDb.database.store('records').values()] as WebEncryptedRecord[];
    expect(caches.filter((record) => record.kind === 'cache')).toHaveLength(4);
  });

  test('purges replaceable cache after quota failure, retries once, and preserves outbox', async () => {
    const store = await loadStore();
    await store.putCache('workspace-snapshot.user-a', 'snapshot-a');
    await store.putCache('workspace-snapshot.user-b', 'snapshot-b');
    await store.enqueue(command());
    controlledIndexedDb.database.nextRecordPutFailure = new DOMException(
      'controlled quota exhaustion',
      'QuotaExceededError',
    );
    await store.putCache('workspace-snapshot.user-c', 'snapshot-c');
    const records = [...controlledIndexedDb.database.store('records').values()] as WebEncryptedRecord[];
    expect(records.filter((record) => record.kind === 'cache')).toEqual([
      expect.objectContaining({ storageKey: `cache:${await digest('workspace-snapshot.user-c')}` }),
    ]);
    expect(records.filter((record) => record.kind === 'outbox')).toHaveLength(1);

    controlledIndexedDb.database.nextRecordPutFailure = new Error('controlled non-quota failure');
    await expect(store.putCache('workspace-snapshot.user-d', 'snapshot-d'))
      .rejects.toThrow('controlled non-quota failure');
  });

  test('encrypts, updates, orders, lists, and removes valid outbox commands', async () => {
    const store = await loadStore();
    const later = command({
      id: '40000000-0000-4000-8000-000000000004',
      createdAt: '2026-08-05T02:00:00.000Z',
      kind: 'register_device',
      state: 'failed',
      attempts: 2,
      lastErrorCode: 'network_unavailable',
      payload: { token: 'controlled-device-token' },
    });
    await store.enqueue(later);
    await store.enqueue(command());
    await expect(store.listOutbox(command().userId, command().organizationId)).resolves.toEqual([
      command(),
      later,
    ]);
    const updated = command({ state: 'sending', attempts: 1, payload: { body: 'Edited body' } });
    await store.updateOutbox(updated);
    await expect(store.listOutbox(command().userId, command().organizationId)).resolves.toEqual([
      updated,
      later,
    ]);
    await store.removeOutbox(command().id);
    await expect(store.listOutbox(command().userId, command().organizationId)).resolves.toEqual([later]);
  });

  test('deletes every invalid queued-command envelope and scope mismatch', async () => {
    const store = await loadStore();
    await store.initialize();
    const invalidCommands: unknown[] = [
      { ...command(), id: 42 },
      { ...command(), userId: 42 },
      { ...command(), organizationId: 42 },
      { ...command(), createdAt: 42 },
      { ...command(), kind: 'unsupported_kind' },
      { ...command(), state: 'unsupported_state' },
      { ...command(), attempts: 'zero' },
    ];
    const records = controlledIndexedDb.database.store('records');
    for (let index = 0; index < invalidCommands.length; index += 1) {
      const raw = await rawOutboxRecord(`invalid-${index}`, invalidCommands[index]);
      records.set(raw.storageKey, raw);
    }
    const invalidJson = await rawOutboxRecord('invalid-json', '{not-json');
    records.set(invalidJson.storageKey, invalidJson);
    const mismatch = await rawOutboxRecord('scope-mismatch', {
      ...command(),
      id: 'scope-mismatch',
      userId: 'different-user',
    });
    records.set(mismatch.storageKey, mismatch);
    const nonOutbox = await rawOutboxRecord('not-an-outbox', command(), { kind: 'cache' });
    records.set(nonOutbox.storageKey, nonOutbox);

    await expect(store.listOutbox(command().userId, command().organizationId)).resolves.toEqual([]);
    for (const record of [...records.values()] as WebEncryptedRecord[]) {
      expect(record.kind).not.toBe('outbox');
    }
  });

  test('purges only records owned by the requested user', async () => {
    const store = await loadStore();
    await store.putCache('workspace-snapshot.user-a', 'snapshot-a');
    await store.putCache('workspace-snapshot.user-b', 'snapshot-b');
    await store.enqueue(command({ id: 'user-a-command', userId: 'user-a' }));
    await store.enqueue(command({ id: 'user-b-command', userId: 'user-b' }));
    await store.purgeUser('user-a');
    const records = [...controlledIndexedDb.database.store('records').values()] as WebEncryptedRecord[];
    const userAHash = await digest('user-a');
    const userBHash = await digest('user-b');
    expect(records.some((record) => record.ownerHash === userAHash)).toBe(false);
    expect(records.some((record) => record.ownerHash === userBHash)).toBe(true);
  });

  test.each([
    { type: 'public', algorithm: { name: 'AES-GCM' }, extractable: false },
    { type: 'secret', algorithm: { name: 'AES-CBC' }, extractable: false },
    { type: 'secret', algorithm: { name: 'AES-GCM' }, extractable: true },
  ])('replaces an invalid key record and purges unrecoverable ciphertext', async (invalidKey) => {
    controlledIndexedDb.database.ensureStores();
    controlledIndexedDb.database.initialized = true;
    controlledIndexedDb.database.store('keyring').set('aes-gcm-v1', {
      id: 'aes-gcm-v1',
      key: invalidKey,
      createdAt: '2026-08-05T00:00:00.000Z',
    });
    controlledIndexedDb.database.store('records').set('unrecoverable', { storageKey: 'unrecoverable' });
    const store = await loadStore();
    await store.initialize();
    expect(controlledIndexedDb.database.store('records').size).toBe(0);
    expect((controlledIndexedDb.database.store('keyring').get('aes-gcm-v1') as WebKeyRecord).key)
      .toMatchObject({ type: 'secret', algorithm: { name: 'AES-GCM' }, extractable: false });
  });

  test('fails closed without IndexedDB or WebCrypto', async () => {
    installWebBoundaries({ indexedDb: false });
    const noDatabase = await loadStore();
    await expect(noDatabase.initialize()).rejects.toThrow('this browser does not support IndexedDB');

    controlledIndexedDb = new ControlledIndexedDb();
    installWebBoundaries({ crypto: false });
    const noCrypto = await loadStore();
    await expect(noCrypto.initialize()).rejects.toThrow('WebCrypto is required');
  });

  test('resets every failed database-open mode so initialization can retry', async () => {
    const scenarios: {
      error: Error | null;
      message: string;
      type: 'blocked' | 'error';
    }[] = [
      { type: 'blocked', error: null, message: 'another app tab is blocking a storage upgrade' },
      { type: 'error', error: new Error('controlled open error'), message: 'controlled open error' },
      { type: 'error', error: null, message: 'database could not open' },
    ];
    for (const scenario of scenarios) {
      controlledIndexedDb = new ControlledIndexedDb();
      installWebBoundaries();
      controlledIndexedDb.nextOpen = { type: scenario.type, error: scenario.error };
      const store = await loadStore();
      await expect(store.initialize()).rejects.toThrow(scenario.message);
      await expect(store.initialize()).resolves.toBeUndefined();
    }
  });

  test('propagates request and transaction failures with stable fallback errors', async () => {
    const store = await loadStore();
    await store.initialize();
    controlledIndexedDb.database.nextRequestFailure = null;
    await expect(store.getCache('missing')).rejects.toThrow('database request failed');

    controlledIndexedDb.database.nextTransactionFailure = { type: 'abort', error: null };
    await expect(store.getCache('missing')).rejects.toThrow('database transaction aborted');
    controlledIndexedDb.database.nextTransactionFailure = {
      type: 'error',
      error: new Error('controlled transaction error'),
    };
    await expect(store.getCache('missing')).rejects.toThrow('controlled transaction error');
  });
});
