import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  MAX_MESSAGE_MENTIONS,
  isValidMentionSelection,
  mentionablePeople,
  normalizeMentionSelection,
  parseMentionDto,
} from '../apps/newone/src/features/chat/mention-controls.mjs';

const self = '00000000-0000-4000-8000-000000000001';
const active = '00000000-0000-4000-8000-000000000002';
const suspended = '00000000-0000-4000-8000-000000000003';
const outsider = '00000000-0000-4000-8000-000000000004';

test('mention choices include only active current conversation members other than self', () => {
  const people = [
    { id: self, displayName: 'Self' },
    { id: active, displayName: 'Active' },
    { id: suspended, displayName: 'Suspended', suspended: true },
    { id: outsider, displayName: 'Outsider' },
  ];
  assert.deepEqual(
    mentionablePeople(people, [self, active, suspended], self).map((person) => person.id),
    [active],
  );
});

test('mention selection is ordered, unique, membership bounded, and excludes self', () => {
  assert.deepEqual(
    normalizeMentionSelection([active, active, outsider, self, suspended], [self, active, suspended], self),
    [active, suspended],
  );
  assert.equal(isValidMentionSelection([active], [self, active], self), true);
  assert.equal(isValidMentionSelection([active, active], [self, active], self), false);
  assert.equal(isValidMentionSelection([outsider], [self, active], self), false);
  assert.equal(isValidMentionSelection([self], [self, active], self), false);
  const oversized = Array.from(
    { length: MAX_MESSAGE_MENTIONS + 1 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
  );
  assert.equal(
    isValidMentionSelection(oversized, oversized, self),
    false,
  );
});

test('server mention DTO parsing fails closed for duplicates, malformed identifiers, and overflow', () => {
  assert.deepEqual(parseMentionDto([active, suspended]), [active, suspended]);
  assert.equal(parseMentionDto([active, active]), null);
  assert.equal(parseMentionDto(['not-a-uuid']), null);
  assert.equal(parseMentionDto(Array(MAX_MESSAGE_MENTIONS + 1).fill(active)), null);
});

test('mention metadata is preserved through the command, encrypted outbox, retry, and read DTO paths', () => {
  const contracts = readFileSync('apps/newone/src/data/repositories/contracts.ts', 'utf8');
  const repository = readFileSync('apps/newone/src/data/repositories/bff-command-repository.ts', 'utf8');
  const workspace = readFileSync('apps/newone/src/state/workspace.tsx', 'utf8');
  const outbox = readFileSync('apps/newone/src/data/persistence/outbox-controls.mjs', 'utf8');
  const reader = readFileSync('apps/newone/src/data/repositories/web-read-repository.ts', 'utf8');
  const pane = readFileSync('apps/newone/src/features/chat/conversation-pane.tsx', 'utf8');

  assert.match(contracts, /mentionUserIds\?: string\[\]/);
  assert.match(repository, /mentionUserIds: input\.mentionUserIds/);
  assert.match(workspace, /mentionUserIds: selectedMentionUserIds/);
  assert.match(outbox, /validMentionUserIds\(payload\.mentionUserIds\)/);
  assert.match(reader, /parseMentionDto\(row\.mentions/);
  assert.match(pane, /MentionSelector/);
  assert.match(pane, /onSend\(draft, replyingTo \?\? undefined, selectedMentionUserIds\)/);
});
