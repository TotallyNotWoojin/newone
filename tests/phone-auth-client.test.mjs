import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const signIn = readFileSync('apps/newone/src/app/sign-in.tsx', 'utf8');
const auth = readFileSync('apps/newone/src/state/auth.tsx', 'utf8');
const webAuth = readFileSync('apps/newone/src/lib/web-auth.ts', 'utf8');
const catalog = readFileSync('apps/newone/src/i18n/catalog.ts', 'utf8');
const admin = readFileSync('apps/newone/src/app/admin.tsx', 'utf8');

test('email and phone OTP use one typed identity contract on web and native', () => {
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

test('sign-in exposes validated email and E.164 phone choices without account enumeration copy', () => {
  assert.match(signIn, /useState<'email' \| 'phone'>\('email'\)/);
  assert.match(signIn, /auth\.emailChannel/);
  assert.match(signIn, /auth\.phoneChannel/);
  assert.match(signIn, /\^\\\+\[1-9\]\[0-9\]\{7,14\}\$/);
  assert.match(signIn, /keyboardType=\{destinationType === 'email' \? 'email-address' : 'phone-pad'\}/);
  assert.match(signIn, /auth\.channelUnavailable/);
  assert.doesNotMatch(signIn, /const destinationType = 'email'/);
});

test('email and phone auth copy is localized in all shipped UI locales', () => {
  assert.equal((catalog.match(/'auth\.phoneLabel':/g) ?? []).length, 3);
  assert.equal((catalog.match(/'auth\.phoneInvalid':/g) ?? []).length, 3);
  assert.equal((catalog.match(/'auth\.differentIdentity':/g) ?? []).length, 3);
});

test('administrators can issue an invitation to either an email or E.164 phone identity', () => {
  assert.match(admin, /useState<'email' \| 'phone'>\('email'\)/);
  assert.match(admin, /admin\.invitePhoneChannel/);
  assert.match(admin, /destinationType: inviteDestinationType/);
  assert.match(admin, /\^\\\+\[1-9\]\[0-9\]\{7,14\}\$/);
  assert.doesNotMatch(admin, /destinationType: 'email'/);
  assert.equal((catalog.match(/'admin\.invitePhone':/g) ?? []).length, 3);
});
