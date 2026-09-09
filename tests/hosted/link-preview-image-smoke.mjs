#!/usr/bin/env node
// Backlog 56: the thumbnail a page offers is drawn, without the phone ever
// reaching the site. The gateway fetches it alongside the page, keeps it in a
// private bucket, and hands the reader a signed link to our own copy.
//
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/link-preview-image-smoke.mjs
import { randomUUID } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID, fail, gatewayRequest, loadAccessToken, projectKeys, signupUser,
} from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') fail('Set NEWONE_HOSTED_E2E=1');
const keys = projectKeys(loadAccessToken());
const runId = makeRunId();
const me = await signupUser(keys, { runId, label: 'lp', language: 'en' });

const unfurl = (url) => gatewayRequest('newone-api', 'POST', '/v2/link-previews/query', keys, {
  installationId: me.installationId, accessToken: me.accessToken, idempotencyKey: randomUUID(),
  body: { organizationId: PERSONAL_REALM_ID, url },
});

// A page that reliably carries an og:image.
const first = await unfurl('https://en.wikipedia.org/wiki/Kimchi');
if (first.status !== 200) fail(`unfurl was refused (${first.status})`, first.payload);
const preview = first.payload?.data ?? first.payload;
if (!preview?.title) fail('the page carried no title', preview);
console.log('ok  the page says:', String(preview.title).slice(0, 48));

if (!preview.imageUrl) fail('no thumbnail came back for a page that has one', preview);
if (!/supabase\.co|storage/.test(preview.imageUrl)) {
  fail('the thumbnail is not our own copy — the phone would reach the site', preview.imageUrl);
}
if (/wikimedia|wikipedia/.test(preview.imageUrl)) {
  fail('the remote address was handed to the reader', preview.imageUrl);
}
console.log('ok  the thumbnail is a signed link to our copy, not the site');

const image = await fetch(preview.imageUrl, { signal: AbortSignal.timeout(20_000) });
if (!image.ok) fail(`the signed thumbnail did not load (${image.status})`);
const type = image.headers.get('content-type') ?? '';
if (!/^image\/(jpeg|png|webp)/.test(type)) fail(`the stored copy is not an image (${type})`);
const bytes = (await image.arrayBuffer()).byteLength;
if (bytes === 0 || bytes > 1_500_000) fail(`the stored copy is ${bytes} bytes`);
console.log(`ok  it loads: ${type}, ${(bytes / 1024).toFixed(0)} KB`);

// The second ask is a cache hit and must still be signed, not the raw address.
const second = await unfurl('https://en.wikipedia.org/wiki/Kimchi');
const cached = second.payload?.data ?? second.payload;
if (!cached?.imageUrl || /wikimedia|wikipedia/.test(cached.imageUrl)) {
  fail('a cached preview handed back the remote address', cached?.imageUrl);
}
console.log('ok  a cached preview is signed too');

// A page with no thumbnail is a card with words, not a failure.
const plain = await unfurl('https://example.com/');
if ((plain.payload?.data ?? plain.payload)?.imageUrl) {
  console.log('note: example.com now carries a thumbnail; nothing is wrong');
}
if (plain.status !== 200) fail(`a plain page failed the reader (${plain.status})`);
console.log('ok  a page without a thumbnail still answers');
console.log('PASS link preview thumbnails');
