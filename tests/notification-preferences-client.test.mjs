import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  activeMutedUntil,
  isConversationMuted,
  normalizeNotificationLevel,
  temporaryMutePatch,
} from '../apps/newone/src/data/notification-preferences.mjs';

const now = Date.parse('2026-08-04T18:00:00.000Z');

test('conversation notification state distinguishes levels, active timed mutes, and expired mutes', () => {
  assert.equal(normalizeNotificationLevel('mentions'), 'mentions');
  assert.equal(normalizeNotificationLevel('unexpected'), 'all');
  assert.equal(isConversationMuted('none', null, now), true);
  assert.equal(isConversationMuted('mentions', '2026-08-04T19:00:00.000Z', now), true);
  assert.equal(isConversationMuted('all', '2026-08-04T17:59:59.000Z', now), false);
  assert.equal(activeMutedUntil('2026-08-04T19:00:00.000Z', now), '2026-08-04T19:00:00.000Z');
  assert.equal(activeMutedUntil('not-a-date', now), null);
});

test('temporary mute preserves mentions, converts indefinite mute safely, and is duration bounded', () => {
  assert.deepEqual(temporaryMutePatch('mentions', 60 * 60, now), {
    notificationLevel: 'mentions',
    mutedUntil: '2026-08-04T19:00:00.000Z',
  });
  assert.deepEqual(temporaryMutePatch('none', 8 * 60 * 60, now), {
    notificationLevel: 'all',
    mutedUntil: '2026-08-05T02:00:00.000Z',
  });
  assert.equal(temporaryMutePatch('all', 59, now), null);
  assert.equal(temporaryMutePatch('all', 7 * 24 * 60 * 60 + 1, now), null);
});

test('conversation controls expose all, mentions, indefinite, and timed choices through the BFF', async () => {
  const [pane, state, commands, copy] = await Promise.all([
    readFile(new URL('../apps/newone/src/features/chat/conversation-pane.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../apps/newone/src/state/workspace.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../apps/newone/src/data/repositories/bff-command-repository.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/newone/src/features/chat/notification-copy.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(pane, /\['all', notification\.all\]/);
  assert.match(pane, /\['mentions', notification\.mentions\]/);
  assert.match(pane, /\['none', notification\.none\]/);
  assert.match(pane, /muteFor\(60 \* 60\)/);
  assert.match(pane, /muteFor\(8 \* 60 \* 60\)/);
  assert.match(pane, /muteFor\(7 \* 24 \* 60 \* 60\)/);
  assert.match(state, /notificationLevel, mutedUntil/);
  assert.match(commands, /\/preferences/);
  assert.match(commands, /notificationLevel: input\.notificationLevel/);
  assert.match(commands, /mutedUntil: input\.mutedUntil/);
  assert.match(copy, /en:\s*\{/);
  assert.match(copy, /ko:\s*\{/);
  assert.match(copy, /es:\s*\{/);
  assert.match(copy, /critical-alert policy is evaluated separately by the server/);
});
