// REVIEW CHECK: the App Store review account signs in with its password
// (v3.2 flow: email → password). The password is the App Store Connect
// demo-account value, kept out of the repo in
// ~/.config/newone/review-account-password.txt. The fixed-code route stays
// on the server for the web/admin path but the app no longer offers a code
// sign-in.
import { readFileSync } from 'node:fs';
export const meta = { id: 'reviewcheck', devices: 1, title: 'App Review account sign-in (single device)' };

export async function run(ctx) {
  const [dev] = ctx.devices;
  const password = readFileSync(`${process.env.HOME}/.config/newone/review-account-password.txt`, 'utf8').trim();
  await ctx.step({ id: 'review-00-signout', title: 'Setup: sign out any prior session', device: dev, flow: 'common/signout.yaml', expected: 'sign-in screen', screen: 'settings' });
  const request = await ctx.step({ id: 'review-01-request', title: 'Review account: email → password step', device: dev, flow: 'common/returning-request.yaml', env: { EMAIL: 'review@newonechat.com' }, expected: 'password step (the lookup finds the account with a password)', screen: 'sign-in' });
  if (!request.uiOk) return;
  await ctx.step({ id: 'review-02-verify', title: 'Review account signs in with its password', device: dev, flow: 'common/returning-verify.yaml', env: { PASSWORD: password }, expected: 'Chats', screen: 'sign-in' });
  ctx.accounts = {};
}
