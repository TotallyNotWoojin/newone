// PUSH TESTER: one signed-in account on a simulator that the owner can message
// directly (no requests for consumers); the harness then sends messages on
// demand (pushsend) so the owner's physical device receives real pushes.
export const meta = { id: 'pushtester', devices: 1, title: 'PUSH TESTER account (single device)' };

export async function run(ctx) {
  const [dev] = ctx.devices;
  const A = await ctx.signup(dev, { label: 'push', displayName: 'Sim Push Tester' });
  ctx.note({ id: 'pushtester-account', title: 'Push tester account', status: A.signedIn ? 'INFO' : 'FAIL', observed: `username ${A.username} email ${A.email} userId ${A.userId ?? 'n/a'} on ${dev}` });
  ctx.accounts = { A };
}
