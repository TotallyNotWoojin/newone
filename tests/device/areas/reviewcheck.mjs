// REVIEW CHECK: the App Store review account signs in with its fixed code.
import { readFileSync } from 'node:fs';
export const meta = { id: 'reviewcheck', devices: 1, title: 'App Review account sign-in (single device)' };

export async function run(ctx) {
  const [dev] = ctx.devices;
  const code = readFileSync(`${process.env.HOME}/.config/newone/review-account-code.txt`, 'utf8').trim();
  await ctx.step({ id: 'review-00-signout', title: 'Setup: sign out any prior session', device: dev, flow: 'common/signout.yaml', expected: 'sign-in screen', screen: 'settings' });
  const request = await ctx.step({ id: 'review-01-request', title: 'Review account requests a returning code', device: dev, flow: 'common/returning-request.yaml', env: { EMAIL: 'review@newonechat.com' }, expected: 'code screen', screen: 'sign-in' });
  if (!request.uiOk) return;
  await ctx.step({ id: 'review-02-verify', title: 'Review account signs in with the fixed code', device: dev, flow: 'common/returning-verify.yaml', env: { CODE: code }, expected: 'Chats', screen: 'sign-in' });
  ctx.accounts = {};
}
