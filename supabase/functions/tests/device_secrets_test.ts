import { protectPushToken, unprotectPushToken } from '../_shared/device-secrets.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

Deno.test('push tokens are AES-GCM protected with organization, user, and installation context', async () => {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const context = {
    organizationId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000010',
    installationId: '00000000-0000-4000-8000-000000000020',
  };
  const rawToken = 'ExponentPushToken[secret-device-token]';
  const encrypted = await protectPushToken(rawToken, context, {
    get: (name) => name === 'NEWONE_PUSH_TOKEN_KEY_V1' ? base64Url(keyBytes) : undefined,
  });
  assert(encrypted.startsWith('ciphertext:v1:'));
  assert(!encrypted.includes(rawToken));
  const environment = {
    get: (name: string) => name === 'NEWONE_PUSH_TOKEN_KEY_V1' ? base64Url(keyBytes) : undefined,
  };
  assertEquals(await unprotectPushToken(encrypted, context, environment), rawToken);

  const [nonceText, ciphertextText] = encrypted.slice('ciphertext:v1:'.length).split('.');
  assert(nonceText && ciphertextText);
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(keyBytes).buffer,
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: Uint8Array.from(decodeBase64Url(nonceText)).buffer,
      additionalData: Uint8Array.from(new TextEncoder().encode(
        `${context.organizationId}:${context.userId}:${context.installationId}`,
      )).buffer,
      tagLength: 128,
    },
    key,
    Uint8Array.from(decodeBase64Url(ciphertextText)).buffer,
  );
  assertEquals(new TextDecoder().decode(plaintext), rawToken);
});

Deno.test('push token protection fails closed without a 256-bit server key', async () => {
  await assertRejects(() =>
    protectPushToken('ExponentPushToken[secret-device-token]', {
      organizationId: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000010',
      installationId: '00000000-0000-4000-8000-000000000020',
    }, { get: () => undefined })
  );
});
