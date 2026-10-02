// A signed-out session must stop working at once, on reads and on writes.
//
// Since Oct 2 2026 newone-api and newone-read know the caller from the token's
// signature alone and no longer ask the Auth service on every request (that
// hop took up to 31.8 s while the database stalled). The token itself stays
// valid until it expires, so this proves the other half: the database
// authorizer every route runs refuses a session that has been signed out.
// A real signup, a read and a send that work, a sign-out through the Auth
// service the way the app does it, and the same token refused on both.
//
//   node tests/hosted/signed-out-token-smoke.mjs
import { randomUUID } from 'node:crypto';

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

const runId = makeRunId();
const keys = projectKeys(loadAccessToken());
const pass = (label, detail = '') => console.log(`ok  ${label}${detail ? ` - ${detail}` : ''}`);
const pinned = (path) => `${path}?forceFunctionRegion=us-west-2`;

const user = await signupUser(keys, { runId, label: 'signedout', language: 'en' });
const peer = await signupUser(keys, { runId, label: 'peer', language: 'es' });
const claims = JSON.parse(Buffer.from(user.accessToken.split('.')[1], 'base64url').toString('utf8'));
if (claims.iss !== `${PROJECT_URL}/auth/v1` || claims.role !== 'authenticated') {
  fail('the access token does not carry the issuer and role the functions check', { iss: claims.iss, role: claims.role });
}
pass('signed_up', `${user.username}; token issued by ${claims.iss}`);

const read = () => gatewayPost('newone-read', pinned('/v2/bootstrap'), keys, {
  installationId: user.installationId,
  accessToken: user.accessToken,
  body: { organizationId: PERSONAL_REALM_ID, timelineLimit: 1 },
});
const write = () => gatewayPost('newone-api', pinned('/v2/contacts/message-requests'), keys, {
  installationId: user.installationId,
  accessToken: user.accessToken,
  idempotencyKey: randomUUID(),
  body: { organizationId: PERSONAL_REALM_ID, targetUserId: peer.userId, body: 'hello' },
});

const before = await read();
if (before.status !== 200) fail(`a live session's read answered ${before.status}`, before.payload);
const sent = await write();
if (sent.status !== 201) fail(`a live session's write answered ${sent.status}`, sent.payload);
pass('live_session_reads_and_writes', `${before.status}, ${sent.status}`);

const logout = await fetch(`${PROJECT_URL}/auth/v1/logout?scope=local`, {
  method: 'POST',
  headers: { apikey: keys.publishableKey, Authorization: `Bearer ${user.accessToken}` },
  signal: AbortSignal.timeout(30_000),
});
if (logout.status !== 204) fail(`sign-out answered ${logout.status}`, await logout.text());
pass('signed_out', String(logout.status));

const after = await read();
if (after.status !== 401 && after.status !== 403) fail(`a signed-out session could still read (${after.status})`, after.payload);
const afterWrite = await write();
if (afterWrite.status !== 401 && afterWrite.status !== 403) {
  fail(`a signed-out session could still write (${afterWrite.status})`, afterWrite.payload);
}
pass('signed_out_session_refused', `read ${after.status} ${after.payload?.error?.code}, write ${afterWrite.status} ${afterWrite.payload?.error?.code}`);

console.log(`signed-out-token smoke passed (${runId})`);
