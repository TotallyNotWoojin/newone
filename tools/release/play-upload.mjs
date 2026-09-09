// Upload a bundle to a Play track. Usage: play-upload.mjs <aab> <track> <name>
//
// The service account lives in ~/.config/newone/play-service-account.json.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PACKAGE = 'com.totallynotwoojin.newone';
const account = JSON.parse(readFileSync(join(homedir(), '.config', 'newone', 'play-service-account.json'), 'utf8'));
const [aabPath, track = 'internal', releaseName] = process.argv.slice(2);
if (!aabPath) {
  console.error('usage: play-upload.mjs <aab> <track> <name>');
  process.exit(2);
}

const base64url = (input) => Buffer.from(input)
  .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${base64url(signer.sign(account.private_key))}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const json = await response.json();
  if (!json.access_token) throw new Error(`no Play access token: ${JSON.stringify(json).slice(0, 200)}`);
  return json.access_token;
}

const token = await accessToken();
const api = async (method, path, options = {}) => {
  const response = await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
    body: options.body,
    signal: AbortSignal.timeout(600_000),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
  return json;
};

const edit = await api('POST', '/edits');
const aab = readFileSync(aabPath);
const uploadResponse = await fetch(
  `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}/edits/${edit.id}/bundles?uploadType=media`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: aab,
    signal: AbortSignal.timeout(600_000),
  },
);
const uploaded = await uploadResponse.json();
if (!uploadResponse.ok) throw new Error(`bundle upload failed: ${JSON.stringify(uploaded).slice(0, 300)}`);
const versionCode = uploaded.versionCode;

await api('PUT', `/edits/${edit.id}/tracks/${track}`, {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    track,
    releases: [{
      name: releaseName ?? `newone ${versionCode}`,
      versionCodes: [String(versionCode)],
      status: process.env.RELEASE_STATUS === 'draft' ? 'draft' : 'completed',
    }],
  }),
});
await api('POST', `/edits/${edit.id}:commit`);
console.log(`PASS uploaded ${aabPath} as version code ${versionCode} to the ${track} track (${releaseName ?? ''})`);
