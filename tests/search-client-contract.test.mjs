import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  mergeSearchResults,
  normalizeSearchRequest,
  parseSearchPage,
  searchDateBoundary,
  searchLanguages,
} from '../apps/newone/src/data/search-contract.mjs';

const organizationId = '10000000-0000-4000-8000-000000000001';
const senderId = '10000000-0000-4000-8000-000000000002';
const conversationId = '10000000-0000-4000-8000-000000000003';
const signedCursor = `${'eyJ2ZXJzaW9uIjoxfQ'}.${'a'.repeat(64)}`;

function result(overrides = {}) {
  return {
    type: 'messages',
    id: '91',
    title: 'Jordan Lee',
    snippet: '압력 점검 완료',
    conversationId,
    occurredAt: '2026-08-04T12:00:00.000Z',
    matchedSource: 'translation',
    matchedLanguage: 'ko',
    ...overrides,
  };
}

test('search request normalization strictly binds source, sender, conversation, language, dates, type, and signed cursor', () => {
  assert.deepEqual(normalizeSearchRequest({
    organizationId,
    query: '  pump pressure  ',
    types: ['messages'],
    cursor: signedCursor,
    limit: 25,
    senderMembershipId: senderId,
    dateFrom: '2026-08-01T00:00:00-06:00',
    dateTo: '2026-08-04T23:59:59-06:00',
    matchSources: ['original', 'attachment_filename'],
    conversationId,
    language: 'ko',
  }), {
    organizationId,
    query: 'pump pressure',
    types: ['messages'],
    cursor: signedCursor,
    limit: 25,
    senderMembershipId: senderId,
    dateFrom: '2026-08-01T06:00:00.000Z',
    dateTo: '2026-08-05T05:59:59.000Z',
    matchSources: ['original', 'attachment_filename'],
    conversationId,
    language: 'ko',
  });
  assert.deepEqual(searchLanguages, ['ko', 'es', 'en', 'mixed', 'und']);

  assert.throws(() => normalizeSearchRequest({
    organizationId,
    query: 'pump',
    types: ['messages', 'people'],
    matchSources: ['translation'],
  }));
  assert.throws(() => normalizeSearchRequest({
    organizationId,
    query: 'pump',
    types: ['messages'],
    matchSources: ['translation', 'translation'],
  }));
  assert.throws(() => normalizeSearchRequest({
    organizationId,
    query: 'pump',
    cursor: 'unsigned-database-cursor',
  }));
  assert.throws(() => normalizeSearchRequest({
    organizationId,
    query: 'pump',
    conversationId: 'not-a-conversation-id',
  }));
  assert.throws(() => normalizeSearchRequest({
    organizationId,
    query: 'pump',
    language: 'fr',
  }));
  assert.throws(() => normalizeSearchRequest({
    organizationId,
    query: 'pump',
    unknownFilter: true,
  }));
});

test('search page parsing rejects extra fields, duplicates, unstable order, and invalid continuation state', () => {
  const page = parseSearchPage({
    results: [
      result(),
      result({
        id: '90',
        occurredAt: '2026-08-04T11:00:00Z',
        snippet: 'pump-inspection.pdf',
        matchedSource: 'attachment_filename',
        matchedLanguage: null,
      }),
    ],
    nextCursor: signedCursor,
    hasMore: true,
  }, 20);
  assert.equal(page.results[1].occurredAt, '2026-08-04T11:00:00.000Z');
  assert.equal(page.nextCursor, signedCursor);

  assert.throws(() => parseSearchPage({
    results: [result(), result()],
    nextCursor: null,
    hasMore: false,
  }));
  assert.throws(() => parseSearchPage({
    results: [
      result({ id: '90', occurredAt: '2026-08-04T11:00:00Z' }),
      result({ id: '91', occurredAt: '2026-08-04T12:00:00Z' }),
    ],
    nextCursor: null,
    hasMore: false,
  }));
  assert.throws(() => parseSearchPage({
    results: [result({ unauthorizedMetadata: 'secret' })],
    nextCursor: null,
    hasMore: false,
  }));
  assert.throws(() => parseSearchPage({
    results: [result()],
    nextCursor: null,
    hasMore: true,
  }));
});

test('append merging preserves server order while removing overlapping page identities', () => {
  const first = result();
  const overlap = result({ snippet: 'changed duplicate' });
  const next = result({ id: '90', occurredAt: '2026-08-04T11:00:00Z' });
  assert.deepEqual(mergeSearchResults([first], [overlap, next]), [first, next]);
});

test('calendar filters use valid local-day boundaries and reject impossible dates', () => {
  const start = searchDateBoundary('2026-08-04', 'start');
  const end = searchDateBoundary('2026-08-04', 'end');
  assert.ok(start && end && Date.parse(start) < Date.parse(end));
  assert.equal(searchDateBoundary('', 'start'), null);
  assert.throws(() => searchDateBoundary('2026-02-30', 'start'));
  assert.throws(() => searchDateBoundary('08/04/2026', 'end'));
});

test('search UI exposes source, sender, conversation, language, date controls and exact-message navigation', async () => {
  const [screen, repository, conversation] = await Promise.all([
    readFile(new URL('../apps/newone/src/features/search/workspace-search-panel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../apps/newone/src/data/repositories/bff-search-repository.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/newone/src/app/conversation/[id].tsx', import.meta.url), 'utf8'),
  ]);
  for (const marker of [
    'selectedSource',
    'selectedSenderId',
    'selectedConversationId',
    'selectedLanguage',
    'dateFromInput',
    'dateToInput',
    'matchSources:',
    'senderMembershipId:',
    'conversationId:',
    'language:',
    'messageId: result.id',
    'mergeSearchResults',
  ]) assert.match(screen, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(repository, /normalizeSearchRequest/);
  assert.match(repository, /parseSearchPage/);
  assert.match(conversation, /focusMessageId=\{messageId\}/);
});
