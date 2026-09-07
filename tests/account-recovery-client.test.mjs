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
  // Every gateway flow (code, password, signup, recovery) now commits through
  // one activateNativeSession helper (4f9cf65, 2026-09-06). The guarantees the
  // inline sequence used to carry are asserted on the helper itself: the
  // in-flight guard is raised before setSession, a session naming a different
  // user is signed straight back out, and only a matching session is kept.
  assert.match(
    authState,
    /activationInFlight\.current = true;[\s\S]*nativeClient\.auth\.setSession\(\{[\s\S]*?data\.session\.user\.id !== expectedUserId[\s\S]*?signOut\(\{ scope: 'local' \}\)[\s\S]*?setSession\(data\.session\)[\s\S]*?finally \{[\s\S]*?activationInFlight\.current = false;/,
  );
  assert.match(authState, /const recovered = await verifyNativeRecoveryOtp\(input\)/);
  // The recovered session is held, never activated, until the new password is
  // saved through it (defect AF). Activation happens in completeRecovery.
  assert.match(
    authState,
    /verifyRecoveryOtp:[\s\S]*?pendingRecovery\.current = \{ transport: 'native', recovered \}[\s\S]*?otherSessionsRevoked/,
  );
  assert.match(
    authState,
    /completeRecovery:[\s\S]*?setNativePassword\(\{ accessToken: pending\.recovered\.session\.accessToken[\s\S]*?activateNativeSession\(/,
  );
  assert.match(
    authState,
    /completeRecovery:[\s\S]*?await setWebPassword\(\{ password \}\)[\s\S]*?setWebUser\(\{ \.\.\.pending\.recovered\.user, hasPassword: true \}\)/,
  );
});

// The separate warned 'recovery' access mode is gone (4f9cf65, 2026-09-06:
// "Sign-in: one returning flow"). Recovery is now reached only through the
// "Forgot password?" link inside the returning flow, so the auth.recoveryWarning
// copy — which existed to steer people out of a mode they might pick by mistake
// — no longer has a mode to warn about and is not rendered anywhere.
//
// The half that still matters is the capability boundary, and the old test had
// stopped checking it: it scoped its doesNotMatch to `if (recoveryMode)`, an
// identifier that no longer exists, so the subject was always the empty string
// and the assertion could never fail. It is re-scoped to the real branch below.
test('the recovery path never reuses invitation or employee-code capabilities', () => {
  assert.match(signIn, /'signup' \| 'returning' \| 'enrollment'/);
  assert.match(signIn, /auth\.requestRecoveryOtp/);
  assert.match(signIn, /auth\.verifyRecoveryOtp/);

  const recoveryRequest = signIn.match(
    /returningMode\s*\?\s*await auth\.requestRecoveryOtp\(\{[\s\S]*?\}\)/,
  )?.[0];
  assert.ok(recoveryRequest, 'the returning flow no longer requests a recovery code');
  assert.doesNotMatch(recoveryRequest, /invitationToken|employeeCode/);

  const recoveryVerify = signIn.match(
    /if \(returningMode\) \{[\s\S]*?await auth\.verifyRecoveryOtp\(\{[\s\S]*?\}\);/,
  )?.[0];
  assert.ok(recoveryVerify, 'the returning flow no longer verifies a recovery code');
  assert.doesNotMatch(recoveryVerify, /invitationToken|employeeCode/);
});
