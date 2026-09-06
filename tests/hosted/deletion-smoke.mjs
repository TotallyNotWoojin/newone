#!/usr/bin/env node
// Real hosted account-deletion smoke: sign a user up through the deployed
// gateway, delete the account through the deployed route, and verify the
// tombstone, immediate username release, auth soft-delete, and that the
// released handle can be registered again (v3.2, backlog 27).
//
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/deletion-smoke.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_PROJECT_REF, makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID,
  fail,
  gatewayPost,
  loadAccessToken,
  managementSql,
  projectKeys,
  signupUser,
} from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') {
  fail('Set NEWONE_HOSTED_E2E=1 to run the hosted deletion smoke');
}

const runId = makeRunId();
const startedAt = new Date().toISOString();
const steps = [];
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);

// Step 1: real signup.
const user = await signupUser(keys, { runId, label: 'deleteme', language: 'en' });
steps.push('signup_completed');

// Step 2: delete the account through the deployed route (native bearer).
const deletion = await gatewayPost('newone-auth', '/v2/auth/account/delete', keys, {
  installationId: user.installationId,
  accessToken: user.accessToken,
  body: {},
});
const deletionStatus = deletion.payload?.data?.status ?? deletion.payload?.status;
if (deletion.status !== 200 || deletionStatus !== 'deleted') {
  fail(`account deletion failed (${deletion.status})`, deletion.payload);
}
steps.push('account_deleted');

// Step 3: durable tombstone evidence.
const evidenceRows = await managementSql(accessToken, `
  select
    (select display_name from public.profiles where user_id = '${user.userId}'::uuid) as display_name,
    (select username::text from public.profiles where user_id = '${user.userId}'::uuid) as username,
    (select count(*) from private.reserved_usernames
      where username = '${user.username}'
        and reserved_reason = 'post-deletion-quarantine') as quarantined,
    (select count(*) from public.organization_memberships
      where user_id = '${user.userId}'::uuid and status <> 'deactivated') as live_memberships,
    (select count(*) from public.device_registrations
      where user_id = '${user.userId}'::uuid) as devices,
    (select deleted_at is not null from auth.users where id = '${user.userId}'::uuid) as auth_soft_deleted
`);
const evidence = Array.isArray(evidenceRows) ? evidenceRows[0] : evidenceRows?.result?.[0];
if (evidence?.display_name !== 'Deleted account') fail('profile not anonymized', evidence);
if (evidence?.username !== null) fail('username not released', evidence);
// v3.2: usernames are freed immediately; no quarantine row may exist.
if (Number(evidence?.quarantined) !== 0) fail('username still quarantined', evidence);
if (Number(evidence?.live_memberships) !== 0) fail('memberships still active', evidence);
if (Number(evidence?.devices) !== 0) fail('device registrations remain', evidence);
if (evidence?.auth_soft_deleted !== true) fail('auth user not soft-deleted', evidence);
steps.push('tombstone_verified');

// Step 4: the released username is accepted by a fresh signup request (the
// reserved-name check no longer holds it; the code is never redeemed here).
const reuse = await gatewayPost('newone-auth', '/v2/auth/native/signup/request', keys, {
  installationId: user.installationId,
  body: {
    destination: `${runId}-reuser@example.test`,
    username: user.username,
    displayName: 'Handle Reuser',
    language: 'en',
    installationId: user.installationId,
    captchaToken: 'hosted-smoke-captcha-placeholder',
  },
});
const reuseStatus = reuse.payload?.data?.status ?? reuse.payload?.status;
if (reuse.status !== 202 || reuseStatus !== 'code_sent') {
  fail(`released username was not accepted for signup (${reuse.status})`, reuse.payload);
}
steps.push('released_username_accepted');

const artifact = {
  runId,
  kind: 'consumer-deletion-smoke',
  projectRef: EXPECTED_PROJECT_REF,
  startedAt,
  finishedAt: new Date().toISOString(),
  identity: { email: user.email, username: user.username, userId: user.userId },
  personalRealmId: PERSONAL_REALM_ID,
  steps,
  cleanup: 'tombstoned identity retained by design; auth row soft-deleted',
};
const artifactDirectory = join(dirname(fileURLToPath(import.meta.url)), '.artifacts');
mkdirSync(artifactDirectory, { recursive: true });
const artifactPath = join(artifactDirectory, `${runId}-deletion-smoke.json`);
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`PASS: hosted account deletion smoke (${steps.length} steps)`);
console.log(`artifact: ${artifactPath}`);
