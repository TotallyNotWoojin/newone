// SESSIONS on two devices: the same human signs in on a second phone
// (returning sign-in with a real code), sees it under Devices on the first,
// signs it out there (the second phone must be signed out), then ends the
// first device's own session. Also: Help screen and the read-receipts /
// sound settings (Settings surfaces without a durable conversation effect).

export const meta = { id: 'sessions', devices: 2, title: 'SESSIONS + SETTINGS extras' };

export async function run(ctx) {
  const [dev1, dev2] = ctx.devices;
  const { server } = ctx;
  const tag = Math.random().toString(36).slice(2, 6);
  const A = await ctx.signup(dev1, { label: 'ses_a', displayName: `Sim Sessions ${tag}` });
  if (!A.signedIn) return;

  await ctx.step({ id: 'sessions-00-help', title: 'Help screen opens and closes', device: dev1, flow: 'sessions/help-screen.yaml', expected: '"Help and recovery" with the account/recovery/privacy sections', screen: 'settings → Help' });
  await ctx.step({
    id: 'sessions-00b-communication-preferences', title: 'Read receipts → Nobody (picker) and Sound off, then both restored', device: dev1, flow: 'sessions/communication-preferences.yaml',
    expected: 'The picker shows Nobody selected when reopened; no error text (account settings auto-save, there is no Save button)', screen: 'settings → General / Notifications', optional: true,
  });

  // Second device: returning sign-in as A.
  await ctx.step({ id: 'sessions-01-second-device-prepare', title: 'Second device at the sign-in screen', device: dev2, flow: 'negative/signup-expect-error.yaml', env: { EMAIL: 'x', USERNAME: 'x', DISPLAY_NAME: 'x', ERROR: '.*(Enter a valid email|Usernames must).*' }, expected: 'sign-in screen (any prior session signed out)', screen: 'sign-in' });
  await ctx.step({ id: 'sessions-01b-back', title: 'Back to mode chips on device 2', device: dev2, flow: 'negative/back-to-modes.yaml', expected: 'Create account', screen: 'sign-in' });
  const request = await ctx.step({ id: 'sessions-02-returning-on-second-device', title: 'A requests a returning code on the second device', device: dev2, flow: 'common/returning-request.yaml', env: { EMAIL: A.email }, expected: 'code screen', screen: 'sign-in' });
  if (!request.uiOk) return;
  // ctx.waitForCode mints the code when NEWONE_DEVICE_MINT_CODES=1 (no mail dependency).
  const code = await ctx.waitForCode(A.mailbox);
  ctx.note({ id: 'sessions-02b-email', title: 'Returning code email arrives', status: code ? 'PASS' : 'FAIL', observed: code ? 'arrived' : 'no email' });
  if (!code) return;
  const verify = await ctx.step({
    id: 'sessions-03-second-device-signed-in', title: 'A is signed in on both devices', device: dev2, flow: 'common/returning-verify.yaml', env: { CODE: code.code },
    expected: 'Chats on device 2; server shows two live session installations', screen: 'sign-in',
    serverTruth: async () => { const w = await server.waitFor(() => server.sessions(A.userId), (rows) => rows.filter((r) => !r.revoked_at).length >= 2, { timeoutMs: 30_000 }); return { ok: w.ok, detail: w.row }; },
  });
  if (!verify.uiOk) return;

  await ctx.step({ id: 'sessions-04-list-shows-other-device', title: 'Device 1 lists the second device under Devices', device: dev1, flow: 'sessions/sessions-list.yaml', expected: 'A device row with a "Sign out" action; not the "No other devices" row', screen: 'settings → Devices' });
  await ctx.step({
    id: 'sessions-05-revoke-other', title: 'Device 1 signs out the second device\'s session', device: dev1, flow: 'sessions/revoke-other.yaml',
    expected: '"Sign out this device?" dialog (no reason field for consumer accounts) → "Yes, sign out"; the list returns to "No other devices"; server revoked_at set for that installation', screen: 'settings → Devices → Sign out',
    serverTruth: async () => { const w = await server.waitFor(() => server.sessions(A.userId), (rows) => rows.some((r) => r.revoked_at), { timeoutMs: 30_000 }); return { ok: w.ok, detail: w.row }; },
  });
  await ctx.step({ id: 'sessions-06-other-device-signed-out', title: 'The revoked device is signed out (next action / relaunch)', device: dev2, flow: 'sessions/other-device-signed-out.yaml', expected: 'Sign-in screen on device 2', screen: 'app' });
  await ctx.observe(dev2, { id: 'sessions-06b-revoked-device-screen', title: 'Exact screen on the revoked device', screen: 'app' });
  // "Revoke this session" is a workplace-only RowAction (settings.tsx renders it
  // when !personalRealm && auth.sessionId); a consumer ends this device's session
  // with "Sign out of Newone", which revokes it on the server before signing out.
  ctx.note({ id: 'sessions-07a-revoke-this-session-control', title: '"Revoke this session" control for the current device', status: 'UNREACHABLE', observed: 'Not rendered for consumer accounts: settings.tsx shows the RowAction only when !personalRealm && auth.sessionId. The consumer path is the "Sign out of Newone" row (sessions-07).', expected: 'n/a for consumer accounts' });
  await ctx.step({
    id: 'sessions-07-revoke-current', title: 'Sign out of Newone ends device 1\'s own session (consumer path)', device: dev1, flow: 'sessions/revoke-current.yaml',
    expected: 'Sign-in screen; server: all installations revoked (sign-out revokes this session on the server)', screen: 'settings → Sign out of Newone',
    serverTruth: async () => { const w = await server.waitFor(() => server.sessions(A.userId), (rows) => rows.length > 0 && rows.every((r) => r.revoked_at), { timeoutMs: 30_000 }); return { ok: w.ok, detail: w.row }; },
  });
  ctx.accounts = { A };
}
