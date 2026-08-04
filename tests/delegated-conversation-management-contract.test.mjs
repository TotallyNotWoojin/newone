import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const paths = {
  migration: 'supabase/migrations/20260804172700_delegate_conversation_management.sql',
  dynamicLifecycle: 'supabase/migrations/20260804171845_complete_policy_managed_team_groups.sql',
  webReader: 'apps/newone/src/data/repositories/web-read-repository.ts',
  domain: 'apps/newone/src/domain/types.ts',
  workspace: 'apps/newone/src/state/workspace.tsx',
  conversationPane: 'apps/newone/src/features/chat/conversation-pane.tsx',
  conversationList: 'apps/newone/src/features/chat/conversation-list.tsx',
  chatIndex: 'apps/newone/src/app/index.tsx',
  managedSection: 'apps/newone/src/features/admin/managed-conversation-section.tsx',
  admin: 'apps/newone/src/app/admin.tsx',
  workspaceState: 'apps/newone/src/components/workspace/workspace-state.tsx',
  scaffold: 'apps/newone/src/components/navigation/app-scaffold.tsx',
  layout: 'apps/newone/src/app/_layout.tsx',
  updates: 'apps/newone/src/app/updates.tsx',
  search: 'apps/newone/src/app/search.tsx',
  handoffs: 'apps/newone/src/app/handoffs.tsx',
  catalog: 'apps/newone/src/i18n/catalog.ts',
  dynamicSection: 'apps/newone/src/features/admin/dynamic-group-section.tsx',
  dynamicCopy: 'apps/newone/src/features/admin/dynamic-group-copy.ts',
  e2e: 'tests/e2e/auth.spec.mjs',
};

const files = Object.fromEntries(await Promise.all(
  Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, 'utf8')]),
));

