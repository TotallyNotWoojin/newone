// Real-API proof for photo previews (owner, Oct 2 2026: "images won't even
// load and they take forever to send/receive"). A chat bubble used to fetch
// the full photo a phone took, through a link that lapsed after five minutes,
// so every scroll back and every restart fetched it again. A bubble now asks
// for a preview: a resized copy, linked for hours. Two real signups, one
// phone-sized photo and one PDF:
//   - the preview of the photo is at most 720 px wide and a fraction of its bytes;
//   - its link lasts six hours and carries no download name;
//   - the original still downloads byte for byte (the viewer, copy and save use it);
//   - a PDF is never resized, and a stranger gets no preview at all;
//   - an upload cannot ask for a preview.
//
//   node tests/hosted/photo-preview-smoke.mjs   (macOS: makes the photo with sips)
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID,
  PROJECT_URL,
  fail,
  gatewayPost,
  loadAccessToken,
  projectKeys,
  signupUser,
} from './smoke-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const runId = makeRunId();
const keys = projectKeys(loadAccessToken());
const dataOf = (response) => response.payload?.data ?? response.payload;
let step = 0;
const pass = (label, detail = '') => console.log(`ok  ${label}${detail ? ` - ${detail}` : ''}`);

function call(fn, user, path, body) {
  step += 1;
  return gatewayPost(fn, path, keys, {
    installationId: user.installationId,
    accessToken: user.accessToken,
    idempotencyKey: `preview-${runId}-${step}`,
    body: { organizationId: PERSONAL_REALM_ID, ...body },
  });
}
function expectStatus(response, status, what) {
  if (response.status !== status) fail(`${what} answered ${response.status}, expected ${status}`, response.payload);
  return dataOf(response);
}
function expect(condition, what, detail) {
  if (!condition) fail(what, detail);
}
const absolute = (signedUrl) => (signedUrl.startsWith('http') ? signedUrl : `${PROJECT_URL}/storage/v1${signedUrl}`);

// A phone photo: 4032 px wide, a few megabytes.
const work = mkdtempSync(join(tmpdir(), 'gist-preview-'));
const photoPath = join(work, 'site.jpg');
execFileSync('sips', [
  '-z', '3024', '4032', '-s', 'formatOptions', '100',
  join(HERE, '../e2e/fixtures/copy-me.jpg'), '--out', photoPath,
], { stdio: 'ignore' });
const photo = readFileSync(photoPath);
expect(photo.length > 500_000, 'the test photo should be phone-sized', { bytes: photo.length });

const sender = await signupUser(keys, { runId, label: 'sender', language: 'ko' });
const reader = await signupUser(keys, { runId, label: 'reader', language: 'es' });
const stranger = await signupUser(keys, { runId, label: 'stranger', language: 'en' });
pass('three_signups', `${sender.username}, ${reader.username}, ${stranger.username}`);

const request = expectStatus(
  await call('newone-api', sender, '/v2/contacts/message-requests', { targetUserId: reader.userId, body: '사진 보낼게요' }),
  201,
  'message request',
);
expectStatus(
  await call('newone-api', reader, `/v2/contacts/connections/${sender.userId}/respond`, { decision: 'accepted' }),
  200,
  'accepting',
);
const chat = String(request.conversationId);

async function sendFile({ fileName, mimeType, bytes }) {
  const sha256Hex = createHash('sha256').update(bytes).digest('hex');
  const message = expectStatus(
    await call('newone-api', sender, `/v2/conversations/${chat}/messages`, {
      clientMessageId: randomUUID(),
      kind: 'attachment',
      body: null,
    }),
    201,
    `${fileName} message`,
  );
  const upload = {
    action: 'upload',
    conversationId: chat,
    messageId: String(message.messageId),
    fileName,
    mimeType,
    byteSize: bytes.length,
    sha256Hex,
  };
  const grant = expectStatus(await call('newone-api', sender, '/v2/attachments/grants', upload), 201, `${fileName} grant`).grant;
  const put = await fetch(absolute(grant.signedUrl), {
    method: 'PUT',
    headers: { 'content-type': mimeType, 'x-upsert': 'false' },
    body: bytes,
    signal: AbortSignal.timeout(60_000),
  });
  expect(put.ok, `${fileName} upload failed (${put.status})`, await put.text());
  expectStatus(
    await call('newone-api', sender, `/v2/attachments/${grant.attachmentId}/complete`, {
      bucket: grant.bucket,
      path: grant.path,
      byteSize: bytes.length,
      sha256Hex,
    }),
    202,
    `${fileName} completion`,
  );
  return { attachmentId: grant.attachmentId, upload };
}

