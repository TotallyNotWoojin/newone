// PUSH SEND: the signed-in push tester (simulator 1) opens the chat the owner
// started with it (consumers message anyone directly; there is no request to
// accept any more) and sends a few messages spaced out, so the owner's
// physical device receives real pushes. The counterpart is discovered from
// the server: the newest direct conversation the tester account is in.
export const meta = { id: 'pushsend', devices: 1, title: 'PUSH SEND to the owner (single device)' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(ctx) {
  const [dev] = ctx.devices;
  const { server } = ctx;
  const tester = (await server.sql(`select user_id from public.profiles where username = 'sim_push_3a1ae9'`))[0];
  if (!tester) { ctx.note({ id: 'pushsend-blocked', title: 'tester account missing', status: 'FAIL' }); return; }
  const chat = (await server.conversationSummaries(tester.user_id)).find((row) => row.kind === 'direct' && !row.is_archived && row.peer);
  if (!chat) { ctx.note({ id: 'pushsend-blocked', title: 'no direct chat with the tester yet (the owner has to message it first)', status: 'FAIL' }); return; }
  ctx.note({ id: 'pushsend-counterpart', title: 'Counterpart', status: 'INFO', observed: `${chat.peer} (conversation ${chat.id}; newest text: ${chat.last_body ?? 'none'})` });
  await ctx.step({ id: 'pushsend-open', title: 'Tester opens the conversation', device: dev, flow: 'common/open-conversation.yaml', env: { PEER: chat.peer }, expected: 'composer', screen: 'chats' });
  for (let index = 1; index <= 3; index += 1) {
    await ctx.step({ id: `pushsend-${index}`, title: `Tester sends push probe ${index}`, device: dev, flow: 'chat/send-text.yaml', env: { TEXT: `Push probe ${index} from the simulator` }, expected: 'bubble', screen: 'conversation' });
    await sleep(20_000);
  }
  ctx.accounts = {};
}
