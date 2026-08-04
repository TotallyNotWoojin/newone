import {
  AESEncryptionKey,
  AESKeySize,
  AESSealedData,
  CryptoDigestAlgorithm,
  aesDecryptAsync,
  aesEncryptAsync,
  digestStringAsync,
} from 'expo-crypto';
import * as SQLite from 'expo-sqlite';

import type { ClientStore, OutboxCommand } from '@/data/persistence/types';
// Metro selects the native SecureStore adapter.
// eslint-disable-next-line import/no-unresolved
import { secureStorage } from '@/lib/secure-storage';

const DB_NAME = 'newone-client-v1.db';
const OUTBOX_KEY_NAME = 'newone.outbox.aes256.v1';
const LEGACY_PAYLOAD_PREFIX = 'newone.outbox.';
const CRYPTO_VERSION = 1;
const MAX_SENSITIVE_CACHE_BYTES = 5 * 1024 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface OutboxRow {
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

interface SecureCacheRow {
  cache_key_hash: string;
  owner_hash: string;
  expires_at: string | null;
  updated_at: string;
  crypto_version: number | null;
  ciphertext_base64: string | null;
  iv_base64: string | null;
  tag_base64: string | null;
}

let databasePromise: ReturnType<typeof SQLite.openDatabaseAsync> | null = null;
let encryptionKeyPromise: Promise<AESEncryptionKey> | null = null;

function legacyPayloadKey(id: string) {
  return `${LEGACY_PAYLOAD_PREFIX}${id}`;
}

function additionalData(input: {
  id: string;
  organizationId: string;
  userId: string;
  kind: OutboxCommand['kind'];
  createdAt: string;
}) {
  return textEncoder.encode(JSON.stringify({
    cryptoVersion: CRYPTO_VERSION,
    recordType: 'outbox_command',
    id: input.id,
    organizationId: input.organizationId,
    userId: input.userId,
    kind: input.kind,
    createdAt: input.createdAt,
  }));
}

function secureCacheAdditionalData(input: {
  cacheKeyHash: string;
  ownerHash: string;
  expiresAt: string | null;
  updatedAt: string;
}) {
  return textEncoder.encode(JSON.stringify({
    cryptoVersion: CRYPTO_VERSION,
    recordType: 'secure_cache',
    cacheKeyHash: input.cacheKeyHash,
    ownerHash: input.ownerHash,
    expiresAt: input.expiresAt,
    updatedAt: input.updatedAt,
  }));
}

function cacheOwner(key: string) {
  return /^cursor\.([^.]+)\./.exec(key)?.[1]
    ?? /^workspace-snapshot\.([^.]+)$/.exec(key)?.[1]
    ?? '';
}

async function sha256(value: string) {
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, value);
}

async function ensureOutboxColumns(db: SQLite.SQLiteDatabase) {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(outbox_commands)');
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('crypto_version')) {
    await db.execAsync('ALTER TABLE outbox_commands ADD COLUMN crypto_version INTEGER;');
  }
  if (!names.has('ciphertext_base64')) {
    await db.execAsync('ALTER TABLE outbox_commands ADD COLUMN ciphertext_base64 TEXT;');
  }
  if (!names.has('iv_base64')) {
    await db.execAsync('ALTER TABLE outbox_commands ADD COLUMN iv_base64 TEXT;');
  }
  if (!names.has('tag_base64')) {
    await db.execAsync('ALTER TABLE outbox_commands ADD COLUMN tag_base64 TEXT;');
  }
}

