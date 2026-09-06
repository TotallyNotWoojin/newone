// AUTH + PROFILE/SETTINGS on one device.
//   Signup A: form → real email → WRONG code (visible error) → REAL code.
//     If the real code is refused after the wrong attempt (a finding), a
//     clean second signup (no wrong attempt) carries the rest of the run.
//   Lifecycle: relaunch persists, profile edit, language switch, push
//     registration, sign out.
//   Returning sign-in: request → resend (cooldown + confirmation) → second
//     email → stale code refused → new code accepted.
//   Delete account → tombstone truth.
//   Mail: the server sinks mail for the throwaway test domains
//   (NEWONE_TEST_MAIL_SINK_DOMAINS) and the suite mints codes through the
//   admin API (NEWONE_DEVICE_MINT_CODES=1), so no real email can arrive; the
//   "email arrives" checks are INFO rows in that mode (run-2026-09-06T01-11-11
//   reported them as failures and the cascade left the device signed out).
import { randomBytes } from 'node:crypto';
import { createMailbox, mintingEnabled } from '../lib/mailbox.mjs';

export const meta = { id: 'auth', devices: 1, title: 'AUTH + PROFILE/SETTINGS' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MINTED = 'mail sinked for test domains (NEWONE_TEST_MAIL_SINK_DOMAINS); code minted through the admin API (NEWONE_DEVICE_MINT_CODES=1)';

// Reports a code delivery: PASS/FAIL on a real inbox, INFO when codes are minted.
function mailNote(ctx, { id, title, code, expected, arrived, missing }) {
  if (mintingEnabled()) {
    ctx.note({ id, title, status: code ? 'INFO' : 'FAIL', expected: 'code minted (mail is sinked for test domains)', observed: code ? MINTED : `${MINTED}; but no code could be minted` });
    return;
  }
  ctx.note({ id, title, status: code ? 'PASS' : 'FAIL', expected, observed: code ? arrived : missing });
}

async function signupWithWrongCodeFirst(ctx, device, { username, displayName, mailbox }) {
  const { server } = ctx;
  const form = await ctx.step({
    id: 'auth-01-signup-form', title: 'Fresh signup: fill form, request code', device,
    flow: 'common/signup-request.yaml', env: { EMAIL: mailbox.email, USERNAME: username, DISPLAY_NAME: displayName },
    expected: 'Form accepts email/username/display name; "One-time code" screen appears', screen: 'sign-in',
  });
  if (!form.uiOk) return { ok: false };
  const requestedAt = Date.now();
  // ctx.waitForCode mints the code when NEWONE_DEVICE_MINT_CODES=1.
  const first = await ctx.waitForCode(mailbox);
  mailNote(ctx, { id: 'auth-02-signup-email', title: 'Signup code email arrives in the real inbox', code: first,
    expected: 'six-digit code email within 150s', arrived: `arrived after ${Math.round((Date.now() - requestedAt) / 1000)}s (subject: ${first?.subject})`, missing: 'no email arrived' });
  if (!first) return { ok: false };
  const wrongCode = first.code === '123456' ? '654321' : '123456';
  await ctx.step({
    id: 'auth-03-wrong-code', title: 'Wrong code is rejected with a visible error', device,
    flow: 'auth/wrong-code.yaml', env: { CODE: wrongCode, OBSERVE: 'error banner shown; still on code screen' },
    expected: 'Visible error text (e.g. "That code could not be verified.") and the user stays on the code screen', screen: 'sign-in (One-time code)',
  });
  const verify = await ctx.step({
    id: 'auth-04-verify-real-code-after-wrong', title: 'Real code from inbox signs the user in (after one wrong attempt)', device,
    flow: 'common/signup-verify.yaml', env: { CODE: first.code },
    expected: 'Chats screen appears; profile row exists', screen: 'sign-in (One-time code)',
    serverTruth: async () => {
      const row = await server.profileByUsername(username);
      return { ok: Boolean(row) && row.display_name === displayName && row.preferred_language === 'en', detail: row ?? 'no profile row' };
    },
  });
  return { ok: verify.uiOk, code: first.code };
}

export async function run(ctx) {
  const [device] = ctx.devices;
  const { server } = ctx;
  const mailbox = await createMailbox();
  let username = `sim_auth_${randomBytes(3).toString('hex')}`;
  const displayName = 'Sim Auth';
  ctx.log(`mailbox ${mailbox.email} username ${username}`);

  let signedIn = (await signupWithWrongCodeFirst(ctx, device, { username, displayName, mailbox })).ok;
  let activeMailbox = mailbox;
  if (!signedIn) {
    // Finding recorded above; carry the rest of the run with a clean signup.
    const fallback = await ctx.signup(device, { label: 'auth2', displayName });
    signedIn = fallback.signedIn;
    username = fallback.username;
    activeMailbox = fallback.mailbox;
    ctx.note({ id: 'auth-04b-clean-signup-fallback', title: 'Clean signup (no wrong attempt) used to continue the lifecycle', status: signedIn ? 'PASS' : 'FAIL', observed: `@${username} ${fallback.email}` });
  }
  if (!signedIn) return;
  const profile = await server.profileByUsername(username);
  const userId = profile?.user_id;

  await ctx.step({ id: 'auth-05-relaunch-persists', title: 'Force-quit + relaunch keeps the session', device, flow: 'common/relaunch.yaml', expected: 'Chats appears without signing in again', screen: 'app launch' });

  const newName = `Sim Auth ${username.slice(-4)}`;
  const status = `Testing ${username.slice(-4)}`;
  await ctx.step({
    id: 'profile-01-edit-profile', title: 'Edit display name + status message', device,
    flow: 'profile/edit-profile.yaml', env: { DISPLAY_NAME: newName, STATUS: status },
    expected: 'Save closes the "Edit profile" sheet; reopening it shows the new name and status; server profile row updated', screen: 'settings / Edit profile sheet',
    serverTruth: async () => {
      const wait = await server.waitFor(() => server.profileByUsername(username), (row) => row?.display_name === newName && row?.status_message === status, { timeoutMs: 20_000 });
      return { ok: wait.ok, detail: wait.row };
    },
  });
  await ctx.step({
    id: 'profile-02-language-es', title: 'Language → Español changes visible UI text', device,
    flow: 'profile/language-to-es.yaml', expected: 'Settings chrome ("Cerrar configuración", "Idioma" row) and tabs ("Ajustes", "Personas") render in Spanish', screen: 'settings',
    serverTruth: async () => { const row = await server.profileByUsername(username); return { ok: true, detail: `server preferred_language stays ${row?.preferred_language} (display language is a device setting)` }; },
  });
  await ctx.step({ id: 'profile-03-language-en', title: 'Language → English restores English UI', device, flow: 'profile/language-to-en.yaml', expected: 'Settings and tabs render in English again', screen: 'settings' });
  await ctx.step({
    id: 'profile-04-enable-notifications', title: 'Allow notifications switch on this (simulator) device', device,
    flow: 'profile/enable-notifications.yaml',
    expected: 'The "Allow notifications" switch asks for OS permission; on a simulator the banner "Push notifications need a physical device." follows (no push token), on a phone the switch turns on; any other error text is a finding', screen: 'settings / Notifications',
    serverTruth: async () => { const rows = userId ? await server.devices(userId) : []; return { ok: true, detail: rows.length ? rows : 'no device_registrations row (expected on a simulator: no push token)' }; },
  });
  await ctx.observe(device, { id: 'profile-04b-notifications-screen', title: 'Exact notifications section text after the attempt', screen: 'settings / Notifications' });

  await ctx.step({ id: 'auth-06-sign-out', title: 'Sign out from Settings', device, flow: 'common/signout.yaml', expected: 'Back at the sign-in screen ("Create account")', screen: 'settings' });

  // Returning sign-in with resend.
  const returning = await ctx.step({ id: 'auth-07-returning-request', title: 'Returning sign-in ("Sign in" chip): request code', device, flow: 'common/returning-request.yaml', env: { EMAIL: activeMailbox.email }, expected: '"One-time code" screen', screen: 'sign-in (Sign in chip)' });
  if (returning.uiOk) {
    const at = Date.now();
    const first = await ctx.waitForCode(activeMailbox);
    mailNote(ctx, { id: 'auth-08-returning-email', title: 'Returning sign-in code arrives', code: first, expected: 'code email within 150s', arrived: `arrived after ${Math.round((Date.now() - at) / 1000)}s`, missing: 'no email arrived' });
    const since = Date.now() - at;
    if (since < 65_000) await sleep(65_000 - since);
    const resend = await ctx.step({
      id: 'auth-09-resend-code', title: 'Resend code: confirmation + disabled link during cooldown', device,
      flow: 'auth/resend-code.yaml', env: { OBSERVE: '"We sent you a new code." and the link disabled with a countdown' },
      expected: '"We sent you a new code." confirmation; Resend link disabled with "(NNs)" countdown (screenshot)', screen: 'sign-in (One-time code)',
    });
    const resendAt = Date.now();
    const second = resend.uiOk ? await ctx.waitForCode(activeMailbox, { timeoutMs: 180_000 }) : null;
    mailNote(ctx, { id: 'auth-10-resend-email', title: 'Resent code email arrives in the real inbox', code: second,
      expected: 'a second six-digit code email arrives after the app confirmed the resend',
      arrived: `arrived after ${Math.round((Date.now() - resendAt) / 1000)}s; ${second?.code === first?.code ? 'IDENTICAL code to the first email' : 'different code from the first email'}`,
      missing: `no second email within 180s although the app said "We sent you a new code." (first email: ${first ? 'present' : 'absent'})` });
    let code = second?.code ?? first?.code ?? null;
    if (first && second && second.code !== first.code) {
      const stale = await ctx.step({
        id: 'auth-11-stale-code', title: 'Superseded (old) code is refused after resend', device,
        flow: 'auth/stale-code-returning.yaml', env: { CODE: first.code, OBSERVE: 'old code refused; still on code screen' },
        expected: 'Old code rejected with a visible error; not signed in', screen: 'sign-in (One-time code)',
      });
      if (!stale.uiOk) code = null; // old code was accepted → already in Chats (finding recorded)
    } else {
      ctx.note({ id: 'auth-11-stale-code', title: 'Superseded (old) code is refused after resend', status: 'SKIPPED', observed: second ? 'resend reissued the identical code; nothing stale to test' : 'no resent code arrived; testing the first code below instead' });
    }
    if (code) {
      await ctx.step({ id: 'auth-12-returning-verify', title: `Returning sign-in: ${second ? 'resent' : 'original'} code signs in`, device, flow: 'common/returning-verify.yaml', env: { CODE: code }, expected: 'Chats appears', screen: 'sign-in (One-time code)' });
    }
  }

  await ctx.step({
    id: 'auth-13-delete-account', title: 'Delete account (type username, confirm) → back at sign-in', device,
    flow: 'auth/delete-account.yaml', env: { USERNAME: username },
    expected: 'Sign-in screen returns; server: profile tombstoned (display_name "Deleted account", username released (free to reuse), auth user soft-deleted)', screen: 'settings / Danger → Delete account',
    serverTruth: async () => {
      if (!userId) return { ok: false, detail: 'no user id resolved before deletion' };
      const wait = await server.waitFor(() => server.tombstone(userId, username), (row) => row?.auth_soft_deleted === true && row?.display_name === 'Deleted account', { timeoutMs: 30_000 });
      const row = wait.row;
      const ok = row?.display_name === 'Deleted account' && row?.username === null && Number(row?.quarantined) === 0 && Number(row?.live_memberships) === 0 && row?.auth_soft_deleted === true;
      return { ok, detail: row };
    },
  });
}
