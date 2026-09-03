#!/usr/bin/env node
// Provision the App Store review account: a real gateway signup for the
// designated review email, after which the static-code secrets are set so
// Apple's reviewers can sign in without email access. Idempotent-ish: fails
// clearly if the username or email is already taken.
//
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/provision-review-account.mjs
import { randomUUID } from 'node:crypto';
import { fail, gatewayPost, loadAccessToken, projectKeys } from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') {
  fail('Set NEWONE_HOSTED_E2E=1 to provision the review account');
}

const email = 'review@newonechat.com';
const username = 'newone_review';
const installationId = randomUUID();
const keys = projectKeys(loadAccessToken());

const request = await gatewayPost('newone-auth', '/v2/auth/native/signup/request', keys, {
  installationId,
  body: {
    destination: email,
    username,
    displayName: 'App Review',
    language: 'en',
    installationId,
  },
});
const status = request.payload?.data?.status ?? request.payload?.status;
if (request.status !== 202 || status !== 'code_sent') {
  fail(`review signup request refused (${request.status})`, request.payload);
}

const { adminRequest } = await import('./smoke-lib.mjs');
const link = await adminRequest(keys.adminKey, '/admin/generate_link', {
  method: 'POST',
  body: JSON.stringify({ type: 'magiclink', email }),
});
const otp = String(link?.email_otp ?? link?.properties?.email_otp ?? '');
if (!/^[0-9]{6,10}$/.test(otp)) fail('no OTP for review account');

const verify = await gatewayPost('newone-auth', '/v2/auth/native/signup/verify', keys, {
  installationId,
  body: { destination: email, code: otp, installationId },
});
if (verify.status !== 200) fail(`review signup verify failed (${verify.status})`, verify.payload);
const data = verify.payload?.data ?? verify.payload ?? {};
if (data.signup?.username !== username) fail('review account username mismatch', data.signup);

console.log(`PASS: review account provisioned — ${email} (@${username})`);
console.log('Next: set NEWONE_REVIEW_ACCOUNT_EMAIL and NEWONE_REVIEW_ACCOUNT_CODE secrets.');
