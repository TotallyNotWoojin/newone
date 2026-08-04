import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const paths = {
  migration: 'supabase/migrations/20260804173000_list_conversation_member_candidates.sql',
  visibility: 'supabase/migrations/20260804172200_complete_group_creation.sql',
  routes: 'supabase/functions/newone-api/routes.ts',
  edgeTest: 'supabase/functions/tests/conversation_member_candidates_routes_test.ts',
  contracts: 'apps/newone/src/data/repositories/contracts.ts',
  repository: 'apps/newone/src/data/repositories/bff-command-repository.ts',
  demo: 'apps/newone/src/data/repositories/demo-repository.ts',
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

const implementation = sqlFunction('private.bff_list_conversation_member_candidates_impl');

test('candidate RPC rejects unauthorized actors and cross-tenant or closed targets', () => {
  assert.match(implementation, /private\.require_service_role\(\)/);
  assert.match(implementation, /private\.assert_bff_request_internal/);
  assert.match(implementation, /actor\.organization_id = p_organization_id/);
  assert.match(implementation, /actor\.user_id = p_actor_user_id/);
  assert.match(implementation, /actor\.membership_type <> 'guest'/);
  assert.match(implementation, /organization_membership_access_current/);
  assert.match(implementation, /conversation\.organization_id = p_organization_id/);
  assert.match(implementation, /conversation\.id = p_conversation_id/);
  assert.match(implementation, /conversation\.kind <> 'direct'/);
  assert.match(implementation, /not conversation\.is_archived/);
  assert.match(implementation, /conversation\.closed_at is null/);
  assert.match(implementation, /private\.actor_can_manage_conversation/);
  assert.match(implementation, /using errcode = '42501'/);
});

test('candidate rows stay tenant-current, privacy-aware, block-aware, and exclude self or any prior member row', () => {
  assert.match(implementation, /membership\.organization_id = p_organization_id/);
  assert.match(implementation, /membership\.user_id <> p_actor_user_id/);
  assert.match(implementation, /membership\.user_id, v_now/);
  assert.match(implementation, /private\.can_view_org_member_for_actor\(/);
  assert.match(implementation, /current_member\.organization_id = p_organization_id/);
  assert.match(implementation, /current_member\.conversation_id = p_conversation_id/);
  assert.match(implementation, /current_member\.user_id = membership\.user_id/);
  assert.doesNotMatch(implementation, /current_member\.status = 'active'/);

  const helperStart = files.visibility.indexOf(
    'create or replace function private.can_view_org_member_for_actor(',
  );
  assert.notEqual(helperStart, -1);
  const helperEnd = files.visibility.indexOf('\n$$;', helperStart);
  const helper = files.visibility.slice(helperStart, helperEnd + 4);
  assert.match(helper, /v_target\.directory_visibility = 'organization'/);
  assert.match(helper, /v_target\.directory_visibility = 'unit'/);
  assert.match(helper, /from public\.member_blocks block/);
  assert.match(helper, /block\.blocker_user_id = p_actor_user_id/);
  assert.match(helper, /block\.blocked_user_id = p_actor_user_id/);
});

test('published dynamic-policy conversations never advertise manual additions', () => {
  const policyCheck = implementation.indexOf('private.dynamic_group_policy_conversation');
  const candidateQuery = implementation.indexOf('with eligible as (');
  assert.notEqual(policyCheck, -1);
  assert.notEqual(candidateQuery, -1);
  assert.ok(policyCheck < candidateQuery, 'dynamic-policy denial must precede candidate selection');
  assert.match(implementation, /'candidates', '\[\]'::jsonb/);
  assert.match(implementation, /'next_cursor', null/);
});

test('query and keyset pagination are normalized, bounded, deterministic, and snapshot-bound', () => {
  assert.match(implementation, /p_limit not between 1 and 100/);
  assert.match(implementation, /char_length\(btrim\(coalesce\(p_query, ''\)\)\) > 120/);
  assert.match(implementation, /v_query := private\.normalize_search_text/);
  assert.match(implementation, /extensions\.digest\(convert_to\(v_query, 'UTF8'\), 'sha256'\)/);
  assert.match(implementation, /\(eligible\.sort_name, eligible\.user_id\) > \(v_after_name, v_after_user_id\)/);
  assert.match(implementation, /order by eligible\.sort_name, eligible\.user_id/);
  assert.match(implementation, /limit p_limit \+ 1/);
  assert.match(implementation, /membership\.updated_at <= v_snapshot_at/);
  assert.match(implementation, /profile\.updated_at <= v_snapshot_at/);
});

test('malformed, replayed across scope, and stale cursors fail closed', () => {
  assert.match(implementation, /char_length\(p_cursor\) > 1536/);
  assert.match(implementation, /count\(\*\).*<> 9/);
  for (const binding of [
    'actor_user_id', 'organization_id', 'conversation_id', 'query_sha256',
    'page_size', 'snapshot_at', 'after_name', 'after_user_id',
  ]) assert.match(implementation, new RegExp(binding));
  assert.match(implementation, /v_cursor_actor_user_id <> p_actor_user_id/);
  assert.match(implementation, /v_cursor_organization_id <> p_organization_id/);
  assert.match(implementation, /v_cursor_conversation_id <> p_conversation_id/);
  assert.match(implementation, /v_snapshot_at < v_now - interval '15 minutes'/);
  assert.match(implementation, /invalid conversation member candidate cursor/);
  assert.match(implementation, /using errcode = '22023'/);
});

test('public RPC and private implementation remain service-only', () => {
  for (const schema of ['private', 'public']) {
    assert.match(
      files.migration,
      new RegExp(`revoke all on function ${schema}\\.bff_list_conversation_member_candidates(?:_impl)?\\([\\s\\S]*?from public, anon, authenticated`),
    );
    assert.match(
      files.migration,
      new RegExp(`grant execute on function ${schema}\\.bff_list_conversation_member_candidates(?:_impl)?\\([\\s\\S]*?to service_role`),
    );
  }
});

test('Edge and repositories expose the exact cursor page without a twelve-result cap', () => {
  assert.match(files.routes, /'conversation\.member\.candidates'/);
  assert.match(files.routes, /\/v2\/conversations\/:conversationId\/member-candidates\/query/);
  assert.match(files.routes, /bff_list_conversation_member_candidates/);
  assert.match(files.routes, /verifyConversationMemberCandidateCursor/);
  assert.match(files.routes, /signConversationMemberCandidateCursor/);
  assert.match(files.routes, /cursorSigningKey/);
  assert.match(files.routes, /exactDependencyKeys\(root, \['candidates', 'nextCursor'\]\)/);
  assert.match(files.contracts, /listConversationMemberCandidates\(input:/);
  assert.match(files.contracts, /Promise<ConversationMemberCandidatePage>/);
  assert.match(files.repository, /parseConversationMemberCandidatePage\(dataValue\(payload\), limit\)/);
  assert.doesNotMatch(files.repository, /listConversationMemberCandidates[\s\S]{0,1200}slice\(0,\s*12\)/);
  assert.match(files.demo, /listConversationMemberCandidates/);
  assert.match(files.edgeTest, /Array\.from\(\{ length: 13 \}/);
  assert.match(files.edgeTest, /body\.candidates\.length, 13/);
  assert.match(files.edgeTest, /rejects tamper and every bound-field mismatch before RPC/);
});
