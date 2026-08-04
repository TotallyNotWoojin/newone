import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sectionPath = new URL(
  '../apps/newone/src/components/settings/message-outbox-section.tsx',
  import.meta.url,
);
const settingsPath = new URL('../apps/newone/src/app/settings.tsx', import.meta.url);
const copyPath = new URL('../apps/newone/src/features/settings/outbox-copy.ts', import.meta.url);

test('settings outbox exposes only bounded edit, retry, and confirmed cancel controls', async () => {
  const source = await readFile(sectionPath, 'utf8');

  assert.match(source, /item\.canEdit/);
  assert.match(source, /item\.canRetry/);
  assert.match(source, /deliveryAmbiguous/);
  assert.match(source, /ActionModal[\s\S]*cancelAmbiguousDescription/);
  assert.match(source, /editBody\.trim\(\)\.length > 12_000/);
  assert.match(source, /onEdit\(editing\.id, editBody\)/);
  assert.match(source, /onRetry\(item\.id\)/);
  assert.match(source, /onCancel\(cancelling\.id\)/);
});

test('settings integrates the identity-scoped outbox with localized safety copy', async () => {
  const [settings, copy] = await Promise.all([
    readFile(settingsPath, 'utf8'),
    readFile(copyPath, 'utf8'),
  ]);

  assert.match(settings, /items=\{workspace\.messageOutbox\}/);
  assert.match(settings, /onEdit=\{workspace\.editOutboxMessage\}/);
  assert.match(settings, /onRetry=\{workspace\.retryOutboxMessage\}/);
  assert.match(settings, /onCancel=\{workspace\.cancelOutboxMessage\}/);
  assert.match(copy, /const copy: Record<AppLocale, MessageOutboxCopy>/);
  assert.match(copy, /en:\s*\{/);
  assert.match(copy, /ko:\s*\{/);
  assert.match(copy, /es:\s*\{/);
  assert.match(copy, /server-accepted message/);
  assert.match(copy, /서버에서 수락된 메시지/);
  assert.match(copy, /mensaje aceptado por el servidor/);
});
