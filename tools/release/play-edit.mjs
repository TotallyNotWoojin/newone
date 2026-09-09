// One Play Developer API edit, authenticated as the service account in
// ~/.config/newone/play-service-account.json. Shared by the scripts that
// change a track after a bundle is already uploaded.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PACKAGE = 'com.totallynotwoojin.newone';

export async function playEdit() {
  const key = JSON.parse(readFileSync(
    join(homedir(), '.config', 'newone', 'play-service-account.json'), 'utf8',
  ));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
  const tokenResponse = await (await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  })).json();
  if (!tokenResponse.access_token) {
    throw new Error(`no Play access token: ${JSON.stringify(tokenResponse).slice(0, 200)}`);
  }
  const auth = {
    Authorization: `Bearer ${tokenResponse.access_token}`,
    'Content-Type': 'application/json',
  };
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
  const edit = await (await fetch(`${base}/edits`, { method: 'POST', headers: auth, body: '{}' })).json();
  if (!edit.id) throw new Error(`no Play edit: ${JSON.stringify(edit).slice(0, 200)}`);
  return {
    base,
    auth,
    edit,
    commit: () => fetch(`${base}/edits/${edit.id}:commit`, { method: 'POST', headers: auth }),
  };
}