function sqlFunction(name) {
  const start = files.migration.indexOf(`create or replace function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = files.migration.indexOf('\n$$;', start);
  assert.notEqual(end, -1, `unterminated ${name}`);
  return files.migration.slice(start, end + 4);
}

test('canonical conversation management is current, tenant-bound, scope-bound, and non-guest', () => {
  const administrator = sqlFunction('private.actor_is_current_conversation_admin');
  const helper = sqlFunction('private.actor_can_manage_conversation');
  assert.match(administrator, /dynamic_group_policy_conversation/);
  assert.match(administrator, /dynamic_group_user_currently_eligible/);
  assert.match(helper, /private\.actor_is_current_conversation_admin/);
  assert.match(helper, /conversation\.organization_id = p_organization_id/);
  assert.match(helper, /conversation\.id = p_conversation_id/);
  assert.match(helper, /conversation\.kind <> 'direct'/);
  assert.match(helper, /conversation\.kind = 'announcement'[\s\S]*conversation\.unit_id is null/);
  assert.match(helper, /actor\.membership_type <> 'guest'/);
  assert.match(helper, /organization_membership_access_current/);
  assert.match(helper, /'conversation\.manage',[\s\n]*conversation\.unit_id/);
  assert.match(helper, /assignment|actor_has_permission/);
});

test('global conversation/content authorization is not widened', () => {
  assert.doesNotMatch(files.migration, /create or replace function private\.is_conversation_admin/);
  assert.doesNotMatch(files.migration, /create or replace function private\.bff_update_conversation_member_role_impl/);
  assert.doesNotMatch(files.migration, /create or replace function private\.bff_close_incident_impl/);
  assert.doesNotMatch(files.migration, /create or replace function private\.bff_set_summary_policy_impl/);
  assert.doesNotMatch(files.migration, /create or replace function private\.bff_create_conversation_avatar_upload_impl/);
  assert.doesNotMatch(files.migration, /create policy|alter policy|drop policy/i);
});

test('only metadata, controls, roster, and join-request workflows use delegated authorization', () => {
  for (const name of [
    'private.bff_update_conversation_impl',
    'private.bff_add_conversation_member_impl',
    'private.bff_remove_conversation_member_impl',
    'private.bff_update_conversation_controls_impl',
    'private.bff_decide_conversation_join_request_impl',
    'private.bff_list_conversation_join_requests_impl',
  ]) {
    assert.match(sqlFunction(name), /private\.actor_can_manage_conversation/);
  }
  assert.match(sqlFunction('private.bff_add_conversation_member_impl'),
    /conversation\.kind in \('group', 'team', 'shift', 'incident'\)/);
  assert.match(sqlFunction('private.bff_add_conversation_member_impl'),
    /delegated managers may add conversation members only/);
  assert.match(sqlFunction('private.bff_remove_conversation_member_impl'),
    /conversation\.kind in \('group', 'team', 'shift', 'incident'\)/);
  assert.match(sqlFunction('private.bff_remove_conversation_member_impl'),
    /delegated managers may remove ordinary non-policy members only/);
  assert.match(sqlFunction('private.bff_remove_conversation_member_impl'),
    /managed_by_policy_id is null/);
  assert.match(sqlFunction('private.bff_update_conversation_impl'),
    /conversation avatar management requires a current conversation administrator/);
});

test('current authorization precedes every privileged idempotent replay return', () => {
  for (const name of [
    'private.bff_update_conversation_impl',
    'private.bff_add_conversation_member_impl',
    'private.bff_remove_conversation_member_impl',
    'private.bff_update_conversation_controls_impl',
    'private.bff_decide_conversation_join_request_impl',
  ]) {
    const source = sqlFunction(name);
    const authorization = source.indexOf('private.actor_can_manage_conversation');
    const replay = source.indexOf("if v_command ->> 'state' = 'replay'");
    assert.notEqual(authorization, -1, `${name} lacks current authorization`);
    assert.notEqual(replay, -1, `${name} lacks replay handling`);
    assert.ok(authorization < replay, `${name} returns replay before current authorization`);
  }
});

test('metadata mutation rechecks current management and avatar authority in the update statement', () => {
  const update = sqlFunction('private.bff_update_conversation_impl');
  const mutation = update.slice(update.indexOf('update public.conversations'));
  assert.match(mutation, /private\.actor_can_manage_conversation\(/);
  assert.match(mutation, /not \(p_patch \? 'avatar_path'\)/);
  assert.match(mutation, /private\.actor_is_current_conversation_admin\(/);
  assert.match(mutation, /using errcode = '42501'/);
});

test('delegated writes are trigger-bound and preserve dynamic and owner locks', () => {
  const memberTrigger = sqlFunction('private.validate_conversation_member_write');
  const controlsTrigger = sqlFunction('private.validate_conversation_controls_update');
  for (const source of [
    sqlFunction('private.bff_add_conversation_member_impl'),
    sqlFunction('private.bff_remove_conversation_member_impl'),
    sqlFunction('private.bff_decide_conversation_join_request_impl'),
    sqlFunction('private.bff_update_conversation_controls_impl'),
  ]) assert.match(source, /app\.delegated_conversation_management_context/);
  assert.match(memberTrigger, /app\.bff_service_context/);
  assert.match(memberTrigger, /only conversation owners may add another owner/);
  assert.match(memberTrigger, /only conversation owners may manage owner roles/);
  assert.match(memberTrigger, /a managed conversation must retain an active owner/);
  assert.match(memberTrigger, /dynamic membership provenance is server-owned/);
  assert.match(memberTrigger, /delegated managers may add conversation members only/);
  assert.match(memberTrigger, /delegated managers may remove ordinary non-policy members only/);
  assert.match(memberTrigger, /dynamic_group_policy_conversation/);
  assert.match(controlsTrigger, /dynamic_group_policies/);
  assert.match(files.dynamicLifecycle, /create trigger conversation_members_05_lock_dynamic_policy/);
});

test('bootstrap uses the same helper and emits content-free management shells', () => {
  const bootstrap = sqlFunction('private.bff_bootstrap_messaging_state_v9_impl');
  assert.match(bootstrap, /'can_manage', private\.actor_is_current_conversation_admin/);
  assert.match(bootstrap, /'can_manage_conversation', private\.actor_can_manage_conversation/);
  assert.match(bootstrap, /'can_manage', false/);
  assert.match(bootstrap, /'management_only', true/);
  assert.match(bootstrap, /'can_post', false/);
  assert.match(bootstrap, /'preview', null/);
  assert.match(bootstrap, /'unread_count', 0/);
  assert.match(bootstrap, /'messages', '\[\]'::jsonb/);
  assert.match(bootstrap, /'has_more', false/);
  assert.match(bootstrap, /p_conversation_limit - jsonb_array_length\(v_conversations\)/);
  assert.match(bootstrap, /dynamic_group_conversation_access_allowed_for_user/);
  assert.doesNotMatch(bootstrap,
    /actor_member\.user_id = p_actor_user_id[\s\S]*actor_member\.status = 'active'/);
  assert.match(bootstrap, /\{discoverable_conversations\}/);
  assert.doesNotMatch(bootstrap, /'body'/);
  assert.match(files.webReader, /canManage: row\.canManage === true/);
  assert.match(files.webReader, /canManageConversation: row\.canManageConversation === true/);
  assert.match(files.webReader, /managementOnly: row\.managementOnly === true/);
  assert.doesNotMatch(files.webReader, /canManage: memberRole === 'owner'/);
});

test('client keeps owner authority distinct from delegated conversation management', () => {
  assert.match(files.domain, /canManageConversation\?: boolean/);
  assert.match(files.domain, /managementOnly\?: boolean/);
  assert.match(files.conversationPane,
    /conversation\.canManageConversation[\s\S]{0,160}\['group', 'team', 'shift', 'incident'\]\.includes/);
  assert.match(files.conversationPane,
    /conversation\.canManageConversation[\s\S]{0,120}!conversation\.policyManaged[\s\S]{0,120}\['group', 'team'\]\.includes/);
  assert.match(files.conversationPane,
    /conversation\.canManage && \['group', 'team', 'shift', 'incident'\]\.includes/);
  assert.match(files.conversationPane, /const canManageSummary = conversation\.canManage === true/);
  assert.match(files.conversationPane,
    /conversation\.canManage && conversation\.kind === 'incident'/);
  assert.match(files.conversationPane, /conversation\.canManage && person\.id !== currentUserId/);
  assert.match(files.workspace, /conversation\?\.canManageConversation/g);
  assert.match(files.workspace, /const effectiveRole = conversation\.canManage \? role : 'member'/);
  assert.match(files.workspace,
    /!conversation\.canManage && conversation\.memberRoles\?\.\[personId\] !== 'member'/);
  assert.match(files.workspace,
    /conversation\.managementOnly[\s\S]{0,100}conversation\.canPost === false/);
  assert.match(files.workspace,
    /canPost: item\.managementOnly[\s\S]{0,120}\? false/);
  assert.match(files.webReader, /const memberCount = Math\.max\(0, integer\(row\.memberCount/);
  assert.match(files.webReader,
    /memberProfiles: row\.managementOnly === true \? memberProfiles : undefined/);
  assert.match(files.domain, /memberProfiles\?: ConversationMemberProfile\[\]/);
});

test('management-only shells never render as ordinary chat, search, forward, or handoff targets', () => {
  assert.match(files.conversationPane, /if \(conversation\.managementOnly\)/);
  assert.match(files.conversationPane, /if \(!conversationId \|\| conversation\?\.managementOnly\) return/);
  assert.match(files.conversationPane, /chat\.managementOnlyBody/);
  assert.match(files.conversationPane, /chat\.managementOnlyDynamicBody/);
  assert.match(files.conversationList, /if \(conversation\.managementOnly\) return false/);
  assert.match(files.conversationList,
    /visibleDiscoverableConversations[\s\S]*!managementOnlyIds\.has/);
  assert.match(files.chatIndex,
    /showDetails && selectedConversation && !selectedConversation\.managementOnly/);
  assert.match(files.chatIndex,
    /if \(!selectedConversation\?\.managementOnly\) return/);
  assert.match(files.chatIndex, /ordinaryConversations\.length === 0/);
  assert.match(files.workspaceState,
    /!workspace\.conversations\.some\([\s\S]{0,100}!conversation\.managementOnly/);
  assert.match(files.search, /if \(conversation\.managementOnly\) continue/);
  assert.match(files.search, /filter\(\(conversation\) => !conversation\.managementOnly\)/);
  assert.match(files.search, /conversationAuthorizationSignature/);
  assert.match(files.search, /resultsAuthorizationSignature/);
  assert.match(files.search, /managementOnlyConversationIds\.has\(result\.conversationId\)/);
  assert.match(files.handoffs, /conversation\.kind === 'shift' && !conversation\.managementOnly/);
  assert.match(files.updates,
    /conversation\.kind === 'announcement'[\s\S]{0,100}!conversation\.managementOnly/);
  assert.match(files.scaffold, /conversation\.managementOnly \? sum/);
  assert.match(files.layout, /conversation\.managementOnly[\s\S]{0,80}\? total/);
  assert.match(files.conversationPane,
    /!conversation\.managementOnly[\s\S]{0,120}conversation\.id !== message\.conversationId/);
  assert.match(files.workspace,
    /if \(conversation\.managementOnly\) return \[conversation\.id, \[\]\]/);
  assert.match(files.workspace,
    /if \(conversation\.managementOnly\) next\.cursors\[conversation\.id\] = null/);
  assert.match(files.managedSection,
    /conversation\.managementOnly === true[\s\S]*conversation\.canManageConversation === true[\s\S]*conversation\.canManageDynamicGroup === true/);
  assert.match(files.admin,
    /<ManagedConversationSection[\s\S]*pathname: '\/conversation\/\[id\]'/);
  for (const key of [
    'managementOnlyBadge', 'managementOnlyTitle', 'managementOnlyBody',
    'managementOnlyOpen', 'managementOnlyDynamicBody', 'managementOnlyOpenAdmin',
    'delegatedMemberSecurity', 'delegatedAddsMembersOnly',
  ]) {
    assert.equal((files.catalog.match(new RegExp(`'chat\\.${key}':`, 'g')) ?? []).length, 3);
  }
});

test('join-request identities and dynamic shell counts use current eligibility', () => {
  const list = sqlFunction('private.bff_list_conversation_join_requests_impl');
  const bootstrap = sqlFunction('private.bff_bootstrap_messaging_state_v9_impl');
  assert.match(list, /organization_membership_access_current\([\s\S]*requester\.organization_id/);
  assert.match(bootstrap, /counted_member\.user_id,[\s\n]*now\(\)/);
  assert.match(bootstrap, /private\.dynamic_group_user_currently_eligible/);
});

test('dynamic-group reachability is a distinct exact-unit capability', () => {
  const helper = sqlFunction('private.actor_can_manage_dynamic_group_conversation');
  const bootstrap = sqlFunction('private.bff_bootstrap_messaging_state_v9_impl');
  assert.match(helper, /conversation\.kind in \('group', 'team', 'shift'\)/);
  assert.match(helper, /conversation\.unit_id is not null/);
  assert.match(helper, /actor\.membership_type <> 'guest'/);
  assert.match(helper, /'unit\.manage',[\s\n]*conversation\.unit_id/);
  assert.match(bootstrap, /'can_manage_dynamic_group'/);
  assert.match(files.domain, /canManageDynamicGroup\?: boolean/);
  assert.match(files.webReader, /canManageDynamicGroup: row\.canManageDynamicGroup === true/);
  assert.match(files.dynamicSection, /conversation\.canManageDynamicGroup === true/);
  assert.doesNotMatch(files.dynamicSection, /conversation\.canManage !== false/);
});

test('dynamic-group raw enum labels are localized in all three supported locales', () => {
  assert.match(files.dynamicSection, /conversationKindLabel\[policy\.conversationKind\]/);
  assert.match(files.dynamicSection, /label=\{membershipRoleLabel\[role\]\}/);
  for (const key of [
    'groupKind', 'teamKind', 'shiftKind',
    'ownerRole', 'adminRole', 'managerRole', 'memberRole',
  ]) {
    assert.equal((files.dynamicCopy.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length, 3);
  }
  assert.doesNotMatch(files.e2e, /test\('unit manager can save/);
  assert.match(files.e2e, /test\('owner demo can save/);
});

test('new helpers are private and the V9 bootstrap remains service-only', () => {
  assert.match(files.migration, /revoke all on function[\s\S]*private\.actor_is_current_conversation_admin/);
  assert.match(files.migration, /revoke all on function[\s\S]*private\.actor_can_manage_conversation/);
  assert.match(files.migration, /private\.actor_can_manage_dynamic_group_conversation/);
  assert.match(files.migration, /grant execute on function private\.bff_bootstrap_messaging_state_v9_impl[\s\S]*to service_role/);
  assert.match(files.migration, /revoke all on function public\.bff_bootstrap_messaging_state[\s\S]*from public, anon, authenticated/);
  assert.match(files.migration, /grant execute on function public\.bff_bootstrap_messaging_state[\s\S]*to service_role/);
});
