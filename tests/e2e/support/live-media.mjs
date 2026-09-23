// A real file sent into a real chat, through the same five calls the app
// makes: the attachment message, the upload grant, the bytes to the signed
// storage target, and the completion (the personal realm marks it clean at
// once). Nothing is seeded into the database.
import { createHash, randomUUID } from 'node:crypto';

import { PERSONAL_REALM_ID, PROJECT_URL, gatewayPost } from '../../hosted/smoke-lib.mjs';

const dataOf = (response) => response.payload?.data ?? response.payload;

function expectStatus(response, expected, what) {
  if (response.status !== expected) {
    throw new Error(`${what} answered ${response.status}: ${JSON.stringify(response.payload).slice(0, 400)}`);
  }
  return dataOf(response);
}

export function apiPost(keys, user, path, label, body) {
  return gatewayPost('newone-api', path, keys, {
    installationId: user.installationId,
    accessToken: user.accessToken,
    idempotencyKey: `web-e2e-${label}-${randomUUID()}`,
    body: { organizationId: PERSONAL_REALM_ID, ...body },
  });
}

export async function sendText(keys, user, conversationId, label, body) {
  const sent = expectStatus(
    await apiPost(keys, user, `/v2/conversations/${conversationId}/messages`, label, {
      clientMessageId: randomUUID(),
      kind: 'text',
      body,
    }),
    201,
    `sending ${label}`,
  );
  return String(sent?.messageId ?? sent?.id ?? '');
}

export async function sendAttachment(keys, user, conversationId, { label, fileName, mimeType, bytes, caption = null }) {
  const messageId = await startAttachment(keys, user, conversationId, { label, caption });
  return finishAttachment(keys, user, conversationId, messageId, { label, fileName, mimeType, bytes });
}

/** The attachment message alone, as the app sends it before the file goes up. */
export async function startAttachment(keys, user, conversationId, { label, caption = null }) {
  const message = expectStatus(
    await apiPost(keys, user, `/v2/conversations/${conversationId}/messages`, `${label}-message`, {
      clientMessageId: randomUUID(),
      kind: 'attachment',
      body: caption,
    }),
    201,
    `${label} attachment message`,
  );
  return String(message.messageId);
}

/** The file for a message startAttachment made: grant, bytes, completion. */
export async function finishAttachment(keys, user, conversationId, messageId, { label, fileName, mimeType, bytes }) {
  const sha256Hex = createHash('sha256').update(bytes).digest('hex');
  const grant = expectStatus(
    await apiPost(keys, user, '/v2/attachments/grants', `${label}-grant`, {
      action: 'upload',
      conversationId,
      messageId,
      fileName,
      mimeType,
      byteSize: bytes.length,
      sha256Hex,
    }),
    201,
    `${label} upload grant`,
  ).grant;
  const uploadUrl = grant.signedUrl.startsWith('http')
    ? grant.signedUrl
    : `${PROJECT_URL}/storage/v1${grant.signedUrl}`;
  const upload = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': mimeType, 'x-upsert': 'false' },
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  if (!upload.ok) throw new Error(`${label} storage upload failed (${upload.status}): ${await upload.text()}`);
  expectStatus(
    await apiPost(keys, user, `/v2/attachments/${grant.attachmentId}/complete`, `${label}-complete`, {
      bucket: grant.bucket,
      path: grant.path,
      byteSize: bytes.length,
      sha256Hex,
    }),
    202,
    `${label} completion`,
  );
  return { messageId, attachmentId: grant.attachmentId };
}
