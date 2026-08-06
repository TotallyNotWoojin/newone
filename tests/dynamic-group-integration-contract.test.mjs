import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const files = Object.fromEntries(await Promise.all(Object.entries({
  migration: 'supabase/migrations/20260804172300_complete_dynamic_group_client_contract.sql',
  delegatedMigration: 'supabase/migrations/20260804172700_delegate_conversation_management.sql',
  lifecycleMigration: 'supabase/migrations/20260804171845_complete_policy_managed_team_groups.sql',
  routes: 'supabase/functions/newone-api/routes.ts',
  contracts: 'apps/newone/src/data/repositories/contracts.ts',
  repository: 'apps/newone/src/data/repositories/bff-command-repository.ts',
  workspace: 'apps/newone/src/state/workspace.tsx',
  admin: 'apps/newone/src/app/admin.tsx',
  section: 'apps/newone/src/features/admin/dynamic-group-section.tsx',
  copy: 'apps/newone/src/features/admin/dynamic-group-copy.ts',
  reader: 'apps/newone/src/data/repositories/web-read-repository.ts',
  domain: 'apps/newone/src/domain/types.ts',
  offline: 'apps/newone/src/data/persistence/offline-workspace.mjs',
}).map(async ([name, path]) => [name, await readFile(path, 'utf8')])));

test('database list contract is service-only, recent-AAL2, bounded, and exact-scope', () => {
  assert.match(files.migration, /private\.bff_list_dynamic_group_policies_impl/);
  assert.match(files.migration, /'dynamic_group\.policy\.read',\s*true,\s*900/);
  assert.match(files.migration, /p_limit not between 1 and 100/);
  assert.match(files.migration, /policy\.id > p_after_policy_id/);
  assert.match(files.migration, /order by policy\.id\s+limit p_limit \+ 1/);
  assert.match(files.migration, /'unit\.manage',\s*conversation\.unit_id/);
  assert.match(files.migration, /'unit\.manage',\s*selected\.unit_id/);
  assert.match(files.migration, /revoke all on function public\.bff_list_dynamic_group_policies[\s\S]*from public, anon, authenticated/);
  assert.match(files.migration, /grant execute on function public\.bff_list_dynamic_group_policies[\s\S]*to service_role/);
});

test('Edge exposes save-preview-publish-pause CAS and removes fail-closed legacy routes', () => {
  for (const kind of ['list', 'save', 'preview', 'publish', 'pause']) {
    assert.match(files.routes, new RegExp(`'dynamic_group\\.${kind}'`));
  }
  assert.match(files.routes, /\/v2\/dynamic-groups\/policies\/query/);
  assert.match(files.routes, /bff_save_dynamic_group_policy_v2/);
  assert.match(files.routes, /bff_preview_dynamic_group_v2/);
  assert.match(files.routes, /bff_publish_dynamic_group_policy/);
  assert.match(files.routes, /bff_pause_dynamic_group_policy/);
  assert.match(files.routes, /p_preview_fingerprint: values\.previewFingerprint/);
  assert.match(files.routes, /receipt\.policyVersion !== values\.expectedVersion/);
  assert.doesNotMatch(files.routes, /kind: 'dynamic_group\.sync'/);
  assert.doesNotMatch(files.routes, /'bff_sync_dynamic_group'/);
  assert.doesNotMatch(files.routes, /'bff_save_dynamic_group_policy',/);
  assert.match(files.lifecycleMigration, /legacy save\/sync contract has no compare-and-swap/);
});

test('repository and workspace preserve strict receipts, versions, and fresh preview fingerprints', () => {
  for (const method of [
    'listDynamicGroupPolicies',
    'saveDynamicGroupPolicy',
    'previewDynamicGroupPolicy',
    'publishDynamicGroupPolicy',
    'pauseDynamicGroupPolicy',
  ]) {
    assert.match(files.contracts, new RegExp(method));
    assert.match(files.repository, new RegExp(method));
    assert.match(files.workspace, new RegExp(method));
  }
  assert.match(files.repository, /parseDynamicGroupPolicyList\(dataValue\(payload\)\)/);
  assert.match(files.repository, /parseDynamicGroupSaveReceipt\(dataValue\(payload\)\)/);
  assert.match(files.repository, /expectedReceiptVersion = input\.policyId \? input\.expectedVersion \+ 1 : 1/);
  assert.match(files.repository, /previewFingerprint: input\.previewFingerprint/);
  assert.match(files.workspace, /idempotencyKey: createClientId\(\)/);
  assert.match(files.workspace, /dynamicGroupOrganizationId === snapshot\?\.organizationId/);
  assert.doesNotMatch(files.offline, /dynamicGroupPolicies|dynamicGroupNextAfterPolicyId/);
});

test('responsive admin UI covers units, lines, roles, descendants, shifts, preview samples, publish, and pause', () => {
  assert.match(files.admin, /<DynamicGroupSection privilegedReady=\{privilegedReady\}/);
  assert.match(files.section, /testID="dynamic-group-section"/);
  assert.match(files.section, /unit\.kind === 'line'[\s\S]{0,80}setLineIds/);
  assert.match(files.section, /unit\.kind === 'line'[\s\S]{0,80}lineIds/);
  assert.match(files.section, /label=\{`\$\{copy\[unit\.kind\]\} · \$\{unit\.name\}`\}/);
  assert.equal((files.section.match(/\['current', copy\.shiftCurrent\]/g) ?? []).length, 1);
  assert.match(files.section, /includeDescendants/);
  assert.match(files.section, /membershipRoleOrder/);
  assert.match(files.section, /conversation\.canManageDynamicGroup === true/);
  assert.doesNotMatch(files.section, /conversation\.canManage !== false/);
  assert.match(files.section, /conversationKindLabel\[policy\.conversationKind\]/);
  assert.match(files.section, /label=\{membershipRoleLabel\[role\]\}/);
  assert.match(files.section, /operationalRoles/);
  assert.match(files.section, /preview\.addedSampleUserIds/);
  assert.match(files.section, /preview\.removedSampleUserIds/);
  assert.match(files.section, /preview\.unchangedSampleUserIds/);
  assert.match(files.section, /preview\.previewFingerprint/);
  assert.match(files.section, /pauseReason\.trim\(\)/);
  assert.match(files.section, /flexWrap: 'wrap'/);
  for (const locale of ['const en =', 'const ko:', 'const es:']) assert.match(files.copy, new RegExp(locale));
  for (const label of [
    'savePreview', 'previewTitle', 'publish', 'pauseReason', 'securityNote',
    'site', 'department', 'team', 'line', 'shift', 'groupKind', 'teamKind',
    'shiftKind', 'ownerRole', 'adminRole', 'managerRole', 'memberRole',
  ]) {
    assert.equal((files.copy.match(new RegExp(`\\b${label}:`, 'g')) ?? []).length, 3);
  }
});

test('dynamic-group reachability is projected separately from conversation administration', () => {
  assert.match(files.delegatedMigration, /private\.actor_can_manage_dynamic_group_conversation/);
  assert.match(files.delegatedMigration, /conversation\.kind in \('group', 'team', 'shift'\)/);
  assert.match(files.delegatedMigration, /conversation\.unit_id is not null/);
  assert.match(files.delegatedMigration, /'unit\.manage',\s*conversation\.unit_id/);
  assert.match(files.delegatedMigration, /'can_manage_dynamic_group'/);
  assert.match(files.delegatedMigration, /'management_only', true/);
  assert.match(files.domain, /canManageDynamicGroup\?: boolean/);
  assert.match(files.reader, /canManageDynamicGroup: row\.canManageDynamicGroup === true/);
});
