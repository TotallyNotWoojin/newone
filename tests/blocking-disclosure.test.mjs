import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const catalog = readFileSync('apps/newone/src/i18n/catalog.ts', 'utf8');
const people = readFileSync('apps/newone/src/app/people.tsx', 'utf8');

test('blocking disclosure is visible and states the required notice and emergency limitation in every locale', () => {
  assert.match(people, /t\('people\.blockNotice'\)/);
  const notices = [...catalog.matchAll(/'people\.blockNotice': '([^']+)'/g)].map((match) => match[1]);
  assert.equal(notices.length, 3);
  assert.match(notices[0], /required company notices/i);
  assert.match(notices[0], /emergency policy/i);
  assert.match(notices[1], /필수 공지/);
  assert.match(notices[1], /비상 정책/);
  assert.match(notices[2], /avisos obligatorios/i);
  assert.match(notices[2], /emergencias/i);
});