const sent = await sendFile({ fileName: 'site.jpg', mimeType: 'image/jpeg', bytes: photo });
const pdf = await sendFile({
  fileName: 'contract.pdf',
  mimeType: 'application/pdf',
  bytes: readFileSync(join(HERE, '../device/fixtures/newone-sample.pdf')),
});
pass('photo_and_pdf_sent', `${photo.length} bytes, 4032 px wide`);

const grantFor = async (user, attachmentId, purpose, status = 200) => {
  const body = { action: 'download', conversationId: chat, attachmentId };
  if (purpose) body.purpose = purpose;
  const response = await call('newone-api', user, '/v2/attachments/grants', body);
  return { status: response.status, grant: response.status === status ? expectStatus(response, status, `${purpose ?? 'file'} grant`).grant : null, response };
};

// The original, byte for byte.
const original = await grantFor(reader, sent.attachmentId, undefined);
const originalBytes = new Uint8Array(await (await fetch(absolute(original.grant.signedUrl), { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
expect(
  createHash('sha256').update(originalBytes).digest('hex') === createHash('sha256').update(photo).digest('hex'),
  'the original should download unchanged',
  { got: originalBytes.length, sent: photo.length },
);
pass('original_downloads_unchanged', `${originalBytes.length} bytes`);

// The preview.
const preview = await grantFor(reader, sent.attachmentId, 'preview');
expect(preview.grant?.action === 'preview', 'a preview grant should say so', preview.grant);
expect(preview.grant.expiresInSeconds === 6 * 60 * 60, 'a preview link should last six hours', preview.grant);
expect(preview.grant.resized === true, 'a JPEG preview should be resized', preview.grant);
expect(preview.grant.signedUrl.includes('/render/image/sign/'), 'a resized preview should come from the image renderer', preview.grant.signedUrl.split('?')[0]);
expect(!/[?&]download=/.test(preview.grant.signedUrl), 'a preview link carries no download name', preview.grant.signedUrl.split('?')[0]);
const previewResponse = await fetch(absolute(preview.grant.signedUrl), { signal: AbortSignal.timeout(60_000) });
expect(previewResponse.ok, `the preview should load (${previewResponse.status})`, await previewResponse.clone().text().catch(() => ''));
const previewBytes = new Uint8Array(await previewResponse.arrayBuffer());
const previewPath = join(work, 'preview.img');
writeFileSync(previewPath, previewBytes);
const size = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', previewPath], { encoding: 'utf8' });
const width = Number(/pixelWidth: (\d+)/.exec(size)?.[1]);
const height = Number(/pixelHeight: (\d+)/.exec(size)?.[1]);
expect(width > 0 && width <= 720, 'the preview should be at most 720 px wide', { width });
// The shape must survive: a width alone once kept the full height and the
// photo came back 720 x 3024, squashed into a strip (Oct 2 2026).
expect(Math.abs(width / height - 4032 / 3024) < 0.02, 'the preview should keep the photo\'s shape', { width, height });
expect(previewBytes.length * 4 < photo.length, 'the preview should be a fraction of the photo', { preview: previewBytes.length, photo: photo.length });
pass('preview_is_small', `${width} x ${height} px, ${previewBytes.length} bytes (${Math.round((previewBytes.length / photo.length) * 100)}% of the photo), ${previewResponse.headers.get('content-type')}`);

// A PDF is never resized; its preview is the file itself.
const pdfPreview = await grantFor(reader, pdf.attachmentId, 'preview');
expect(pdfPreview.grant.resized === false, 'a PDF preview is not resized', pdfPreview.grant);
expect(pdfPreview.grant.signedUrl.includes('/object/sign/'), 'a PDF preview is the stored file', pdfPreview.grant.signedUrl.split('?')[0]);
pass('pdf_preview_not_resized');

// Nobody outside the chat gets one, and an upload cannot ask for one.
const refused = await grantFor(stranger, sent.attachmentId, 'preview');
expect(refused.status >= 400 && refused.status < 500, 'a stranger should be refused a preview', refused.response);
const badUpload = await call('newone-api', sender, '/v2/attachments/grants', { ...sent.upload, purpose: 'preview' });
expect(badUpload.status === 400, 'an upload asking for a preview should be refused', badUpload);
pass('stranger_and_upload_refused', `${refused.status}, ${badUpload.status}`);

console.log(`photo-preview smoke passed (${runId})`);
