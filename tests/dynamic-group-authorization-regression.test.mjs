import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationPath =
  'supabase/migrations/20260804172800_restore_dynamic_group_authorization.sql';
const migration = await readFile(migrationPath, 'utf8');

function sqlFunction(name) {
  const start = migration.indexOf(`create or replace function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = migration.indexOf('\n$$;', start);
  assert.notEqual(end, -1, `unterminated ${name}`);
  return migration.slice(start, end + 4);
}

test('current membership requires lifecycle access and dynamic policy eligibility', () => {
  const helper = sqlFunction('private.is_conversation_member');
  assert.match(helper, /private\.current_session_active_for_org\(p_organization_id\)/);
  assert.match(helper, /member\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(helper, /member\.status = 'active'/);
  assert.match(helper, /private\.organization_membership_access_current/);
  assert.match(helper, /not private\.dynamic_group_policy_conversation/);
  assert.match(helper, /or private\.dynamic_group_user_currently_eligible/);
});

test('conversation administration keeps non-guest lifecycle and dynamic eligibility gates', () => {
  const helper = sqlFunction('private.is_conversation_admin');
  assert.match(helper, /member\.role in \('owner', 'admin'\)/);
  assert.match(helper, /organization_member\.membership_type <> 'guest'/);
  assert.match(helper, /private\.organization_membership_access_current/);
  assert.match(helper, /not private\.dynamic_group_policy_conversation/);
  assert.match(helper, /or private\.dynamic_group_user_currently_eligible/);
});

test('the repair narrows only the two shared authorization predicates', () => {
  assert.equal(
    (migration.match(/create or replace function private\.is_conversation_/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(migration, /create policy|alter policy|drop policy/i);
  assert.doesNotMatch(migration, /grant\s+/i);
  assert.match(migration, /begin;[\s\S]*commit;/);
});
