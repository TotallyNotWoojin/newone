import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createHash } from 'node:crypto';

import type { ClientStore, OutboxCommand } from '@/data/persistence/types';

interface ControlledKey {
  encoded: (format: 'base64') => Promise<string>;
  material: string;
  size: number;
}

interface ControlledCipher {
  additionalData: string;
  ciphertext: string;
  iv: string;
  keyMaterial: string;
  plaintext: Uint8Array;
  tag: string;
}

interface NativeOutboxRow {
  id: string;
  organization_id: string;
  user_id: string;
  kind: OutboxCommand['kind'];
  created_at: string;
  attempts: number;
  state: OutboxCommand['state'];
  last_error_code: string | null;
  crypto_version: number | null;
  ciphertext_base64: string | null;
  iv_base64: string | null;
  tag_base64: string | null;
}

interface NativeSecureCacheRow {
  cache_key_hash: string;
  owner_hash: string;
  expires_at: string | null;
  updated_at: string;
  crypto_version: number | null;
  ciphertext_base64: string | null;
  iv_base64: string | null;
  tag_base64: string | null;
}

interface NativePlaintextCacheRow {
  value: string;
  expires_at: string | null;
  updated_at: string;
}

const mockOpenDatabaseAsync = jest.fn();
const mockDigestStringAsync = jest.fn();
const mockGenerateKey = jest.fn();
const mockImportKey = jest.fn();
const mockEncrypt = jest.fn();
const mockDecrypt = jest.fn();
const mockFromParts = jest.fn();
const mockSecureGet = jest.fn();
const mockSecureSet = jest.fn();
const mockSecureRemove = jest.fn();

let mockCipherSequence = 0;
const mockCiphertexts = new Map<string, ControlledCipher>();
const mockSecureValues = new Map<string, string>();
let mockDatabase: ControlledSqliteDatabase;

function controlledKey(material = 'controlled-device-key', size = 256): ControlledKey {
  return {
    encoded: async () => material,
    material,
    size,
  };
}

function bytes(value: Uint8Array) {
  return Buffer.from(value).toString('base64');
}

class ControlledSqliteDatabase {
  readonly cacheEntries = new Map<string, NativePlaintextCacheRow>();
  readonly secureCacheEntries = new Map<string, NativeSecureCacheRow>();
  readonly outboxCommands = new Map<string, NativeOutboxRow>();
  readonly execCalls: string[] = [];
  readonly runCalls: { sql: string; args: unknown[] }[] = [];
  columns = new Set([
    'id',
    'organization_id',
    'user_id',
    'kind',
    'created_at',
    'attempts',
    'state',
    'last_error_code',
    'crypto_version',
    'ciphertext_base64',
    'iv_base64',
    'tag_base64',
  ]);
  failExec: unknown = null;
  failRun: unknown = null;

  async execAsync(sql: string) {
    this.execCalls.push(sql);
    if (this.failExec) {
      const failure = this.failExec;
      this.failExec = null;
      throw failure;
    }
    const match = /ALTER TABLE outbox_commands ADD COLUMN (\w+)/i.exec(sql);
    if (match) this.columns.add(match[1]);
  }

