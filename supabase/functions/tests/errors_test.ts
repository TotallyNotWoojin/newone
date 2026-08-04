import { fromDatabaseError } from '../_shared/errors.ts';
import { assertEquals } from './assert.ts';

Deno.test('stale exact-version database conflicts tell clients to refresh', () => {
  const error = fromDatabaseError({ code: '40001' });
  assertEquals(error.status, 409);
  assertEquals(error.code, 'conflict');
});
