import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('critical update commands stay behind strict BFF routes and server-owned priority mapping', async () => {
  const [routes, repository] = await Promise.all([
    source('../supabase/functions/newone-api/routes.ts'),
    source('../apps/newone/src/data/repositories/bff-command-repository.ts'),
  ]);

  for (const routeMarker of [
    "kind: 'update.manage.list'",
    "kind: 'update.non_acknowledgers.list'",
    "kind: 'update.read'",
    "requireAal2: true",
    'recentAuthSeconds: 300',
    "'bff_list_managed_announcements'",
    "'bff_list_announcement_non_acknowledgers'",
    "'bff_mark_announcement_read'",
  ]) assert.match(routes, new RegExp(routeMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  assert.match(routes, /priority === 'emergency'[\s\S]*\? 'critical'[\s\S]*priority === 'important'[\s\S]*\? 'urgent'[\s\S]*: 'routine'/);
  assert.match(routes, /notificationClass !== expectedNotificationClass/);
  assert.match(routes, /notificationClass !== 'routine'[\s\S]*criticalCategory === null \|\| quietHoursOverrideReason === null/);

  for (const pathMarker of [
    '/v2/updates/audience/preview',
    '/v2/updates/manage/list',
    '/non-acknowledgers',
    '/acknowledgements',
    '/corrections',
    '/cancel',
    '/read',
  ]) assert.ok(repository.includes(pathMarker), `missing repository route ${pathMarker}`);
  assert.doesNotMatch(repository, /\.from\(['"](?:announcements|announcement_versions|announcement_acknowledgements)['"]\)/);
});

test('acknowledgement and publisher DTOs fail closed around attributable evidence and notice-only privacy', async () => {
  const [contracts, repository] = await Promise.all([
    source('../apps/newone/src/data/repositories/contracts.ts'),
    source('../apps/newone/src/data/repositories/bff-command-repository.ts'),
  ]);

  for (const evidenceField of [
    'sessionId: string',
    'installationId: string',
    "platform: 'ios' | 'android' | 'web'",
    'sessionEvidenceCaptured: true',
  ]) assert.ok(contracts.includes(evidenceField), `missing acknowledgement evidence ${evidenceField}`);
  assert.match(repository, /data\.sessionEvidenceCaptured !== true/);
  assert.match(repository, /requiredString\(data\.sessionId, 'acknowledgement session'\)/);
  assert.match(repository, /requiredString\(data\.installationId, 'acknowledgement installation'\)/);

  assert.match(contracts, /privacyScope: 'notice_response_state_only'/);
  assert.match(repository, /data\.privacyScope !== 'notice_response_state_only'/);
  assert.match(repository, /!\['delivered', 'pending', 'unreachable'\]\.includes/);
  assert.match(repository, /requiredInteger\(person\.reminderCount/);
  assert.match(repository, /requiredInteger\(data\.versionNumber/);
});

test('web and native update UI exposes the complete deliberate critical-update workflow in all locales', async () => {
  const [screen, copy, demo] = await Promise.all([
    source('../apps/newone/src/app/updates.tsx'),
    source('../apps/newone/src/features/updates/update-copy.ts'),
    source('../apps/newone/src/data/repositories/demo-repository.ts'),
  ]);

  for (const marker of [
    'previewCurrentAudience',
    'audienceReady',
    'scheduledAt',
    'cancelScheduled',
    'notificationClassForPriority',
    'attestationConfirmed',
    'acknowledgeExactVersion',
    'publishCorrection',
    'PublisherControlCenter',
    'loadNonResponders',
    'recipientCount',
    'deliveredCount',
    'readCount',
    'overdueCount',
    'unreachableCount',
    'immutableHistory',
    'smsDisabled',
  ]) assert.ok(screen.includes(marker), `missing update UI behavior ${marker}`);

  assert.match(screen, /Opening this detail|markReadBoundary/);
  assert.match(screen, /acknowledgementSchema\?\.attestationRequired && !attestationConfirmed/);
  assert.match(copy, /const en =/);
  assert.match(copy, /const ko: UpdateCopy/);
  assert.match(copy, /const es: UpdateCopy/);
  assert.match(copy, /opening or scrolling as acknowledgement/);
  assert.match(copy, /열기나 스크롤을 확인으로 간주하지 않습니다/);
  assert.match(copy, /Abrir o desplazarse nunca confirma/);

  for (const parityMethod of [
    'previewUpdateAudience',
    'publishUpdate',
    'cancelScheduledUpdate',
    'acknowledgeUpdate',
    'markUpdateRead',
    'correctUpdate',
    'listManagedUpdates',
    'listUpdateNonAcknowledgers',
  ]) assert.ok(demo.includes(parityMethod), `demo mode lacks ${parityMethod}`);
});
