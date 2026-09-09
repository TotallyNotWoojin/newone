// Put an already-uploaded version code on a track. Usage: node play-track.mjs <track> <versionCode> [release name]
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
const [track, versionCode, releaseName = `newone build ${process.argv[3]}`] = process.argv.slice(2);
const pkg = 'com.totallynotwoojin.newone';
const key = JSON.parse(readFileSync(`${process.env.HOME}/.config/newone/play-service-account.json`, 'utf8'));
const now = Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: key.token_uri, iat: now, exp: now + 3600 })}`;
const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
const { access_token } = await (await fetch(key.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }) })).json();
const auth = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };
const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}`;
const edit = await (await fetch(`${base}/edits`, { method: 'POST', headers: auth, body: '{}' })).json();
const r = await fetch(`${base}/edits/${edit.id}/tracks/${track}`, { method: 'PUT', headers: auth, body: JSON.stringify({ track, releases: [{ name: releaseName, versionCodes: [String(versionCode)], status: process.env.RELEASE_STATUS ?? 'completed' }] }) });
console.log('track', track, r.status, (await r.text()).slice(0, 200).replace(/\s+/g, ' '));
const commit = await fetch(`${base}/edits/${edit.id}:commit`, { method: 'POST', headers: auth });
console.log('commit', commit.status, (await commit.text()).slice(0, 120).replace(/\s+/g, ' '));
