// GROUPS on three devices: A (owner), B, C. Friendships first (group
// candidates are friends), then create, fan-out, add/remove, promote/demote,
// member self-role check, ownership transfer, leave, avatar, @mention.
export const meta = { id: 'groups', devices: 3, title: 'GROUPS (A/B/C)' };

export async function run(ctx) {
  const [devA, devB, devC] = ctx.devices;
  const { server } = ctx;
  const tag = Math.random().toString(36).slice(2, 6);
  const [A, B, C] = await Promise.all([
    ctx.signup(devA, { label: 'grp_a', displayName: `Sim Owner ${tag}` }),
    ctx.signup(devB, { label: 'grp_b', displayName: `Sim Ben ${tag}` }),
    ctx.signup(devC, { label: 'grp_c', displayName: `Sim Cara ${tag}` }),
  ]);
  if (!A.signedIn || !B.signedIn || !C.signedIn) {
    ctx.note({ id: 'groups-blocked', title: 'GROUPS blocked: setup signup failed', status: 'FAIL', observed: `A=${A.signedIn} B=${B.signedIn} C=${C.signedIn}` });
    return;
  }

  // Friendships: A connects with B and C; they accept from People.
  for (const [peer, dev] of [[B, devB], [C, devC]]) {
    await ctx.step({ id: `setup-friend-${peer.label}-search`, title: `Setup: A finds ${peer.displayName}`, device: devA, flow: 'people/search-user.yaml', env: { USERNAME: peer.username, NAME: peer.displayName, EXPECT_BUTTON: 'Connect' }, expected: 'card', screen: 'people' });
    await ctx.step({ id: `setup-friend-${peer.label}-connect`, title: `Setup: A connects with ${peer.displayName}`, device: devA, flow: 'people/connect.yaml', expected: 'pending', screen: 'people' });
    await ctx.step({ id: `setup-friend-${peer.label}-see`, title: `Setup: ${peer.displayName} sees the request`, device: dev, flow: 'people/see-request.yaml', env: { NAME: A.displayName }, expected: 'Requests', screen: 'people' });
    await ctx.step({
      id: `setup-friend-${peer.label}-accept`, title: `Setup: ${peer.displayName} accepts`, device: dev, flow: 'people/accept-request.yaml', env: { NAME: A.displayName }, expected: 'friends', screen: 'people',
      serverTruth: async () => { const w = await server.waitFor(() => server.connection(A.userId, peer.userId), (r) => r?.status === 'accepted', { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row }; },
    });
  }

  const name = `Crew ${tag}`;
  const created = await ctx.step({
    id: 'groups-01-create', title: 'A creates a group with B (name + member from friends)', device: devA,
    flow: 'groups/create-group.yaml', env: { NAME: name, MEMBER1: B.displayName, HAS_MEMBER2: 'false', MEMBER2: '' },
    expected: 'Group conversation opens; server conversations row with A owner + B member', screen: 'new-group',
    serverTruth: async () => { const w = await server.waitFor(() => server.groupByName(name), (r) => Boolean(r), { timeoutMs: 20_000 }); const m = w.row ? await server.members(w.row.id) : []; return { ok: w.ok && m.some((r) => r.user_id === A.userId && r.role === 'owner') && m.some((r) => r.user_id === B.userId), detail: { group: w.row?.id, members: m } }; },
  });
  if (!created.uiOk) return;
  const group = await server.groupByName(name);
  const gid = group.id;
  const openGroup = (dev, who) => ctx.step({ id: `groups-open-${who}-${ctx.seq = (ctx.seq ?? 0) + 1}`, title: `${who} opens the group`, device: dev, flow: 'common/open-conversation.yaml', env: { PEER: name }, expected: 'composer', screen: 'chats' });

  const g1 = `Group hello ${tag}`;
  await ctx.step({ id: 'groups-02-send', title: 'A posts in the group', device: devA, flow: 'chat/send-text.yaml', env: { TEXT: g1 }, expected: 'bubble; server row', screen: 'group', serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(gid, g1), (r) => Boolean(r), { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row?.id }; } });
  await ctx.step({ id: 'groups-03-b-sees-group', title: 'B sees the group in Chats', device: devB, flow: 'groups/group-in-chats.yaml', env: { NAME: name }, expected: 'group row listed', screen: 'chats' });
  await openGroup(devB, 'B');
  await ctx.step({ id: 'groups-04-b-receives', title: 'B receives the group message', device: devB, flow: 'chat/see-text.yaml', env: { TEXT: g1, TIMEOUT: '30000' }, expected: 'visible', screen: 'group' });

  await ctx.step({
    id: 'groups-05-add-member', title: 'A adds C from the controls sheet', device: devA, flow: 'groups/add-member.yaml', env: { NAME: C.displayName },
    expected: 'C added; system row "… was added to the conversation."; server 3 active members', screen: 'group → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.members(gid), (rows) => rows.some((r) => r.user_id === C.userId && r.status === 'active'), { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row }; },
  });
  const g2 = `Fan-out ${tag}`;
  await ctx.step({ id: 'groups-06-send-2', title: 'A posts again (fan-out to B and C)', device: devA, flow: 'chat/send-text.yaml', env: { TEXT: g2 }, expected: 'bubble', screen: 'group' });
  await ctx.step({ id: 'groups-07-b-receives-2', title: 'B receives the fan-out message', device: devB, flow: 'chat/see-text.yaml', env: { TEXT: g2, TIMEOUT: '30000' }, expected: 'visible on B', screen: 'group' });
  await ctx.step({ id: 'groups-08-c-sees-group', title: 'C sees the group in Chats after being added', device: devC, flow: 'groups/group-in-chats.yaml', env: { NAME: name }, expected: 'listed', screen: 'chats' });
  await openGroup(devC, 'C');
  await ctx.step({ id: 'groups-09-c-receives-2', title: 'C receives the fan-out message', device: devC, flow: 'chat/see-text.yaml', env: { TEXT: g2, TIMEOUT: '30000' }, expected: 'visible on C', screen: 'group' });
  await ctx.observe(devC, { id: 'groups-09b-c-history', title: 'What C sees of the history from before joining (history policy)', screen: 'group' });

  const m1 = `Mention probe ${tag}`;
  await ctx.step({ id: 'groups-10-mention', title: 'A @mentions B in the group', device: devA, flow: 'groups/mention.yaml', env: { NAME: B.displayName, TEXT: m1 }, expected: 'Mention picker works; message sends', screen: 'group → Mention people' });
  await ctx.step({ id: 'groups-11-b-sees-mention', title: 'B sees the mention message', device: devB, flow: 'chat/see-text.yaml', env: { TEXT: m1, TIMEOUT: '30000' }, expected: 'visible', screen: 'group' });
  await ctx.observe(devB, { id: 'groups-11b-mention-render', title: 'Mention rendering on B', screen: 'group' });

  await ctx.step({
    id: 'groups-12-promote', title: 'A promotes B to Admin', device: devA, flow: 'groups/set-role.yaml', env: { ROLE: 'Admin', NAME: B.displayName },
    expected: 'Chip selected; system row "… had their conversation role changed."; server role admin', screen: 'group → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.members(gid), (rows) => rows.find((r) => r.user_id === B.userId)?.role === 'admin', { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row?.find?.((r) => r.user_id === B.userId) }; },
  });
  await ctx.step({
    id: 'groups-13-demote', title: 'A demotes B back to Member', device: devA, flow: 'groups/set-role.yaml', env: { ROLE: 'Member', NAME: B.displayName },
    expected: 'server role member', screen: 'group → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.members(gid), (rows) => rows.find((r) => r.user_id === B.userId)?.role === 'member', { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row?.find?.((r) => r.user_id === B.userId) }; },
  });
  await ctx.step({
    id: 'groups-14-member-self-role', title: 'Member (B) cannot change roles: no role chips/remove/add controls', device: devB, flow: 'groups/member-self-role-check.yaml', env: { SELF: B.displayName, OTHER: C.displayName },
    expected: 'Controls sheet for a member shows the members list without role chips, Remove buttons or Add a member', screen: 'group → Conversation controls',
    serverTruth: async () => { const rows = await server.members(gid); return { ok: rows.find((r) => r.user_id === B.userId)?.role === 'member', detail: rows }; },
  });

  await ctx.step({
    id: 'groups-15-remove-member', title: 'A removes C', device: devA, flow: 'groups/remove-member.yaml', env: { NAME: C.displayName },
    expected: 'System row "… was removed from the conversation."; server C not active', screen: 'group → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.members(gid), (rows) => { const c = rows.find((r) => r.user_id === C.userId); return !c || c.status !== 'active'; }, { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row?.find?.((r) => r.user_id === C.userId) ?? 'row gone' }; },
  });
  await ctx.step({ id: 'groups-16-c-after-removal', title: 'Removed member C no longer sees the group after relaunch', device: devC, flow: 'groups/group-gone.yaml', env: { NAME: name }, expected: 'Group not listed for C', screen: 'chats', optional: true });
  await ctx.observe(devC, { id: 'groups-16b-c-screen', title: 'What C sees after removal', screen: 'chats' });

  await ctx.step({
    id: 'groups-17-transfer-ownership', title: 'A transfers ownership to B (Owner chip)', device: devA, flow: 'groups/set-role.yaml', env: { ROLE: 'Owner', NAME: B.displayName },
    expected: 'server B owner; A demoted (record A\'s new role)', screen: 'group → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.members(gid), (rows) => rows.find((r) => r.user_id === B.userId)?.role === 'owner', { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row }; },
  });
  await ctx.observe(devA, { id: 'groups-17b-after-transfer', title: 'A\'s view after transfer (own role in members list)', screen: 'group' });
  await ctx.step({
    id: 'groups-18-leave', title: 'A leaves the group', device: devA, flow: 'groups/leave-group.yaml',
    expected: 'Sheet closes, A back in Chats; server A not active', screen: 'group → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.members(gid), (rows) => { const a = rows.find((r) => r.user_id === A.userId); return !a || a.status !== 'active'; }, { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row?.find?.((r) => r.user_id === A.userId) ?? 'row gone' }; },
  });
  await ctx.observe(devA, { id: 'groups-18b-after-leave', title: 'Where A lands after leaving', screen: 'chats' });
  await openGroup(devB, 'B');
  await ctx.observe(devB, { id: 'groups-19-owner-timeline', title: 'New owner B\'s timeline (system rows for role change/leave)', screen: 'group' });
  await ctx.step({
    id: 'groups-20-avatar', title: 'New owner B sets a group photo', device: devB, flow: 'groups/group-avatar.yaml',
    expected: '"Change photo" after upload; server avatar_path set', screen: 'group → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.conversationRow(gid), (r) => Boolean(r?.avatar_path), { timeoutMs: 60_000 }); return { ok: w.ok, detail: w.row }; },
    timeoutMs: 400_000,
  });
  ctx.accounts = { A, B, C };
}