async function removeLegacyPayloads(db: SQLite.SQLiteDatabase) {
  const legacyRows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM outbox_commands
     WHERE crypto_version IS NULL OR ciphertext_base64 IS NULL OR iv_base64 IS NULL OR tag_base64 IS NULL`,
  );
  if (!legacyRows.length) return;
  await db.runAsync(
    `DELETE FROM outbox_commands
     WHERE crypto_version IS NULL OR ciphertext_base64 IS NULL OR iv_base64 IS NULL OR tag_base64 IS NULL`,
  );
  await Promise.all(legacyRows.map((row) => secureStorage.removeItem(legacyPayloadKey(row.id))));
}

async function database() {
  databasePromise ??= (async () => {
    const db = await SQLite.openDatabaseAsync(DB_NAME);
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS cache_entries (
        cache_key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        expires_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox_commands (
        id TEXT PRIMARY KEY NOT NULL,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        last_error_code TEXT,
        crypto_version INTEGER,
        ciphertext_base64 TEXT,
        iv_base64 TEXT,
        tag_base64 TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_scope_created_idx
        ON outbox_commands(user_id, organization_id, created_at);
      CREATE TABLE IF NOT EXISTS secure_cache_entries (
        cache_key_hash TEXT PRIMARY KEY NOT NULL,
        owner_hash TEXT NOT NULL,
        expires_at TEXT,
        updated_at TEXT NOT NULL,
        crypto_version INTEGER NOT NULL,
        ciphertext_base64 TEXT NOT NULL,
        iv_base64 TEXT NOT NULL,
        tag_base64 TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS secure_cache_owner_idx
        ON secure_cache_entries(owner_hash, updated_at);
    `);
    await ensureOutboxColumns(db);
    await removeLegacyPayloads(db);
    await db.runAsync(
      'DELETE FROM secure_cache_entries WHERE expires_at IS NOT NULL AND expires_at <= ?',
      new Date().toISOString(),
    );
    return db;
  })().catch((error) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

async function purgeAllEncryptedData(db: SQLite.SQLiteDatabase) {
  await db.runAsync('DELETE FROM outbox_commands');
  await db.runAsync('DELETE FROM secure_cache_entries');
}

async function encryptionKey() {
  if (encryptionKeyPromise) return encryptionKeyPromise;
  encryptionKeyPromise = (async () => {
    const db = await database();
    const encoded = await secureStorage.getItem(OUTBOX_KEY_NAME);
    if (encoded) {
      try {
        const imported = await AESEncryptionKey.import(encoded, 'base64');
        if (imported.size !== AESKeySize.AES256) throw new Error('invalid key size');
        return imported;
      } catch {
        // A corrupt device key cannot authenticate any existing command.
        await purgeAllEncryptedData(db);
        await secureStorage.removeItem(OUTBOX_KEY_NAME);
      }
    } else {
      const existingRows = await db.getFirstAsync<{ count: number }>(
        `SELECT
          (SELECT count(*) FROM outbox_commands)
          + (SELECT count(*) FROM secure_cache_entries) AS count`,
      );
      if ((existingRows?.count ?? 0) > 0) {
        // SecureStore was cleared or became unrecoverable while SQLite survived.
        await purgeAllEncryptedData(db);
      }
    }

    const generated = await AESEncryptionKey.generate(AESKeySize.AES256);
    await secureStorage.setItem(OUTBOX_KEY_NAME, await generated.encoded('base64'));
    return generated;
  })().catch((error) => {
    encryptionKeyPromise = null;
    throw error;
  });
  return encryptionKeyPromise;
}

async function sealPayload(command: OutboxCommand) {
  const sealed = await aesEncryptAsync(
    textEncoder.encode(JSON.stringify(command.payload)),
    await encryptionKey(),
    {
      nonce: { length: 12 },
      tagLength: 16,
      additionalData: additionalData({
        id: command.id,
        organizationId: command.organizationId,
        userId: command.userId,
        kind: command.kind,
        createdAt: command.createdAt,
      }),
    },
  );
  const [ciphertext, iv, tag] = await Promise.all([
    sealed.ciphertext({ encoding: 'base64' }),
    sealed.iv('base64'),
    sealed.tag('base64'),
  ]);
  return { ciphertext, iv, tag };
}

async function materialize(row: OutboxRow): Promise<OutboxCommand | null> {
  if (
    row.crypto_version !== CRYPTO_VERSION
    || !row.ciphertext_base64
    || !row.iv_base64
    || !row.tag_base64
  ) return null;
  try {
    const sealed = AESSealedData.fromParts(
      row.iv_base64,
      row.ciphertext_base64,
      row.tag_base64,
    );
    const payload = await aesDecryptAsync(sealed, await encryptionKey(), {
      additionalData: additionalData({
        id: row.id,
        organizationId: row.organization_id,
        userId: row.user_id,
        kind: row.kind,
        createdAt: row.created_at,
      }),
    });
    return {
      id: row.id,
      organizationId: row.organization_id,
      userId: row.user_id,
      kind: row.kind,
      payload: JSON.parse(textDecoder.decode(payload)) as unknown,
      createdAt: row.created_at,
      attempts: row.attempts,
      state: row.state,
      lastErrorCode: row.last_error_code ?? undefined,
    };
  } catch {
    // Authentication failure means tampering, scope mismatch, key loss, or corruption.
    return null;
  }
}

async function writeCommand(command: OutboxCommand) {
  const sealed = await sealPayload(command);
  const db = await database();
  await db.runAsync(
    `INSERT OR REPLACE INTO outbox_commands
      (id, organization_id, user_id, kind, created_at, attempts, state, last_error_code,
       crypto_version, ciphertext_base64, iv_base64, tag_base64)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    command.id,
    command.organizationId,
    command.userId,
    command.kind,
    command.createdAt,
    command.attempts,
    command.state,
    command.lastErrorCode ?? null,
    CRYPTO_VERSION,
    sealed.ciphertext,
    sealed.iv,
    sealed.tag,
  );
}

async function writeSecureCache(key: string, value: string, expiresAt?: string) {
  const plaintext = JSON.stringify({ key, value });
  if (textEncoder.encode(plaintext).byteLength > MAX_SENSITIVE_CACHE_BYTES) {
    throw new Error('Sensitive cache entry exceeds the device storage limit.');
  }
  const [cacheKeyHash, ownerHash] = await Promise.all([
    sha256(key),
    sha256(cacheOwner(key)),
  ]);
  const updatedAt = new Date().toISOString();
  const normalizedExpiry = expiresAt ?? null;
  const sealed = await aesEncryptAsync(
    textEncoder.encode(plaintext),
    await encryptionKey(),
    {
      nonce: { length: 12 },
      tagLength: 16,
      additionalData: secureCacheAdditionalData({
        cacheKeyHash,
        ownerHash,
        expiresAt: normalizedExpiry,
        updatedAt,
      }),
    },
  );
  const [ciphertext, iv, tag] = await Promise.all([
    sealed.ciphertext({ encoding: 'base64' }),
    sealed.iv('base64'),
    sealed.tag('base64'),
  ]);
  const db = await database();
  await db.runAsync(
    `INSERT OR REPLACE INTO secure_cache_entries
      (cache_key_hash, owner_hash, expires_at, updated_at, crypto_version,
       ciphertext_base64, iv_base64, tag_base64)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    cacheKeyHash,
    ownerHash,
    normalizedExpiry,
    updatedAt,
    CRYPTO_VERSION,
    ciphertext,
    iv,
    tag,
  );
}

async function readSecureCache(key: string) {
  const cacheKeyHash = await sha256(key);
  const db = await database();
  const row = await db.getFirstAsync<SecureCacheRow>(
    `SELECT cache_key_hash, owner_hash, expires_at, updated_at, crypto_version,
            ciphertext_base64, iv_base64, tag_base64
     FROM secure_cache_entries WHERE cache_key_hash = ?`,
    cacheKeyHash,
  );
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    await db.runAsync('DELETE FROM secure_cache_entries WHERE cache_key_hash = ?', cacheKeyHash);
    return null;
  }
  if (
    row.crypto_version !== CRYPTO_VERSION
    || !row.ciphertext_base64
    || !row.iv_base64
    || !row.tag_base64
  ) {
    await db.runAsync('DELETE FROM secure_cache_entries WHERE cache_key_hash = ?', cacheKeyHash);
    return null;
  }
  try {
    const sealed = AESSealedData.fromParts(
      row.iv_base64,
      row.ciphertext_base64,
      row.tag_base64,
    );
    const plaintext = await aesDecryptAsync(sealed, await encryptionKey(), {
      additionalData: secureCacheAdditionalData({
        cacheKeyHash: row.cache_key_hash,
        ownerHash: row.owner_hash,
        expiresAt: row.expires_at,
        updatedAt: row.updated_at,
      }),
    });
    const envelope = JSON.parse(textDecoder.decode(plaintext)) as { key?: unknown; value?: unknown };
    if (envelope.key !== key || typeof envelope.value !== 'string') throw new Error('invalid cache');
    return envelope.value;
  } catch {
    await db.runAsync('DELETE FROM secure_cache_entries WHERE cache_key_hash = ?', cacheKeyHash);
    return null;
  }
}

