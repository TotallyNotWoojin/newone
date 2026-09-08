// CONTACTS on two devices: name/@username search (v3.3: strangers moved into
// Contacts → "Add a friend"; the Contacts list itself finds only people you
// already know), "Message" opens a chat with anyone at once (the Sep 2026
// social stream removed connect requests and message requests for consumers),
// the recipient simply sees the message, the Contacts tab lists the people you
// have chatted with ("Your people"), a display-name change reaches the other
// side, block → sender's send fails visibly → unblock. Server truth on every
// durable step.
// Removed with the request model (features gone by design, not UNREACHABLE):
// people-02-connect-c, people-03-cancel-request, people-05-decline (+ the
// decline-from-people fallback and people-05c), people-07-connect-b,
// people-08-b-sees-request, people-09-b-accepts, people-17-remove-connection.
export const meta = { id: 'people', devices: 2, title: 'CONTACTS (A/B + C as the stranger)' };

export async function run(ctx) {
  const [devA, devB] = ctx.devices;
  const { server } = ctx;
  const tag = Math.random().toString(36).slice(2, 6);

  // C first on device B (stranger path), A on device A.
  const [A, C] = await Promise.all([
    ctx.signup(devA, { label: 'ppl_a', displayName: `Sim Alpha ${tag}` }),
    ctx.signup(devB, { label: 'ppl_c', displayName: `Sim Charlie ${tag}` }),
  ]);
  if (!A.signedIn || !C.signedIn) {
    ctx.note({ id: 'people-blocked', title: 'PEOPLE blocked: setup signup failed', status: 'FAIL', observed: `A signedIn=${A.signedIn} C signedIn=${C.signedIn}` });
    return;
  }

  await ctx.step({
    id: 'people-01-search-c', title: 'Name/@username search finds a stranger (C)', device: devA,
    flow: 'people/search-user.yaml', env: { USERNAME: C.username, NAME: C.displayName, EXPECT_BUTTON: 'Message' },
    expected: 'Contacts → "Add a friend" → a row with C\'s display name, @username and a "Message" button (no Connect, no "Send message request")', screen: 'contacts → Add a friend',
  });
  // The step id keeps its history; the request compose modal is gone, so this
  // is now "Message" → the chat opens directly → the first text is sent.
  const firstText = `Hi Charlie, it is Alpha ${tag}`;
  const firstMessage = await ctx.step({
    id: 'people-04-message-request', title: 'Message opens a chat with the stranger at once; A sends the first text', device: devA,
    flow: 'people/message-from-result.yaml', env: { NAME: C.displayName, TEXT: firstText },
    expected: 'Conversation opens directly (no pending banner, no approval); the first message renders as sent; server: direct conversation + message row', screen: 'contacts → conversation',
    serverTruth: async () => {
      const conversation = await server.waitFor(() => server.directConversation(A.userId, C.userId), (row) => Boolean(row), { timeoutMs: 20_000 });
      const message = conversation.row ? await server.waitFor(() => server.messageByBody(conversation.row.id, firstText), (row) => Boolean(row), { timeoutMs: 20_000 }) : { ok: false };
      return { ok: message.ok, detail: { conversation: conversation.row?.id ?? null, message: message.row?.id ?? null } };
    },
  });
  if (firstMessage.uiOk) {
    await ctx.step({
      id: 'people-05-c-receives', title: 'Recipient (C) sees the stranger\'s message in Chats → conversation; nothing to accept or decline', device: devB,
      flow: 'people/receive-text.yaml', env: { PEER: A.displayName, TEXT: firstText },
      expected: 'Conversation row with A in Chats; the text is visible within 45s; no Accept/Decline banner', screen: 'chats → conversation',
    });
    await ctx.observe(devB, { id: 'people-05b-recipient-screen', title: 'Screen after receiving a message from someone new (what the recipient sees)', screen: 'conversation' });
    // v3.1 (backlog 5): declining a request asks first. Consumers have nothing
    // to decline any more (message and connect requests left the personal realm),
    // so the confirmation lives on the workplace People card and is proven by Jest.
    ctx.note({ id: 'people-05-decline-confirm', title: 'Declining a request asks first (Decline / Keep)', status: 'UNREACHABLE', observed: 'No request to decline exists for a consumer account; the Decline / Keep confirmation is on the workplace People card (Jest workflow-screens: Keep leaves the request, Decline confirms it).', expected: 'A small Decline / Keep confirmation before a request is declined' });
  }

  // C leaves device B; B signs up there.
  await ctx.step({ id: 'setup-ppl_c-signout', title: 'Setup: C signs out of device B', device: devB, flow: 'common/signout.yaml', expected: 'sign-in screen', screen: 'settings' });
  const B = await ctx.signup(devB, { label: 'ppl_b', displayName: `Sim Bravo ${tag}` });
  if (!B.signedIn) {
    ctx.note({ id: 'people-blocked-b', title: 'PEOPLE (A/B) blocked: B signup failed', status: 'FAIL', observed: 'see setup-ppl_b-* rows' });
    return;
  }

  // v3.3 (backlog 31): Contacts finds only people you already know. C is a
  // contact (A has chatted with C); B is a real account A has never chatted
  // with, so Contacts must not find B — that is what "Add a friend" is for.
  await ctx.step({
    id: 'people-05e-contacts-search', title: 'Contacts search finds a contact (C) and not a stranger (B)', device: devA,
    flow: 'people/contacts-search.yaml',
    env: { KNOWN: C.displayName, KNOWN_QUERY: C.username, STRANGER: B.displayName, STRANGER_QUERY: B.username },
    expected: 'Typing C\'s @username lists C with a Message button; typing B\'s @username answers "No one in your contacts matches that." and shows no row for B',
    screen: 'contacts',
  });
  // A contact row's main action starts a chat.
  const fromRow = `From the contact row ${tag}`;
  await ctx.step({
    id: 'people-05f-contact-row-message', title: 'A contact row\'s Message opens the chat with that person', device: devA,
    flow: 'people/contact-row-message.yaml', env: { NAME: C.displayName, QUERY: C.username, TEXT: fromRow },
    expected: 'The direct conversation with C opens from the row and takes a message; server: the message lands in the A↔C conversation',
    screen: 'contacts → conversation',
    serverTruth: async () => {
      const conversation = await server.directConversation(A.userId, C.userId);
      const w = conversation ? await server.waitFor(() => server.messageByBody(conversation.id, fromRow), (row) => Boolean(row), { timeoutMs: 20_000 }) : { ok: false };
      return { ok: w.ok, detail: { conversation: conversation?.id ?? null, message: w.row?.id ?? 'no row' } };
    },
  });

  await ctx.step({
    id: 'people-06-search-b', title: 'A finds B by username', device: devA,
    flow: 'people/search-user.yaml', env: { USERNAME: B.username, NAME: B.displayName, EXPECT_BUTTON: 'Message' },
    expected: 'B\'s row with a Message button', screen: 'contacts → Add a friend',
  });
  const hello = `Hello Bravo from Alpha ${tag}`;
  await ctx.step({
    id: 'people-11-message-friend', title: 'A taps Message on B\'s row and sends a text', device: devA,
    flow: 'people/message-from-result.yaml', env: { NAME: B.displayName, TEXT: hello },
    expected: 'Direct conversation opens; message renders as sent; server message row', screen: 'contacts → conversation',
    serverTruth: async () => {
      const conversation = await server.waitFor(() => server.directConversation(A.userId, B.userId), (row) => Boolean(row), { timeoutMs: 20_000 });
      const message = conversation.row ? await server.waitFor(() => server.messageByBody(conversation.row.id, hello), (row) => Boolean(row), { timeoutMs: 20_000 }) : { ok: false };
      return { ok: message.ok, detail: { conversation: conversation.row?.id, message: message.row?.id } };
    },
  });
  const live = await ctx.step({
    id: 'people-10-a-sees-friend', title: 'A\'s Contacts tab lists B under "Your people" without relaunch', device: devA,
    flow: 'people/friends-shows.yaml', env: { NAME: B.displayName },
    expected: 'B listed under "Your people" with a Message button within 45s of the first message', screen: 'contacts',
  });
  if (!live.uiOk) {
    await ctx.step({
      id: 'people-10b-a-sees-friend-relaunch', title: 'A sees B under "Your people" after a relaunch (fallback check)', device: devA,
      flow: 'people/friends-shows-after-relaunch.yaml', env: { NAME: B.displayName },
      expected: 'After force-quit + relaunch, B is listed under "Your people"', screen: 'contacts',
    });
  }
  await ctx.step({
    id: 'people-12-b-receives', title: 'B receives A\'s message', device: devB,
    flow: 'people/receive-text.yaml', env: { PEER: A.displayName, TEXT: hello },
    expected: 'Text visible on B within 45s', screen: 'chats → conversation',
  });

  // Account-name desync: A renames themself; B must see the new name on the
  // People row and in the chat list without relaunching.
  const renamed = `Sim Renamed ${tag}`;
  const rename = await ctx.step({
    id: 'people-12b-a-renames', title: 'A changes their display name in Settings', device: devA,
    flow: 'profile/edit-profile.yaml', env: { DISPLAY_NAME: renamed, STATUS: `Renamed ${tag}` },
    expected: 'Save succeeds; server profile row carries the new display name', screen: 'settings / Edit profile',
    serverTruth: async () => {
      const wait = await server.waitFor(() => server.profileByUsername(A.username), (row) => row?.display_name === renamed, { timeoutMs: 20_000 });
      return { ok: wait.ok, detail: wait.row };
    },
  });
  if (rename.serverResult?.ok) {
    await ctx.step({
      id: 'people-12c-b-sees-new-name', title: 'B sees A\'s new display name on the Contacts row (no relaunch)', device: devB,
      flow: 'people/friends-shows.yaml', env: { NAME: renamed },
      expected: 'Contacts → Your people shows the renamed A within 45s', screen: 'contacts',
    });
    await ctx.step({
      id: 'people-12d-b-sees-new-name-in-chats', title: 'B\'s Chats list and conversation header use the new name', device: devB,
      flow: 'common/open-conversation.yaml', env: { PEER: renamed },
      expected: 'Conversation row and header show the renamed A (header subtitle is A\'s @handle)', screen: 'chats → conversation',
    });
    await ctx.observe(devB, { id: 'people-12e-header-after-rename', title: 'Exact header/name rendering on B after A\'s rename', screen: 'conversation' });
    A.displayName = renamed;
  }

  await ctx.step({
    id: 'people-13-block', title: 'B blocks A from the Contacts row\'s "…" menu (Manage contact and privacy)', device: devB,
    flow: 'people/block.yaml', env: { NAME: A.displayName },
    expected: '"Blocked" badge replaces the Message button on A\'s row; server member_blocks row', screen: 'contacts → Contact and privacy',
    serverTruth: async () => {
      const wait = await server.waitFor(() => server.block(B.userId, A.userId), (row) => Number(row?.blocks) === 1, { timeoutMs: 20_000 });
      return { ok: wait.ok, detail: wait.row };
    },
  });
  const blockedText = `Blocked attempt ${tag}`;
  const conversationAB = await server.directConversation(A.userId, B.userId);
  const before = conversationAB ? (await server.messages(conversationAB.id)).length : 0;
  await ctx.step({
    id: 'people-14-blocked-send-fails', title: 'A\'s send to B fails with a visible error while blocked', device: devA,
    flow: 'people/send-expect-error.yaml', env: { PEER: B.displayName, TEXT: blockedText },
    expected: 'Visible failure ("Not sent" / permission error) or the composer replaced by the cannot-send notice; server: no new message row', screen: 'conversation',
    serverTruth: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const rows = conversationAB ? await server.messages(conversationAB.id) : [];
      const landed = rows.find((row) => row.body === blockedText);
      return { ok: !landed, detail: landed ? `BLOCKED MESSAGE LANDED: id ${landed.id}` : `message count ${before} → ${rows.length}; blocked text not stored` };
    },
  });
  await ctx.observe(devA, { id: 'people-14b-blocked-send-screen', title: 'Exact composer state after the blocked send', screen: 'conversation' });
  await ctx.step({
    id: 'people-15-unblock', title: 'B unblocks A', device: devB,
    flow: 'people/unblock.yaml', env: { NAME: A.displayName }, expected: '"Blocked" badge gone, Message button back; server member_blocks row removed', screen: 'contacts → Contact and privacy',
    serverTruth: async () => {
      const wait = await server.waitFor(() => server.block(B.userId, A.userId), (row) => Number(row?.blocks) === 0, { timeoutMs: 20_000 });
      return { ok: wait.ok, detail: wait.row };
    },
  });
  const afterText = `After unblock ${tag}`;
  await ctx.step({
    id: 'people-16-send-after-unblock', title: 'A can message B again after unblock', device: devA,
    flow: 'people/send-text.yaml', env: { PEER: B.displayName, TEXT: afterText },
    expected: 'Message sends; server row exists', screen: 'conversation',
    serverTruth: async () => {
      const wait = conversationAB ? await server.waitFor(() => server.messageByBody(conversationAB.id, afterText), (row) => Boolean(row), { timeoutMs: 20_000 }) : { ok: false };
      return { ok: wait.ok, detail: wait.row?.id ?? 'no row' };
    },
  });
  // people-17-remove-connection: removed — consumer Contacts rows have no
  // "Remove connection" (there is no connection to remove); blocking is the
  // only way to cut someone off, covered by people-13/15.
  ctx.accounts = { A, B, C };
}