  async getAllAsync<T>(sql: string, ...args: unknown[]): Promise<T[]> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.startsWith('pragma table_info')) {
      return [...this.columns].map((name) => ({ name })) as T[];
    }
    if (normalized.startsWith('select id from outbox_commands')) {
      return [...this.outboxCommands.values()]
        .filter((row) => row.crypto_version === null
          || row.ciphertext_base64 === null
          || row.iv_base64 === null
          || row.tag_base64 === null)
        .map((row) => ({ id: row.id })) as T[];
    }
    if (normalized.includes('from outbox_commands') && normalized.includes('where user_id = ?')) {
      const [userId, organizationId] = args as [string, string];
      return [...this.outboxCommands.values()]
        .filter((row) => row.user_id === userId && row.organization_id === organizationId)
        .sort((left, right) => left.created_at.localeCompare(right.created_at)) as T[];
    }
    throw new Error(`Unhandled controlled getAllAsync SQL: ${normalized}`);
  }

  async getFirstAsync<T>(sql: string, ...args: unknown[]): Promise<T | null> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.includes('select count(*) from outbox_commands')) {
      return {
        count: this.outboxCommands.size + this.secureCacheEntries.size,
      } as T;
    }
    if (normalized.includes('from secure_cache_entries where cache_key_hash = ?')) {
      return (this.secureCacheEntries.get(String(args[0])) ?? null) as T | null;
    }
    if (normalized.includes('from cache_entries where cache_key = ?')) {
      return (this.cacheEntries.get(String(args[0])) ?? null) as T | null;
    }
    throw new Error(`Unhandled controlled getFirstAsync SQL: ${normalized}`);
  }

  async runAsync(sql: string, ...args: unknown[]) {
    this.runCalls.push({ sql, args });
    if (this.failRun) {
      const failure = this.failRun;
      this.failRun = null;
      throw failure;
    }
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.startsWith('insert or replace into outbox_commands')) {
      const [
        id,
        organizationId,
        userId,
        kind,
        createdAt,
        attempts,
        state,
        lastErrorCode,
        cryptoVersion,
        ciphertext,
        iv,
        tag,
      ] = args;
      this.outboxCommands.set(String(id), {
        id: String(id),
        organization_id: String(organizationId),
        user_id: String(userId),
        kind: kind as OutboxCommand['kind'],
        created_at: String(createdAt),
        attempts: Number(attempts),
        state: state as OutboxCommand['state'],
        last_error_code: lastErrorCode === null ? null : String(lastErrorCode),
        crypto_version: Number(cryptoVersion),
        ciphertext_base64: String(ciphertext),
        iv_base64: String(iv),
        tag_base64: String(tag),
      });
      return;
    }
    if (normalized.startsWith('insert or replace into secure_cache_entries')) {
      const [cacheKeyHash, ownerHash, expiresAt, updatedAt, cryptoVersion, ciphertext, iv, tag] = args;
      this.secureCacheEntries.set(String(cacheKeyHash), {
        cache_key_hash: String(cacheKeyHash),
        owner_hash: String(ownerHash),
        expires_at: expiresAt === null ? null : String(expiresAt),
        updated_at: String(updatedAt),
        crypto_version: Number(cryptoVersion),
        ciphertext_base64: String(ciphertext),
        iv_base64: String(iv),
        tag_base64: String(tag),
      });
      return;
    }
    if (normalized.startsWith('insert or replace into cache_entries')) {
      const [key, value, expiresAt, updatedAt] = args;
      this.cacheEntries.set(String(key), {
        value: String(value),
        expires_at: expiresAt === null ? null : String(expiresAt),
        updated_at: String(updatedAt),
      });
      return;
    }
    if (normalized === 'delete from outbox_commands') {
      this.outboxCommands.clear();
      return;
    }
    if (normalized === 'delete from secure_cache_entries') {
      this.secureCacheEntries.clear();
      return;
    }
    if (normalized.startsWith('delete from secure_cache_entries where expires_at is not null')) {
      const cutoff = String(args[0]);
      for (const [key, row] of this.secureCacheEntries) {
        if (row.expires_at && row.expires_at <= cutoff) this.secureCacheEntries.delete(key);
      }
      return;
    }
    if (normalized.startsWith('delete from outbox_commands where crypto_version is null')) {
      for (const [id, row] of this.outboxCommands) {
        if (row.crypto_version === null
          || row.ciphertext_base64 === null
          || row.iv_base64 === null
          || row.tag_base64 === null) this.outboxCommands.delete(id);
      }
      return;
    }
    if (normalized.startsWith('delete from outbox_commands where id in')) {
      for (const id of args) this.outboxCommands.delete(String(id));
      return;
    }
    if (normalized === 'delete from outbox_commands where id = ?') {
      this.outboxCommands.delete(String(args[0]));
      return;
    }
    if (normalized === 'delete from outbox_commands where user_id = ?') {
      for (const [id, row] of this.outboxCommands) {
        if (row.user_id === args[0]) this.outboxCommands.delete(id);
      }
      return;
    }
    if (normalized === 'delete from cache_entries where cache_key = ?') {
      this.cacheEntries.delete(String(args[0]));
      return;
    }
    if (normalized === 'delete from cache_entries where cache_key like ?') {
      const fragment = String(args[0]).replaceAll('%', '');
      for (const key of this.cacheEntries.keys()) {
        if (key.includes(fragment)) this.cacheEntries.delete(key);
      }
      return;
    }
    if (normalized === 'delete from secure_cache_entries where cache_key_hash = ?') {
      this.secureCacheEntries.delete(String(args[0]));
      return;
    }
    if (normalized === 'delete from secure_cache_entries where owner_hash = ?') {
      for (const [key, row] of this.secureCacheEntries) {
        if (row.owner_hash === args[0]) this.secureCacheEntries.delete(key);
      }
      return;
    }
    throw new Error(`Unhandled controlled runAsync SQL: ${normalized}`);
  }
}

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: (...mockArgs: unknown[]) => mockOpenDatabaseAsync(...mockArgs),
}));

