// CHAT + MEDIA on two devices (A ↔ B). A messages B straight from a People
// search (consumers have no message requests since the Sep 2026 social
// stream), B opens the chat from Chats; then every message action is
// performed for real on one device and observed on the other, with the
// database row consulted after each durable effect.
import { openUrl, backgroundApp, launchApp } from '../lib/devices.mjs';

export const meta = { id: 'chat', devices: 2, title: 'CHAT + MEDIA (A/B)' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(ctx) {
  const [devA, devB] = ctx.devices;
  const { server } = ctx;
  const tag = Math.random().toString(36).slice(2, 6);
  const [A, B] = await Promise.all([
    ctx.signup(devA, { label: 'chat_a', displayName: `Sim Ana ${tag}` }),
    ctx.signup(devB, { label: 'chat_b', displayName: `Sim Ben ${tag}` }),
  ]);
  if (!A.signedIn || !B.signedIn) {
    ctx.note({ id: 'chat-blocked', title: 'CHAT blocked: setup signup failed', status: 'FAIL', observed: `A=${A.signedIn} B=${B.signedIn}` });
    return;
  }

  // Relationship: A messages B directly from the People search (the message
  // request / accept path is gone; the step ids keep their history).
  const intro = `Hey Ben, Ana here ${tag}`;
  await ctx.step({ id: 'chat-00a-search', title: 'Setup: A finds B', device: devA, flow: 'people/search-user.yaml', env: { USERNAME: B.username, NAME: B.displayName, EXPECT_BUTTON: 'Message' }, expected: 'B row with a Message button', screen: 'people' });
  const request = await ctx.step({
    id: 'chat-00b-message-request', title: 'A taps Message and sends the first text (the chat opens directly, no request)', device: devA,
    flow: 'people/message-from-result.yaml', env: { TEXT: intro }, expected: 'Conversation opens at once; first text renders as sent; server: direct conversation row', screen: 'people → conversation',
    serverTruth: async () => {
      const wait = await server.waitFor(() => server.directConversation(A.userId, B.userId), (row) => Boolean(row), { timeoutMs: 20_000 });
      return { ok: wait.ok, detail: wait.row };
    },
  });
  if (!request.uiOk) return;
  const conversation = await server.directConversation(A.userId, B.userId);
  const convId = conversation.id;
  const accept = await ctx.step({
    id: 'chat-00c-accept', title: 'B sees the first text in Chats → conversation (nothing to accept)', device: devB,
    flow: 'people/receive-text.yaml', env: { PEER: A.displayName, TEXT: intro }, expected: 'Text visible on B; composer present, no Accept/Decline banner; server message row', screen: 'chats → conversation',
    serverTruth: async () => {
      const wait = await server.waitFor(() => server.messageByBody(convId, intro), (row) => Boolean(row), { timeoutMs: 20_000 });
      return { ok: wait.ok, detail: wait.row?.id ?? 'no row' };
    },
  });
  if (!accept.uiOk) return;
  const openA = () => ctx.step({ id: `chat-open-a-${ctx.seq = (ctx.seq ?? 0) + 1}`, title: 'A (re)opens the conversation', device: devA, flow: 'common/open-conversation.yaml', env: { PEER: B.displayName }, expected: 'composer visible', screen: 'chats' });
  const openB = () => ctx.step({ id: `chat-open-b-${ctx.seq = (ctx.seq ?? 0) + 1}`, title: 'B (re)opens the conversation', device: devB, flow: 'common/open-conversation.yaml', env: { PEER: A.displayName }, expected: 'composer visible', screen: 'chats' });
  await openA();

  const t1 = `First text ${tag} zebra${tag}`;
  await ctx.step({
    id: 'chat-01-send-text', title: 'A sends a text', device: devA, flow: 'chat/send-text.yaml', env: { TEXT: t1 },
    expected: 'Bubble renders; server messages row', screen: 'conversation',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, t1), (r) => Boolean(r), { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row?.id ?? 'no row' }; },
  });
  const t1Sent = Date.now();
  await ctx.step({ id: 'chat-02-b-receives', title: 'B receives the text within 20s', device: devB, flow: 'chat/see-text.yaml', env: { TEXT: t1, TIMEOUT: '20000' }, expected: 'Text visible on B within 20s of send', screen: 'conversation', latencyFrom: t1Sent });

  const r1 = `Reply from Ben ${tag}`;
  await ctx.step({
    id: 'chat-03-reply', title: 'B replies (quoted preview)', device: devB, flow: 'chat/reply.yaml', env: { TARGET: t1, REPLY: r1 },
    expected: '"Replying to" preview then reply bubble; server reply_to_message_id set', screen: 'conversation → Message actions',
    serverTruth: async () => {
      const original = await server.messageByBody(convId, t1);
      const w = await server.waitFor(() => server.messageByBody(convId, r1), (r) => Boolean(r), { timeoutMs: 20_000 });
      return { ok: w.ok && w.row?.reply_to === original?.id, detail: { reply: w.row?.id, reply_to: w.row?.reply_to, original: original?.id } };
    },
  });
  await ctx.step({ id: 'chat-04-a-sees-reply', title: 'A sees the reply with the quoted original', device: devA, flow: 'chat/see-text.yaml', env: { TEXT: r1, TIMEOUT: '30000' }, expected: 'Reply bubble with quote', screen: 'conversation' });
  await ctx.observe(devA, { id: 'chat-04b-reply-render', title: 'Reply bubble render on A (quote should name B and preview the original)', screen: 'conversation' });

  await ctx.step({
    id: 'chat-05-react', title: 'A reacts 👍 to the reply', device: devA, flow: 'chat/react.yaml', env: { TARGET: r1 },
    expected: '👍 chip under the message; server message_reactions row', screen: 'conversation → Message actions',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, r1), (r) => (r?.reaction_detail ?? '').includes('👍'), { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row?.reaction_detail ?? 'no reaction' }; },
  });
  await ctx.step({ id: 'chat-06-b-sees-reaction', title: 'B sees the 👍 chip', device: devB, flow: 'chat/see-reaction.yaml', expected: '👍 visible on B within 45s', screen: 'conversation' });

  const t1e = `First text edited ${tag} zebra${tag}`;
  await ctx.step({
    id: 'chat-07-edit', title: 'A edits the first text', device: devA, flow: 'chat/edit.yaml', env: { TARGET: t1, EDITED: t1e },
    expected: 'New text with "edited" label; server body + edited_at', screen: 'conversation → Message actions',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, `edited ${tag}`), (r) => Boolean(r?.edited_at), { timeoutMs: 20_000 }); return { ok: w.ok, detail: { body: w.row?.body, edited_at: w.row?.edited_at } }; },
  });
  await ctx.step({ id: 'chat-08-b-sees-edit', title: 'B sees the edited text and label', device: devB, flow: 'chat/see-text.yaml', env: { TEXT: t1e, TIMEOUT: '30000' }, expected: 'Edited text visible on B', screen: 'conversation' });
  await ctx.step({ id: 'chat-09-receipt-state', title: 'Sender bubble shows a receipt state (Sent/delivered/Read)', device: devA, flow: 'chat/receipt-state.yaml', expected: 'Receipt text present; server message_receipts row for B', screen: 'conversation',
    serverTruth: async () => { const row = await server.messageByBody(convId, `edited ${tag}`); return { ok: Boolean(row?.receipts), detail: row?.receipts ?? 'no receipt rows' }; } });

  await ctx.step({
    id: 'chat-10-pin', title: 'A pins the reply', device: devA, flow: 'chat/pin.yaml', env: { TARGET: r1 },
    expected: 'Sheet offers Unpin afterwards; server message_pins row', screen: 'conversation → Message actions',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, r1), (r) => r?.pinned === true, { timeoutMs: 20_000 }); return { ok: w.ok, detail: `pinned=${w.row?.pinned}` }; },
  });
  await ctx.note({ id: 'chat-10b-pinned-view', title: 'Pinned-messages view', status: 'UNREACHABLE', observed: 'No pinned-messages surface exists in the consumer UI: the only pin affordance is Pin/Unpin in the Message actions sheet (conversation-pane.tsx:2610); no banner or list renders message.pinned.', expected: 'A place to see pinned messages' });
  await ctx.step({
    id: 'chat-11-unpin', title: 'A unpins the reply', device: devA, flow: 'chat/unpin.yaml', env: { TARGET: r1 },
    expected: 'Pin offered again; server row removed', screen: 'conversation → Message actions',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, r1), (r) => r?.pinned === false, { timeoutMs: 20_000 }); return { ok: w.ok, detail: `pinned=${w.row?.pinned}` }; },
  });

  await ctx.step({
    id: 'chat-12-delete-for-me', title: 'A deletes the reply for me', device: devA, flow: 'chat/delete-for-me.yaml', env: { TARGET: r1 },
    expected: 'Reply disappears on A only; server message_user_visibility row for A', screen: 'conversation → Message actions',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, r1), (r) => (r?.hidden_for ?? '').includes(A.userId), { timeoutMs: 20_000 }); return { ok: w.ok && !w.row?.deleted_at, detail: { hidden_for: w.row?.hidden_for, deleted_at: w.row?.deleted_at } }; },
  });
  await ctx.step({ id: 'chat-13-b-still-sees', title: 'B still sees the reply after A\'s delete-for-me', device: devB, flow: 'chat/expect-still-visible.yaml', env: { TEXT: r1 }, expected: 'Reply still visible on B', screen: 'conversation' });

  const t2 = `Delete me everywhere ${tag}`;
  await ctx.step({ id: 'chat-14a-send-t2', title: 'A sends a second text', device: devA, flow: 'chat/send-text.yaml', env: { TEXT: t2 }, expected: 'bubble', screen: 'conversation' });
  await ctx.step({ id: 'chat-14b-b-sees-t2', title: 'B sees the second text', device: devB, flow: 'chat/see-text.yaml', env: { TEXT: t2, TIMEOUT: '30000' }, expected: 'visible', screen: 'conversation' });
  const t2Id = (await server.waitFor(() => server.messageByBody(convId, t2), (r) => Boolean(r), { timeoutMs: 20_000 })).row?.id ?? null;
  await ctx.step({
    id: 'chat-14-delete-for-everyone', title: 'A deletes the second text for everyone', device: devA, flow: 'chat/delete-for-everyone.yaml', env: { TARGET: t2 },
    expected: 'Gone on A; server deleted_at set', screen: 'conversation → Message actions',
    serverTruth: async () => {
      // Delete-for-everyone keeps the row but scrubs the body, so look it up by the id captured before the delete.
      if (!t2Id) return { ok: false, detail: 'second text never reached the server' };
      const w = await server.waitFor(() => server.messageById(t2Id), (r) => Boolean(r?.deleted_at), { timeoutMs: 20_000 });
      return { ok: w.ok && w.row?.body === null, detail: { id: t2Id, deleted_at: w.row?.deleted_at, body_scrubbed: w.row?.body === null } };
    },
  });
  await ctx.step({ id: 'chat-15-b-sees-deleted', title: 'Deleted-for-everyone text disappears on B', device: devB, flow: 'chat/expect-gone.yaml', env: { TEXT: t2, TIMEOUT: '45000' }, expected: 'Text gone on B within 45s', screen: 'conversation' });
  // Propagation latency evidence: if the open thread still shows the text after
  // 45s, keep waiting so the report says "slow" or "never" rather than guessing.
  const deletedAt = Date.now();
  await ctx.step({ id: 'chat-15b-b-sees-deleted-late', title: 'Deleted-for-everyone text gone on B within a further 120s (latency evidence)', device: devB, flow: 'chat/expect-gone.yaml', env: { TEXT: t2, TIMEOUT: '120000' }, expected: 'Gone by 165s at the latest', screen: 'conversation', optional: true, latencyFrom: deletedAt });

  // Typing indicator: B types, A watches.
  // Typing hints expire 6 s after the last broadcast, so A must watch while B
  // types: the two steps run concurrently and B keeps typing in bursts.
  await Promise.all([
    ctx.step({ id: 'chat-16a-b-types', title: 'B starts typing', device: devB, flow: 'chat/start-typing.yaml', expected: 'draft in composer', screen: 'conversation' }),
    ctx.step({ id: 'chat-16-typing-indicator', title: 'A sees "… is typing" while B types', device: devA, flow: 'chat/see-typing.yaml', expected: '".*typing.*" banner on A within 30s', screen: 'conversation' }),
  ]);
  await ctx.step({ id: 'chat-16b-b-clears', title: 'B clears the draft', device: devB, flow: 'chat/clear-composer.yaml', expected: 'composer empty', screen: 'conversation' });

  // Forward: A needs a second conversation → a small group with B.
  const groupName = `Fwd ${tag}`;
  const group = await ctx.step({
    id: 'chat-17a-create-group', title: 'A creates a group with B (forward target)', device: devA, flow: 'groups/create-group.yaml', env: { NAME: groupName, MEMBER1: B.displayName, MEMBER1_QUERY: B.username, HAS_MEMBER2: 'false', MEMBER2: '', MEMBER2_QUERY: '' },
    expected: 'Group opens; server conversations row + 2 members', screen: 'new-group',
    serverTruth: async () => { const w = await server.waitFor(() => server.groupByName(groupName), (r) => Boolean(r), { timeoutMs: 20_000 }); const m = w.row ? await server.members(w.row.id) : []; return { ok: w.ok && m.length === 2, detail: { group: w.row?.id, members: m } }; },
  });
  const groupRow = await server.groupByName(groupName);
  if (group.uiOk) {
    await openA();
    await ctx.step({
      id: 'chat-17-forward', title: 'A forwards the edited text to the group ("Forward to a chat")', device: devA, flow: 'chat/forward.yaml', env: { TARGET: t1e, DEST: groupName },
      expected: 'Sheet closes; server message_forward_provenance row in the group', screen: 'conversation → Message actions',
      // Defect K (Sep 4 2026): the forwarded copy must also get language
      // detection like a typed message; the row's detection state proves it.
      serverTruth: async () => { const w = groupRow ? await server.waitFor(() => server.messageByBody(groupRow.id, `edited ${tag}`), (r) => r?.forwarded === true && r?.language_detection_state === 'completed', { timeoutMs: 90_000 }) : { ok: false }; return { ok: w.ok, detail: w.row ? { id: w.row.id, forwarded: w.row.forwarded, detection: w.row.language_detection_state } : 'no forwarded row' }; },
    });
    await ctx.step({ id: 'chat-18-see-forwarded', title: 'Forwarded copy shows the FORWARDED label in the group', device: devA, flow: 'chat/see-forwarded.yaml', env: { DEST: groupName, TEXT: t1e }, expected: 'FORWARDED label + text', screen: 'group conversation' });
  }

  const query = `zebra${tag}`;
  await ctx.step({ id: 'chat-19-search', title: 'Message search finds the text (results as you type; no Search button or filter chips for consumers)', device: devA, flow: 'chat/search-messages.yaml', env: { QUERY: query }, expected: 'A Messages result ("Open …") containing the token', screen: 'search' });
  // The Messages filter chip is workplace-only; the step id keeps its history
  // and now proves the result opens the conversation.
  await ctx.step({ id: 'chat-20-search-filter', title: 'Open the Messages result from Search', device: devA, flow: 'chat/search-filter-messages.yaml', env: { QUERY: query }, expected: 'Tapping "Open …" opens the conversation with the text', screen: 'search' });

  // Unread badge: A on the Chats list, B sends.
  await ctx.step({ id: 'chat-21a-a-back', title: 'A returns to the Chats list', device: devA, flow: 'chat/back-to-chats.yaml', expected: 'Chats', screen: 'chats' });
  const t3 = `Unread probe ${tag}`;
  await ctx.step({ id: 'chat-21b-b-sends', title: 'B sends while A is on the list', device: devB, flow: 'chat/send-text.yaml', env: { TEXT: t3 }, expected: 'bubble', screen: 'conversation' });
  await ctx.step({ id: 'chat-21-unread-badge', title: 'Unread count/badge appears, Unread filter lists the chat, clears after reading', device: devA, flow: 'chat/unread-badge.yaml', env: { PEER: B.displayName, TEXT: t3 }, expected: '"N unread" header badge; Unread filter shows the chat; badge gone after opening', screen: 'chats' });

  await openA();
  await ctx.step({
    id: 'chat-22-translation-toggle', title: 'Conversation translation Off → Automatic', device: devA, flow: 'chat/translation-off-on.yaml',
    expected: 'Hints change; server conversation_preferences.translation_mode off then automatic', screen: 'conversation → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.preferences(convId, A.userId), (r) => r?.translation_mode === 'automatic', { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row }; },
  });
  await ctx.step({
    id: 'chat-23-notification-level', title: 'Notification level: muted → 1 hour timed mute → remove → all activity', device: devA, flow: 'chat/notification-level.yaml',
    expected: 'Timed mute status appears and clears; server notification_level all, muted_until null', screen: 'conversation → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.preferences(convId, A.userId), (r) => r && r.notification_level === 'all' && !r.muted_until, { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row }; },
  });
  await ctx.step({
    id: 'chat-24-favorite', title: 'Add favorite → Favorites filter → Remove favorite', device: devA, flow: 'chat/favorite.yaml', env: { PEER: B.displayName },
    expected: 'Label flips; Favorites filter lists the chat; server is_favorite toggles', screen: 'conversation → Conversation controls',
    serverTruth: async () => { const row = await server.preferences(convId, A.userId); return { ok: true, detail: row }; },
  });

  // chat-25-report-message / chat-25b-after-report: removed — "Report
  // privately" left the Message actions sheet with the Sep 2026 chat stream
  // (the feature is gone by design; blocking from People remains, people-13).

  // MEDIA
  await openA();
  await openB();
  await ctx.step({
    id: 'media-01-photo', title: 'A sends a photo from the simulator photo library', device: devA, flow: 'media/photo-library.yaml',
    expected: 'The photo renders inline (dimmed under a progress ring, then labelled "Open image full screen"; no file card); server message_attachments row scan_status clean', screen: 'conversation → Add attachment',
    serverTruth: async () => { const w = await server.waitFor(() => server.attachments(convId), (rows) => rows.some((r) => r.mime_type?.startsWith('image/') && r.scan_status === 'clean'), { timeoutMs: 90_000 }); return { ok: w.ok, detail: w.row }; },
    timeoutMs: 420_000,
  });
  await ctx.step({ id: 'media-02-b-opens-photo', title: 'B sees the photo and opens it full screen', device: devB, flow: 'media/see-attachment.yaml', expected: 'Image labelled "Open image full screen" on B; tap opens the viewer ("Close image"), then back to the conversation', screen: 'conversation', timeoutMs: 420_000 });
  await openB();
  await ctx.step({
    id: 'media-03-voice-note', title: 'A records and sends a 2s voice note', device: devA, flow: 'media/voice-note.yaml',
    expected: '"Voice message" bubble with Play; server audio attachment clean', screen: 'conversation → mic',
    serverTruth: async () => { const w = await server.waitFor(() => server.attachments(convId), (rows) => rows.some((r) => r.mime_type?.startsWith('audio/') && r.scan_status === 'clean'), { timeoutMs: 90_000 }); return { ok: w.ok, detail: w.row?.filter?.((r) => r.mime_type?.startsWith('audio/')) ?? w.row }; },
    timeoutMs: 420_000,
  });
  await ctx.step({ id: 'media-04-b-plays-voice', title: 'B sees the voice note and plays it', device: devB, flow: 'media/see-voice-note.yaml', expected: 'Play → Pause state', screen: 'conversation', timeoutMs: 420_000 });
  const doc = await ctx.step({ id: 'media-05-document', title: 'A sends a document from the Files picker', device: devA, flow: 'media/choose-file.yaml', expected: 'A document is selectable and uploads clean (simulator may offer none)', screen: 'conversation → Choose file', optional: true, timeoutMs: 300_000 });
  if (!doc.uiOk) await ctx.step({ id: 'media-05b-cancel-picker', title: 'Dismiss the document picker', device: devA, flow: 'media/cancel-picker.yaml', expected: 'composer visible', screen: 'conversation' });

  // Summary sheet (header "Summarize"; replaced the in-list briefing card).
  await openA();
  await ctx.step({
    id: 'chat-26-briefing', title: 'Summary sheet: summarize the conversation, copy the text', device: devA, flow: 'chat/briefing.yaml',
    expected: 'The header "Summarize" button opens the "Summary" sheet; after "Summarize conversation" the prose appears, the sheet says "No new messages since the last summary.", and Copy shows "Copied"; anything else (failure text) is recorded verbatim', screen: 'conversation → Summary sheet',
    serverTruth: async () => { const rows = await server.summaries(convId); return { ok: rows.some((r) => r.status === 'ready_for_review' || r.status === 'ready' || r.primary_topic), detail: rows }; },
    timeoutMs: 400_000,
  });
  await ctx.observe(devA, { id: 'chat-26b-briefing-final', title: 'Conversation after the Summary sheet closes', screen: 'conversation' });

  // Resilience: send + kill; background 60s.
  await openA();
  const t4 = `Kill mid send ${tag}`;
  await ctx.step({
    id: 'chat-27-send-and-kill', title: 'Send then force-quit immediately; relaunch recovers the message', device: devA, flow: 'chat/send-and-kill.yaml', env: { TEXT: t4, PEER: B.displayName },
    expected: 'Message present after relaunch and not marked Not sent/Queued; server row exists', screen: 'conversation',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, t4), (r) => Boolean(r), { timeoutMs: 60_000 }); return { ok: w.ok, detail: w.row?.id ?? 'no row' }; },
  });
  await ctx.step({ id: 'chat-28-outbox-section', title: 'Settings shows the message outbox section', device: devA, flow: 'chat/outbox-section.yaml', expected: 'An outbox/queued section is visible in Settings', screen: 'settings', optional: true });
  await openA();
  backgroundApp(devA);
  ctx.log('A backgrounded (Settings app in front) for 60s');
  const t5 = `While you were away ${tag}`;
  await ctx.step({ id: 'chat-29a-b-sends', title: 'B sends while A is backgrounded', device: devB, flow: 'chat/send-text.yaml', env: { TEXT: t5 }, expected: 'bubble', screen: 'conversation' });
  await sleep(60_000);
  launchApp(devA);
  const fg = Date.now();
  const fgSeen = await ctx.step({ id: 'chat-29-foreground-realtime', title: 'After 60s in background, A shows the message on return', device: devA, flow: 'chat/foreground-see.yaml', env: { TEXT: t5, TIMEOUT: '30000' }, expected: 'Text visible within 30s of foregrounding', screen: 'conversation', latencyFrom: fg });
  if (!fgSeen.uiOk) {
    // Run 2026-09-04T04-57-19: the thread showed its top after foregrounding,
    // so the message may have arrived below the fold. Separate that case.
    await ctx.step({ id: 'chat-29b-foreground-scroll', title: 'The message is in the thread after scrolling (arrived but the list sat at the top)', device: devA, flow: 'chat/foreground-see-scroll.yaml', env: { TEXT: t5, TIMEOUT: '30000' }, expected: 'Text found after scrolling down', screen: 'conversation', latencyFrom: fg,
      serverTruth: async () => { const row = await server.messageByBody(convId, t5); return { ok: Boolean(row), detail: row ? `server row ${row.id}` : 'no server row' }; } });
  }

  await ctx.step({ id: 'chat-30-language-mid-session', title: 'Switch display language mid-session; originals unchanged', device: devA, flow: 'chat/language-mid-session.yaml', env: { PEER: B.displayName, TEXT: t5 }, expected: 'Spanish chrome in the conversation ("Escribe un mensaje…", "Volver a chats"), message text unchanged, English restored', screen: 'settings / conversation' });

  // Deep link.
  await ctx.step({ id: 'chat-31a-a-back', title: 'A returns to Chats', device: devA, flow: 'chat/back-to-chats.yaml', expected: 'Chats', screen: 'chats' });
  try {
    openUrl(devA, `newone://conversation/${convId}`);
    await ctx.step({ id: 'chat-31-deep-link', title: 'Deep link newone://conversation/<id> opens the conversation', device: devA, flow: 'chat/deep-link-opened.yaml', env: { PEER: B.displayName }, expected: 'Conversation with B open', screen: 'deep link' });
  } catch (error) {
    ctx.note({ id: 'chat-31-deep-link', title: 'Deep link', status: 'FAIL', observed: String(error.message) });
  }
  ctx.note({ id: 'chat-32-push-tap', title: 'Notification tap routing', status: 'UNREACHABLE', observed: 'iOS simulators cannot receive APNs/Expo push; injecting a synthetic simctl payload would be a mock, so this is not exercised. Push registration itself is covered by profile-04.', expected: 'Tapping a real push opens the conversation' });

  // Group housekeeping: rename + archive the forward-target group.
  if (groupRow) {
    await ctx.step({ id: 'chat-33a-open-group', title: 'A opens the group', device: devA, flow: 'common/open-conversation.yaml', env: { PEER: groupName }, expected: 'composer', screen: 'chats' });
    const renamed = `${groupName} renamed`;
    await ctx.step({
      id: 'chat-33-rename-group', title: 'Rename group + description (Save conversation)', device: devA, flow: 'chat/rename-group.yaml', env: { NAME: renamed, DESCRIPTION: `desc ${tag}` },
      expected: 'Header shows the new name; server conversations.name updated', screen: 'conversation → Conversation controls',
      serverTruth: async () => { const w = await server.waitFor(() => server.conversationRow(groupRow.id), (r) => r?.name === renamed, { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row }; },
    });
    await ctx.step({
      id: 'chat-34-archive', title: 'Archive the group conversation', device: devA, flow: 'chat/archive.yaml',
      expected: 'Sheet closes; server is_archived true', screen: 'conversation → Conversation controls',
      serverTruth: async () => { const w = await server.waitFor(() => server.conversationRow(groupRow.id), (r) => r?.is_archived === true, { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row }; },
    });
    await ctx.observe(devA, { id: 'chat-34b-after-archive', title: 'Where the user lands after archiving', screen: 'conversation/chats' });
  }
  // Owner ask: the phone's Chats list must match the server's conversations
  // and groups for that user (no desync). The server names every active
  // conversation and its newest text; the device must show each one.
  const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [who, account, device] of [['a', A, devA], ['b', B, devB]]) {
    const rows = (await server.conversationSummaries(account.userId)).filter((row) => !row.is_archived).slice(0, 3);
    const env = { HAS_2: 'false', HAS_3: 'false' };
    rows.forEach((row, index) => {
      env[`NAME_${index + 1}`] = escapeRegex(row.kind === 'group' ? row.name : row.peer);
      env[`PREVIEW_${index + 1}`] = escapeRegex(String(row.last_body ?? '').slice(0, 24));
      if (index > 0) env[`HAS_${index + 1}`] = 'true';
    });
    if (rows.length === 0) continue;
    await ctx.step({
      id: `chat-35-list-matches-server-${who}`, title: `${who.toUpperCase()}'s Chats list shows every server conversation with its newest text`, device,
      flow: 'chat/list-matches-server.yaml', env, expected: `${rows.length} server conversation(s) visible with previews`, screen: 'chats',
      serverTruth: async () => ({ ok: true, detail: rows.map((row) => `${row.kind}:${row.kind === 'group' ? row.name : row.peer}`).join(', ') }),
    });
  }
  // v3.1 (backlog 6): the status pill floats over the list instead of pushing it
  // down, so a tap right after launch, while the pill may still be showing, lands
  // on the intended row (a shifting list once hit the row below, run-2026-09-04T20-41-40).
  await ctx.step({
    id: 'chat-36-open-row-at-launch', title: 'Right after launch (status pill may be showing) a tap on B\'s row opens B\'s conversation, not a neighbour', device: devA,
    flow: 'chat/open-row-at-launch.yaml', env: { PEER: B.displayName },
    expected: 'Conversation with B open at once (header names B, composer visible); no other conversation opens', screen: 'chats → conversation',
  });
  ctx.accounts = { A, B };
}
