import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  normalizeOrganizationAiPolicyUpdate,
  parseOrganizationAiPolicy,
  parseOrganizationAiPolicyUpdateReceipt,
} from '../apps/newone/src/data/repositories/ai-policy-dto.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('AI policy DTO accepts the pinned provider route and exact coherent receipt', () => {
  const organizationId = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(parseOrganizationAiPolicy({
    organizationId,
    enabled: true,
    policyVersion: 4,
    approvedUseCases: ['summary', 'translation'],
    providerAllowlist: ['google-vertex/us-south1'],
    routePolicy: 'approved_zero_retention',
    tenantApproved: true,
    globalKillSwitchStillRequired: true,
  }), {
    organizationId,
    enabled: true,
    policyVersion: 4,
    approvedUseCases: ['summary', 'translation'],
    providerAllowlist: ['google-vertex/us-south1'],
    routePolicy: 'approved_zero_retention',
    tenantApproved: true,
    globalKillSwitchStillRequired: true,
  });
  assert.deepEqual(normalizeOrganizationAiPolicyUpdate({
    enabled: true,
    approvedUseCases: ['translation'],
    providerAllowlist: ['google-vertex/us-south1'],
    routePolicy: 'approved_zero_retention',
    expectedVersion: 0,
    reason: '  Approve reviewed processing.  ',
  }).reason, 'Approve reviewed processing.');
});

test('AI policy update receipt is bound to the exact tenant, version, tasks, provider routes, and route policy', () => {
  const organizationId = '00000000-0000-4000-8000-000000000001';
  const update = {
    enabled: true,
    approvedUseCases: ['translation'],
    providerAllowlist: ['google-vertex/us-south1'],
    routePolicy: 'approved_zero_retention',
    expectedVersion: 2,
    reason: 'Approve reviewed processing.',
  };
  const receipt = {
    organizationId,
    enabled: true,
    policyVersion: 3,
    approvedUseCases: ['translation'],
    providerAllowlist: ['google-vertex/us-south1'],
    routePolicy: 'approved_zero_retention',
    tenantApproved: true,
    globalKillSwitchStillRequired: true,
  };
  assert.deepEqual(
    parseOrganizationAiPolicyUpdateReceipt(receipt, organizationId, update),
    receipt,
  );
  for (const widened of [
    { ...receipt, organizationId: '00000000-0000-4000-8000-000000000002' },
    { ...receipt, policyVersion: 4 },
    { ...receipt, approvedUseCases: ['summary'] },
    { ...receipt, providerAllowlist: ['other-provider/us-south1'] },
  ]) assert.throws(() => parseOrganizationAiPolicyUpdateReceipt(widened, organizationId, update));
});

test('AI policy DTO rejects widened, malformed, nullable, and incoherent authority', () => {
  const base = {
    enabled: true,
    approvedUseCases: ['translation'],
    providerAllowlist: ['google-vertex/us-south1'],
    routePolicy: 'approved_zero_retention',
    expectedVersion: 1,
    reason: 'Approve reviewed processing.',
  };
  for (const value of [
    { ...base, prompt: 'secret' },
    { ...base, approvedUseCases: null },
    { ...base, providerAllowlist: null },
    { ...base, routePolicy: null },
    { ...base, providerAllowlist: ['Google-Vertex/us-south1'] },
    { ...base, providerAllowlist: ['google vertex/us-south1'] },
    { ...base, providerAllowlist: [`a${'x'.repeat(160)}`] },
    { ...base, providerAllowlist: ['/google-vertex'] },
    { ...base, providerAllowlist: [] },
    { ...base, enabled: false, routePolicy: 'deny' },
  ]) assert.throws(() => normalizeOrganizationAiPolicyUpdate(value));
});

