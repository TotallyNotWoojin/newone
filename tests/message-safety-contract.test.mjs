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

// The preservation-hold operator path was a workplace desk and went with it
// on Sep 10 2026.
