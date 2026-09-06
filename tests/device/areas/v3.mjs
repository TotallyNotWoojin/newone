// v3 CONSUMER FEATURES on two devices (A en ↔ B ko): everything the Sep 2026
// v3 streams added is exercised for real on a simulator against the live
// backend, one step per feature, with the database row consulted wherever the
// feature leaves one. A signs up with a password typed on the signup form
// (v3.2: every account is created with one; the add-a-password step is gone)
// and keeps the first-launch notification card for v3-01; B signs up in
// Korean (server language ko, UI switched back to English) so A's Spanish
// reaches B as a Korean translation for the translated-only bubble.
import { randomBytes } from 'node:crypto';
import { SIGNUP_PASSWORD } from '../lib/harness.mjs';
import { createMailbox } from '../lib/mailbox.mjs';

export const meta = { id: 'v3', devices: 2, title: 'v3 consumer features' };
const PASSWORD = SIGNUP_PASSWORD;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Server contract for "this account has a password": the auth gateway stamps
// app_metadata.newone_password_set_at when a password is chosen; the presence
// of encrypted_password says nothing (newone-auth/handler.ts).
async function passwordState(server, userId) {
  const row = await server.one(`select raw_app_meta_data->>'newone_password_set_at' as password_set_at
    from auth.users where id = ${server.lit(userId)}::uuid`);
  return { hasPassword: typeof row?.password_set_at === 'string', passwordSetAt: row?.password_set_at ?? null };
}

// Like ctx.signup (lib/harness.mjs), but proves the password typed on the
// signup form (PASSWORD) was stamped on the account, and leaves the
// first-launch notification card for v3-01 to exercise. Reported as setup
// actions like the harness's own signup.
async function signupWithPassword(ctx, device, { label, displayName }) {
  const { server } = ctx;
  const mailbox = await createMailbox();
  const username = `sim_${label}_${randomBytes(3).toString('hex')}`.toLowerCase();
  const account = { label, email: mailbox.email, username, displayName, language: 'en', mailbox, userId: null, device, password: PASSWORD, signedIn: false };
  ctx.log(`signup ${label}: ${mailbox.email} @${username} (en, saves a password) on ${device}`);
  const form = await ctx.step({
    id: `setup-${label}-signup-form`, title: `Setup: sign up ${displayName} (en) — form`, device,
    flow: 'common/signup-request.yaml', env: { EMAIL: mailbox.email, USERNAME: username, DISPLAY_NAME: displayName },
    expected: 'Sign-up form accepts email/username/display name and shows the one-time code screen', screen: 'sign-in (Create account)',
  });
  if (!form.uiOk) return account;
  const requestedAt = Date.now();
  const code = await ctx.waitForCode(mailbox);
  if (!code) {
    ctx.note({ id: `setup-${label}-signup-email`, title: `Setup: signup email for ${displayName}`, status: 'FAIL', expected: 'verification email arrives (or is minted) within 150s', observed: 'no six-digit code' });
    return account;
  }
  ctx.note({ id: `setup-${label}-signup-email`, title: `Setup: signup email for ${displayName}`, status: 'PASS', expected: 'verification code available', observed: `code arrived after ${Math.round((Date.now() - requestedAt) / 1000)}s (subject: ${code.subject})` });
  account.code = code.code;
  const verify = await ctx.step({
    id: `setup-${label}-signup-verify`, title: `Setup: verify the code for ${displayName} (password already typed on the form)`, device,
    flow: 'common/signup-verify.yaml', env: { CODE: code.code },
    expected: 'Code accepted → Chats (no add-a-password step); server: profile row + app_metadata.newone_password_set_at stamped at signup',
    screen: 'sign-in (One-time code)',
    serverTruth: async () => {
      const row = await server.profileByUsername(username);
      if (!row) return { ok: false, detail: 'no profile row for the new username' };
      account.userId = row.user_id;
      const password = await server.waitFor(() => passwordState(server, row.user_id), (state) => state.hasPassword, { timeoutMs: 20_000 });
      return { ok: row.display_name === displayName && password.ok, detail: { ...row, ...password.row } };
    },
  });
  if (!account.userId) {
    const row = await server.profileByUsername(username).catch(() => null);
    account.userId = row?.user_id ?? null;
  }
  account.signedIn = verify.uiOk;
  return account;
}

