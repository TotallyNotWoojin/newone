import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('targeted update contract carries every audience dimension through Edge and repository', async () => {
  const [routes, contracts, repository] = await Promise.all([
    source('../supabase/functions/newone-api/routes.ts'),
    source('../apps/newone/src/data/repositories/contracts.ts'),
    source('../apps/newone/src/data/repositories/bff-command-repository.ts'),
  ]);
  for (const marker of [
    'conversationMembers', 'siteIds', 'departmentIds', 'teamIds', 'unitIds',
    'operationalRoles', 'membershipRoles', 'languages', 'currentShiftOnly',
  ]) assert.ok(contracts.includes(marker), `missing client audience dimension ${marker}`);
  assert.match(routes, /function announcementAudienceSpec/);
  assert.match(routes, /p_audience_spec: values\.audienceSpec/g);
  assert.match(repository, /audienceSpec: input\.audienceSpec/g);
  assert.match(repository, /active_members_and_current_shift_at_publish/);
});

test('responsive authoring exposes hierarchy, exact configured roles, access roles, language, and shift independently', async () => {
  const [screen, copy, workspace] = await Promise.all([
    source('../apps/newone/src/app/updates.tsx'),
    source('../apps/newone/src/features/updates/update-copy.ts'),
    source('../apps/newone/src/state/workspace.tsx'),
  ]);
  for (const marker of [
    "AudienceScope = 'company' | 'conversation' | 'units'",
    "(['site', 'department', 'team', 'line', 'shift'] as const)",
    'selectedOperationalRoles',
    'operationalRoleEntry',
    'configuredRolesPlaceholder',
    'selectedMembershipRoles',
    'selectedAudienceLanguages',
    'currentShiftOnly',
    'previewAudienceFingerprint',
  ]) assert.ok(screen.includes(marker), `missing audience authoring control ${marker}`);
  assert.match(copy, /These are not account access tiers/);
  assert.match(copy, /descendant departments, teams, lines, and shifts/);
  assert.match(screen, /unit\.kind === 'line' \|\| unit\.kind === 'shift'/);
  assert.match(copy, /actual publication time/);
  assert.match(workspace, /units: snapshot\?\.units \?\? \[\]/);
});

test('scheduled promotion never reintroduces all conversation members and rejects infinite evaluation time', async () => {
  const migration = await source('../supabase/migrations/20260804163052_complete_targeted_update_audiences.sql');
  const promoter = migration.slice(migration.indexOf(
    'create or replace function private.bff_promote_due_announcements_impl',
  ));
  assert.match(promoter, /announcement_audience_candidates/);
  assert.match(promoter, /snapshot_announcement_audience_internal/);
  assert.doesNotMatch(promoter, /insert into public\.announcement_recipients[\s\S]{0,500}from public\.conversation_members/);
  assert.match(migration, /not isfinite\(p_evaluated_at\)/g);
  assert.match(migration, /with recursive selected_units/);
  assert.match(migration, /child\.parent_unit_id = parent\.id/);
});
