import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const catalog = readFileSync('apps/newone/src/i18n/catalog.ts', 'utf8');
const people = readFileSync('apps/newone/src/app/people.tsx', 'utf8');

test('blocking disclosure is visible and states the required notice and emergency limitation in every locale', () => {
  // Workplace realms keep the company-notice disclosure. The personal realm
  // never got a consumer variant of it: the manage sheet there shows no block
  // notice at all, because a consumer block has no company notices or
  // emergency policy to carve out and the disclosure would be a privacy
  // lecture. apps/newone/tests/people-username-search.test.tsx pins both
  // sides — "No privacy lecture in the consumer manage sheet" asserts the
  // notice is absent in the personal realm and present in a workspace one.
  // people.blockNotice was the workplace disclosure -- company notices and
  // emergency policy -- and is not shown to consumers (Sep 10 2026). The copy
  // itself is still asserted below, in all three locales.
  const notices = [...catalog.matchAll(/'people\.blockNotice': '([^']+)'/g)].map((match) => match[1]);
  assert.equal(notices.length, 3);
  assert.match(notices[0], /required company notices/i);
  assert.match(notices[0], /emergency policy/i);
  assert.match(notices[1], /필수 공지/);
  assert.match(notices[1], /비상 정책/);
  assert.match(notices[2], /avisos obligatorios/i);
  assert.match(notices[2], /emergencias/i);
});