jest.mock('expo-crypto', () => ({
  AESEncryptionKey: {
    generate: (...mockArgs: unknown[]) => mockGenerateKey(...mockArgs),
    import: (...mockArgs: unknown[]) => mockImportKey(...mockArgs),
  },
  AESKeySize: { AES256: 256 },
  AESSealedData: {
    fromParts: (...mockArgs: unknown[]) => mockFromParts(...mockArgs),
  },
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  aesDecryptAsync: (...mockArgs: unknown[]) => mockDecrypt(...mockArgs),
  aesEncryptAsync: (...mockArgs: unknown[]) => mockEncrypt(...mockArgs),
  digestStringAsync: (...mockArgs: unknown[]) => mockDigestStringAsync(...mockArgs),
}));

jest.mock('@/lib/secure-storage', () => ({
  secureStorage: {
    getItem: (...mockArgs: unknown[]) => mockSecureGet(...mockArgs),
    removeItem: (...mockArgs: unknown[]) => mockSecureRemove(...mockArgs),
    setItem: (...mockArgs: unknown[]) => mockSecureSet(...mockArgs),
  },
}));

function command(overrides: Partial<OutboxCommand> = {}): OutboxCommand {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    organizationId: '20000000-0000-4000-8000-000000000002',
    userId: '30000000-0000-4000-8000-000000000003',
    kind: 'send_message',
    payload: { body: 'Controlled durable message' },
    createdAt: '2026-08-05T01:00:00.000Z',
    attempts: 0,
    state: 'queued',
    ...overrides,
  };
}

async function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function loadStore() {
  jest.resetModules();
  return jest.requireActual<{ clientStore: ClientStore }>(
    '@/data/persistence/client-store.native',
  ).clientStore;
}

