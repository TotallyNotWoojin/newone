// IPAD SHOTS: sign the showcase account (Maya Chen) in on the iPad simulator
// given by NEWONE_SHOT_DEVICE (email NEWONE_SHOT_EMAIL, password
// NEWONE_SHOT_PASSWORD; v3.2 sign-in is email → password) and capture the
// Chats list and a conversation.
import { bootAndInstall, launchApp } from '../lib/devices.mjs';
export const meta = { id: 'ipadshots', devices: 1, title: 'iPad screenshots (showcase account)' };

export async function run(ctx) {
  const dev = process.env.NEWONE_SHOT_DEVICE;
  const email = process.env.NEWONE_SHOT_EMAIL;
  const password = process.env.NEWONE_SHOT_PASSWORD;
  const peer = process.env.NEWONE_SHOT_PEER ?? 'Diego Ruiz';
  if (!dev || !email || !password) { ctx.note({ id: 'ipadshots-blocked', title: 'NEWONE_SHOT_DEVICE / NEWONE_SHOT_EMAIL / NEWONE_SHOT_PASSWORD not set', status: 'FAIL' }); return; }
  bootAndInstall(dev, (message) => ctx.log(`[ipad] ${message}`));
  // The pool warm-up launches only pool devices; this one needs an explicit launch.
  launchApp(dev);
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const request = await ctx.step({ id: 'ipad-01-request', title: 'Returning sign-in: email → password step', device: dev, flow: 'common/returning-request.yaml', env: { EMAIL: email }, expected: 'password step', screen: 'sign-in' });
  if (!request.uiOk) return;
  await ctx.step({ id: 'ipad-02-verify', title: 'Returning sign-in with the password', device: dev, flow: 'common/returning-verify.yaml', env: { PASSWORD: password }, expected: 'Chats', screen: 'sign-in' });
  await ctx.shot(dev, 'ipad-00-chats');
  await ctx.step({ id: 'ipad-03-open', title: 'Open the conversation', device: dev, flow: 'common/open-conversation.yaml', env: { PEER: peer }, expected: 'composer', screen: 'chats' });
  await ctx.shot(dev, 'ipad-01-conversation');
  ctx.accounts = {};
}
