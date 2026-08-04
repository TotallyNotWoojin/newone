import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migrationPath = 'supabase/migrations/20260804162342_message_safety_contract.sql';

test('message edits append protected immutable versions and holds gate deletion', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  assert.match(migration, /create table private\.message_versions/);
  assert.match(migration, /after insert or update of body on public\.messages/);
  assert.match(migration, /message versions are immutable/);
  assert.match(migration, /create table private\.message_preservation_holds/);
  assert.match(migration, /hold_type in \('legal', 'incident_preservation'\)/);
  assert.match(migration, /message deletion blocked by organization preservation policy/);
  assert.match(migration, /'message\.preservation\.place', true, 900/);
  assert.match(migration, /'message\.preservation\.release', true, 900/);
  assert.match(migration, /message\.preservation\.manage/);
  assert.match(migration, /force row level security/);
  assert.match(migration, /revoke all on table private\.message_versions from public, anon, authenticated, service_role/);
});

test('forward authorization requires current source visibility and refuses attachments', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  assert.match(migration, /source_member\.history_visible_from is null[\s\S]*message\.created_at >= source_member\.history_visible_from/);
  assert.match(migration, /message\.available_at <= now\(\)/);
  assert.match(migration, /from public\.message_user_visibility visibility/);
  assert.match(migration, /visibility\.user_id = p_actor_user_id/);
  assert.match(migration, /not exists \([\s\S]*from public\.message_attachments attachment/);
  assert.match(migration, /message\.kind = 'text'/);
  assert.match(migration, /readable forwardable text message not found/);
});

test('the client disables attachment forwarding and never clones attachment capability', () => {
  const workspace = readFileSync('apps/newone/src/state/workspace.tsx', 'utf8');
  const pane = readFileSync('apps/newone/src/features/chat/conversation-pane.tsx', 'utf8');
  const catalog = readFileSync('apps/newone/src/i18n/catalog.ts', 'utf8');

  assert.match(workspace, /message\.deleted\s*\|\| Boolean\(message\.attachment\)/);
  assert.match(workspace, /attachment: undefined,[\s\S]*forwarded: true/);
  assert.doesNotMatch(workspace, /Forwarded attachment/);
  assert.match(pane, /message\.attachment \? \([\s\S]*chat\.attachmentForwardUnavailable/);
  assert.match(catalog, /'chat\.attachmentForwardUnavailable'/);
});

test('preservation holds have a reachable, capability-gated operator path', () => {
  const routes = readFileSync('supabase/functions/newone-api/routes.ts', 'utf8');
  const repository = readFileSync('apps/newone/src/data/repositories/bff-command-repository.ts', 'utf8');
  const reads = readFileSync('apps/newone/src/data/repositories/web-read-repository.ts', 'utf8');
  const admin = readFileSync('apps/newone/src/app/admin.tsx', 'utf8');
  const control = readFileSync('apps/newone/src/features/admin/message-preservation-section.tsx', 'utf8');
  const adminAccess = readFileSync('apps/newone/src/features/admin/admin-access.ts', 'utf8');

  assert.match(routes, /kind: 'message\.preservation\.place'[\s\S]*requireAal2: true[\s\S]*recentAuthSeconds: 900/);
  assert.match(routes, /kind: 'message\.preservation\.release'[\s\S]*requireAal2: true[\s\S]*recentAuthSeconds: 900/);
  assert.match(routes, /bff_place_message_preservation_hold/);
  assert.match(routes, /bff_release_message_preservation_hold/);
  assert.match(repository, /placeMessagePreservationHold[\s\S]*\/v2\/admin\/messages/);
  assert.match(repository, /releaseMessagePreservationHold[\s\S]*message-preservation-holds/);
  assert.match(reads, /parseWorkspaceCapabilities\(payload\.capabilities\)/);
  assert.match(adminAccess, /'message\.preservation\.manage'/);
  assert.match(admin, /hasCapability\('message\.preservation\.manage'\)/);
  assert.match(control, /This enforces preservation only; it is not a complete eDiscovery workflow|admin\.preservationDescription/);
  assert.match(control, /SHA256_PATTERN/);
});
