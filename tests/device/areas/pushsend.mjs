// PUSH SEND: the signed-in push tester (simulator 1) accepts the owner's
// pending message request and sends a few messages spaced out, so the owner's
// physical device receives real pushes. The counterpart is discovered from the
// server: the pending connection addressed to the tester account.
export const meta = { id: 'pushsend', devices: 1, title: 'PUSH SEND to the owner (single device)' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(ctx) {
  const [dev] = ctx.devices;
  const { server } = ctx;
  const tester = (await server.sql(`select user_id from public.profiles where username = 'sim_push_3a1ae9'`))[0];
  if (!tester) { ctx.note({ id: 'pushsend-blocked', title: 'tester account missing', status: 'FAIL' }); return; }
  const pending = (await server.sql(`select c.requested_by_user_id, p.display_name, c.status from public.contact_connections c join public.profiles p on p.user_id = c.requested_by_user_id where (c.member_low_user_id = '${tester.user_id}' or c.member_high_user_id = '${tester.user_id}') and c.requested_by_user_id <> '${tester.user_id}' order by c.created_at desc limit 1`))[0];
  if (!pending) { ctx.note({ id: 'pushsend-blocked', title: 'no message request addressed to the tester yet', status: 'FAIL' }); return; }
  ctx.note({ id: 'pushsend-counterpart', title: 'Counterpart', status: 'INFO', observed: `${pending.display_name} (${pending.requested_by_user_id}) status ${pending.status}` });
  if (pending.status !== 'accepted') {
    await ctx.step({ id: 'pushsend-accept', title: `Tester accepts ${pending.display_name}'s request`, device: dev, flow: 'chat/accept-in-conversation.yaml', env: { NAME: pending.display_name }, expected: 'composer', screen: 'chats → conversation' });
  } else {
    await ctx.step({ id: 'pushsend-open', title: 'Tester opens the conversation', device: dev, flow: 'common/open-conversation.yaml', env: { PEER: pending.display_name }, expected: 'composer', screen: 'chats' });
  }
  for (let index = 1; index <= 3; index += 1) {
    await ctx.step({ id: `pushsend-${index}`, title: `Tester sends push probe ${index}`, device: dev, flow: 'chat/send-text.yaml', env: { TEXT: `Push probe ${index} from the simulator` }, expected: 'bubble', screen: 'conversation' });
    await sleep(20_000);
  }
  ctx.accounts = {};
}
