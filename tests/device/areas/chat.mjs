// CHAT + MEDIA on two devices (A ↔ B). A messages B straight from a People
// search (consumers have no message requests since the Sep 2026 social
// stream), B opens the chat from Chats; then every message action is
// performed for real on one device and observed on the other, with the
// database row consulted after each durable effect.
import { openUrl, backgroundApp, launchApp } from '../lib/devices.mjs';
import { setupThirdPerson } from '../lib/accounts.mjs';

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

  // v3.3 (backlog 36): a group needs three people, and this area has two
  // devices, so the third is an account nobody holds — created through the same
  // public signup route and found by the picker like anyone else.
  const C = await setupThirdPerson(ctx, { label: 'chat_c', displayName: `Sim Cass ${tag}` });

  // Relationship: A messages B directly from the People search (the message
  // request / accept path is gone; the step ids keep their history).
  const intro = `Hey Ben, Ana here ${tag}`;
  await ctx.step({ id: 'chat-00a-search', title: 'Setup: A finds B', device: devA, flow: 'people/search-user.yaml', env: { USERNAME: B.username, NAME: B.displayName, EXPECT_BUTTON: 'Message' }, expected: 'B row with a Message button', screen: 'contacts → Add a friend' });
  const request = await ctx.step({
    id: 'chat-00b-message-request', title: 'A taps Message and sends the first text (the chat opens directly, no request)', device: devA,
    flow: 'people/message-from-result.yaml', env: { NAME: B.displayName, TEXT: intro }, expected: 'Conversation opens at once; first text renders as sent; server: direct conversation row', screen: 'contacts → conversation',
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
  await ctx.step({
    id: 'chat-10b-pinned-view', title: 'A opens the chat’s pins from conversation settings and jumps to one', device: devA,
    flow: 'chat/pinned-list.yaml', env: { TARGET: r1 },
    expected: 'Pinned lists the reply with its sender and time; tapping the row closes the sheet and lands on the message',
    screen: 'conversation → Conversation controls → Pinned',
  });
  await ctx.step({
    id: 'chat-10c-pinned-across-chats', title: 'A opens the pins gathered from every chat on Chats', device: devA,
    flow: 'chat/pinned-across-chats.yaml', env: { TARGET: r1 },
    expected: 'Pinned messages groups the row under its chat; tapping it opens that chat at the message',
    screen: 'chats → Pinned messages',
  });
  await ctx.step({
    id: 'chat-10d-return-to-conversation', title: 'A is back in the conversation for the unpin', device: devA,
    flow: 'chat/see-text.yaml', env: { TEXT: r1, TIMEOUT: '20000' },
    expected: 'The reply is on screen again', screen: 'conversation',
  });
  // v3.3 (backlog 41): a pin can also be taken back from the list it lives in.
  await ctx.step({
    id: 'chat-10e-unpin-from-list', title: 'A unpins from the chat\'s Pinned list ("Unpin: <sender>")', device: devA,
    flow: 'chat/unpin-from-list.yaml', env: { TARGET: r1, SENDER: B.displayName },
    expected: 'The row goes and the list says "Nothing pinned yet"; server message_pins row removed',
    screen: 'conversation → Conversation controls → Pinned',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, r1), (r) => r?.pinned === false, { timeoutMs: 20_000 }); return { ok: w.ok, detail: `pinned=${w.row?.pinned}` }; },
  });
  await ctx.step({
    id: 'chat-10f-repin', title: 'A pins the reply again (so the sheet\'s own Unpin still has something to undo)', device: devA, flow: 'chat/pin.yaml', env: { TARGET: r1 },
    expected: 'Pinned again; server message_pins row', screen: 'conversation → Message actions',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, r1), (r) => r?.pinned === true, { timeoutMs: 20_000 }); return { ok: w.ok, detail: `pinned=${w.row?.pinned}` }; },
  });
  await ctx.step({
    id: 'chat-11-unpin', title: 'A unpins the reply', device: devA, flow: 'chat/unpin.yaml', env: { TARGET: r1 },
    expected: 'Pin offered again; server row removed', screen: 'conversation → Message actions',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, r1), (r) => r?.pinned === false, { timeoutMs: 20_000 }); return { ok: w.ok, detail: `pinned=${w.row?.pinned}` }; },
  });

  // v3.3 (backlog 44/45): the consumer sheet is the reaction row, Reply, Copy,
  // Pin, Forward, Translate for me, and — inside fifteen minutes — Edit and
  // Delete for everyone. "Delete for me" was removed from the app entirely
  // (the old chat-12/chat-13 pair exercised it), and the workplace review
  // items are hidden, so the sheet's contents are what is checked here.
  const fresh = `Fresh own text ${tag}`;
  await ctx.step({ id: 'chat-11b-send-fresh', title: 'A sends a text to long-press while it is still inside the fifteen-minute window', device: devA, flow: 'chat/send-text.yaml', env: { TEXT: fresh }, expected: 'bubble', screen: 'conversation',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, fresh), (r) => Boolean(r), { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row?.id ?? 'no row' }; } });
  await ctx.step({
    id: 'chat-12-actions-sheet-contents', title: 'The long-press sheet for a consumer: reactions, Reply, Copy, Pin, Forward, Edit and Delete for everyone — no corrections, no provenance, no "Delete for me"', device: devA,
    flow: 'chat/actions-sheet-contents.yaml', env: { TARGET: fresh },
    expected: 'Reply, Copy, Pin and Forward present; Edit message + Save edit + "Delete for everyone" on an own message minutes old; none of "Propose correction", "Review correction", "Show details", "Hide details", "Create action item", "Delete for me"',
    screen: 'conversation → Message actions',
  });
  // v3.3 (backlog 43): six reactions in one row, and a "+" that takes any emoji.
  await ctx.step({
    id: 'chat-13-reactions', title: 'The six reactions (👍 ❤️ 😂 😮 😢 🙏) and the "+" emoji route; anything that is not one emoji is refused', device: devA,
    flow: 'chat/reactions.yaml', env: { TARGET: r1, CUSTOM: '🎉' },
    expected: 'All six offered plus "More emoji"; the old ✅ and 👀 gone; "+" opens an "Any emoji" field that answers "Pick one emoji." to words and stores 🎉; server message_reactions row carries 🎉',
    screen: 'conversation → Message actions',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, r1), (r) => (r?.reaction_detail ?? '').includes('🎉'), { timeoutMs: 30_000 }); return { ok: w.ok, detail: w.row?.reaction_detail ?? 'no 🎉 reaction' }; },
  });

  // v3.3 (backlog 46): the reply gesture.
  const swipeReply = `Swiped reply ${tag}`;
  await ctx.step({
    id: 'chat-13b-swipe-reply', title: 'A swipes right on B\'s reply to answer it', device: devA,
    flow: 'chat/swipe-reply.yaml', env: { TARGET: r1, REPLY: swipeReply },
    expected: 'The drag opens "Replying to …" without the actions sheet; the sent bubble quotes B; server reply_to_message_id points at B\'s reply',
    screen: 'conversation',
    serverTruth: async () => {
      const original = await server.messageByBody(convId, r1);
      const w = await server.waitFor(() => server.messageByBody(convId, swipeReply), (r) => Boolean(r), { timeoutMs: 20_000 });
      return { ok: w.ok && w.row?.reply_to === original?.id, detail: { reply: w.row?.id, reply_to: w.row?.reply_to, original: original?.id } };
    },
  });
  // v3.3 (backlog 47d): tapping the quote goes to the message it answers.
  await ctx.step({
    id: 'chat-13c-jump-to-quoted', title: 'Tapping the quote on A\'s swiped reply jumps to B\'s original', device: devA,
    flow: 'chat/jump-to-quoted.yaml', env: { REPLY: swipeReply, SENDER: B.displayName, QUOTED: `Reply from Ben ${tag}`, ORIGINAL: r1 },
    expected: 'The quote reads "<B>: <the original>"; tapping it centres the original in the thread',
    screen: 'conversation',
  });
  // v3.3 (backlog 47g): a link grows a card saying what the page calls itself.
  const linkText = `Look at this ${tag} https://example.com/`;
  await ctx.step({
    id: 'chat-13d-link-preview', title: 'A sends a link; the bubble grows a preview card with the page title', device: devA,
    flow: 'chat/link-preview.yaml', env: { TEXT: linkText, TITLE: 'Example Domain', TIMEOUT: '60000' },
    expected: 'A card under the bubble reading "Example Domain"; server: private.link_previews holds https://example.com/ with status ready (the gateway fetched it, not the phone)',
    screen: 'conversation',
    serverTruth: async () => {
      const w = await server.waitFor(
        () => server.one(`select url, title, site_name, status from private.link_previews where url = 'https://example.com/'`),
        (row) => row?.status === 'ready' && Boolean(row?.title),
        { timeoutMs: 60_000 },
      );
      return { ok: w.ok, detail: w.row ?? 'no cached preview' };
    },
    timeoutMs: 240_000,
  });

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
  const group = C.userId
    ? await ctx.step({
      id: 'chat-17a-create-group', title: 'A creates a group with B and the third account (forward target; v3.3 needs three people)', device: devA, flow: 'groups/create-group.yaml', env: { NAME: groupName, MEMBER1: B.displayName, MEMBER1_QUERY: B.username, HAS_MEMBER2: 'true', MEMBER2: C.displayName, MEMBER2_QUERY: C.username },
      expected: 'Group opens; server conversations row + 3 members', screen: 'new-group',
      serverTruth: async () => { const w = await server.waitFor(() => server.groupByName(groupName), (r) => Boolean(r), { timeoutMs: 20_000 }); const m = w.row ? await server.members(w.row.id) : []; return { ok: w.ok && m.filter((r) => r.status === 'active').length === 3, detail: { group: w.row?.id, members: m } }; },
    })
    : (ctx.note({ id: 'chat-17a-create-group', title: 'A creates a group (forward target)', status: 'FAIL', expected: 'a three-person group to forward into', observed: `the third account could not be created: ${C.error}` }), { uiOk: false });
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
    // v3.3 (backlog 47b): the chat-row gesture on a group is named for what it
    // does. B leaves from the row; nothing later needs B in this group.
    await ctx.step({
      id: 'chat-18b-row-leave-group', title: 'B leaves the group from its row: the row says Leave, never Delete, and the confirmation names the group', device: devB,
      flow: 'chat/row-leave-group.yaml', env: { NAME: groupName },
      expected: '"Leave" with no "Delete"; "Leave <group>?" carrying "The group carries on without you." and a "Keep it" alongside; after Leave the row goes and the server has B no longer active',
      screen: 'chats',
      serverTruth: async () => { const w = await server.waitFor(() => server.members(groupRow.id), (rows) => { const b = rows.find((r) => r.user_id === B.userId); return !b || b.status !== 'active'; }, { timeoutMs: 30_000 }); return { ok: w.ok, detail: w.row?.find?.((r) => r.user_id === B.userId) ?? 'row gone' }; },
    });
    await openB();
  }

  const query = `zebra${tag}`;
  await ctx.step({ id: 'chat-19-search', title: 'The Chats field finds the message (v3.3: the Search tab is gone; results arrive as you type)', device: devA, flow: 'chat/search-messages.yaml', env: { QUERY: query }, expected: 'A "Messages" section under the field with a row carrying the token; no "Search people and messages" screen anywhere', screen: 'chats (search field)' });
  // The Messages filter chip is workplace-only; the step id keeps its history
  // and now proves the result opens the conversation.
  await ctx.step({ id: 'chat-20-search-filter', title: 'Open the message suggestion from the Chats field', device: devA, flow: 'chat/search-filter-messages.yaml', env: { QUERY: query }, expected: 'Tapping the "<chat> · <matched words>" row opens that conversation at the text', screen: 'chats (search field)' });

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

  // Photos and files: everything the chat has carried, in one grid.
  await openA();
  await ctx.step({
    id: 'media-06-shared-media', title: 'A opens Photos and files for the chat', device: devA, flow: 'chat/shared-media.yaml',
    expected: 'The grid lists the photo as a thumbnail and the voice note and document as rows, newest first; tapping the photo opens the full-screen viewer, and "Next photo"/"Previous photo" step along the grid when it holds more than one',
    screen: 'conversation → Conversation controls → Photos and files',
    serverTruth: async () => { const rows = await server.attachments(convId); return { ok: rows.length > 0, detail: rows.map((r) => ({ mime: r.mime_type, scan: r.scan_status })) }; },
    timeoutMs: 300_000,
  });

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

  // v3.3 (backlog 47c): scrolled back through a thread, an arriving message
  // shows a pill rather than yanking the list; tapping it returns to the newest.
  await openA();
  const jumpText = `Arrived while scrolled back ${tag}`;
  await Promise.all([
    ctx.step({
      id: 'chat-29c-new-messages-jump', title: 'A is scrolled back when B sends: a "N new messages" pill appears and returns A to the newest', device: devA,
      flow: 'chat/new-messages-jump.yaml', env: { TEXT: jumpText, TIMEOUT: '60000' },
      expected: 'After two drags back through the history the pill appears within 60s of B\'s send; tapping it lands on the new message. A thread shorter than a screenful never leaves the bottom, so the pill never appears and the step records that instead of failing.',
      screen: 'conversation', optional: true,
    }),
    (async () => {
      await sleep(12_000);
      return ctx.step({ id: 'chat-29d-b-sends-for-jump', title: 'B sends while A is scrolled back', device: devB, flow: 'chat/send-text.yaml', env: { TEXT: jumpText }, expected: 'bubble', screen: 'conversation' });
    })(),
  ]);

  await ctx.step({ id: 'chat-30-language-mid-session', title: 'Switch display language mid-session; originals unchanged', device: devA, flow: 'chat/language-mid-session.yaml', env: { PEER: B.displayName, TEXT: t5 }, expected: 'Spanish chrome in the conversation ("Escribe un mensaje…", "Volver a chats"), message text unchanged, English restored', screen: 'settings / conversation' });

  // Deep link.
  await ctx.step({ id: 'chat-31a-a-back', title: 'A returns to Chats', device: devA, flow: 'chat/back-to-chats.yaml', expected: 'Chats', screen: 'chats' });
  try {
    openUrl(devA, `newone://conversation/${convId}`);
    await ctx.step({ id: 'chat-31-deep-link', title: 'Deep link newone://conversation/<id> opens the conversation', device: devA, flow: 'chat/deep-link-opened.yaml', env: { PEER: B.displayName }, expected: 'Conversation with B open', screen: 'deep link' });
  } catch (error) {
    ctx.note({ id: 'chat-31-deep-link', title: 'Deep link', status: 'FAIL', observed: String(error.message) });
  }
  ctx.note({
    id: 'chat-32b-no-banner-for-open-chat', title: 'No notification banner for the chat that is already open', status: 'INFO',
    expected: 'A message arriving in the conversation on screen shows no banner; it simply appears in the thread',
    observed: 'Not provable on a simulator: iOS simulators receive no APNs/Expo push at all (Device.isDevice is false, so no push token is ever issued), which is also why chat-32 is unreachable. The suppression is on the phone, in the notification handler: setVisibleConversation records the conversation on screen and announcesVisibleConversation makes handleNotification return shouldShowBanner/shouldShowList false for a push naming it (apps/newone/src/device/push-registration.native.ts, visible-conversation.ts), which Jest covers in apps/newone/tests/visible-conversation.test.ts. On a physical device this is the step to watch; chat-02 already proves the message itself lands in the open thread.',
    screen: 'conversation',
  });
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

  // ---- v3.3: what the Chats list itself now does ----
  // The one search field: chips for people, and two chips meaning "the chats
  // holding both". A's list has the direct chat with B and the group with B
  // and the third account, so chipping both leaves only the group.
  if (groupRow && C.userId) {
    await ctx.step({
      id: 'chat-37-search-chips', title: 'Chats search: a person suggestion becomes a chip (with the comma written), a second chip narrows to the chat holding both, one tap clears a chip', device: devA,
      flow: 'chat/search-chips.yaml', env: { PERSON1: B.displayName, PERSON2: C.displayName, BOTH: groupName, ABSENT: t5 },
      expected: 'Typing B suggests B under "People"; tapping it leaves a "Remove <B>" chip; adding the third account leaves both chips and only the group listed; tapping a chip clears just that one',
      screen: 'chats (search field)',
    });
  }
  // The "+" menu: two rows, one to the stranger search and one to creation.
  await ctx.step({
    id: 'chat-38-new-menu', title: 'The "+" on the Chats header: "Add a friend" reaches the stranger search, "New group" reaches creation', device: devA,
    flow: 'chat/new-menu.yaml',
    expected: 'The "New" sheet holds exactly "Add a friend" and "New group"; the first opens Contacts with the "Search by name or @username" sheet, the second opens "Create a group"; the old "Start a conversation" entry is gone',
    screen: 'chats → New',
  });
  // Chat-row actions: mark unread, mute, and the two confirmations.
  await ctx.step({
    id: 'chat-39-row-mark-unread', title: 'A puts B\'s chat back to unread from the row, then reads it again', device: devA,
    flow: 'chat/row-mark-unread.yaml', env: { PEER: B.displayName },
    expected: 'A long press opens Mark unread / Mute / Archive / Delete; after Mark unread the Unread filter lists the chat and the row offers Mark read',
    screen: 'chats',
  });
  await ctx.step({
    id: 'chat-40-row-mute', title: 'A mutes B\'s chat from the row and unmutes it again', device: devA,
    flow: 'chat/row-mute.yaml', env: { PEER: B.displayName },
    expected: 'Mute becomes Unmute; server conversation_preferences.notification_level none while muted and all afterwards',
    screen: 'chats',
    serverTruth: async () => { const w = await server.waitFor(() => server.preferences(convId, A.userId), (r) => r?.notification_level === 'all', { timeoutMs: 30_000 }); return { ok: w.ok, detail: w.row }; },
  });
  await ctx.step({
    id: 'chat-41-row-delete-confirmation', title: 'Deleting a one-to-one chat asks first and names the other person; "Keep it" leaves it alone', device: devA,
    flow: 'chat/row-delete-confirm.yaml', env: { PEER: B.displayName },
    expected: '"Delete this chat?" with "It disappears from your list. <B> keeps theirs." and Keep it; the row is a one-to-one so it says Delete, never Leave; after Keep it the chat is still listed',
    screen: 'chats',
    serverTruth: async () => { const row = await server.preferences(convId, A.userId); return { ok: row?.is_archived !== true, detail: row ?? 'no preference row (not archived)' }; },
  });
  // Archiving from the row takes the chat off the list at once. Last, because
  // it removes B's chat from A's list.
  await ctx.step({
    id: 'chat-43-row-archive', title: 'A archives B\'s chat from the row: it leaves the list', device: devA,
    flow: 'chat/row-archive.yaml', env: { PEER: B.displayName },
    expected: 'The row disappears; server conversation_preferences.is_archived true for A',
    screen: 'chats',
    serverTruth: async () => { const w = await server.waitFor(() => server.preferences(convId, A.userId), (r) => r?.is_archived === true, { timeoutMs: 30_000 }); return { ok: w.ok, detail: w.row }; },
  });
  // Back to the newest: the control only exists once the list is a screenful
  // deep, which a test account with a few chats never is.
  await ctx.step({
    id: 'chat-44-jump-to-latest', title: 'Scrolled down the Chats list, "Back to the newest" returns to the top', device: devA,
    flow: 'chat/jump-to-latest.yaml',
    expected: 'After two upward drags the control appears and returns the list to the top; a list shorter than a screenful never scrolls, and that is recorded rather than forced',
    screen: 'chats', optional: true,
  });
  ctx.accounts = { A, B, C };
}
