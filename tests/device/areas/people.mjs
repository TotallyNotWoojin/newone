// PEOPLE on two devices: username search, Connect → Requests → Accept on
// both sides, cancel an outgoing request, message request with a first
// message + decline (third disposable account), block → sender's send fails
// visibly → unblock, remove connection. Server truth on every durable step.
export const meta = { id: 'people', devices: 2, title: 'PEOPLE (A/B + C for decline)' };

export async function run(ctx) {
  const [devA, devB] = ctx.devices;
  const { server } = ctx;
  const tag = Math.random().toString(36).slice(2, 6);

  // C first on device B (decline path + cancel path), A on device A.
  const [A, C] = await Promise.all([
    ctx.signup(devA, { label: 'ppl_a', displayName: `Sim Alpha ${tag}` }),
    ctx.signup(devB, { label: 'ppl_c', displayName: `Sim Charlie ${tag}` }),
  ]);
  if (!A.signedIn || !C.signedIn) {
    ctx.note({ id: 'people-blocked', title: 'PEOPLE blocked: setup signup failed', status: 'FAIL', observed: `A signedIn=${A.signedIn} C signedIn=${C.signedIn}` });
    return;
  }

  await ctx.step({
    id: 'people-01-search-c', title: 'Username search finds a stranger (C)', device: devA,
    flow: 'people/search-user.yaml', env: { USERNAME: C.username, NAME: C.displayName, EXPECT_BUTTON: 'Connect' },
    expected: 'Card with C\'s display name, @username, "Send message request" and "Connect"', screen: 'people',
  });
  await ctx.step({
    id: 'people-02-connect-c', title: 'Connect → card shows "Cancel request"', device: devA,
    flow: 'people/connect.yaml', expected: 'Outgoing pending state; server contact_connections pending, requested by A', screen: 'people',
    serverTruth: async () => {
      const wait = await server.waitFor(() => server.connection(A.userId, C.userId), (row) => row?.status === 'pending', { timeoutMs: 20_000 });
      return { ok: wait.ok && wait.row?.requested_by_user_id === A.userId, detail: wait.row };
    },
  });
  await ctx.step({
    id: 'people-03-cancel-request', title: 'Cancel outgoing request → state returns to none', device: devA,
    flow: 'people/cancel-request.yaml', expected: 'Card shows "Connect" again; server row gone or not pending', screen: 'people',
    serverTruth: async () => {
      const wait = await server.waitFor(() => server.connection(A.userId, C.userId), (row) => !row || row.status !== 'pending', { timeoutMs: 20_000 });
      return { ok: wait.ok, detail: wait.row ?? 'no contact_connections row (cancelled)' };
    },
  });
  const cancelled = !(await server.connection(A.userId, C.userId))?.status || (await server.connection(A.userId, C.userId))?.status !== 'pending';
  if (cancelled) {
    const requestText = `Hi Charlie, it is Alpha ${tag}`;
    const messageRequest = await ctx.step({
      id: 'people-04-message-request', title: 'Message request with a first message', device: devA,
      flow: 'people/send-message-request.yaml', env: { TEXT: requestText },
      expected: 'Conversation opens with "Request pending" banner and the first message; server: pending connection + message row', screen: 'people → conversation',
      serverTruth: async () => {
        const wait = await server.waitFor(() => server.connection(A.userId, C.userId), (row) => row?.status === 'pending', { timeoutMs: 20_000 });
        const conversation = await server.directConversation(A.userId, C.userId);
        const message = conversation ? await server.messageByBody(conversation.id, requestText) : null;
        return { ok: wait.ok && Boolean(message), detail: { connection: wait.row, conversation: conversation?.id, message: message?.id ?? null } };
      },
    });
    if (messageRequest.uiOk) {
      await ctx.step({
        id: 'people-05-decline', title: 'Recipient declines the message request (conversation banner)', device: devB,
        flow: 'people/decline-request.yaml', env: { NAME: A.displayName },
        expected: 'Incoming banner "… wants to message you" with Accept/Decline; after Decline the banner disappears; server status declined', screen: 'chats → conversation',
        serverTruth: async () => { const wait = await server.waitFor(() => server.connection(A.userId, C.userId), (row) => row?.status === 'declined', { timeoutMs: 20_000 }); return { ok: wait.ok, detail: wait.row }; },
      });
      await ctx.observe(devB, { id: 'people-05b-after-decline', title: 'Screen after decline (what the recipient sees)', screen: 'conversation' });
    }
  } else {
    ctx.note({ id: 'people-04-message-request', title: 'Message request with a first message (to C)', status: 'SKIPPED', observed: 'the connect request to C is still pending on the server because Cancel request had no effect (people-03); the card offers no "Send message request". The message-request path is exercised in the CHAT area setup instead.' });
    await ctx.step({
      id: 'people-05-decline', title: 'Recipient declines the pending connect request (People → Requests)', device: devB,
      flow: 'people/decline-from-people.yaml', env: { NAME: A.displayName },
      expected: 'A listed under Requests with Accept/Decline; after Decline the row disappears; server status declined', screen: 'people',
      serverTruth: async () => { const wait = await server.waitFor(() => server.connection(A.userId, C.userId), (row) => row?.status === 'declined', { timeoutMs: 20_000 }); return { ok: wait.ok, detail: wait.row }; },
    });
    await ctx.step({
      id: 'people-05c-a-state-after-decline', title: 'Requester\'s card after the decline (should return to Connect / no pending)', device: devA,
      flow: 'people/search-user.yaml', env: { USERNAME: C.username, NAME: C.displayName, EXPECT_BUTTON: 'Connect' },
      expected: 'C\'s card shows Connect again (declines are not announced, but the pending state must clear)', screen: 'people',
    });
  }

  // C leaves device B; B signs up there.
  await ctx.step({ id: 'setup-ppl_c-signout', title: 'Setup: C signs out of device B', device: devB, flow: 'common/signout.yaml', expected: 'sign-in screen', screen: 'settings' });
  const B = await ctx.signup(devB, { label: 'ppl_b', displayName: `Sim Bravo ${tag}` });
  if (!B.signedIn) {
    ctx.note({ id: 'people-blocked-b', title: 'PEOPLE (A/B) blocked: B signup failed', status: 'FAIL', observed: 'see setup-ppl_b-* rows' });
    return;
  }

  await ctx.step({
    id: 'people-06-search-b', title: 'A finds B by username', device: devA,
    flow: 'people/search-user.yaml', env: { USERNAME: B.username, NAME: B.displayName, EXPECT_BUTTON: 'Connect' },
    expected: 'B\'s card with Connect', screen: 'people',
  });
  await ctx.step({
    id: 'people-07-connect-b', title: 'A sends Connect request to B', device: devA,
    flow: 'people/connect.yaml', expected: '"Cancel request" shown; server pending', screen: 'people',
    serverTruth: async () => {
      const wait = await server.waitFor(() => server.connection(A.userId, B.userId), (row) => row?.status === 'pending', { timeoutMs: 20_000 });
      return { ok: wait.ok, detail: wait.row };
    },
  });
  await ctx.step({
    id: 'people-08-b-sees-request', title: 'B sees the request under People → Requests', device: devB,
    flow: 'people/see-request.yaml', env: { NAME: A.displayName },
    expected: '"Requests" section lists A with Accept/Decline', screen: 'people',
  });
  await ctx.step({
    id: 'people-09-b-accepts', title: 'B accepts → A appears under "Your friends"', device: devB,
    flow: 'people/accept-request.yaml', env: { NAME: A.displayName },
    expected: 'A listed as a friend with a Message button; server status accepted', screen: 'people',
    serverTruth: async () => {
      const wait = await server.waitFor(() => server.connection(A.userId, B.userId), (row) => row?.status === 'accepted', { timeoutMs: 20_000 });
      return { ok: wait.ok, detail: wait.row };
    },
  });
  const live = await ctx.step({
    id: 'people-10-a-sees-friend', title: 'A learns of the acceptance without relaunch', device: devA,
    flow: 'people/friends-shows.yaml', env: { NAME: B.displayName },
    expected: 'A\'s People tab shows B under "Your friends" with Message within 45s of acceptance', screen: 'people',
  });
  if (!live.uiOk) {
    await ctx.step({
      id: 'people-10b-a-sees-friend-relaunch', title: 'A sees the friend after a relaunch (fallback check)', device: devA,
      flow: 'people/friends-shows-after-relaunch.yaml', env: { NAME: B.displayName },
      expected: 'After force-quit + relaunch, B is listed as a friend', screen: 'people',
    });
  }
  const hello = `Hello Bravo from Alpha ${tag}`;
  await ctx.step({
    id: 'people-11-message-friend', title: 'A taps Message on the friend card and sends a text', device: devA,
    flow: 'people/message-friend.yaml', env: { TEXT: hello },
    expected: 'Direct conversation opens; message renders as sent; server message row', screen: 'people → conversation',
    serverTruth: async () => {
      const conversation = await server.waitFor(() => server.directConversation(A.userId, B.userId), (row) => Boolean(row), { timeoutMs: 20_000 });
      const message = conversation.row ? await server.waitFor(() => server.messageByBody(conversation.row.id, hello), (row) => Boolean(row), { timeoutMs: 20_000 }) : { ok: false };
      return { ok: message.ok, detail: { conversation: conversation.row?.id, message: message.row?.id } };
    },
  });
  await ctx.step({
    id: 'people-12-b-receives', title: 'B receives the friend message', device: devB,
    flow: 'people/receive-text.yaml', env: { PEER: A.displayName, TEXT: hello },
    expected: 'Text visible on B within 45s', screen: 'chats → conversation',
  });

  // Account-name desync: A renames themself; B must see the new name on the
  // friend card and in the chat list without relaunching.
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
      id: 'people-12c-b-sees-new-name', title: 'B sees A\'s new display name on the friend card (no relaunch)', device: devB,
      flow: 'people/friends-shows.yaml', env: { NAME: renamed },
      expected: 'Friend card shows the renamed A within 45s', screen: 'people',
    });
    await ctx.step({
      id: 'people-12d-b-sees-new-name-in-chats', title: 'B\'s Chats list and conversation header use the new name', device: devB,
      flow: 'common/open-conversation.yaml', env: { PEER: renamed },
      expected: 'Conversation row and header show the renamed A', screen: 'chats → conversation',
    });
    await ctx.observe(devB, { id: 'people-12e-header-after-rename', title: 'Exact header/name rendering on B after A\'s rename', screen: 'conversation' });
    A.displayName = renamed;
  }

  await ctx.step({
    id: 'people-13-block', title: 'B blocks A from the friend card (Manage contact and privacy)', device: devB,
    flow: 'people/block.yaml', env: { NAME: A.displayName },
    expected: '"Blocked" badge on A\'s card; server member_blocks row', screen: 'people → Contact and privacy',
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
    expected: 'Visible failure ("Not sent" / permission error); server: no new message row', screen: 'conversation',
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
    flow: 'people/unblock.yaml', expected: '"Blocked" badge gone; server member_blocks row removed', screen: 'people → Contact and privacy',
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
  await ctx.step({
    id: 'people-17-remove-connection', title: 'A removes the connection with B', device: devA,
    flow: 'people/remove-connection.yaml', env: { NAME: B.displayName },
    expected: 'B disappears from "Your friends"; server row removed or no longer accepted', screen: 'people',
    serverTruth: async () => {
      const wait = await server.waitFor(() => server.connection(A.userId, B.userId), (row) => !row || row.status !== 'accepted', { timeoutMs: 20_000 });
      return { ok: wait.ok, detail: wait.row ?? 'no contact_connections row' };
    },
  });
  ctx.accounts = { A, B, C };
}
