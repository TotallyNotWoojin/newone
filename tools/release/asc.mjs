// App Store Connect, signed with the API key.
//
// This lived in the session scratchpad under /private/tmp until Sep 9 2026,
// when the directory was pruned and took the issuer id with it. Tooling
// belongs in the repository; the credentials it reads belong in
// ~/.config/newone, which is not swept.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG = join(homedir(), '.config', 'newone', 'asc.json');

function config() {
  try {
    return JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch {
    throw new Error(`No App Store Connect config at ${CONFIG}. It needs issuerId, keyId and keyPath.`);
  }
}

const base64url = (input) => Buffer.from(input)
  .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function token() {
  const { issuerId, keyId, keyPath } = config();
  const key = readFileSync(keyPath.replace(/^~/, homedir()), 'utf8');
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({
    iss: issuerId,
    iat: now,
    exp: now + 19 * 60,
    aud: 'appstoreconnect-v1',
  }));
  const signer = createSign('SHA256');
  signer.update(`${header}.${payload}`);
  const der = signer.sign(key);
  // ES256 wants the raw r||s pair, not the DER sequence openssl hands back.
  let offset = 4;
  const rLength = der[3];
  const r = der.subarray(offset, offset + rLength);
  offset += rLength + 2;
  const s = der.subarray(offset, offset + der[offset - 1]);
  const pad = (value) => {
    const out = Buffer.alloc(32);
    value.subarray(Math.max(0, value.length - 32)).copy(out, Math.max(0, 32 - value.length));
    return out;
  };
  return `${header}.${payload}.${base64url(Buffer.concat([pad(r), pad(s)]))}`;
}

export async function asc(method, path, body) {
  const response = await fetch(`https://api.appstoreconnect.apple.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

export const ascConfig = config;