export async function run(ctx) {
  const [devA, devB] = ctx.devices;
  const { server } = ctx;
  const tag = Math.random().toString(36).slice(2, 6);
  const [A, B] = await Promise.all([
    signupWithPassword(ctx, devA, { label: 'v3_a', displayName: `Sim Vera ${tag}` }),
    ctx.signup(devB, { label: 'v3_b', displayName: `Sim Yuna ${tag}`, language: 'ko' }),
  ]);
  if (!A.signedIn || !B.signedIn) {
    ctx.note({ id: 'v3-blocked', title: 'v3 blocked: setup signup failed', status: 'FAIL', observed: `A=${A.signedIn} B=${B.signedIn}` });
    return;
  }

  // 1. Notification prompt: the card on the first signed-in launch, answered
  //    with "Not now", stays away after a relaunch. (No server row: the answer
  //    is a device preference.) The card renders only while the OS permission
  //    is undetermined/denied; a simulator that already granted it never shows
  //    it, which the FAIL screenshot would make obvious.
  const card = await ctx.step({ id: 'v3-01-notification-card', title: 'First signed-in launch shows the "Turn on notifications" card; "Not now" removes it', device: devA, flow: 'v3/notification-prompt.yaml', expected: 'Card with "Turn on" and "Not now" at the top of Chats; gone right after Not now', screen: 'chats' });
  if (card.uiOk && (card.entry?.screenshots ?? []).some((shot) => String(shot).includes('card-absent'))) {
    ctx.note({ id: 'v3-01-card-not-exercised', title: 'Notification card not exercised on this simulator', status: 'INFO', expected: 'Card with "Turn on" and "Not now" at first signed-in launch', observed: 'No card rendered: the simulator already answered the OS notification prompt in an earlier run, and the card only renders while that permission is undetermined. A fresh install re-arms it (the first pass showed the card). v3-01c still checks that no card appears after the relaunch.', screen: 'chats' });
  }
  await ctx.step({ id: 'v3-01b-relaunch', title: 'Force-quit and relaunch', device: devA, flow: 'common/relaunch.yaml', expected: 'Chats', screen: 'chats' });
  await ctx.step({ id: 'v3-01c-card-stays-gone', title: 'The answered card does not return after the relaunch', device: devA, flow: 'v3/notification-prompt-gone.yaml', expected: 'No "Turn on notifications" card, no "Not now"', screen: 'chats' });

  // 2. Password sign-in: sign out, then back in with the saved password. The
  //    sign-out revokes the current installation on the server, so a fresh,
  //    unrevoked private.session_installations row must appear.
  await ctx.step({ id: 'v3-02a-signout', title: 'A signs out (Settings → Sign out of Newone)', device: devA, flow: 'common/signout.yaml', expected: 'Sign-in screen with the Create account / Sign in chips', screen: 'settings → sign-in' });
  const sessionsBefore = new Set((await server.sessions(A.userId).catch(() => [])).map((row) => row.id));
  const signin = await ctx.step({
    id: 'v3-02-password-signin', title: 'A signs back in with the password ("Sign in" chip → email → Continue → password → Sign in)', device: devA,
    flow: 'v3/password-signin.yaml', env: { EMAIL: A.email, PASSWORD },
    expected: 'Chats (no code screen, no method chips); server: a new unrevoked private.session_installations row for A', screen: 'sign-in',
    serverTruth: async () => {
      const wait = await server.waitFor(() => server.sessions(A.userId), (rows) => rows.some((row) => !sessionsBefore.has(row.id) && !row.revoked_at), { timeoutMs: 30_000 });
      return { ok: wait.ok, detail: (wait.row ?? []).map((row) => ({ id: row.id, platform: row.platform, app_version: row.app_version, revoked_at: row.revoked_at, new: !sessionsBefore.has(row.id) })) };
    },
  });
  if (!signin.uiOk) {
    // Keep the rest of the area alive: take the forgot-password road (code →
    // new password) instead and say so. signout.yaml relaunches the app, which
    // puts the sign-in screen back on its first step wherever the failure left it.
    ctx.note({ id: 'v3-02b-forgot-fallback', title: 'Password sign-in failed; the remaining steps continue after a forgot-password recovery', status: 'INFO', observed: 'see v3-02-password-signin' });
    await ctx.step({ id: 'setup-v3_a-signin-screen', title: 'Setup: back to the sign-in screen', device: devA, flow: 'common/signout.yaml', expected: 'sign-in screen', screen: 'settings' });
    const request = await ctx.step({ id: 'setup-v3_a-returning-request', title: 'Setup: A enters the email; password step', device: devA, flow: 'common/returning-request.yaml', env: { EMAIL: A.email }, expected: 'password step', screen: 'sign-in' });
    if (!request.uiOk) return;
    const forgot = await ctx.step({ id: 'setup-v3_a-forgot-password', title: 'Setup: A asks for a recovery code', device: devA, flow: 'auth/forgot-password.yaml', expected: 'code screen', screen: 'sign-in' });
    if (!forgot.uiOk) return;
    const code = await ctx.waitForCode(A.mailbox);
    if (!code) return;
    const verified = await ctx.step({ id: 'setup-v3_a-forgot-verify', title: 'Setup: A enters the recovery code', device: devA, flow: 'auth/forgot-verify.yaml', env: { CODE: code.code }, expected: '"Set a new password"', screen: 'sign-in' });
    if (!verified.uiOk) return;
    const reset = await ctx.step({ id: 'setup-v3_a-new-password', title: 'Setup: A sets the password again and is signed in', device: devA, flow: 'auth/new-password.yaml', env: { PASSWORD }, expected: 'Chats', screen: 'sign-in' });
    if (!reset.uiOk) return;
  }

  // 3. Invite anyone: A messages B straight from the People search with no
  //    connection between them (contact_connections has no accepted row).
  await ctx.step({ id: 'v3-03a-search', title: 'A finds B by @username on the People tab (strangers, no connection)', device: devA, flow: 'people/search-user.yaml', env: { USERNAME: B.username, NAME: B.displayName, EXPECT_BUTTON: 'Message' }, expected: 'B row with a "Message" button (no Connect)', screen: 'people' });
  const hola = 'hola desde A';
  const opened = await ctx.step({
    id: 'v3-03-message-anyone', title: 'A taps Message with no prior connection: the chat opens; A sends "hola desde A"', device: devA,
    flow: 'people/message-from-result.yaml', env: { TEXT: hola },
    expected: 'Conversation opens at once; the text renders as sent; server: public.conversations direct row between A and B, no accepted contact_connections row', screen: 'people → conversation',
    serverTruth: async () => {
      const conversation = await server.waitFor(() => server.directConversation(A.userId, B.userId), (row) => Boolean(row), { timeoutMs: 20_000 });
      const message = conversation.row ? await server.waitFor(() => server.messageByBody(conversation.row.id, hola), (row) => Boolean(row), { timeoutMs: 20_000 }) : { ok: false };
      const connection = await server.connection(A.userId, B.userId);
      const noAcceptedConnection = !connection || connection.status !== 'accepted';
      return { ok: conversation.ok && message.ok && noAcceptedConnection, detail: { conversation: conversation.row?.id ?? null, message: message.row?.id ?? null, contact_connection: connection ?? 'none' } };
    },
  });
  if (!opened.uiOk) return;
  const conversation = await server.directConversation(A.userId, B.userId);
  const convId = conversation?.id ?? null;
  await ctx.step({ id: 'v3-03b-b-receives', title: 'B opens the chat from the Chats list and sees "hola desde A"', device: devB, flow: 'people/receive-text.yaml', env: { PEER: A.displayName, TEXT: hola }, expected: 'Row with A in Chats; the text visible within 45s; nothing to accept', screen: 'chats → conversation' });
  const openA = () => ctx.step({ id: `v3-open-a-${ctx.seq = (ctx.seq ?? 0) + 1}`, title: 'A (re)opens the conversation', device: devA, flow: 'common/open-conversation.yaml', env: { PEER: B.displayName }, expected: 'composer visible', screen: 'chats → conversation' });
  const openB = () => ctx.step({ id: `v3-open-b-${ctx.seq = (ctx.seq ?? 0) + 1}`, title: 'B (re)opens the conversation', device: devB, flow: 'common/open-conversation.yaml', env: { PEER: A.displayName }, expected: 'composer visible', screen: 'chats → conversation' });

  // 4. Enter key sends: the switch is on by default, so prove it does
  //    something by turning it off first (return key breaks the line, nothing
  //    sent), then back on (return key sends).
  await ctx.step({ id: 'v3-04a-enter-sends-off', title: 'Settings → "Enter key sends" switch off', device: devA, flow: 'v3/toggle-switch.yaml', env: { LABEL: 'Enter key sends', ID: 'setting-enter-sends' }, expected: 'Switch flips (default on → off); back to Chats', screen: 'settings → Chats group' });
  await openA();
  const newline = 'enter newline test';
  await ctx.step({
    id: 'v3-04b-return-breaks-line', title: 'With the switch off, the return key does not send: draft and send button stay', device: devA, flow: 'v3/enter-newline.yaml', env: { TEXT: newline },
    expected: '"Send message" still shown and the placeholder hidden after the return key; server: no message row', screen: 'conversation',
    serverTruth: async () => {
      await sleep(6_000);
      const row = convId ? await server.messageByBody(convId, newline) : null;
      return { ok: !row, detail: row ? `SENT DESPITE THE SWITCH BEING OFF: message ${row.id}` : 'no message row (correct)' };
    },
  });
  await ctx.step({ id: 'v3-04c-enter-sends-on', title: 'Settings → "Enter key sends" switch back on', device: devA, flow: 'v3/toggle-switch.yaml', env: { LABEL: 'Enter key sends', ID: 'setting-enter-sends' }, expected: 'Switch on again; back to Chats', screen: 'settings → Chats group' });
  await openA();
  const enterText = 'enter sends test';
  await ctx.step({
    id: 'v3-04-enter-sends', title: 'The keyboard return key sends "enter sends test" (no send-button tap)', device: devA, flow: 'v3/enter-sends.yaml', env: { TEXT: enterText },
    expected: 'Bubble appears, composer empties; server messages row', screen: 'conversation',
    serverTruth: async () => { const wait = await server.waitFor(() => server.messageByBody(convId, enterText), (row) => Boolean(row), { timeoutMs: 20_000 }); return { ok: wait.ok, detail: wait.row?.id ?? 'no row' }; },
  });

  // 5. Translated-only bubble on B (ko). "hola desde A" is too short for a
  //    dependable language detection, so A sends a full Spanish sentence whose
  //    Korean translation must contain 월요일 (Monday); the server row proves
  //    the ko translation completed before B looks.
  const spanish = `Nos vemos el lunes por la mañana en la cafetería ${tag}`;
  const spanishKey = 'por la mañana';
  const sentEs = Date.now();
  await ctx.step({
    id: 'v3-05a-a-sends-spanish', title: 'A sends a Spanish sentence (B reads Korean)', device: devA, flow: 'chat/send-text.yaml', env: { TEXT: spanish },
    expected: 'Bubble; server: message_translations row completed for target ko', screen: 'conversation',
    serverTruth: async () => {
      const wait = await server.waitFor(() => server.messageByBody(convId, spanishKey), (row) => (row?.translations ?? '').includes('ko=completed'), { timeoutMs: 150_000 });
      const row = wait.row;
      const latency = row?.translation_completed_at && row?.created_at ? Math.round((new Date(row.translation_completed_at) - new Date(row.created_at)) / 100) / 10 : null;
      return { ok: wait.ok, detail: { translations: row?.translations, detected: row?.detected_language, serverLatencySeconds: latency } };
    },
    timeoutMs: 240_000,
  });
  await ctx.step({ id: 'v3-05b-translated-only-on', title: 'B: Settings → "Show only translations" on', device: devB, flow: 'v3/toggle-switch.yaml', env: { LABEL: 'Show only translations', ID: 'setting-translated-only' }, expected: 'Switch on (hint "Tap a message to see the original"); back to Chats', screen: 'settings → Chats group' });
  await openB();
  await ctx.step({
    id: 'v3-05-translation-only-bubble', title: 'B sees only the Korean translation with an "Original" control; "Show original" reveals the Spanish', device: devB,
    flow: 'v3/translated-only-bubble.yaml', env: { HIT: '월요', TEXT_KEY: spanishKey, TIMEOUT: '90000' },
    expected: 'Korean text containing 월요일 visible, the Spanish hidden, a control named "Show original"; after the tap the Spanish appears under it and the control reads "Hide original"', screen: 'conversation',
    latencyFrom: sentEs, timeoutMs: 240_000,
  });
  await ctx.observe(devB, { id: 'v3-05c-render', title: 'Exact translated-only rendering on B after Show original', screen: 'conversation' });

  // 6. Full-screen image viewer on the sender's own photo.
  await openA();
  await ctx.step({
    id: 'v3-06a-photo', title: 'A sends a photo from the simulator photo library', device: devA, flow: 'media/photo-library.yaml',
    expected: 'Inline photo labelled "Open image full screen"; server message_attachments row scan_status clean', screen: 'conversation → Add attachment',
    serverTruth: async () => { const wait = await server.waitFor(() => server.attachments(convId), (rows) => rows.some((row) => row.mime_type?.startsWith('image/') && row.scan_status === 'clean'), { timeoutMs: 120_000 }); return { ok: wait.ok, detail: wait.row ?? 'no clean image attachment' }; },
    timeoutMs: 420_000,
  });
  await ctx.step({ id: 'v3-06-image-viewer', title: 'Tap the photo ("Open image full screen"): the viewer opens ("Close image") and closes', device: devA, flow: 'media/open-image-viewer.yaml', expected: '"Close image" visible, then the composer again', screen: 'conversation → viewer', timeoutMs: 240_000 });

  // 7. Summary sheet (v3.1): pick a range and a subject, summarize, copy, and
  //    make sure no source ids or participant labels leak.
  await openA();
  await ctx.step({
    id: 'v3-07-summary-copy', title: 'Header "Summarize" → "Summary" sheet → range "Everything" + subject → "Summarize conversation" → prose + scope line → Copy → "Copied"; no "s1234"-style source ids', device: devA,
    flow: 'v3/summary-share.yaml', env: { SUBJECT: 'the plan' },
    expected: 'Sheet first says "Nothing summarized yet." with the range chips (Today … Everything) and the "What should this cover?" field; after the request the prose appears under "Everything · N messages · about the plan" with Copy and Share enabled; Copy shows "Copied"; no text matching s[0-9]{4}; server conversation_summaries row draft with scope_kind everything and scope_subject "the plan", without such tokens', screen: 'conversation → Summary sheet',
    serverTruth: async () => {
      const rows = await server.sql(`select id, status, request_mode, failure_code, primary_topic, summary_body, scope_kind, scope_subject,
          cardinality(source_message_ids) as source_count, processor_provenance->>'slices' as slices, created_at
        from public.conversation_summaries where conversation_id = ${server.lit(convId)} order by created_at desc`);
      const ready = rows.find((row) => ['draft', 'approved'].includes(row.status) || row.primary_topic);
      const leaked = ready ? /\bs[0-9]{4}\b|participant [0-9]/i.test(`${ready.primary_topic ?? ''} ${ready.summary_body ?? ''}`) : false;
      const scoped = ready?.scope_kind === 'everything' && ready?.scope_subject === 'the plan';
      return { ok: Boolean(ready) && !leaked && scoped, detail: { rows: rows.length, status: ready?.status ?? rows[0]?.status ?? 'none', failure_code: rows[0]?.failure_code ?? null, topic: ready?.primary_topic ?? null, scope_kind: ready?.scope_kind ?? null, scope_subject: ready?.scope_subject ?? null, source_count: ready?.source_count ?? null, slices: ready?.slices ?? null, leaked, body: (ready?.summary_body ?? '').slice(0, 200) } };
    },
    timeoutMs: 400_000,
  });
  await ctx.observe(devA, { id: 'v3-07b-after-summary', title: 'Conversation after the Summary sheet closes', screen: 'conversation' });

  // 8. Composer bottom inset: iOS is INFO-only here; the screenshots of the
  //    enter-key steps show the composer with the keyboard up.
  ctx.note({
    id: 'v3-08-composer-inset-ios', title: 'Composer bottom inset (iOS): information only', status: 'INFO',
    expected: 'The composer rides above the keyboard and the home indicator; never hidden behind either',
    observed: 'iOS uses KeyboardAvoidingScreen; the v3-04b-return-breaks-line and v3-04-enter-sends screenshots (composer with the keyboard up) are the visual evidence. The Android inset check is separate: tests/device/android/composer-check.sh.',
  });
  // 9. Notifications switch = server-side mute (backlog 13). Off writes
  //    device_registrations.notifications_muted = true for this registration
  //    (the outbox worker then settles its deliveries as skipped); on writes
  //    false. Only a bound device has a registration row: a simulator never
  //    obtains a push token (Device.isDevice is false), so the switch cannot
  //    be turned on there and the server write is proven by
  //    tests/hosted/mute-smoke.mjs instead. On a phone the switch starts on.
  const registration = (await server.devices(A.userId).catch(() => [])).find((row) => !row.revoked_at);
  if (!registration) {
    ctx.note({
      id: 'v3-09-mute-not-exercised', title: 'Notifications switch (server-side mute) not exercised on this simulator', status: 'INFO',
      expected: 'Settings → "Notifications" switch off shows the "Muted" hint and writes device_registrations.notifications_muted = true; on clears the hint and writes false',
      observed: `No device registration for A (${A.username}): a simulator cannot obtain a push token, so the switch stays off and there is no row to mute. The server write and the worker skip are covered by tests/hosted/mute-smoke.mjs; run this area on a physical device to exercise the switch itself.`,
      screen: 'settings → Notifications group',
    });
  } else {
    const muteRow = () => server.one(`select notifications_muted, updated_at from public.device_registrations
      where user_id = ${server.lit(A.userId)}::uuid and revoked_at is null order by updated_at desc limit 1`);
    await ctx.step({
      id: 'v3-09a-mute', title: 'Settings → "Notifications" switch off (mutes this device on the server)', device: devA,
      flow: 'v3/toggle-switch.yaml', env: { LABEL: 'Notifications', ID: 'setting-allow-notifications' },
      expected: 'Switch off with the "Muted" hint; back to Chats; server: device_registrations.notifications_muted = true', screen: 'settings → Notifications group',
      serverTruth: async () => { const wait = await server.waitFor(muteRow, (row) => row?.notifications_muted === true, { timeoutMs: 30_000 }); return { ok: wait.ok, detail: wait.row ?? 'no registration row' }; },
    });
    await ctx.step({
      id: 'v3-09b-unmute', title: 'Settings → "Notifications" switch back on (unmutes)', device: devA,
      flow: 'v3/toggle-switch.yaml', env: { LABEL: 'Notifications', ID: 'setting-allow-notifications' },
      expected: 'Switch on, no "Muted" hint; back to Chats; server: notifications_muted = false', screen: 'settings → Notifications group',
      serverTruth: async () => { const wait = await server.waitFor(muteRow, (row) => row?.notifications_muted === false, { timeoutMs: 30_000 }); return { ok: wait.ok, detail: wait.row ?? 'no registration row' }; },
    });
  }
  ctx.accounts = { A, B };
}
