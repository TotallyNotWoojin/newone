import { hmacSha256Hex } from '../_shared/crypto.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import { networkFingerprint } from '../_shared/security.ts';
import { assertEquals, assertRejects } from './assert.ts';

const networkHashKey = 'network-hash-key-that-is-at-least-32-characters';
const webGatewaySharedSecret = 'web-gateway-secret-that-is-at-least-32-characters';
const config: RuntimeConfig = {
  allowedOrigins: new Set(),
  accessCookieName: '__Host-newone_access',
  refreshCookieName: '__Host-newone_refresh',
  csrfCookieName: '__Host-newone_csrf',
  maxJsonBytes: 65_536,
  networkHashKey,
  webGatewaySharedSecret,
  allowHttpLocal: false,
};

Deno.test('native rate-limit fingerprint ignores spoofable IP alternatives and left XFF hops', async () => {
  const request = new Request('https://project.supabase.co/functions/v1/newone-auth', {
    headers: {
      'CF-Connecting-IP': '192.0.2.10',
      'X-Real-IP': '192.0.2.11',
      'X-Vercel-Forwarded-For': '192.0.2.12',
      'X-Forwarded-For': '192.0.2.13, 198.51.100.24',
    },
  });
  assertEquals(
    await networkFingerprint(request, config),
    await hmacSha256Hex(networkHashKey, '198.51.100.24'),
  );
});

Deno.test('Vercel BFF path uses its signed ingress peer, not the downstream proxy hop', async () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const peer = '203.0.113.17';
  const signature = await hmacSha256Hex(
    webGatewaySharedSecret,
    `newone-gateway-ip-v1\n${timestamp}\n${peer}`,
  );
  const request = new Request('https://project.supabase.co/functions/v1/newone-api', {
    headers: {
      'X-Forwarded-For': '203.0.113.17, 198.51.100.80, 198.51.100.81',
      'X-Real-IP': '203.0.113.17',
      'X-Newone-Gateway': 'web',
      'X-Newone-Gateway-Timestamp': timestamp,
      'X-Newone-Gateway-Network-Peer': peer,
      'X-Newone-Gateway-Network-Signature': signature,
    },
  });
  assertEquals(
    await networkFingerprint(request, config),
    await hmacSha256Hex(networkHashKey, peer),
  );
});

Deno.test('Vercel BFF network identity fails closed when missing, stale, or forged', async () => {
  const now = Math.floor(Date.now() / 1000);
  const invalidHeaders: Array<Record<string, string>> = [
    { 'X-Newone-Gateway': 'web' },
    {
      'X-Newone-Gateway': 'web',
      'X-Newone-Gateway-Timestamp': String(now - 121),
      'X-Newone-Gateway-Network-Peer': '203.0.113.17',
      'X-Newone-Gateway-Network-Signature': '0'.repeat(64),
    },
    {
      'X-Newone-Gateway': 'web',
      'X-Newone-Gateway-Timestamp': String(now),
      'X-Newone-Gateway-Network-Peer': '203.0.113.17',
      'X-Newone-Gateway-Network-Signature': '0'.repeat(64),
    },
  ];
  for (const headers of invalidHeaders) {
    await assertRejects(
      () =>
        networkFingerprint(
          new Request('https://project.supabase.co/functions/v1/newone-auth', { headers }),
          config,
        ),
    );
  }
});

Deno.test('missing managed network metadata maps to a stable non-raw fallback bucket', async () => {
  assertEquals(
    await networkFingerprint(
      new Request('https://project.supabase.co/functions/v1/newone-auth'),
      config,
    ),
    await hmacSha256Hex(networkHashKey, 'gateway-peer-unavailable'),
  );
});
