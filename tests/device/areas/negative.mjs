// NEGATIVE on one device: form validation (invalid email/username, taken
// username), unknown returning email (plain message + create-account
// shortcut), email-only sign-in (no phone or method chips), wrong password,
// consumed/expired code refused on the forgot-password road, and the group
// picker offering a stranger (anyone can be added). The friends-only group
// refusal and the message-request cap are gone with the Sep 2026 social/chat
// streams (neg-06b, neg-07* removed below).
// (Messaging a blocked user is covered by people-14.)
import { SIGNUP_PASSWORD } from '../lib/harness.mjs';

export const meta = { id: 'negative', devices: 1, title: 'NEGATIVE' };

export async function run(ctx) {
  const [device] = ctx.devices;
  const { server } = ctx;
  const tag = Math.random().toString(36).slice(2, 6);

  // X exists (stranger + taken username), then signs out.
  const X = await ctx.signup(device, { label: 'neg_x', displayName: `Sim Xena ${tag}` });
  if (!X.signedIn) {
    ctx.note({ id: 'negative-blocked', title: 'NEGATIVE blocked: X signup failed', status: 'FAIL', observed: 'see setup rows' });
    return;
  }
  const xCode = X.code;
  await ctx.step({ id: 'setup-neg-x-signout', title: 'Setup: X signs out', device, flow: 'common/signout.yaml', expected: 'sign-in', screen: 'settings' });

  await ctx.step({ id: 'neg-01-invalid-email', title: 'Signup with an invalid email is refused', device, flow: 'negative/signup-expect-error.yaml', env: { EMAIL: 'not-an-email', USERNAME: `sim_neg_${tag}`, DISPLAY_NAME: 'Sim Neg', ERROR: 'Enter a valid email address.' }, expected: '"Enter a valid email address." and no code screen', screen: 'sign-in' });
  await ctx.step({ id: 'neg-02-invalid-username', title: 'Signup with a malformed username is refused', device, flow: 'negative/signup-expect-error.yaml', env: { EMAIL: X.email, USERNAME: 'ab', DISPLAY_NAME: 'Sim Neg', ERROR: '.*Usernames must be 4–30 lowercase letters.*' }, expected: 'Username rule error', screen: 'sign-in' });
  await ctx.step({ id: 'neg-03-taken-username', title: 'Signup with an already-taken username is refused (server)', device, flow: 'negative/signup-expect-error.yaml', env: { EMAIL: `${tag}-taken@example.test`, USERNAME: X.username, DISPLAY_NAME: 'Sim Neg', ERROR: '.*(already taken|reserved|could not).*' }, expected: '"That username is already taken." from the server', screen: 'sign-in' });
  await ctx.step({ id: 'neg-03b-back', title: 'Return to the mode chips', device, flow: 'negative/back-to-modes.yaml', expected: 'Create account visible', screen: 'sign-in' });

  await ctx.step({
    id: 'neg-04-unknown-returning-email', title: 'Sign in with an email that has no account', device,
    flow: 'negative/returning-unknown-email.yaml', env: { EMAIL: `nobody-${tag}@example.test` },
    expected: '"There’s no account with that email." with a "Create an account instead" shortcut; no code screen, no password field', screen: 'sign-in (Sign in chip)',
  });
  await ctx.observe(device, { id: 'neg-04b-unknown-email-screen', title: 'Exact screen after looking up an unknown email', screen: 'sign-in' });
  await ctx.step({
    id: 'neg-04c-phone-chips-absent', title: 'Email only: no Phone/Email channel chips and no code/password method chips', device,
    flow: 'negative/phone-chips-absent.yaml',
    expected: 'No "Phone", "Email me a code" or "Use password" chips on the Sign in step; none on Create account either; neutral email placeholder', screen: 'sign-in',
  });
  await ctx.step({ id: 'neg-04d-back', title: 'Return to the mode chips', device, flow: 'negative/back-to-modes.yaml', expected: 'Create account', screen: 'sign-in' });

  // Wrong password, then the forgot-password road: the OLD (consumed) signup
  // code is refused, the fresh code opens "Set a new password".
  const returning = await ctx.step({ id: 'neg-05a-returning-request', title: 'X enters the email; the password step appears', device, flow: 'common/returning-request.yaml', env: { EMAIL: X.email }, expected: 'password step', screen: 'sign-in' });
  if (returning.uiOk) {
    await ctx.step({
      id: 'neg-05b-wrong-password', title: 'A wrong password is refused', device,
      flow: 'auth/wrong-password.yaml', env: { PASSWORD: `Wrong-${tag}-2026`, OBSERVE: '"That email or password is incorrect."; still on the password step' },
      expected: '"That email or password is incorrect."; not signed in', screen: 'sign-in (password step)',
    });
    const forgot = await ctx.step({ id: 'neg-05c-forgot-password', title: 'X asks for a recovery code ("Forgot password?")', device, flow: 'auth/forgot-password.yaml', expected: 'code screen', screen: 'sign-in (password step)' });
    if (forgot.uiOk && xCode) {
      // ctx.waitForCode mints the code when NEWONE_DEVICE_MINT_CODES=1.
      const fresh = await ctx.waitForCode(X.mailbox);
      await ctx.step({ id: 'neg-05-consumed-code', title: 'Previously used (consumed) signup code is refused', device, flow: 'auth/stale-code-returning.yaml', env: { CODE: xCode, OBSERVE: 'consumed code refused' }, expected: 'Visible rejection; not signed in, not on "Set a new password"', screen: 'sign-in (One-time code)' });
      if (fresh) {
        const verified = await ctx.step({ id: 'neg-05d-fresh-code-works', title: 'The fresh code still opens "Set a new password" afterwards', device, flow: 'auth/forgot-verify.yaml', env: { CODE: fresh.code }, expected: '"Set a new password"', screen: 'sign-in (One-time code)' });
        if (verified.uiOk) await ctx.step({ id: 'neg-05e-new-password', title: 'X sets a new password and is signed in', device, flow: 'auth/new-password.yaml', env: { PASSWORD: SIGNUP_PASSWORD }, expected: 'Chats', screen: 'sign-in (Set a new password)' });
      }
    }
  }
  const signedInAsX = Boolean((await server.profileByUsername(X.username))?.user_id);
  if (!signedInAsX) return;

  // Y: a second account on the same device for stranger-related checks.
  await ctx.step({ id: 'setup-neg-x-signout-2', title: 'Setup: X signs out again', device, flow: 'common/signout.yaml', expected: 'sign-in', screen: 'settings' });
  const Y = await ctx.signup(device, { label: 'neg_y', displayName: `Sim Yara ${tag}` });
  if (!Y.signedIn) return;
  // The id keeps its history; the check inverted with the social stream: the
  // picker must offer a stranger found by @username instead of refusing them.
  const groupName = `Anyone ${tag}`;
  await ctx.step({
    id: 'neg-06-group-with-non-friend', title: 'Create group: a stranger found by @username is offered (anyone can be added); form cancelled', device, flow: 'negative/group-stranger-offered.yaml', env: { NAME: groupName, STRANGER: X.displayName, STRANGER_QUERY: X.username },
    expected: '"Add <stranger>" row appears for a non-contact; the old "No authorized candidates" refusal is gone; no group is created', screen: 'new-group',
    serverTruth: async () => { const row = await server.groupByName(groupName); return { ok: !row, detail: row ? `group created unexpectedly: ${row.id}` : 'no group row (form cancelled)' }; },
  });
  // neg-06b-group-non-friend-attempt: removed — adding a non-contact is the
  // intended behaviour now, not a refusal to probe.
  // neg-07a-search-x, neg-07b-request, neg-07-request-cap, neg-07c-cap-screen:
  // removed — message requests and their 3-message cap no longer exist; a
  // stranger's first message lands directly (people-04/people-05 prove it).
  ctx.note({ id: 'neg-08-blocked-send', title: 'Message a blocked user', status: 'INFO', observed: 'Covered by people-14-blocked-send-fails / people-16-send-after-unblock in the PEOPLE area.' });
  ctx.accounts = { X, Y };
}
