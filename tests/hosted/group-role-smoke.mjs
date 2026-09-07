// Real-API proof that a consumer group owner can change a member's role:
// two real signups, a request accepted, a group, then member → admin → member
// through the route the app uses. The route asks for AAL2 and a recent
// session, which the personal realm waives (consumer accounts have neither).
import { makeRunId } from './lib.mjs';
import { PERSONAL_REALM_ID, fail, gatewayRequest, gatewayPost, loadAccessToken, managementSql, projectKeys, signupUser } from './smoke-lib.mjs';
const runId = makeRunId();
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);
const ana = await signupUser(keys, { runId, label: 'ana', language: 'en' });
const ben = await signupUser(keys, { runId, label: 'ben', language: 'en' });
// A group is three people or more (backlog 36), so the smoke brings a third.
const cara = await signupUser(keys, { runId, label: 'cara', language: 'en' });
const post = (user, path, label, body) => gatewayPost('newone-api', path, keys, {
  installationId: user.installationId, accessToken: user.accessToken, idempotencyKey: `role-${runId}-${label}`,
  body: { organizationId: PERSONAL_REALM_ID, ...body },
});
const request = await post(ana, '/v2/contacts/message-requests', 'req', { targetUserId: ben.userId, body: 'Hi Ben, group time.' });
if (request.status !== 201) fail(`message request failed (${request.status})`, request.payload);
const accept = await post(ben, `/v2/contacts/connections/${ana.userId}/respond`, 'acc', { decision: 'accepted' });
if (accept.status !== 200) fail(`accept failed (${accept.status})`, accept.payload);
const group = await post(ana, '/v2/conversations/group', 'grp', {
  name: `Role smoke ${runId}`, kind: 'group', memberAssignments: [{ membershipId: ben.userId, role: 'member' }, { membershipId: cara.userId, role: 'member' }],
});
if (group.status !== 201) fail(`group creation failed (${group.status})`, group.payload);
const conversationId = (group.payload?.data ?? group.payload)?.conversationId;
const rows = async (query) => { const r = await managementSql(accessToken, query); return Array.isArray(r) ? r : r?.result ?? []; };
const roleOf = async () => (await rows(`select role from public.conversation_members where conversation_id = '${conversationId}' and user_id = '${ben.userId}'`))[0]?.role;
const setRole = (label, expectedRole, newRole) => gatewayRequest('newone-api', 'PATCH', `/v2/conversations/${conversationId}/members/${ben.userId}/role`, keys, {
  installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `role-${runId}-${label}`,
  body: { organizationId: PERSONAL_REALM_ID, expectedRole, newRole },
});
console.log('before:', await roleOf());
const promote = await setRole('promote', 'member', 'admin');
console.log('promote →', promote.status, JSON.stringify(promote.payload?.data ?? promote.payload).slice(0, 160));
if (promote.status !== 200) fail(`promotion refused (${promote.status})`, promote.payload);
const afterPromote = await roleOf();
if (afterPromote !== 'admin') fail('server role is not admin after promotion', afterPromote);
const demote = await setRole('demote', 'admin', 'member');
console.log('demote →', demote.status);
if (demote.status !== 200) fail(`demotion refused (${demote.status})`, demote.payload);
const afterDemote = await roleOf();
if (afterDemote !== 'member') fail('server role is not member after demotion', afterDemote);
console.log('PASS: consumer group owner promoted a member to admin and back (aal1 session, no step-up)');
