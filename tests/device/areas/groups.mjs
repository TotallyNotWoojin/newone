// GROUPS on three devices: A (owner), B, C. Anyone can be added to a group
// (Sep 2026 social stream), so there is no friendship setup: A creates the
// group by finding B through the picker's people search, then fan-out,
// add/remove, promote/demote, member self-role check, ownership transfer,
// leave, avatar, @mention.
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

  // The friendship setup loop (setup-friend-*: search → Connect → Requests →
  // Accept) is gone: connect requests no longer exist for consumers and the
  // group picker finds anyone by name or @username.

  // v3.3 (backlog 35): what the form says before anything is typed — the
  // optional name, description and photo, the collapsed Advanced options with
  // its summary line, the three-person rule, and the picker keeping contacts
  // and strangers apart. Nothing is created; the form is cancelled.
  await ctx.step({
    id: 'groups-00-create-form', title: 'The creation form: optional name/description/photo, collapsed Advanced options with its summary, contacts above strangers', device: devA,
    flow: 'groups/create-form-optional.yaml',
    expected: '"Group name (optional)", "Description (optional)", "Add a photo (optional)", "A group needs three people — you and two others.", "Advanced options" closed over "Everyone can post · new members start from when they join"; opening it shows "Who can post" and "Chat history for people added later"; the picker shows "Your contacts" then "Search everyone"',
    screen: 'new-group',
  });
  // v3.3 (backlog 36): two people is not a group. The client keeps Create
  // disabled and says why; the service refuses the same shape (Deno
  // group-rules tests, tests/hosted/group-rules-smoke.mjs).
  await ctx.step({
    id: 'groups-00b-minimum-three', title: 'One person picked: the form says a group needs three and Create stays disabled; a second person enables it', device: devA,
    flow: 'groups/minimum-three.yaml', env: { MEMBER1: B.displayName, MEMBER1_QUERY: B.username, MEMBER2: C.displayName, MEMBER2_QUERY: C.username },
    expected: '"1 selected" with "A group needs three people — you and two others." and a disabled Create; "2 selected" with Create enabled; nothing created',
    screen: 'new-group',
    serverTruth: async () => { const rows = await server.sql(`select count(*)::int as groups from public.conversations where organization_id = ${server.lit(server.ORG)} and kind = 'group' and created_at > now() - interval '5 minutes' and name like 'Crew %'`); return { ok: (rows[0]?.groups ?? 0) === 0, detail: rows[0] }; },
  });

  const name = `Crew ${tag}`;
  const created = await ctx.step({
    id: 'groups-01-create', title: 'A creates a group with B and C (v3.3: three people, both found by @username search)', device: devA,
    flow: 'groups/create-group.yaml', env: { NAME: name, MEMBER1: B.displayName, MEMBER1_QUERY: B.username, HAS_MEMBER2: 'true', MEMBER2: C.displayName, MEMBER2_QUERY: C.username },
    expected: 'Group conversation opens; server conversations row with A owner + B and C members (three people)', screen: 'new-group',
    serverTruth: async () => { const w = await server.waitFor(() => server.groupByName(name), (r) => Boolean(r), { timeoutMs: 20_000 }); const m = w.row ? await server.members(w.row.id) : []; const active = m.filter((r) => r.status === 'active'); return { ok: w.ok && active.length === 3 && m.some((r) => r.user_id === A.userId && r.role === 'owner') && m.some((r) => r.user_id === B.userId) && m.some((r) => r.user_id === C.userId), detail: { group: w.row?.id, members: m } }; },
  });
  if (!created.uiOk) return;
  const group = await server.groupByName(name);
  const gid = group.id;
  const openGroup = (dev, who) => ctx.step({ id: `groups-open-${who}-${ctx.seq = (ctx.seq ?? 0) + 1}`, title: `${who} opens the group`, device: dev, flow: 'common/open-conversation.yaml', env: { PEER: name }, expected: 'composer', screen: 'chats' });

  // v3.3 (backlog 37): the rule is the member set, not the name. Picking B and
  // C again offers the group that exists instead of making a second one, and
  // "Open it" lands in it.
  await ctx.step({
    id: 'groups-01b-duplicate-guard', title: 'A picks B and C again under a different name: "You already have a group with these people." → "Open it" opens the existing group', device: devA,
    flow: 'groups/duplicate-guard.yaml', env: { NAME: `Crew again ${tag}`, MEMBER1: B.displayName, MEMBER1_QUERY: B.username, MEMBER2: C.displayName, MEMBER2_QUERY: C.username, EXISTING: name },
    expected: 'The duplicate notice with an "Open it" button; tapping it opens the existing group; server: still exactly one group with that member set and no conversation named "Crew again …"',
    screen: 'new-group',
    serverTruth: async () => {
      const rows = await server.sql(`select id, name from public.conversations
        where organization_id = ${server.lit(server.ORG)} and kind = 'group' and name like ${server.lit(`Crew%${tag}`)}`);
      return { ok: rows.length === 1 && rows[0].id === gid, detail: rows };
    },
  });

  const g1 = `Group hello ${tag}`;
  await ctx.step({ id: 'groups-02-send', title: 'A posts in the group', device: devA, flow: 'chat/send-text.yaml', env: { TEXT: g1 }, expected: 'bubble; server row', screen: 'group', serverTruth: async () => { const w = await server.waitFor(() => server.messageByBody(gid, g1), (r) => Boolean(r), { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row?.id }; } });
  await ctx.step({ id: 'groups-03-b-sees-group', title: 'B sees the group in Chats', device: devB, flow: 'groups/group-in-chats.yaml', env: { NAME: name }, expected: 'group row listed', screen: 'chats' });
  await openGroup(devB, 'B');
  await ctx.step({ id: 'groups-04-b-receives', title: 'B receives the group message', device: devB, flow: 'chat/see-text.yaml', env: { TEXT: g1, TIMEOUT: '30000' }, expected: 'visible', screen: 'group' });

  // v3.3: everybody is already in the group (a group of two is refused), so
  // "add a member" is proved by taking C out and putting C back. The re-add is
  // the case migration 20260908070000 fixed: a departed membership is revived
  // rather than colliding with the primary key.
  await ctx.step({
    id: 'groups-05a-remove-from-member-row', title: 'A removes C from the member row ("Options for …" → Remove from group)', device: devA, flow: 'groups/member-remove.yaml', env: { NAME: C.displayName },
    expected: 'C\'s row goes; system row "… was removed from the group."; server C no longer active', screen: 'group → Conversation controls → People in this group',
    serverTruth: async () => { const w = await server.waitFor(() => server.members(gid), (rows) => { const c = rows.find((r) => r.user_id === C.userId); return !c || c.status !== 'active'; }, { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row?.find?.((r) => r.user_id === C.userId) ?? 'row gone' }; },
  });
  await ctx.step({
    id: 'groups-05-add-member', title: 'A adds C back from the controls sheet (Add people → Search people → Add to group): a departed membership is revived, not rejected', device: devA, flow: 'groups/add-member.yaml', env: { NAME: C.displayName, QUERY: C.username },
    expected: 'C added again; system row "… was added to the group."; server 3 active members and no primary-key conflict', screen: 'group → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.members(gid), (rows) => rows.filter((r) => r.status === 'active').length === 3 && rows.some((r) => r.user_id === C.userId && r.status === 'active'), { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row }; },
  });
  const g2 = `Fan-out ${tag}`;
  await ctx.step({ id: 'groups-06-send-2', title: 'A posts again (fan-out to B and C)', device: devA, flow: 'chat/send-text.yaml', env: { TEXT: g2 }, expected: 'bubble', screen: 'group' });
  await ctx.step({ id: 'groups-07-b-receives-2', title: 'B receives the fan-out message', device: devB, flow: 'chat/see-text.yaml', env: { TEXT: g2, TIMEOUT: '30000' }, expected: 'visible on B', screen: 'group' });
  await ctx.step({ id: 'groups-08-c-sees-group', title: 'C sees the group in Chats after being added', device: devC, flow: 'groups/group-in-chats.yaml', env: { NAME: name }, expected: 'listed', screen: 'chats' });
  await openGroup(devC, 'C');
  await ctx.step({ id: 'groups-09-c-receives-2', title: 'C receives the fan-out message', device: devC, flow: 'chat/see-text.yaml', env: { TEXT: g2, TIMEOUT: '30000' }, expected: 'visible on C', screen: 'group' });
  await ctx.observe(devC, { id: 'groups-09b-c-history', title: 'What C sees of the history from before joining (history policy)', screen: 'group' });

  const m1 = `Mention probe ${tag}`;
  await ctx.step({ id: 'groups-10-mention', title: 'A @mentions B in the group', device: devA, flow: 'groups/mention.yaml', env: { NAME: B.displayName, TEXT: m1 }, expected: 'Mention picker ("People" list) works; message sends', screen: 'group → Mention people' });
  await ctx.step({ id: 'groups-11-b-sees-mention', title: 'B sees the mention message', device: devB, flow: 'chat/see-text.yaml', env: { TEXT: m1, TIMEOUT: '30000' }, expected: 'visible', screen: 'group' });
  await ctx.observe(devB, { id: 'groups-11b-mention-render', title: 'Mention rendering on B', screen: 'group' });

  await ctx.step({
    id: 'groups-12-promote', title: 'A promotes B to Admin', device: devA, flow: 'groups/set-role.yaml', env: { ROLE: 'Admin', NAME: B.displayName },
    expected: 'Chip selected; system row "… had their role changed."; server role admin', screen: 'group → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.members(gid), (rows) => rows.find((r) => r.user_id === B.userId)?.role === 'admin', { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row?.find?.((r) => r.user_id === B.userId) }; },
  });
  await ctx.step({
    id: 'groups-13-demote', title: 'A demotes B back to Member', device: devA, flow: 'groups/set-role.yaml', env: { ROLE: 'Member', NAME: B.displayName },
    expected: 'server role member', screen: 'group → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.members(gid), (rows) => rows.find((r) => r.user_id === B.userId)?.role === 'member', { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row?.find?.((r) => r.user_id === B.userId) }; },
  });
  await ctx.step({
    id: 'groups-14-member-self-role', title: 'Member (B) cannot change roles: no role chips/remove/add controls', device: devB, flow: 'groups/member-self-role-check.yaml', env: { SELF: B.displayName, OTHER: C.displayName },
    expected: 'Controls sheet for a member shows the People list without role chips, Remove buttons or the Add people section', screen: 'group → Conversation controls',
    serverTruth: async () => { const rows = await server.members(gid); return { ok: rows.find((r) => r.user_id === B.userId)?.role === 'member', detail: rows }; },
  });


  // v3.3 (backlog 50): a member row is where you act on a person — message
  // them, add them as a friend, mute them, block them, remove them. Mute and
  // block are personal settings and hide nothing, so both are put back.
  await ctx.step({
    id: 'groups-14b-member-actions', title: 'A acts on C from the member row: Add as friend → Mute → Unmute → Block → Unblock', device: devA,
    flow: 'groups/member-actions.yaml', env: { NAME: C.displayName },
    expected: '"People in this group" lists C; "Options for C" opens Message / Add as friend / Mute / Block; Add as friend becomes "Request sent"; Mute shows "Muted" on the row and offers Unmute; Block shows "Blocked" and offers Unblock; server: a contact_connections request, a person_mutes row while muted and none after, a member_blocks row while blocked and none after',
    screen: 'group → Conversation controls → People in this group',
    serverTruth: async () => {
      const connection = await server.connection(A.userId, C.userId);
      const mute = await server.one(`select count(*)::int as mutes from public.person_mutes
        where organization_id = ${server.lit(server.ORG)} and muter_user_id = ${server.lit(A.userId)}::uuid and muted_user_id = ${server.lit(C.userId)}::uuid`);
      const block = await server.block(A.userId, C.userId);
      return {
        ok: Boolean(connection) && Number(mute?.mutes) === 0 && Number(block?.blocks) === 0,
        detail: { connection: connection ?? 'none', mutes_left: mute?.mutes, blocks_left: block?.blocks },
      };
    },
  });
  // "Message" leaves the group for the one-to-one chat with that person.
  await ctx.step({
    id: 'groups-14c-member-message', title: 'A taps Message on B\'s member row: the one-to-one chat with B opens', device: devA,
    flow: 'groups/member-message.yaml', env: { NAME: B.displayName, GROUP: name },
    expected: 'The direct conversation with B opens (composer, header naming B, the group name gone); server: a direct conversation between A and B',
    screen: 'group → Conversation controls → People in this group → conversation',
    serverTruth: async () => { const w = await server.waitFor(() => server.directConversation(A.userId, B.userId), (row) => Boolean(row), { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row?.id ?? 'no direct conversation' }; },
  });
  await openGroup(devA, 'A');

  await ctx.step({
    id: 'groups-15-remove-member', title: 'A removes C', device: devA, flow: 'groups/remove-member.yaml', env: { NAME: C.displayName },
    expected: 'System row "… was removed from the group."; server C not active', screen: 'group → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.members(gid), (rows) => { const c = rows.find((r) => r.user_id === C.userId); return !c || c.status !== 'active'; }, { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row?.find?.((r) => r.user_id === C.userId) ?? 'row gone' }; },
  });
  await ctx.step({ id: 'groups-16-c-after-removal', title: 'Removed member C no longer sees the group after relaunch', device: devC, flow: 'groups/group-gone.yaml', env: { NAME: name }, expected: 'Group not listed for C', screen: 'chats', optional: true });
  await ctx.observe(devC, { id: 'groups-16b-c-screen', title: 'What C sees after removal', screen: 'chats' });

  await ctx.step({
    id: 'groups-17-transfer-ownership', title: 'A transfers ownership to B (Owner chip)', device: devA, flow: 'groups/set-role.yaml', env: { ROLE: 'Owner', NAME: B.displayName },
    expected: 'server B owner; A demoted (record A\'s new role)', screen: 'group → Conversation controls',
    serverTruth: async () => { const w = await server.waitFor(() => server.members(gid), (rows) => rows.find((r) => r.user_id === B.userId)?.role === 'owner', { timeoutMs: 20_000 }); return { ok: w.ok, detail: w.row }; },
  });
  await ctx.observe(devA, { id: 'groups-17b-after-transfer', title: 'A\'s view after transfer (own role in the People list)', screen: 'group' });
  await ctx.step({
    id: 'groups-18-leave', title: 'A leaves the group ("I understand" → Leave group)', device: devA, flow: 'groups/leave-group.yaml',
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
