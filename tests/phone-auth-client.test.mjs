import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const signIn = readFileSync('apps/newone/src/app/sign-in.tsx', 'utf8');
const auth = readFileSync('apps/newone/src/state/auth.tsx', 'utf8');
const webAuth = readFileSync('apps/newone/src/lib/web-auth.ts', 'utf8');
const catalog = readFileSync('apps/newone/src/i18n/catalog.ts', 'utf8');
const admin = readFileSync('apps/newone/src/app/admin.tsx', 'utf8');

const catalogCount = (key) => (catalog.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) ?? []).length;

test('the OTP identity contract keeps its destination type, so the server phone paths stay inert but intact', () => {
  assert.match(webAuth, /interface OtpIdentity[\s\S]*destinationType: 'email' \| 'phone'[\s\S]*destination: string/);
  assert.match(webAuth, /requestWebOtp[\s\S]*destinationType: input\.destinationType[\s\S]*destination: input\.destination/);
  assert.match(webAuth, /verifyWebOtp[\s\S]*destinationType: input\.destinationType[\s\S]*destination: input\.destination/);
  assert.match(webAuth, /requestWebRecoveryOtp[\s\S]*destinationType: input\.destinationType[\s\S]*destination: input\.destination/);
  assert.match(webAuth, /verifyWebRecoveryOtp[\s\S]*destinationType: input\.destinationType[\s\S]*destination: input\.destination/);
  assert.match(webAuth, /phone\?: string/);
  assert.match(webAuth, /typeof user\.phone === 'string'/);
  assert.doesNotMatch(auth, /Phone (?:sign-in|recovery) is not configured/);
  assert.match(auth, /requestWebOtp\(\{[\s\S]*destinationType: input\.destinationType[\s\S]*destination: input\.destination/);
});

test('sign-in is email only (v3.2): no channel or method chips, and every request names the email type', () => {
  assert.doesNotMatch(signIn, /auth\.emailChannel|auth\.phoneChannel|auth\.methodCode|auth\.methodPassword/);
  assert.doesNotMatch(signIn, /useState<'email' \| 'phone'>/);
  assert.doesNotMatch(signIn, /phone-pad|\+52 81 5555 0192/);
  assert.match(signIn, /keyboardType="email-address"/);
  // The lookup is the first step of a returning sign-in; the account lookup
  // and the recovery request both carry the email type explicitly.
  assert.match(signIn, /auth\.lookupAccount\(\{\s*destinationType: 'email'/);
  assert.match(signIn, /auth\.requestRecoveryOtp\(\{\s*destinationType: 'email'/);
  assert.match(signIn, /auth\.signInWithPassword\(\{\s*destinationType: 'email'/);
  assert.match(signIn, /auth\.channelUnavailable/);
  assert.match(webAuth, /interface AccountLookupInput[\s\S]*destinationType: 'email'/);
  // The add-a-password screen is gone with the pre-wipe accounts.
  assert.doesNotMatch(signIn, /passwordPromptPending|passwordPromptTitle|dismissPasswordPrompt/);
  assert.doesNotMatch(auth, /passwordPromptPending|passwordSetFor|dismissPasswordPrompt/);
});

test('the removed chips left no copy behind and the email-only flow is localized in every shipped locale', () => {
  for (const key of [
    'auth.emailChannel',
    'auth.phoneChannel',
    'auth.methodCode',
    'auth.methodPassword',
    'auth.passwordPromptTitle',
    'auth.passwordPromptBody',
  ]) {
    assert.equal(catalogCount(key), 0, `${key} should be gone`);
  }
  for (const key of [
    'auth.subtitleReturn',
    'auth.subtitlePassword',
    'auth.forgotPassword',
    'auth.noAccount',
    'auth.createAccountShortcut',
    'auth.newPasswordTitle',
    'auth.differentEmail',
  ]) {
    assert.equal(catalogCount(key), 3, `${key} should exist in en, ko, and es`);
  }
});

test('administrators can issue an invitation to either an email or E.164 phone identity', () => {
  assert.match(admin, /useState<'email' \| 'phone'>\('email'\)/);
  assert.match(admin, /admin\.invitePhoneChannel/);
  assert.match(admin, /destinationType: inviteDestinationType/);
  assert.match(admin, /\^\\\+\[1-9\]\[0-9\]\{7,14\}\$/);
  assert.doesNotMatch(admin, /destinationType: 'email'/);
  assert.equal(catalogCount('admin.invitePhone'), 3);
});
