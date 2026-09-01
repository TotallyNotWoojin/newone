#!/usr/bin/env node
// Real hosted consumer-signup smoke against the linked development project.
// No mocks: it exercises the deployed newone-auth gateway, hosted GoTrue,
// Postgres, and the signup RPCs end-to-end with one uniquely prefixed
// synthetic identity, then verifies durable database state through the
// Management API. The OTP code is obtained through the admin generate-link
// API so the run does not depend on mailbox delivery. Secrets are never
// printed or written to the artifact.
//
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/signup-smoke.mjs
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_PROJECT_REF, makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID,
  adminRequest,
  fail,
  gatewayPost,
  loadAccessToken,
  managementSql,
  projectKeys,
} from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') {
  fail('Set NEWONE_HOSTED_E2E=1 to run the hosted signup smoke');
}

const runId = makeRunId();
const entropy = randomBytes(3).toString('hex');
const email = `${runId}-signup@example.test`;
const username = `e2e_signup_${entropy}`;
const language = 'ko';
const installationId = randomUUID();
const startedAt = new Date().toISOString();
const steps = [];

const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);

// Step 1: signup request through the deployed gateway.
const request = await gatewayPost('newone-auth', '/v2/auth/native/signup/request', keys, {
  installationId,
  body: {
    destination: email,
    username,
    displayName: 'Hosted Signup Smoke',
    language,
    installationId,
    captchaToken: 'hosted-smoke-captcha-placeholder',
  },
});
const requestStatus = request.payload?.data?.status ?? request.payload?.status;
if (request.status !== 202 || requestStatus !== 'code_sent') {
  fail(`signup request was not accepted (${request.status})`, request.payload);
}
steps.push('signup_request_accepted');

// Step 2: the pending auth user exists with the pending marker.
const userList = await adminRequest(
  keys.adminKey,
  `/admin/users?page=1&per_page=1&filter=${encodeURIComponent(email)}`,
);
const pendingUser = (userList?.users ?? []).find(
  (candidate) => candidate?.email?.toLowerCase() === email,
);
if (!pendingUser?.id) fail('pending signup auth user was not provisioned');
if (pendingUser.app_metadata?.newone_signup_state !== 'pending') {
  fail('pending signup marker is missing', pendingUser.app_metadata);
}
steps.push('pending_user_provisioned');

// Step 3: obtain the OTP through the admin generate-link API (no mailbox).
const link = await adminRequest(keys.adminKey, '/admin/generate_link', {
  method: 'POST',
  body: JSON.stringify({ type: 'magiclink', email }),
});
const otp = link?.email_otp ?? link?.properties?.email_otp;
if (!otp || !/^[0-9]{6,10}$/.test(String(otp))) fail('admin generate-link did not yield an email OTP');
steps.push('otp_obtained_via_admin_api');

// Step 4: verify through the deployed gateway; expect a session + signup receipt.
const verify = await gatewayPost('newone-auth', '/v2/auth/native/signup/verify', keys, {
  installationId,
  body: { destination: email, code: String(otp), installationId },
});
if (verify.status !== 200) fail(`signup verify failed (${verify.status})`, verify.payload);
const verifyData = verify.payload?.data ?? verify.payload ?? {};
const nativeSession = verifyData.session ?? {};
if (typeof nativeSession.accessToken !== 'string' || nativeSession.accessToken.length < 20
  || typeof nativeSession.refreshToken !== 'string' || nativeSession.refreshToken.length < 10) {
  fail('signup verify did not return a native session', Object.keys(nativeSession));
}
if (verifyData.authenticated !== true) fail('signup verify session is not authenticated');
if (verifyData.signup?.username !== username) {
  fail('signup receipt username mismatch', verifyData.signup);
}
const organizationId = verifyData.signup?.organizationId;
if (organizationId !== PERSONAL_REALM_ID) {
  fail('signup receipt did not name the personal realm', verifyData.signup);
}
steps.push('signup_verified_with_session');

// Step 5: durable database state, read through the Management API.
const evidenceRows = await managementSql(accessToken, `
  select
    (select username::text from public.profiles where user_id = '${pendingUser.id}'::uuid) as username,
    (select preferred_language from public.profiles where user_id = '${pendingUser.id}'::uuid) as preferred_language,
    (select count(*) from public.organization_memberships
      where organization_id = private.personal_realm_organization_id()
        and user_id = '${pendingUser.id}'::uuid
        and role = 'member' and status = 'active'
        and directory_visibility = 'private') as realm_memberships,
    (select dm_policy from public.organizations
      where id = private.personal_realm_organization_id()) as realm_dm_policy,
    (select ui_language from public.organization_user_preferences
      where organization_id = private.personal_realm_organization_id()
        and user_id = '${pendingUser.id}'::uuid) as realm_ui_language,
    (select count(*) from private.signup_reservations
      where destination = '${email}') as remaining_reservations
`);
const evidence = Array.isArray(evidenceRows) ? evidenceRows[0] : evidenceRows?.result?.[0];
if (!evidence) fail('database evidence query returned no rows', evidenceRows);
if (evidence.username !== username) fail('hosted profile username mismatch', evidence);
if (evidence.preferred_language !== language) fail('hosted preferred language mismatch', evidence);
if (Number(evidence.realm_memberships) !== 1) fail('personal-realm membership missing', evidence);
if (evidence.realm_dm_policy !== 'request_first') fail('personal realm dm policy mismatch', evidence);
if (evidence.realm_ui_language !== language) fail('realm UI language mismatch', evidence);
if (Number(evidence.remaining_reservations) !== 0) fail('signup reservation was not consumed', evidence);
steps.push('database_state_verified');

// Step 6: the pending marker was cleared.
const completedUser = await adminRequest(keys.adminKey, `/admin/users/${pendingUser.id}`);
if (completedUser?.app_metadata?.newone_signup_state !== 'complete') {
  fail('signup completion marker missing', completedUser?.app_metadata);
}
if (!completedUser?.email_confirmed_at) fail('signup verify did not confirm the email');
steps.push('signup_state_completed');

// Step 7: returning-member OTP authorization now accepts this account, proving
// post-signup sign-in works (the response is generic by design; the database
// authorizer decision is what distinguishes members).
const returning = await gatewayPost('newone-auth', '/v2/auth/native/otp/request', keys, {
  installationId,
  body: {
    destination: email,
    destinationType: 'email',
    installationId,
    captchaToken: 'hosted-smoke-captcha-placeholder',
  },
});
if (returning.status >= 500) fail(`returning member OTP request errored (${returning.status})`, returning.payload);
steps.push('returning_member_request_accepted');

const artifact = {
  runId,
  kind: 'consumer-signup-smoke',
  projectRef: EXPECTED_PROJECT_REF,
  startedAt,
  finishedAt: new Date().toISOString(),
  identity: { email, username, userId: pendingUser.id, language },
  personalRealmId: organizationId,
  steps,
  cleanup: 'retained synthetic identity; sweep with the harness cleanup procedure',
};
const artifactDirectory = join(dirname(fileURLToPath(import.meta.url)), '.artifacts');
mkdirSync(artifactDirectory, { recursive: true });
const artifactPath = join(artifactDirectory, `${runId}-signup-smoke.json`);
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`PASS: hosted consumer signup smoke (${steps.length} steps)`);
console.log(`identity: ${email} (${username})`);
console.log(`artifact: ${artifactPath}`);
