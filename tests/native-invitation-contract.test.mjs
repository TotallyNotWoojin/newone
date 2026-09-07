import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const signIn = readFileSync('apps/newone/src/app/sign-in.tsx', 'utf8');
const auth = readFileSync('apps/newone/src/state/auth.tsx', 'utf8');
const webAuth = readFileSync('apps/newone/src/lib/web-auth.ts', 'utf8');
const layout = readFileSync('apps/newone/src/app/_layout.tsx', 'utf8');
const admin = readFileSync('apps/newone/src/app/admin.tsx', 'utf8');
const commandRepository = readFileSync('apps/newone/src/data/repositories/bff-command-repository.ts', 'utf8');
const routes = readFileSync('supabase/functions/newone-api/routes.ts', 'utf8');
const workspace = readFileSync('apps/newone/src/state/workspace.tsx', 'utf8');
const catalog = readFileSync('apps/newone/src/i18n/catalog.ts', 'utf8');

test('native OTP uses the bounded Newone gateway with installation binding', () => {
  assert.match(webAuth, /'\/v2\/auth\/native\/otp\/request'/);
  assert.match(webAuth, /'\/v2\/auth\/native\/otp\/verify'/);
  assert.match(webAuth, /'X-Newone-Client-Platform': Platform\.OS/);
  assert.match(webAuth, /'X-Newone-Installation-Id': installationId/);
  assert.match(webAuth, /body: JSON\.stringify\(\{ \.\.\.body, installationId \}\)/);
  // The gateway session reaches the native client only through the shared
  // activateNativeSession helper (4f9cf65, 2026-09-06), which the OTP flow
  // calls with the user id the server named.
  assert.match(
    auth,
    /const gatewaySession = await verifyNativeOtp\(input\);\s*await activateNativeSession\(\s*gatewaySession\.session,\s*gatewaySession\.user\.id,/,
  );
  assert.match(
    auth,
    /activationInFlight\.current = true;[\s\S]*try \{[\s\S]*nativeClient\.auth\.setSession[\s\S]*finally \{[\s\S]*activationInFlight\.current = false;/,
  );
  assert.doesNotMatch(signIn, /signInWithOtp|emailRedirectTo|exchangeCodeForSession/);
  assert.doesNotMatch(auth, /exchangeCodeForSession|consumePendingNativeInvitation/);
});

test('invitation capabilities never use native or query-parameter deep links', () => {
  assert.doesNotMatch(signIn, /searchParams\.(?:get|delete)\(['"](?:invite|invitationToken)/);
  assert.doesNotMatch(signIn, /useLocalSearchParams|Linking\.createURL|emailRedirectTo/);
  assert.match(signIn, /fragment\.get\('invite'\)/);
  assert.match(signIn, /secureTextEntry/);
  assert.doesNotMatch(layout, /auth\/callback/);
  assert.equal(existsSync('apps/newone/src/app/auth/callback.tsx'), false);
  assert.equal(existsSync('apps/newone/src/lib/pending-native-invitation.native.ts'), false);
  assert.equal(existsSync('apps/newone/src/lib/pending-native-invitation.web.ts'), false);
});

test('web OTP and refresh bind the installation and manual employee code', () => {
  assert.match(webAuth, /interface OtpIdentity[\s\S]*employeeCode\?: string \| null/);
  assert.match(webAuth, /requestWebOtp\(input: OtpIdentity/);
  assert.match(webAuth, /verifyWebOtp\(input: OtpIdentity/);
  assert.match(webAuth, /input\.employeeCode \? \{ employeeCode: input\.employeeCode \} : \{\}/);
  assert.match(
    webAuth,
    /refreshWebSession[\s\S]*'\/v2\/auth\/session\/refresh'[\s\S]*installationId: client\.installationId/,
  );
  assert.match(auth, /requestWebOtp\(\{[\s\S]*destinationType: input\.destinationType[\s\S]*employeeCode: input\.employeeCode/);
  assert.match(auth, /verifyWebOtp\(\{[\s\S]*destinationType: input\.destinationType[\s\S]*employeeCode: input\.employeeCode/);
});

test('external invitations carry server-enforced membership expiry and guest sponsorship', () => {
  assert.match(routes, /bff_issue_organization_invite_v2/);
  assert.match(routes, /p_membership_type: command\.values\.membershipType/);
  assert.match(routes, /p_membership_access_expires_at: command\.values\.membershipAccessExpiresAt/);
  assert.match(routes, /p_guest_sponsor_user_id: command\.values\.guestSponsorUserId/);
  assert.match(routes, /membershipType === 'guest'[\s\S]{0,240}role !== 'member'/);
  assert.match(commandRepository, /membershipType: input\.membershipType/);
  assert.match(workspace, /accessExpiry > Date\.now\(\) \+ input\.expiresInSeconds \* 1000/);
  assert.match(workspace, /input\.membershipType === 'guest'[\s\S]{0,180}input\.role !== 'member'/);
  assert.match(admin, /inviteMembershipType === 'guest' \? 'member' : inviteRole/);
  assert.match(admin, /queryGroupCreationCandidates/);
  assert.match(admin, /candidate\.membershipType !== 'guest'/);
  assert.match(admin, /guestSponsorUserId: inviteMembershipType === 'guest'/);
  for (const key of [
    'admin.inviteMembershipType',
    'admin.inviteMembershipGuest',
    'admin.inviteAccessDuration',
    'admin.inviteSponsor',
    'admin.inviteGuestRoleLocked',
  ]) assert.equal((catalog.match(new RegExp(`'${key.replaceAll('.', '\\.')}'`, 'g')) ?? []).length, 3);
});
