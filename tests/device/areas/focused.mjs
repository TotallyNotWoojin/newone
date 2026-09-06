// FOCUSED (A ↔ B): the two chat steps that missed in the final v2.2 run —
// delete-for-everyone propagation to B (defect T) and the unread badge
// clearing after A opens a short thread (defect U). Same setup as chat.
export const meta = { id: 'focused', devices: 2, title: 'FOCUSED: deletion propagation + unread clear (A/B)' };

export async function run(ctx) {
  const [devA, devB] = ctx.devices;
  const { server } = ctx;
  const tag = Math.random().toString(36).slice(2, 6);
  const [A, B] = await Promise.all([
    ctx.signup(devA, { label: 'foc_a', displayName: `Sim Ana ${tag}` }),
    ctx.signup(devB, { label: 'foc_b', displayName: `Sim Ben ${tag}` }),
  ]);
  if (!A.signedIn || !B.signedIn) {
    ctx.note({ id: 'focused-blocked', title: 'FOCUSED blocked: setup signup failed', status: 'FAIL', observed: `A=${A.signedIn} B=${B.signedIn}` });
    return;
  }
  const intro = `Hey Ben, Ana here ${tag}`;
  await ctx.step({ id: 'foc-00a-search', title: 'Setup: A finds B', device: devA, flow: 'people/search-user.yaml', env: { USERNAME: B.username, NAME: B.displayName, EXPECT_BUTTON: 'Message' }, expected: 'B row with a Message button', screen: 'people' });
  const request = await ctx.step({
    id: 'foc-00b-message-request', title: 'Setup: A taps Message and sends the first text (no request)', device: devA,
    flow: 'people/message-from-result.yaml', env: { TEXT: intro }, expected: 'Conversation opens at once; first text sent', screen: 'people → conversation',
    serverTruth: async () => { const w = await server.waitFor(() => server.directConversation(A.userId, B.userId), (row) => Boolean(row), { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row }; },
  });
  if (!request.uiOk) return;
  const convId = (await server.directConversation(A.userId, B.userId)).id;
  const accept = await ctx.step({
    id: 'foc-00c-accept', title: 'Setup: B sees the first text in Chats → conversation (nothing to accept)', device: devB,
    flow: 'people/receive-text.yaml', env: { PEER: A.displayName, TEXT: intro }, expected: 'Text visible; composer present', screen: 'chats → conversation',
    serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(convId, intro), (row) => Boolean(row), { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row?.id ?? 'no row' }; },
  });
  if (!accept.uiOk) return;
  await ctx.step({ id: 'foc-00d-open-a', title: 'Setup: A opens the conversation', device: devA, flow: 'common/open-conversation.yaml', env: { PEER: B.displayName }, expected: 'composer visible', screen: 'chats' });

  // Defect T: delete for everyone must disappear on B without a cold start.
  const t2 = `Delete me everywhere ${tag}`;
  await ctx.step({ id: 'foc-14a-send-t2', title: 'A sends a text', device: devA, flow: 'chat/send-text.yaml', env: { TEXT: t2 }, expected: 'bubble', screen: 'conversation' });
  await ctx.step({ id: 'foc-14b-b-sees-t2', title: 'B sees the text', device: devB, flow: 'chat/see-text.yaml', env: { TEXT: t2, TIMEOUT: '30000' }, expected: 'visible', screen: 'conversation' });
  const t2Id = (await server.waitFor(() => server.messageByBody(convId, t2), (r) => Boolean(r), { timeoutMs: 20_000 })).row?.id ?? null;
  await ctx.step({
    id: 'foc-14-delete-for-everyone', title: 'A deletes the text for everyone', device: devA, flow: 'chat/delete-for-everyone.yaml', env: { TARGET: t2 },
    expected: 'Gone on A; server deleted_at set', screen: 'conversation → Message actions',
    serverTruth: async () => {
      if (!t2Id) return { ok: false, detail: 'text never reached the server' };
      const w = await server.waitFor(() => server.messageById(t2Id), (r) => Boolean(r?.deleted_at), { timeoutMs: 20_000 });
      return { ok: w.ok && w.row?.body === null, detail: { id: t2Id, deleted_at: w.row?.deleted_at } };
    },
  });
  const deletedAt = Date.now();
  const gone = await ctx.step({ id: 'foc-15-b-sees-deleted', title: 'Deleted-for-everyone text disappears on B (up to 120s; step duration = latency)', device: devB, flow: 'chat/expect-gone.yaml', env: { TEXT: t2, TIMEOUT: '120000' }, expected: 'Text gone on B', screen: 'conversation' });
  ctx.note({ id: 'foc-15b-latency', title: 'Deletion propagation latency on B', status: gone.uiOk ? 'INFO' : 'FAIL', observed: `${Math.round((Date.now() - deletedAt) / 1000)}s after the server deletion (includes B flow start-up)` });

  // Defect U: the unread badge clears after A opens the short thread.
  await ctx.step({ id: 'foc-21a-a-back', title: 'A returns to the Chats list', device: devA, flow: 'chat/back-to-chats.yaml', expected: 'Chats', screen: 'chats' });
  const t3 = `Unread probe ${tag}`;
  await ctx.step({ id: 'foc-21b-b-sends', title: 'B sends while A is on the list', device: devB, flow: 'chat/send-text.yaml', env: { TEXT: t3 }, expected: 'bubble', screen: 'conversation' });
  await ctx.step({ id: 'foc-21-unread-badge', title: 'Unread badge appears, Unread filter lists the chat, clears after reading', device: devA, flow: 'chat/unread-badge.yaml', env: { PEER: B.displayName, TEXT: t3 }, expected: 'badge, then gone after opening', screen: 'chats' });
  ctx.accounts = { A, B };
}
