import { ApiError } from './errors.ts';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

async function pushTokenKey(
  usages: KeyUsage[],
  env: Pick<typeof Deno.env, 'get'>,
): Promise<CryptoKey> {
  const encodedKey = env.get('NEWONE_PUSH_TOKEN_KEY_V1')?.trim() ?? '';
  const keyBytes = decodeBase64Url(encodedKey);
  if (keyBytes.byteLength !== 32) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  return await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(keyBytes).buffer,
    'AES-GCM',
    false,
    usages,
  );
}

export async function protectPushToken(
  rawToken: string,
  context: { organizationId: string; userId: string; installationId: string },
  env: Pick<typeof Deno.env, 'get'> = Deno.env,
): Promise<string> {
  const key = await pushTokenKey(['encrypt'], env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(
    `${context.organizationId}:${context.userId}:${context.installationId}`,
  );
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: Uint8Array.from(nonce).buffer,
      additionalData: Uint8Array.from(additionalData).buffer,
      tagLength: 128,
    },
    key,
    Uint8Array.from(new TextEncoder().encode(rawToken)).buffer,
  );
  return `ciphertext:v1:${base64Url(nonce)}.${base64Url(new Uint8Array(encrypted))}`;
}

export async function unprotectPushToken(
  protectedToken: string,
  context: { organizationId: string; userId: string; installationId: string },
  env: Pick<typeof Deno.env, 'get'> = Deno.env,
): Promise<string> {
  const match = /^ciphertext:v1:([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,4096})$/.exec(
    protectedToken,
  );
  if (!match?.[1] || !match[2]) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  const nonce = decodeBase64Url(match[1]);
  const ciphertext = decodeBase64Url(match[2]);
  if (nonce.byteLength !== 12 || ciphertext.byteLength < 17 || ciphertext.byteLength > 4096) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  const key = await pushTokenKey(['decrypt'], env);
  const additionalData = new TextEncoder().encode(
    `${context.organizationId}:${context.userId}:${context.installationId}`,
  );
  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: Uint8Array.from(nonce).buffer,
        additionalData: Uint8Array.from(additionalData).buffer,
        tagLength: 128,
      },
      key,
      Uint8Array.from(ciphertext).buffer,
    );
    const rawToken = new TextDecoder('utf-8', { fatal: true }).decode(decrypted);
    if (rawToken.length < 16 || rawToken.length > 2048 || /[\u0000-\u001f\u007f]/.test(rawToken)) {
      throw new Error('invalid token');
    }
    return rawToken;
  } catch {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}