function approvedPlaintextCacheKey(key: string) {
  return key === 'preferences.ui-locale' || key.startsWith('cursor.');
}

export const clientStore: ClientStore = {
  async initialize() {
    await database();
    await encryptionKey();
  },
  async putCache(key, value, expiresAt) {
    if (!approvedPlaintextCacheKey(key)) return writeSecureCache(key, value, expiresAt);
    const db = await database();
    await db.runAsync(
      `INSERT OR REPLACE INTO cache_entries(cache_key, value, expires_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      key,
      value,
      expiresAt ?? null,
      new Date().toISOString(),
    );
  },
  async getCache(key) {
    if (!approvedPlaintextCacheKey(key)) return readSecureCache(key);
    const db = await database();
    const row = await db.getFirstAsync<{ value: string; expires_at: string | null }>(
      'SELECT value, expires_at FROM cache_entries WHERE cache_key = ?',
      key,
    );
    if (!row) return null;
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      await db.runAsync('DELETE FROM cache_entries WHERE cache_key = ?', key);
      return null;
    }
    return row.value;
  },
  async removeCache(key) {
    const db = await database();
    await db.runAsync('DELETE FROM cache_entries WHERE cache_key = ?', key);
    await db.runAsync('DELETE FROM secure_cache_entries WHERE cache_key_hash = ?', await sha256(key));
  },
  enqueue: writeCommand,
  async listOutbox(userId, organizationId) {
    const db = await database();
    const rows = await db.getAllAsync<OutboxRow>(
      `SELECT id, organization_id, user_id, kind, created_at, attempts, state, last_error_code,
              crypto_version, ciphertext_base64, iv_base64, tag_base64
       FROM outbox_commands
       WHERE user_id = ? AND organization_id = ?
       ORDER BY created_at ASC`,
      userId,
      organizationId,
    );
    const commands = await Promise.all(rows.map(materialize));
    const corruptIds = rows.filter((_, index) => commands[index] === null).map((row) => row.id);
    if (corruptIds.length) {
      const placeholders = corruptIds.map(() => '?').join(',');
      await db.runAsync(`DELETE FROM outbox_commands WHERE id IN (${placeholders})`, ...corruptIds);
    }
    return commands.filter((command): command is OutboxCommand => command !== null);
  },
  updateOutbox: writeCommand,
  async removeOutbox(id) {
    const db = await database();
    await db.runAsync('DELETE FROM outbox_commands WHERE id = ?', id);
  },
  async purgeUser(userId) {
    const db = await database();
    await db.runAsync('DELETE FROM outbox_commands WHERE user_id = ?', userId);
    await db.runAsync('DELETE FROM cache_entries WHERE cache_key LIKE ?', `%${userId}%`);
    await db.runAsync('DELETE FROM secure_cache_entries WHERE owner_hash = ?', await sha256(userId));
  },
};
