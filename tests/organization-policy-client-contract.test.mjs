import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  normalizeOrganizationPolicyUpdate,
  parseOrganizationPolicy,
} from '../apps/newone/src/data/repositories/organization-policy-dto.mjs';

const files = Object.fromEntries(await Promise.all([
  'migration',
  'routes',
  'contracts',
  'repository',
  'workspace',
  'admin',
  'section',
  'catalog',
].map(async (name) => {
  const path = {
    migration: 'supabase/migrations/20260804172200_complete_group_creation.sql',
    routes: 'supabase/functions/newone-api/routes.ts',
    contracts: 'apps/newone/src/data/repositories/contracts.ts',
    repository: 'apps/newone/src/data/repositories/bff-command-repository.ts',
    workspace: 'apps/newone/src/state/workspace.tsx',
    admin: 'apps/newone/src/app/admin.tsx',
    section: 'apps/newone/src/features/admin/organization-policy-section.tsx',
    catalog: 'apps/newone/src/i18n/catalog.ts',
  }[name];
  return [name, await readFile(path, 'utf8')];
})));

const validPolicy = {
  messageRetentionDays: 180,
  allowMemberDirectMessages: false,
  dmPolicy: 'request_first',
  requireMfaForAdmins: true,
  shiftScheduleAuthoritative: true,
  groupCreationPolicy: 'admins',
  allowExternalGuests: false,
  externalGuestMaxAccessDays: 45,
  version: 2,
};

test('organization policy DTO rejects partial or malformed authoritative receipts', () => {
  assert.deepEqual(parseOrganizationPolicy(validPolicy), validPolicy);
  assert.throws(() => parseOrganizationPolicy({ ...validPolicy, groupCreationPolicy: 'everyone' }));
  assert.throws(() => parseOrganizationPolicy({ ...validPolicy, allowExternalGuests: null }));
  assert.throws(() => parseOrganizationPolicy({ ...validPolicy, externalGuestMaxAccessDays: 366 }));
  assert.deepEqual(
    normalizeOrganizationPolicyUpdate({ ...validPolicy, reason: '  tighten policy  ' }),
    { ...validPolicy, reason: 'tighten policy' },
  );
  assert.throws(() => normalizeOrganizationPolicyUpdate({ ...validPolicy, reason: 'no' }));
});

test('database and Edge contracts require the service-only recent-AAL2 owner workflow', () => {
  assert.match(files.migration, /organization_policy_version bigint not null default 1/);
  assert.match(files.migration, /app\.organization_policy_context/);
  assert.match(files.migration, /'organization\.policy\.update', true, 300/);
  assert.match(files.migration, /membership\.role = 'owner'/);
  assert.match(files.migration, /organization policy version conflict/);
  assert.match(files.migration, /'organization\.policy\.updated'/);
  assert.match(files.migration, /organization_membership_access_current\([\s\S]*membership\.user_id/);
  assert.match(files.routes, /kind: 'organization\.policy\.update'[\s\S]*requireAal2: true[\s\S]*recentAuthSeconds: 300/);
  assert.match(files.routes, /'bff_update_organization_policy'/);
});

test('strict repository and workspace preserve the server receipt and CAS revision', () => {
  assert.match(files.contracts, /updateOrganizationPolicy/);
  assert.match(files.repository, /normalizeOrganizationPolicyUpdate/);
  assert.match(files.repository, /\/v2\/admin\/organization-policy/);
  assert.match(files.repository, /parseOrganizationPolicy\(dataValue\(payload\)\)/);
  assert.match(files.workspace, /snapshot\.currentMembershipRole !== 'owner'/);
  assert.match(files.workspace, /organizationPolicy: result/);
});

test('owner-only responsive admin UI exposes all policy inputs with localized audit copy', () => {
  assert.match(files.admin, /workspace\.currentMembershipRole === 'owner'/);
  assert.match(files.admin, /<OrganizationPolicySection privilegedReady=\{privilegedReady\}/);
  assert.match(files.section, /policy\.version/);
  assert.match(files.section, /workspace\.updateOrganizationPolicy/);
  assert.match(files.section, /workspace\.actionBusy === 'organization-policy-update'/);
  for (const key of [
    'admin.organizationPolicyTitle',
    'admin.organizationPolicyExternalGuests',
    'admin.organizationPolicyRetentionDays',
    'admin.organizationPolicyReason',
  ]) {
    assert.equal((files.catalog.match(new RegExp(`'${key}':`, 'g')) ?? []).length, 3);
  }
});
