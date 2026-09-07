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
  // Reworded for consumers in d7854dd (2026-09-05). The property is unchanged
  // and is the honest half of the cancel dialog: cancelling removes the local
  // queue item only, and an attempt that already reached the service may still
  // land. Said in all three locales, with matching keys throughout.
  const blocks = [...copy.matchAll(/\b(en|ko|es): \{([\s\S]*?)\n  \}/g)];
  assert.equal(blocks.length, 3);
  const keysFor = (block) => [...block.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((m) => m[1]).sort();
  const [en, ko, es] = blocks.map((block) => keysFor(block[2]));
  assert.ok(en.length >= 15, `suspiciously few outbox copy keys (${en.length})`);
  assert.deepEqual(ko, en);
  assert.deepEqual(es, en);
  assert.match(copy, /may already have reached the service\. Cancelling removes only this local queue item\./);
  assert.match(copy, /이미 서비스에 도달했을 수 있습니다\. 취소하면 이 로컬 대기열 항목만 제거됩니다\./);
  assert.match(copy, /podría haber llegado al servicio\. Cancelar solo elimina este elemento de la cola local\./);
});
