import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const load = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('shared workspace creates every initial member role through one atomic command', async () => {
  const [workspace, repository, screen] = await Promise.all([
    load('../apps/newone/src/state/workspace.tsx'),
    load('../apps/newone/src/data/repositories/bff-command-repository.ts'),
    load('../apps/newone/src/app/new-group.tsx'),
  ]);
  assert.match(workspace, /memberAssignments: input\.members/);
  assert.doesNotMatch(workspace, /for \(const member of input\.members\)[\s\S]{0,400}addConversationMember/);
  assert.match(repository, /\/v2\/conversations\/group\/candidates\/query/);
  assert.match(repository, /memberAssignments: input\.memberAssignments/);
  assert.match(screen, /queryGroupCreationCandidates/);
  assert.match(screen, /membershipType === 'guest' && role !== 'member'/);
  assert.match(screen, /group\.guestRoleLocked/);
  assert.match(screen, /group\.postingAdminsOnly/);
  assert.match(screen, /group\.joinApproval/);
});

test('role updates are recent-AAL2 compare-and-set commands reflected only after receipt', async () => {
  const [routes, repository, workspace, pane] = await Promise.all([
    load('../supabase/functions/newone-api/routes.ts'),
    load('../apps/newone/src/data/repositories/bff-command-repository.ts'),
    load('../apps/newone/src/state/workspace.tsx'),
    load('../apps/newone/src/features/chat/conversation-pane.tsx'),
  ]);
  assert.match(routes, /kind: 'conversation\.member\.role\.update'[\s\S]{0,220}requireAal2: true,[\s\S]{0,80}recentAuthSeconds: 900/);
  assert.match(routes, /bff_update_conversation_member_role/);
  assert.match(routes, /conversation-member-role/);
  assert.match(repository, /expectedRole: input\.expectedRole, newRole: input\.newRole/);
  assert.match(workspace, /conversation\.memberRoles\?\.\[personId\] !== expectedRole/);
  assert.match(workspace, /\[personId\]: receipt\.role/);
  assert.match(pane, /onUpdateMemberRole/);
  assert.match(pane, /chat\.memberRoleSecurity/);
});

test('conversation system events are exact, target-bound, and localized in all supported languages', async () => {
  const [reader, pane, catalog] = await Promise.all([
    load('../apps/newone/src/data/repositories/web-read-repository.ts'),
    load('../apps/newone/src/features/chat/conversation-pane.tsx'),
    load('../apps/newone/src/i18n/catalog.ts'),
  ]);
  assert.match(reader, /hasExactKeys\(systemEventRow, \['eventType', 'targetUserId'\]\)/);
  for (const event of [
    'conversation.created',
    'conversation.member.added',
    'conversation.member.removed',
    'conversation.member.role_changed',
  ]) assert.match(reader, new RegExp(event.replaceAll('.', '\\.')));
  assert.match(pane, /chat\.systemConversationCreated/);
  assert.match(pane, /chat\.systemMemberAdded/);
  assert.match(pane, /chat\.systemMemberRemoved/);
  assert.match(pane, /chat\.systemMemberRoleChanged/);
  for (const key of [
    'chat.systemConversationCreated',
    'chat.systemMemberAdded',
    'chat.systemMemberRemoved',
    'chat.systemMemberRoleChanged',
    'chat.memberRoleSecurity',
  ]) assert.equal((catalog.match(new RegExp(`'${key.replaceAll('.', '\\.')}':`, 'g')) ?? []).length, 3);
});
