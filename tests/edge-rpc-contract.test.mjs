import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const workspace = path.resolve(import.meta.dirname, '..');
const functionsRoot = path.join(workspace, 'supabase', 'functions');
const migrationRoot = path.join(workspace, 'supabase', 'migrations');

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    if (entry.name === 'tests') return [];
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return entry.isFile() && entry.name.endsWith('.ts') ? [target] : [];
  }));
  return nested.flat();
}

test('every Edge RPC dependency has a public migration wrapper', async () => {
  const referenced = new Set();
  for (const file of await sourceFiles(functionsRoot)) {
    const source = await readFile(file, 'utf8');
    for (
      const match of source.matchAll(
        /["']((?:bff_[a-z0-9_]+)|redeem_organization_invite)["']/g,
      )
    ) referenced.add(match[1]);
  }

  const migrationFiles = (await readdir(migrationRoot))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const migration = (await Promise.all(
    migrationFiles.map((name) => readFile(path.join(migrationRoot, name), 'utf8')),
  )).join('\n');
  const defined = new Set(
    [...migration.matchAll(
      /create\s+or\s+replace\s+function\s+public\.([a-z0-9_]+)\s*\(/gi,
    )].map((match) => match[1].toLowerCase()),
  );
  const missing = [...referenced].filter((name) => !defined.has(name)).sort();
  assert.deepEqual(
    missing,
    [],
    `Edge RPC calls without public migration wrappers (would surface as PGRST202): ${missing.join(', ')}`,
  );
});
