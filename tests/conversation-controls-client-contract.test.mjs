import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const load = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('shared web and native composer honors effective server posting access', async () => {
  const pane = await load('../apps/newone/src/features/chat/conversation-pane.tsx');
  assert.match(pane, /conversation\.isReadOnly === true \|\| conversation\.canPost === false/);
  assert.match(pane, /chat\.adminsOnlyPosting/);
  assert.match(pane, /updateConversationControls/);
  assert.match(pane, /loadConversationJoinRequests/);
  assert.match(pane, /decideConversationJoinRequest/);
  assert.match(pane, /message\.systemEvent \? <SystemEventRow/);
  assert.match(pane, /conversation\.posting\.admins_only/);
});

test('group discovery includes request state and history disclosure', async () => {
  const [list, reader, repository] = await Promise.all([
    load('../apps/newone/src/features/chat/conversation-list.tsx'),
    load('../apps/newone/src/data/repositories/web-read-repository.ts'),
    load('../apps/newone/src/data/repositories/bff-command-repository.ts'),
  ]);
  assert.match(list, /discoverableConversations/);
  assert.match(list, /historyDisclosure\.labelKey/);
  assert.match(list, /myJoinRequest\?\.status === 'pending'/);
  assert.match(reader, /payload\.discoverableConversations/);
  assert.match(reader, /allowedSystemEvents/);
  assert.match(reader, /invalid conversation system event/);
  assert.match(repository, /\/v2\/conversations\/discover\/query/);
  assert.match(repository, /expectedVersion: input\.expectedVersion/);
});

test('conversation controls have complete English, Korean, and Spanish copy', async () => {
  const catalog = await load('../apps/newone/src/i18n/catalog.ts');
  assert.match(catalog, /Only conversation administrators can post right now/);
  assert.match(catalog, /현재는 대화 관리자만 메시지를 보낼 수 있습니다/);
  assert.match(catalog, /Solo los administradores de la conversación pueden publicar ahora/);
  assert.equal((catalog.match(/'chat\.accessControls':/g) ?? []).length, 3);
  assert.equal((catalog.match(/'chat\.requestToJoin':/g) ?? []).length, 3);
});

test('database contract makes revision reconciliation durable and realtime bounded', async () => {
  const migration = await load('../supabase/migrations/20260804165238_complete_conversation_controls.sql');
  const requestWorkflow = migration.slice(
    migration.indexOf('create or replace function private.bff_request_conversation_join_impl'),
    migration.indexOf('create or replace function private.bff_cancel_conversation_join_request_impl'),
  );
  const decisionWorkflow = migration.slice(
    migration.indexOf('create or replace function private.bff_decide_conversation_join_request_impl'),
    migration.indexOf('create or replace function private.bff_list_discoverable_conversations_impl'),
  );
  const organizationWorkflow = migration.slice(
    migration.indexOf('create or replace function private.bff_update_organization_conversation_controls_impl'),
    migration.indexOf('create or replace function private.bff_update_conversation_controls_impl'),
  );
  assert.match(migration, /conversation_controls_version = organization\.conversation_controls_version \+ 1/);
  assert.match(migration, /order by membership\.user_id limit 5000/);
  assert.doesNotMatch(migration, /fanout exceeds the synchronous safety bound/);
  assert.match(migration, /exact organization-unit membership/);
  assert.match(migration, /create trigger messages_05_serialize_posting_access/);
  assert.match(migration, /create trigger member_blocks_05_serialize_direct_policy/);
  assert.match(migration, /direct_pair_policy_permitted/);
  assert.match(migration, /:join-budget:/);
  assert.ok(requestWorkflow.indexOf(':join-budget:') < requestWorkflow.indexOf('select request.* into v_request'));
  assert.ok(requestWorkflow.indexOf('select request.* into v_request') < requestWorkflow.indexOf('if (select count(*)'));
  assert.match(requestWorkflow, /expires_at <= clock_timestamp\(\)/);
  assert.match(decisionWorkflow, /if p_decision = 'approved' then[\s\S]*membership\.status = 'active'/);
  assert.ok(
    organizationWorkflow.indexOf('perform private.broadcast_organization_conversation_controls_internal')
      < organizationWorkflow.indexOf("'organization.conversation_controls.updated'"),
  );
  assert.match(migration, /revoke all on table public\.conversation_join_requests from service_role/);
});
