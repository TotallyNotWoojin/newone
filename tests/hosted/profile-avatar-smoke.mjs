// Hosted smoke: profile pictures end to end through the real API and storage.
// Pia uploads a PNG (grant → signed PUT → activate), reads her own picture,
// Quin (a co-member) reads it too, then Pia removes it and both get 404.
import { randomUUID, createHash } from 'node:crypto';
import { isUuid, makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID,
  PROJECT_URL,
  fail,
  gatewayRequest,
  loadAccessToken,
  managementSql,
  projectKeys,
  signupUser,
} from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') fail('Set NEWONE_HOSTED_E2E=1 to run the profile avatar smoke');

const ORG = PERSONAL_REALM_ID;
const runId = makeRunId();
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);
const sql = (query) => managementSql(accessToken, query);
const idem = (label) => `avatar-${runId}-${label}`;
const data = (response) => response.payload?.data ?? response.payload ?? {};
const firstRow = (rows) => (Array.isArray(rows) ? rows[0] : rows?.result?.[0]) ?? {};
function expect(condition, message, extra) { if (!condition) fail(message, extra); }
function expectStatus(response, status, label) {
  if (response.status !== status) fail(`${label} returned ${response.status} (expected ${status})`, response.payload);
  return data(response);
}
let stepStartedMs = Date.now();
function done(name, detail) {
  const elapsedMs = Date.now() - stepStartedMs; stepStartedMs = Date.now();
  console.log(`ok  ${name} (${elapsedMs}ms)${detail ? ` - ${detail}` : ''}`);
}
async function api(actor, method, path, label, body, options = {}) {
  return await gatewayRequest('newone-api', method, path, keys, {
    installationId: actor.installationId,
    accessToken: actor.accessToken,
    idempotencyKey: options.noIdempotency ? undefined : idem(label),
    body: { organizationId: ORG, ...body },
  });
}

// A 1x1 PNG.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const sha256Hex = createHash('sha256').update(png).digest('hex');

const pia = await signupUser(keys, { runId, label: 'pia', language: 'en' });
const quin = await signupUser(keys, { runId, label: 'quin', language: 'es' });
done('two_signups', `${pia.username}, ${quin.username}`);

// No picture yet: 404 for self and for a co-member.
expect((await api(pia, 'POST', `/v2/profiles/${pia.userId}/avatar/query`, 'q0', {}, { noIdempotency: true })).status === 404, 'self query before upload should be 404');
expect((await api(quin, 'POST', `/v2/profiles/${pia.userId}/avatar/query`, 'q0b', {}, { noIdempotency: true })).status === 404, 'peer query before upload should be 404');
done('no_picture_is_404');

const grant = expectStatus(await api(pia, 'POST', '/v2/profile/avatar/grants', 'grant', {
  fileName: 'me.png', mimeType: 'image/png', byteSize: png.length, sha256Hex,
}), 201, 'profile avatar grant').grant ?? {};
expect(grant.action === 'upload' && isUuid(grant.uploadId) && grant.bucket === 'profile-avatars' && grant.expiresInSeconds === 7200, 'grant shape', grant);
const parts = String(grant.path).split('/');
expect(parts.length === 4 && parts[0] === ORG && parts[1] === pia.userId && parts[2] === grant.uploadId && parts[3] === 'avatar', 'grant path shape', grant.path);
done('grant', grant.path);

// Activation before the object exists must be refused.
const early = await api(pia, 'POST', `/v2/profile/avatar/${grant.uploadId}/activate`, 'early', { expectedAvatarPath: null });
expect(early.status === 403, `activation before upload should be 403, got ${early.status}`, early.payload);
done('activation_refused_before_upload');

const uploadUrl = grant.signedUrl.startsWith('http') ? grant.signedUrl : `${PROJECT_URL}/storage/v1${grant.signedUrl}`;
const upload = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png', 'x-upsert': 'false' }, body: png, signal: AbortSignal.timeout(30_000) });
expect(upload.ok, `storage upload failed (${upload.status})`, (await upload.text().catch(() => '')).slice(0, 300));
done('uploaded_to_signed_url');

const activated = expectStatus(await api(pia, 'POST', `/v2/profile/avatar/${grant.uploadId}/activate`, 'activate', { expectedAvatarPath: null }), 200, 'activate');
expect(activated.activated === true && activated.avatarPath === grant.path && activated.previousAvatarPath === null && activated.userId === pia.userId, 'activation receipt', activated);
const row = firstRow(await sql(`select p.avatar_path, u.status from public.profiles p join public.profile_avatar_uploads u on u.id = '${grant.uploadId}' where p.user_id = '${pia.userId}'`));
expect(row.avatar_path === grant.path && row.status === 'active', 'server profile row after activation', row);
done('activated', row.avatar_path);

for (const [who, actor] of [['self', pia], ['peer', quin]]) {
  const read = expectStatus(await api(actor, 'POST', `/v2/profiles/${pia.userId}/avatar/query`, `read-${who}`, {}, { noIdempotency: true }), 200, `${who} read grant`);
  expect(read.userId === pia.userId && read.avatarPath === grant.path && read.expiresInSeconds === 300 && typeof read.signedUrl === 'string', `${who} read grant shape`, read);
  const url = read.signedUrl.startsWith('http') ? read.signedUrl : `${PROJECT_URL}/storage/v1${read.signedUrl}`;
  const download = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const bytes = Buffer.from(await download.arrayBuffer());
  expect(download.ok && bytes.equals(png), `${who} download bytes match (${download.status}, ${bytes.length} bytes)`);
  done(`read_${who}`);
}

// Stale precondition is refused; the right one removes.
const stale = await api(pia, 'DELETE', '/v2/profile/avatar', 'remove-stale', { expectedAvatarPath: `${ORG}/${pia.userId}/${randomUUID()}/avatar` });
expect(stale.status === 409 || stale.status === 403, `stale removal precondition should be refused, got ${stale.status}`, stale.payload);
const removed = expectStatus(await api(pia, 'DELETE', '/v2/profile/avatar', 'remove', { expectedAvatarPath: grant.path }), 200, 'remove');
expect(removed.removed === true && removed.avatarPath === null && removed.previousAvatarPath === grant.path, 'removal receipt', removed);
expect((await api(quin, 'POST', `/v2/profiles/${pia.userId}/avatar/query`, 'q9', {}, { noIdempotency: true })).status === 404, 'peer query after removal should be 404');
const after = firstRow(await sql(`select avatar_path from public.profiles where user_id = '${pia.userId}'`));
expect(after.avatar_path === null, 'server avatar_path null after removal', after);
done('removed');
console.log('PASS profile-avatar-smoke');
