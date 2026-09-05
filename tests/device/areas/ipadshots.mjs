// IPAD SHOTS: sign the showcase account (Maya Chen) in on the iPad simulator
// given by NEWONE_SHOT_DEVICE and capture the Chats list and a conversation.
import { bootAndInstall } from '../lib/devices.mjs';
export const meta = { id: 'ipadshots', devices: 1, title: 'iPad screenshots (showcase account)' };

export async function run(ctx) {
  const dev = process.env.NEWONE_SHOT_DEVICE;
  const email = process.env.NEWONE_SHOT_EMAIL;
  const peer = process.env.NEWONE_SHOT_PEER ?? 'Diego Ruiz';
  if (!dev || !email) { ctx.note({ id: 'ipadshots-blocked', title: 'NEWONE_SHOT_DEVICE / NEWONE_SHOT_EMAIL not set', status: 'FAIL' }); return; }
  bootAndInstall(dev, (message) => ctx.log(`[ipad] ${message}`));
  const request = await ctx.step({ id: 'ipad-01-request', title: 'Returning sign-in request', device: dev, flow: 'common/returning-request.yaml', env: { EMAIL: email }, expected: 'code screen', screen: 'sign-in' });
  if (!request.uiOk) return;
  const code = await ctx.waitForCode({ email });
  if (!code) { ctx.note({ id: 'ipad-02-code', title: 'code', status: 'FAIL', observed: 'no code' }); return; }
  await ctx.step({ id: 'ipad-02-verify', title: 'Returning sign-in verify', device: dev, flow: 'common/returning-verify.yaml', env: { CODE: code.code }, expected: 'Chats', screen: 'sign-in' });
  await ctx.shot(dev, 'ipad-00-chats');
  await ctx.step({ id: 'ipad-03-open', title: 'Open the conversation', device: dev, flow: 'common/open-conversation.yaml', env: { PEER: peer }, expected: 'composer', screen: 'chats' });
  await ctx.shot(dev, 'ipad-01-conversation');
  ctx.accounts = {};
}
