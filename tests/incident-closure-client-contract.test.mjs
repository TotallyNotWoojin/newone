import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pane = readFileSync('apps/newone/src/features/chat/conversation-pane.tsx', 'utf8');
const workspace = readFileSync('apps/newone/src/state/workspace.tsx', 'utf8');
const repository = readFileSync('apps/newone/src/data/repositories/bff-command-repository.ts', 'utf8');
const routes = readFileSync('supabase/functions/newone-api/routes.ts', 'utf8');
const migration = readFileSync('supabase/migrations/20260804141000_harden_incident_closure.sql', 'utf8');

test('authorized incident controls require a reason and render retained read-only state', () => {
  assert.match(pane, /conversation\.canManage && conversation\.kind === 'incident' && !conversation\.isReadOnly/);
  assert.match(pane, /incidentCloseReason\.trim\(\)\.length < 3/);
  assert.match(pane, /workspace\.closeIncident\(conversation\.id, reason\)/);
  assert.match(pane, /disabled=\{composerDisabled\}/);
  assert.match(pane, /conversation\.isReadOnly === true \|\| \(conversation\.canPost === false && !outgoingRequest\)/);
  assert.match(pane, /conversation\.closureReason \?\? t\('chat\.incidentClosedBody'\)/);
});

test('closure travels through the bounded repository and BFF route before local state becomes read-only', () => {
  assert.match(repository, /\/incident\/close/);
  assert.match(routes, /'conversation\.incident\.close'/);
  assert.match(routes, /'bff_close_incident'/);
  assert.match(workspace, /repositories\.commands\.closeIncident/);
  assert.match(workspace, /closureReason: normalizedReason[\s\S]*isReadOnly: true/);
});

test('closed incident evidence is immutable at the database boundary', () => {
  assert.match(migration, /old\.closed_at is not null/);
  assert.match(migration, /closed incident record is immutable/);
  assert.match(migration, /new\.incident_classification is distinct from old\.incident_classification/);
});
