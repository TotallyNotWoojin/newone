import { ApiError, fromDatabaseError } from '../_shared/errors.ts';
import { assertEquals } from './assert.ts';

Deno.test('stale exact-version database conflicts tell clients to refresh', () => {
  const error = fromDatabaseError({ code: '40001' });
  assertEquals(error.status, 409);
  assertEquals(error.code, 'conflict');
});

Deno.test('code delivery failures carry a plain user-facing message', () => {
  const error = new ApiError(503, 'code_delivery_failed');
  assertEquals(error.status, 503);
  assertEquals(error.code, 'code_delivery_failed');
  assertEquals(error.message, 'We could not send your code. Try again.');
  assertEquals(error.retryAfterSeconds, undefined);
});
