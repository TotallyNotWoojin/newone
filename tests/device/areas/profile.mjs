// PROFILE PICTURES (one device): a fresh account sets a photo from the
// simulator's library, the server profile carries the path, then removes it.
export const meta = { id: 'profile', devices: 1, title: 'PROFILE PICTURES' };

export async function run(ctx) {
  const [dev] = ctx.devices;
  const { server } = ctx;
  const tag = Math.random().toString(36).slice(2, 6);
  const A = await ctx.signup(dev, { label: 'profile_a', displayName: `Sim Pia ${tag}` });
  if (!A.signedIn) {
    ctx.note({ id: 'profile-blocked', title: 'PROFILE blocked: setup signup failed', status: 'FAIL' });
    return;
  }
  await ctx.step({
    id: 'profile-01-set-photo', title: 'Settings → Edit profile → Choose photo → library photo becomes the profile picture', device: dev, flow: 'sessions/profile-photo.yaml',
    expected: '"Remove photo" appears in the Edit profile sheet (the picture replaced the initials); server profiles.avatar_path set and the upload row active', screen: 'settings → Edit profile sheet',
    serverTruth: async () => {
      const w = await server.waitFor(() => server.profileAvatar(A.userId), (r) => Boolean(r?.avatar_path) && r?.upload_status === 'active', { timeoutMs: 60_000 });
      return { ok: w.ok, detail: w.row };
    },
    timeoutMs: 240_000,
  });
  await ctx.step({
    id: 'profile-02-photo-in-people', title: 'The picture replaces the initials in the rail/people avatars (screenshot)', device: dev, flow: 'sessions/close-settings.yaml',
    expected: 'Chats screen; avatar image visible in the header rail on wide layouts', screen: 'chats', optional: true,
  });
  await ctx.step({
    id: 'profile-03-remove-photo', title: 'Remove photo (Edit profile sheet) clears the picture', device: dev, flow: 'sessions/remove-photo.yaml',
    expected: 'Initials again; server profiles.avatar_path null', screen: 'settings → Edit profile sheet',
    serverTruth: async () => {
      const w = await server.waitFor(() => server.profileAvatar(A.userId), (r) => r?.avatar_path === null, { timeoutMs: 30_000 });
      return { ok: w.ok, detail: w.row };
    },
  });
  ctx.accounts = { A };
}