beforeEach(() => {
  mockDatabase = new ControlledSqliteDatabase();
  mockCipherSequence = 0;
  mockCiphertexts.clear();
  mockSecureValues.clear();
  mockOpenDatabaseAsync.mockReset();
  mockDigestStringAsync.mockReset();
  mockGenerateKey.mockReset();
  mockImportKey.mockReset();
  mockEncrypt.mockReset();
  mockDecrypt.mockReset();
  mockFromParts.mockReset();
  mockSecureGet.mockReset();
  mockSecureSet.mockReset();
  mockSecureRemove.mockReset();

  mockOpenDatabaseAsync.mockImplementation(async () => mockDatabase);
  mockDigestStringAsync.mockImplementation(async (_algorithm: unknown, value: unknown) => sha256(String(value)));
  mockGenerateKey.mockImplementation(async () => controlledKey());
  mockImportKey.mockImplementation(async (encoded: unknown) => {
    if (encoded === 'corrupt-key') throw new Error('controlled corrupt key');
    return controlledKey(String(encoded), encoded === 'wrong-size-key' ? 128 : 256);
  });
  mockFromParts.mockImplementation((iv: unknown, ciphertext: unknown, tag: unknown) => ({
    ciphertext: String(ciphertext),
    iv: String(iv),
    tag: String(tag),
  }));
  mockEncrypt.mockImplementation(async (...mockArgs: unknown[]) => {
    const [plaintext, key, options] = mockArgs as [
      Uint8Array,
      ControlledKey,
      { additionalData: Uint8Array },
    ];
    mockCipherSequence += 1;
    const ciphertext = `ciphertext-${mockCipherSequence}`;
    const iv = `iv-${mockCipherSequence}`;
    const tag = `tag-${mockCipherSequence}`;
    mockCiphertexts.set(ciphertext, {
      additionalData: bytes(options.additionalData),
      ciphertext,
      iv,
      keyMaterial: key.material,
      plaintext: new Uint8Array(plaintext),
      tag,
    });
    return {
      ciphertext: async () => ciphertext,
      iv: async () => iv,
      tag: async () => tag,
    };
  });
  mockDecrypt.mockImplementation(async (...mockArgs: unknown[]) => {
    const [sealed, key, options] = mockArgs as [
      { ciphertext: string; iv: string; tag: string },
      ControlledKey,
      { additionalData: Uint8Array },
    ];
    const stored = mockCiphertexts.get(sealed.ciphertext);
    if (!stored
      || stored.iv !== sealed.iv
      || stored.tag !== sealed.tag
      || stored.keyMaterial !== key.material
      || stored.additionalData !== bytes(options.additionalData)) {
      throw new Error('controlled authentication failure');
    }
    return new Uint8Array(stored.plaintext);
  });
  mockSecureGet.mockImplementation(async (key: unknown) => mockSecureValues.get(String(key)) ?? null);
  mockSecureSet.mockImplementation(async (key: unknown, value: unknown) => {
    mockSecureValues.set(String(key), String(value));
  });
  mockSecureRemove.mockImplementation(async (key: unknown) => {
    mockSecureValues.delete(String(key));
  });
});