test('AI policy client path is capability, AAL2, CAS, idempotency, and disclosure gated', () => {
  const files = {
    contracts: read('apps/newone/src/data/repositories/contracts.ts'),
    repository: read('apps/newone/src/data/repositories/bff-command-repository.ts'),
    workspace: read('apps/newone/src/state/workspace.tsx'),
    admin: read('apps/newone/src/app/admin.tsx'),
    section: read('apps/newone/src/features/admin/ai-policy-section.tsx'),
    copy: read('apps/newone/src/features/admin/ai-policy-copy.ts'),
    migration: read('supabase/migrations/20260804172600_complete_ai_policy_admin_contract.sql'),
  };
  assert.match(files.contracts, /getOrganizationAiPolicy/);
  assert.match(files.contracts, /updateOrganizationAiPolicy/);
  assert.match(files.repository, /\/v2\/admin\/ai-policy\/query/);
  assert.match(files.repository, /idempotencyKey: input\.idempotencyKey/);
  assert.match(files.repository, /parseOrganizationAiPolicy\(dataValue\(payload\), input\.organizationId\)/);
  assert.match(files.repository, /parseOrganizationAiPolicyUpdateReceipt/);
  assert.match(files.workspace, /capabilities\.includes\('ai\.policy\.manage'\)/);
  assert.match(files.workspace, /expectedVersion: organizationAiPolicy\.policyVersion/);
  assert.match(files.admin, /hasCapability\('ai\.policy\.manage'\)/);
  assert.match(files.section, /privilegedReady/);
  assert.match(files.section, /organization-ai-policy-update/);
  assert.match(files.section, /!enabled \|\| \(providers && approvedUseCases\.length > 0/);
  assert.match(files.section, /\(enabled && !providers\)/);
  assert.match(files.section, /providerAllowlist: enabled \? providers as string\[\] : \[\]/);
  assert.match(files.section, /copy\.enableFreshness/);
  assert.match(files.section, /copy\.reverify/);
  assert.match(files.section, /!policy \? \([\s\S]*copy\.loading[\s\S]*copy\.reverify[\s\S]*\) : \(/);
  assert.match(files.admin, /onSignInAgain[\s\S]*auth\.signOut\(\)[\s\S]*router\.replace\('\/sign-in'\)/);
  assert.doesNotMatch(files.section, /issuedAt|expiresAt|\.iat\b/);
  for (const disclosure of ['OpenRouter', 'Translation', 'summaries', 'zero-retention', 'kill switch']) {
    assert.match(files.copy, new RegExp(disclosure, 'i'));
  }
  assert.match(files.copy, /previous five minutes/);
  assert.match(files.copy, /does not guess freshness from token timestamps/);
  assert.match(files.copy, /Revocation remains available to a current AAL2 policy manager/);
  assert.match(files.migration, /p_expected_version integer/);
  assert.match(files.migration, /organization AI policy version conflict/);
  assert.match(files.migration, /prepare_bff_command_internal[\s\S]*'ai\.policy\.set', true, 0/);
  assert.match(files.migration, /if p_enabled then[\s\S]*'ai\.policy\.enable', true, 300[\s\S]*end if;[\s\S]*if v_command ->> 'state' = 'replay'/);
  assert.match(files.migration, /global_kill_switch_still_required', true/);
  assert.match(files.migration, /revoke select on table public\.organization_ai_policies from authenticated/);
  assert.match(files.migration, /revoke execute on function public\.bff_set_organization_ai_policy\(/);
  assert.match(files.migration, /revoke execute on function private\.bff_set_organization_ai_policy_impl\(/);
});

test('AI policy egress provenance and immutable history fail closed across every boundary', () => {
  const files = {
    routes: read('supabase/functions/newone-api/routes.ts'),
    openrouter: read('supabase/functions/_shared/openrouter.ts'),
    controlPlane: read('supabase/functions/_shared/openrouter-control-plane.ts'),
    policy: read('config/ai-route-policy.json'),
    schema: read('config/ai-route-policy.schema.json'),
    foundation: read('supabase/migrations/20260728031052_messenger_foundation.sql'),
    history: read('supabase/migrations/20260804172900_complete_ai_policy_audit_history.sql'),
    hardening: read('supabase/migrations/20260804173100_harden_ai_policy_authority_history.sql'),
    pgTap: read('supabase/tests/ai_policy_admin_contract_test.sql'),
    routeVerifier: read('scripts/verify-openrouter-route.mjs'),
    evaluator: read('scripts/run-openrouter-language-eval.mjs'),
  };
  const policy = JSON.parse(files.policy);
  const schema = JSON.parse(files.schema);
  assert.equal(policy.providerTag, 'google-vertex/us-south1');
  assert.equal(policy.providerMetadataName, 'Google');
  assert.equal(policy.policyVersion, '2026-08-04.2');
  assert.equal(policy.requirements.implicitCaching, false);
  assert.equal(policy.requirements.bringYourOwnKeys, false);
  assert.equal(policy.requirements.managementControlPlanePreflight, true);
  assert.equal(policy.requirements.syntheticRouteProbe, true);
  assert.ok(schema.required.includes('providerMetadataName'));
  assert.match(files.openrouter, /selectedEndpoint\.provider !== expectedProviderMetadataName/);
  assert.match(files.openrouter, /metadata\.is_byok !== false/);
  assert.match(files.openrouter, /metadata\.attempts\.length !== 1/);
  assert.match(files.routeVerifier, /providerCatalogMatches\[0\]\?\.name === policy\.providerMetadataName/);
  assert.match(files.routeVerifier, /endpoint\.provider_name === policy\.providerMetadataName/);
  assert.match(files.routeVerifier, /endpoint\.supports_implicit_caching === false/);
  assert.match(files.evaluator, /max_price: policy\.priceCeilingsUsdPerMillionTokens/);
  assert.match(files.evaluator, /metadata\?\.is_byok !== false/);
  assert.match(files.evaluator, /bytes\.byteLength > 131072/);
  assert.match(files.openrouter, /if \(metadata\.pipeline\.length > 0\)/);
  assert.match(files.openrouter, /verifyEmployeeEgressBeforeContent\(environment, fetcher, spec\.correlationId\)/);
  assert.match(files.openrouter, /dataClassification: 'employee'/);
  assert.match(files.openrouter, /plugins: DISABLED_OPENROUTER_PLUGINS/);
  assert.match(files.openrouter, /protectTokens\(introducedText\)\.tokens\.length > 0/);
  assert.match(files.controlPlane, /\/keys\/\$\{controls\.apiKeyHash\}/);
  assert.match(files.controlPlane, /\/byok\?workspace_id=/);
  assert.match(files.controlPlane, /\/guardrails\?workspace_id=/);
  assert.match(files.controlPlane, /credential\.disabled !== true/);
  assert.match(files.controlPlane, /endpoint\.supports_implicit_caching === false/);
  assert.match(files.routes, /function publicOrganizationAiPolicy\(/);
  assert.match(files.routes, /exactDependencyKeys\(row, \[[\s\S]*'globalKillSwitchStillRequired'/);
  assert.match(files.routes, /organizationId !== expectedOrganizationId/);
  assert.match(files.routes, /policyVersion !== expectedUpdate\.expectedVersion \+ 1/);
  assert.match(files.routes, /case 'organization\.ai_policy\.read':[\s\S]*publicOrganizationAiPolicy\(/);
  assert.match(files.routes, /case 'organization\.ai_policy\.update':[\s\S]*publicOrganizationAiPolicy\(receipt, org/);

  const slashRoutePattern = /\^\[a-z0-9\]\[a-z0-9\._\/-\]\{1,159\}\$/g;
  assert.equal(
    [...files.foundation.matchAll(slashRoutePattern)].length,
    7,
    'all seven foundation resolver/completion/failure boundaries must accept the pinned slash route',
  );
  assert.match(files.history, /create table public\.organization_ai_policy_versions/);
  assert.match(files.history, /force row level security/);
  assert.match(files.history, /organization_ai_policy_versions_immutable/);
  assert.match(files.history, /change_reason text not null/);
  assert.match(files.history, /request_sha256 text not null/);
  assert.match(files.history, /foreign key \(organization_id, changed_by_user_id\)[\s\S]*organization_memberships/);
  assert.match(files.history, /insert into public\.organization_ai_policy_versions/);
  assert.match(files.history, /'reason', btrim\(p_reason\)/);
  assert.match(files.history, /revoke all on table public\.organization_ai_policy_versions[\s\S]*service_role/);
  assert.match(
    files.hardening,
    /revoke insert, update, delete, truncate[\s\S]*on table public\.organization_ai_policies[\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.match(files.hardening, /lock table public\.organization_ai_policies in share row exclusive mode/);
  assert.match(files.hardening, /add column provenance jsonb not null default jsonb_build_object/);
  assert.match(files.hardening, /'source', 'legacy_current_policy_backfill'/);
  assert.match(files.hardening, /'request_sha256_semantics', 'canonical_current_policy_snapshot_sha256_v1'/);
  assert.match(files.hardening, /on conflict \(organization_id, policy_version\) do nothing/);
  assert.match(files.hardening, /current AI policy does not match immutable history/);
  assert.match(files.hardening, /set timezone = 'UTC'/);
  assert.match(files.hardening, /select private\.backfill_organization_ai_policy_history\(\)/);
  assert.match(files.pgTap, /service role direct AI-policy DML is denied/);
  assert.match(files.pgTap, /re-running the backfill is idempotent/);
});
