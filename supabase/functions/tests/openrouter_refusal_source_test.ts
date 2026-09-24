import { refusalSource } from '../_shared/openrouter.ts';
import { assertEquals } from './assert.ts';

const refusal = (body: string, status = 429) => new Response(body, { status });

Deno.test('a refusal OpenRouter passes on from the provider is labelled upstream', async () => {
  assertEquals(await refusalSource(refusal(JSON.stringify({
    error: {
      code: 429,
      message: 'Provider returned error',
      metadata: { provider_name: 'Google', raw: 'Resource exhausted' },
    },
  }))), 'upstream');
});

Deno.test('a refusal of OpenRouter\'s own, or one that cannot be read, is labelled openrouter', async () => {
  assertEquals(await refusalSource(refusal(JSON.stringify({
    error: { code: 429, message: 'Rate limit exceeded' },
  }))), 'openrouter');
  assertEquals(await refusalSource(refusal('<html>busy</html>', 503)), 'openrouter');
  assertEquals(await refusalSource(refusal('')), 'openrouter');
});
