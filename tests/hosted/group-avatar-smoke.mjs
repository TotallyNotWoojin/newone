// Hosted smoke: the group photo path exactly as the app does it — grant → signed
// PUT → complete → state poll → activate — against the consumer (no-scan) realm.
// groups-20 (run-2026-09-04T14-58-38) uploaded a clean image but never activated.
import { createHash } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import { PERSONAL_REALM_ID, PROJECT_URL, fail, gatewayRequest, loadAccessToken, managementSql, projectKeys, signupUser } from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') fail('Set NEWONE_HOSTED_E2E=1 to run the group avatar smoke');
const ORG = PERSONAL_REALM_ID; const runId = makeRunId(); const accessToken = loadAccessToken(); const keys = projectKeys(accessToken);
const data = (r) => r.payload?.data ?? r.payload ?? {};
const api = (actor, method, path, label, body) => gatewayRequest('newone-api', method, path, keys, { installationId: actor.installationId, accessToken: actor.accessToken, idempotencyKey: label ? `gav-${runId}-${label}` : undefined, body: { organizationId: ORG, ...body } });
function expectStatus(r, status, label) { if (r.status !== status) fail(`${label} returned ${r.status} (expected ${status})`, r.payload); return data(r); }
const ana = await signupUser(keys, { runId, label: 'ana', language: 'en' });
const ben = await signupUser(keys, { runId, label: 'ben', language: 'en' });
// A group is three people or more (backlog 36).
const cara = await signupUser(keys, { runId, label: 'cara', language: 'en' });
expectStatus(await api(ana, 'POST', '/v2/contacts/message-requests', 'req', { targetUserId: ben.userId, body: 'Hi Ben, photo time.' }), 201, 'request');
expectStatus(await api(ben, 'POST', `/v2/contacts/connections/${ana.userId}/respond`, 'acc', { decision: 'accepted' }), 200, 'accept');
const group = expectStatus(await api(ana, 'POST', '/v2/conversations/group', 'grp', { name: `Photo smoke ${runId}`, kind: 'group', memberAssignments: [{ membershipId: ben.userId, role: 'member' }, { membershipId: cara.userId, role: 'member' }] }), 201, 'group');
const conversationId = group.conversationId; console.log('ok  group', conversationId);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const sha256Hex = createHash('sha256').update(png).digest('hex');
const grant = expectStatus(await api(ana, 'POST', `/v2/conversations/${conversationId}/avatar/grants`, 'grant', { fileName: 'group.png', mimeType: 'image/png', byteSize: png.length, sha256Hex }), 201, 'avatar grant').grant ?? {};
console.log('ok  grant', grant.attachmentId, grant.scanStatus);
const uploadUrl = grant.signedUrl.startsWith('http') ? grant.signedUrl : `${PROJECT_URL}/storage/v1${grant.signedUrl}`;
const up = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png', 'x-upsert': 'false' }, body: png });
if (!up.ok) fail(`upload failed ${up.status}`, await up.text());
const complete = await api(ana, 'POST', `/v2/attachments/${grant.attachmentId}/complete`, 'complete', { bucket: grant.bucket, path: grant.path, byteSize: png.length, sha256Hex });
console.log('ok  complete', complete.status, JSON.stringify(data(complete)).slice(0, 200));
let state = null;
for (const delay of [0, 1000, 2000, 4000]) {
  if (delay) await new Promise((r) => setTimeout(r, delay));
  const s = await api(ana, 'POST', `/v2/attachments/${grant.attachmentId}/state`, null, {});
  state = data(s); console.log('state', s.status, JSON.stringify(state).slice(0, 200));
  if (state.found === true && state.attachment?.scanStatus === 'clean') break;
}
if (state?.attachment?.scanStatus !== 'clean') fail('attachment never reported clean', state);
const activate = await api(ana, 'POST', `/v2/conversations/${conversationId}/avatar/${grant.attachmentId}/activate`, 'activate', { expectedAvatarPath: null });
console.log('activate', activate.status, JSON.stringify(activate.payload).slice(0, 240));
const row = (await managementSql(accessToken, `select avatar_path from public.conversations where id = '${conversationId}'`));
const avatarPath = (Array.isArray(row) ? row[0] : row?.result?.[0])?.avatar_path;
console.log('server avatar_path:', avatarPath);
if (activate.status !== 200 || avatarPath !== grant.path) fail('group avatar not activated');
console.log('PASS group-avatar-smoke');