describe('native encrypted client store', () => {
  test('initializes schema, migrates every encryption column, and removes legacy payloads', async () => {
    mockDatabase.columns = new Set(['id']);
    mockDatabase.outboxCommands.set('legacy-a', {
      id: 'legacy-a',
      organization_id: 'org-a',
      user_id: 'user-a',
      kind: 'send_message',
      created_at: '2026-08-05T00:00:00.000Z',
      attempts: 0,
      state: 'queued',
      last_error_code: null,
      crypto_version: null,
      ciphertext_base64: null,
      iv_base64: null,
      tag_base64: null,
    });
    mockSecureValues.set('newone.outbox.legacy-a', 'legacy-plaintext');
    const store = await loadStore();
    await store.initialize();

    expect(mockOpenDatabaseAsync).toHaveBeenCalledWith('newone-client-v1.db');
    expect(mockDatabase.columns).toEqual(expect.objectContaining({}));
    expect(mockDatabase.columns).toEqual(new Set([
      'id',
      'crypto_version',
      'ciphertext_base64',
      'iv_base64',
      'tag_base64',
    ]));
    expect(mockDatabase.outboxCommands.size).toBe(0);
    expect(mockSecureRemove).toHaveBeenCalledWith('newone.outbox.legacy-a');
    expect(mockSecureSet).toHaveBeenCalledWith('newone.outbox.aes256.v1', 'controlled-device-key');
    await store.initialize();
    expect(mockOpenDatabaseAsync).toHaveBeenCalledTimes(1);
    expect(mockGenerateKey).toHaveBeenCalledTimes(1);
  });

  test('retries database and key initialization only after failures', async () => {
    mockOpenDatabaseAsync
      .mockImplementationOnce(async () => {
        throw new Error('controlled database open failure');
      })
      .mockImplementation(async () => mockDatabase);
    const store = await loadStore();
    await expect(store.initialize()).rejects.toThrow('controlled database open failure');
    await expect(store.initialize()).resolves.toBeUndefined();
    expect(mockOpenDatabaseAsync).toHaveBeenCalledTimes(2);

    const keyStore = await loadStore();
    mockSecureGet
      .mockImplementationOnce(async () => {
        throw new Error('controlled secure store failure');
      })
      .mockImplementation(async (key: unknown) => mockSecureValues.get(String(key)) ?? null);
    await expect(keyStore.initialize()).rejects.toThrow('controlled secure store failure');
    await expect(keyStore.initialize()).resolves.toBeUndefined();
  });

  test.each(['corrupt-key', 'wrong-size-key'])('purges ciphertext before replacing an invalid %s', async (encoded) => {
    mockSecureValues.set('newone.outbox.aes256.v1', encoded);
    mockDatabase.outboxCommands.set('encrypted-a', {
      ...command(),
      organization_id: command().organizationId,
      user_id: command().userId,
      created_at: command().createdAt,
      last_error_code: null,
      crypto_version: 1,
      ciphertext_base64: 'ciphertext-old',
      iv_base64: 'iv-old',
      tag_base64: 'tag-old',
    } as unknown as NativeOutboxRow);
    mockDatabase.secureCacheEntries.set('cache-old', {
      cache_key_hash: 'cache-old',
      owner_hash: 'owner-old',
      expires_at: null,
      updated_at: '2026-08-05T00:00:00.000Z',
      crypto_version: 1,
      ciphertext_base64: 'ciphertext-old',
      iv_base64: 'iv-old',
      tag_base64: 'tag-old',
    });
    const store = await loadStore();
    await store.initialize();
    expect(mockDatabase.outboxCommands.size).toBe(0);
    expect(mockDatabase.secureCacheEntries.size).toBe(0);
    expect(mockSecureRemove).toHaveBeenCalledWith('newone.outbox.aes256.v1');
    expect(mockGenerateKey).toHaveBeenCalled();
  });

  test('reuses a valid AES-256 key without deleting encrypted rows', async () => {
    mockSecureValues.set('newone.outbox.aes256.v1', 'existing-valid-key');
    const store = await loadStore();
    await store.initialize();
    expect(mockImportKey).toHaveBeenCalledWith('existing-valid-key', 'base64');
    expect(mockGenerateKey).not.toHaveBeenCalled();
    expect(mockDatabase.runCalls.filter(({ sql }) => sql.trim() === 'DELETE FROM outbox_commands')).toHaveLength(0);
  });

  test('purges orphaned encrypted rows when SecureStore lost the key', async () => {
    mockDatabase.secureCacheEntries.set('orphan', {
      cache_key_hash: 'orphan',
      owner_hash: 'owner',
      expires_at: null,
      updated_at: '2026-08-05T00:00:00.000Z',
      crypto_version: 1,
      ciphertext_base64: 'cipher',
      iv_base64: 'iv',
      tag_base64: 'tag',
    });
    const store = await loadStore();
    await store.initialize();
    expect(mockDatabase.secureCacheEntries.size).toBe(0);
  });

  test('encrypts, updates, orders, and removes durable outbox commands', async () => {
    const store = await loadStore();
    const later = command({
      id: '40000000-0000-4000-8000-000000000004',
      createdAt: '2026-08-05T02:00:00.000Z',
      kind: 'register_device',
      payload: { token: 'controlled-device-token' },
      attempts: 1,
      state: 'failed',
      lastErrorCode: 'network_unavailable',
    });
    await store.enqueue(later);
    await store.enqueue(command());
    const raw = mockDatabase.outboxCommands.get(command().id);
    expect(raw?.ciphertext_base64).not.toContain('Controlled durable message');
    expect(raw?.last_error_code).toBeNull();
    expect(JSON.parse(Buffer.from(mockCiphertexts.get(raw!.ciphertext_base64!)!.additionalData, 'base64').toString())).toMatchObject({
      cryptoVersion: 1,
      recordType: 'outbox_command',
      id: command().id,
      organizationId: command().organizationId,
      userId: command().userId,
      kind: 'send_message',
    });

    await expect(store.listOutbox(command().userId, command().organizationId)).resolves.toEqual([
      command(),
      later,
    ]);
    const updated = command({ attempts: 2, state: 'sending', payload: { body: 'Edited body' } });
    await store.updateOutbox(updated);
    await expect(store.listOutbox(command().userId, command().organizationId)).resolves.toEqual([
      updated,
      later,
    ]);
    await store.removeOutbox(command().id);
    expect(mockDatabase.outboxCommands.has(command().id)).toBe(false);
  });

  test('deletes every malformed or unauthenticated outbox row instead of returning it', async () => {
    const store = await loadStore();
    await store.enqueue(command({ id: 'valid-command' }));
    const valid = mockDatabase.outboxCommands.get('valid-command')!;
    const corrupt: NativeOutboxRow[] = [
      { ...valid, id: 'bad-version', crypto_version: 2 },
      { ...valid, id: 'missing-ciphertext', ciphertext_base64: null },
      { ...valid, id: 'missing-iv', iv_base64: null },
      { ...valid, id: 'missing-tag', tag_base64: null },
      { ...valid, id: 'bad-ciphertext', ciphertext_base64: 'unknown-ciphertext' },
      { ...valid, id: 'aad-scope-mismatch', organization_id: 'different-org' },
    ];
    for (const row of corrupt) {
      row.user_id = command().userId;
      row.organization_id = command().organizationId;
      mockDatabase.outboxCommands.set(row.id, row);
    }
    const result = await store.listOutbox(command().userId, command().organizationId);
    expect(result).toEqual([expect.objectContaining({ id: 'valid-command' })]);
    for (const row of corrupt) expect(mockDatabase.outboxCommands.has(row.id)).toBe(false);
    expect(mockDatabase.runCalls.some(({ sql }) => sql.includes('WHERE id IN (?,?,?,?,?,?)'))).toBe(true);
  });

  test('stores approved low-sensitivity keys in plaintext and expires them authoritatively', async () => {
    const store = await loadStore();
    await store.putCache('preferences.ui-locale', 'ko');
    await store.putCache('cursor.user-a.conversation-a', 'cursor-1', '2099-01-01T00:00:00.000Z');
    expect(mockDatabase.cacheEntries.get('preferences.ui-locale')?.value).toBe('ko');
    await expect(store.getCache('preferences.ui-locale')).resolves.toBe('ko');
    await expect(store.getCache('cursor.user-a.conversation-a')).resolves.toBe('cursor-1');
    await expect(store.getCache('cursor.missing')).resolves.toBeNull();

    mockDatabase.cacheEntries.set('preferences.ui-locale', {
      value: 'en',
      expires_at: '2000-01-01T00:00:00.000Z',
      updated_at: '1999-01-01T00:00:00.000Z',
    });
    await expect(store.getCache('preferences.ui-locale')).resolves.toBeNull();
    expect(mockDatabase.cacheEntries.has('preferences.ui-locale')).toBe(false);
  });

  test('encrypts sensitive cache envelopes for every owner-key pattern', async () => {
    const store = await loadStore();
    const entries = [
      ['workspace-snapshot.user-a', 'snapshot'],
      ['private-cache-without-owner', 'private'],
    ] as const;
    for (const [key, value] of entries) await store.putCache(key, value, '2099-01-01T00:00:00.000Z');
    for (const [key, value] of entries) await expect(store.getCache(key)).resolves.toBe(value);
    expect(mockDatabase.secureCacheEntries.size).toBe(2);
    const workspaceHash = await sha256('workspace-snapshot.user-a');
    const workspace = mockDatabase.secureCacheEntries.get(workspaceHash)!;
    expect(workspace.owner_hash).toBe(await sha256('user-a'));
    expect(JSON.parse(Buffer.from(mockCiphertexts.get(workspace.ciphertext_base64!)!.additionalData, 'base64').toString())).toMatchObject({
      cryptoVersion: 1,
      recordType: 'secure_cache',
      cacheKeyHash: workspaceHash,
      ownerHash: await sha256('user-a'),
    });
  });

  test('deletes expired, unsupported, corrupt, and mismatched secure cache records', async () => {
    const store = await loadStore();
    const key = 'workspace-snapshot.user-a';
    const hash = await sha256(key);
    await store.putCache(key, 'controlled-value');
    const base = mockDatabase.secureCacheEntries.get(hash)!;

    mockDatabase.secureCacheEntries.set(hash, { ...base, expires_at: '2000-01-01T00:00:00.000Z' });
    await expect(store.getCache(key)).resolves.toBeNull();

    for (const invalid of [
      { ...base, crypto_version: 2 },
      { ...base, ciphertext_base64: null },
      { ...base, iv_base64: null },
      { ...base, tag_base64: null },
      { ...base, ciphertext_base64: 'unknown-ciphertext' },
    ]) {
      mockDatabase.secureCacheEntries.set(hash, invalid);
      await expect(store.getCache(key)).resolves.toBeNull();
      expect(mockDatabase.secureCacheEntries.has(hash)).toBe(false);
    }

    await store.putCache(key, 'controlled-value');
    const mismatch = mockDatabase.secureCacheEntries.get(hash)!;
    const cipher = mockCiphertexts.get(mismatch.ciphertext_base64!)!;
    cipher.plaintext = new TextEncoder().encode(JSON.stringify({ key: 'other-key', value: 'controlled-value' }));
    await expect(store.getCache(key)).resolves.toBeNull();

    await store.putCache(key, 'controlled-value');
    const invalidValue = mockDatabase.secureCacheEntries.get(hash)!;
    mockCiphertexts.get(invalidValue.ciphertext_base64!)!.plaintext = new TextEncoder().encode(JSON.stringify({ key, value: 42 }));
    await expect(store.getCache(key)).resolves.toBeNull();
  });

  test('rejects oversized sensitive cache entries before encryption', async () => {
    const store = await loadStore();
    await expect(store.putCache(
      'workspace-snapshot.user-a',
      'x'.repeat(5 * 1024 * 1024 + 1),
    )).rejects.toThrow('Sensitive cache entry exceeds the device storage limit.');
    expect(mockEncrypt).not.toHaveBeenCalled();
  });

  test('removes both cache representations and purges only the requested user scope', async () => {
    const store = await loadStore();
    await store.putCache('preferences.ui-locale', 'en');
    await store.putCache('workspace-snapshot.user-a', 'snapshot-a');
    await store.putCache('workspace-snapshot.user-b', 'snapshot-b');
    await store.enqueue(command({ id: 'user-a-command', userId: 'user-a' }));
    await store.enqueue(command({ id: 'user-b-command', userId: 'user-b' }));

    await store.removeCache('preferences.ui-locale');
    expect(mockDatabase.cacheEntries.has('preferences.ui-locale')).toBe(false);
    await store.purgeUser('user-a');
    expect(mockDatabase.outboxCommands.has('user-a-command')).toBe(false);
    expect(mockDatabase.outboxCommands.has('user-b-command')).toBe(true);
    expect(mockDatabase.secureCacheEntries.has(await sha256('workspace-snapshot.user-a'))).toBe(false);
    expect(mockDatabase.secureCacheEntries.has(await sha256('workspace-snapshot.user-b'))).toBe(true);
  });
});
