import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const webAuth = readFileSync('apps/newone/src/lib/web-auth.ts', 'utf8');
const authState = readFileSync('apps/newone/src/state/auth.tsx', 'utf8');
const signIn = readFileSync('apps/newone/src/app/sign-in.tsx', 'utf8');

test('self-service recovery uses dedicated web and native identity endpoints', () => {
  assert.match(webAuth, /requestWebRecoveryOtp[\s\S]*'\/v2\/auth\/recovery\/otp\/request'/);
  assert.match(webAuth, /verifyWebRecoveryOtp[\s\S]*'\/v2\/auth\/recovery\/otp\/verify'/);
  assert.match(webAuth, /requestNativeRecoveryOtp[\s\S]*'\/v2\/auth\/native\/recovery\/otp\/request'/);
  assert.match(webAuth, /verifyNativeRecoveryOtp[\s\S]*'\/v2\/auth\/native\/recovery\/otp\/verify'/);
  assert.match(webAuth, /parseRecoverySession[\s\S]*currentSessionPreserved[\s\S]*otherSessionsRevoked[\s\S]*securityEventRecorded/);
});

test('native recovery commits the gateway session only after the server recovery result', () => {
  assert.match(
    authState,
    /verifyNativeRecoveryOtp\(input\)[\s\S]*activationInFlight\.current = true[\s\S]*nativeClient\.auth\.setSession/,
  );
  assert.match(
    authState,
    /verifyRecoveryOtp:[\s\S]*setWebUser\(recovered\.user\)[\s\S]*otherSessionsRevoked/,
  );
});

test('recovery is an explicit warned mode and never reuses invitation capabilities', () => {
  assert.match(signIn, /'returning' \| 'enrollment' \| 'recovery'/);
  assert.match(signIn, /auth\.recoveryWarning/);
  assert.match(signIn, /auth\.requestRecoveryOtp/);
  assert.match(signIn, /auth\.verifyRecoveryOtp/);
  assert.doesNotMatch(
    signIn.match(/if \(recoveryMode\)[\s\S]*?\} else \{/)?.[0] ?? '',
    /invitationToken|employeeCode/,
  );
});
