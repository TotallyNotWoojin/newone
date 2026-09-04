// MEDIA only (A ↔ B): the attachment path on its own, for a quick proof after
// an attachment fix without the whole chat area. Same real signups, request,
// and acceptance as the chat area; then photo, voice note, and document.
export const meta = { id: 'media', devices: 2, title: 'MEDIA (A/B)' };

export async function run(ctx) {
  const [devA, devB] = ctx.devices;
  const { server } = ctx;
  const tag = Math.random().toString(36).slice(2, 6);
  const [A, B] = await Promise.all([
    ctx.signup(devA, { label: 'media_a', displayName: `Sim Mia ${tag}` }),
    ctx.signup(devB, { label: 'media_b', displayName: `Sim Max ${tag}` }),
  ]);
  if (!A.signedIn || !B.signedIn) {
    ctx.note({ id: 'media-blocked', title: 'MEDIA blocked: setup signup failed', status: 'FAIL', observed: `A=${A.signedIn} B=${B.signedIn}` });
    return;
  }
  const intro = `Hey Max, Mia here ${tag}`;
  await ctx.step({ id: 'media-00a-search', title: 'Setup: A finds B', device: devA, flow: 'people/search-user.yaml', env: { USERNAME: B.username, NAME: B.displayName, EXPECT_BUTTON: 'Send message request' }, expected: 'B card', screen: 'people' });
  const request = await ctx.step({
    id: 'media-00b-message-request', title: 'A sends a message request with a first message', device: devA,
    flow: 'people/send-message-request.yaml', env: { TEXT: intro }, expected: 'Conversation opens with pending banner', screen: 'people → conversation',
    serverTruth: async () => { const w = await server.waitFor(() => server.directConversation(A.userId, B.userId), (row) => Boolean(row), { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row }; },
  });
  if (!request.uiOk) return;
  const conversation = await server.directConversation(A.userId, B.userId);
  const convId = conversation.id;
  const accept = await ctx.step({
    id: 'media-00c-accept', title: 'B accepts the request in the conversation', device: devB,
    flow: 'chat/accept-in-conversation.yaml', env: { NAME: A.displayName }, expected: 'Composer unlocks after Accept', screen: 'chats → conversation',
  });
  if (!accept.uiOk) return;
  const openA = () => ctx.step({ id: `media-open-a-${ctx.seq = (ctx.seq ?? 0) + 1}`, title: 'A (re)opens the conversation', device: devA, flow: 'common/open-conversation.yaml', env: { PEER: B.displayName }, expected: 'conversation open', screen: 'conversation' });
  const openB = () => ctx.step({ id: `media-open-b-${ctx.seq = (ctx.seq ?? 0) + 1}`, title: 'B (re)opens the conversation', device: devB, flow: 'common/open-conversation.yaml', env: { PEER: A.displayName }, expected: 'conversation open', screen: 'conversation' });
  await openA();
  await openB();
  await ctx.step({
    id: 'media-01-photo', title: 'A sends a photo from the simulator photo library', device: devA, flow: 'media/photo-library.yaml',
    expected: 'Attachment card reaches "Scanned and safe"; server message_attachments row scan_status clean', screen: 'conversation → Add attachment',
    serverTruth: async () => { const w = await server.waitFor(() => server.attachments(convId), (rows) => rows.some((r) => r.mime_type?.startsWith('image/') && r.scan_status === 'clean'), { timeoutMs: 120_000 }); return { ok: w.ok, detail: w.row ?? 'no clean image attachment' }; },
    timeoutMs: 420_000,
  });
  await ctx.step({ id: 'media-02-b-opens-photo', title: 'B sees the photo card and opens it', device: devB, flow: 'media/see-attachment.yaml', expected: 'Card "Scanned and safe" on B; tap opens the secure viewer', screen: 'conversation', timeoutMs: 240_000 });
  await openB();
  await ctx.step({
    id: 'media-03-voice-note', title: 'A records and sends a 2s voice note', device: devA, flow: 'media/voice-note.yaml',
    expected: '"Voice message" bubble with Play; server audio attachment clean', screen: 'conversation → mic',
    serverTruth: async () => { const w = await server.waitFor(() => server.attachments(convId), (rows) => rows.some((r) => r.mime_type?.startsWith('audio/') && r.scan_status === 'clean'), { timeoutMs: 120_000 }); return { ok: w.ok, detail: w.row ?? 'no clean audio attachment' }; },
    timeoutMs: 420_000,
  });
  await ctx.step({ id: 'media-04-b-plays-voice', title: 'B sees the voice note and plays it', device: devB, flow: 'media/see-voice-note.yaml', expected: 'Play → Pause state', screen: 'conversation', timeoutMs: 240_000 });
  const doc = await ctx.step({ id: 'media-05-document', title: 'A sends a document from the Files picker', device: devA, flow: 'media/choose-file.yaml', expected: 'A document is selectable and uploads', screen: 'conversation → Choose file', optional: true, timeoutMs: 240_000 });
  if (!doc.uiOk) await ctx.step({ id: 'media-05b-cancel-picker', title: 'Dismiss the document picker', device: devA, flow: 'media/cancel-picker.yaml', expected: 'composer visible', screen: 'conversation', optional: true });
}
