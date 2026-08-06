import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  EXPECTED_PROJECT_REF,
  REQUIRED_EXECUTION_FUNCTIONS,
  generateTotp,
  makeRunId,
  parseArguments,
  realtimeApplicationPayload,
  sanitizeText,
  selectProjectKeys,
  sqlLiteral,
  validateCleanupManifest,
  validateHostedExecutionPrerequisites,
} from './lib.mjs';
import { cleanupSql } from './run.mjs';

test('argument parsing defaults to a read-only dry run', () => {
  assert.deepEqual(parseArguments([]), {
    mode: 'dry-run',
    projectRef: EXPECTED_PROJECT_REF,
    runId: null,
    cleanup: false,
    cleanupArtifact: null,
    help: false,
  });
  assert.throws(() => parseArguments(['--dry-run', '--cleanup']), /only with --execute/);
  assert.throws(() => parseArguments(['--execute', '--cleanup-artifact', 'x']), /Select one run mode/);
});

test('run IDs are unique-prefix-compatible slugs', () => {
  const runId = makeRunId(new Date('2026-08-04T12:34:56.000Z'), 'a1b2c3d4');
  assert.equal(runId, 'newone-e2e-20260804t123456z-a1b2c3d4');
  assert.equal(parseArguments(['--execute', '--run-id', runId]).runId, runId);
  assert.throws(
    () => parseArguments(['--execute', '--run-id', 'production']),
    /newone-e2e/,
  );
});

test('project key selection prefers modern CLI keys without transforming them', () => {
  const inventory = [
    { name: 'anon', type: 'legacy', api_key: 'legacy-public-value' },
    { name: 'service_role', type: 'legacy', api_key: 'legacy-secret-value' },
    { name: 'default', type: 'publishable', api_key: 'sb_publishable_value' },
    { name: 'default', type: 'secret', api_key: 'sb_secret_value' },
  ];
  assert.deepEqual(selectProjectKeys(inventory), {
    publishableKey: 'sb_publishable_value',
    secretKey: 'sb_secret_value',
  });
  assert.throws(
    () => selectProjectKeys([{ name: 'default', type: 'publishable', api_key: 'one-key' }]),
    /server secret key/,
  );
});

test('hosted execution requires all four real gateways and a bounded local bootstrap secret', () => {
  assert.deepEqual(REQUIRED_EXECUTION_FUNCTIONS, [
    'newone-api',
    'newone-auth',
    'newone-bootstrap',
    'newone-read',
  ]);
  const active = new Set(REQUIRED_EXECUTION_FUNCTIONS);
  const secret = 'hosted-bootstrap-token-with-32-characters-minimum';
  const deployments = REQUIRED_EXECUTION_FUNCTIONS.map((name, index) => ({
    name,
    version: index + 1,
    verifyJwt: false,
    sha256: String(index + 1).repeat(64),
  }));
  assert.equal(validateHostedExecutionPrerequisites(active, secret, deployments), secret);
  assert.throws(
    () => validateHostedExecutionPrerequisites(
      new Set(['newone-api', 'newone-read']),
      secret,
      deployments,
    ),
    /newone-auth, newone-bootstrap/,
  );
  assert.throws(
    () => validateHostedExecutionPrerequisites(active, 'too-short', deployments),
    /32-4096/,
  );
  assert.throws(
    () => validateHostedExecutionPrerequisites(active, secret, deployments.map((entry) =>
      entry.name === 'newone-auth' ? { ...entry, verifyJwt: true } : entry
    )),
    /newone-auth.*verify_jwt=false/,
  );
});

test('Realtime payload extraction follows the nested database Broadcast transport', () => {
  const envelope = {
    payload: {
      payload: {
        schema_version: 1,
        event_id: '10000000-0000-4000-8000-000000000001',
        organization_id: '20000000-0000-4000-8000-000000000001',
      },
    },
  };
  assert.deepEqual(realtimeApplicationPayload(envelope), envelope.payload.payload);
  assert.deepEqual(realtimeApplicationPayload({ payload: envelope.payload.payload }), envelope.payload.payload);
  assert.deepEqual(realtimeApplicationPayload(null), {});
});

test('TOTP implementation matches the RFC 6238 SHA-1 vector', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(generateTotp(secret, { timestampSeconds: 59, digits: 8 }), '94287082');
  assert.match(generateTotp(secret, { timestampSeconds: 59 }), /^\d{6}$/);
});

test('SQL literals escape quotes and reject null bytes', () => {
  assert.equal(sqlLiteral("owner's run"), "'owner''s run'");
  assert.throws(() => sqlLiteral('bad\0value'), /null byte/);
});

test('cleanup validation accepts only exact run-prefixed targets', () => {
  const manifest = {
    runId: 'newone-e2e-20260804t123456z-a1b2c3d4',
    projectRef: EXPECTED_PROJECT_REF,
    startedAt: '2026-08-04T12:34:56.000Z',
    users: [{
      id: '10000000-0000-4000-8000-000000000001',
      email: 'newone-e2e-20260804t123456z-a1b2c3d4-owner-a@example.invalid',
    }],
    organizations: [{
      id: '20000000-0000-4000-8000-000000000001',
      slug: 'newone-e2e-20260804t123456z-a1b2c3d4-org-a',
    }],
  };
  assert.equal(validateCleanupManifest(manifest).runId, manifest.runId);
  assert.throws(
    () => validateCleanupManifest({
      ...manifest,
      users: [{ ...manifest.users[0], email: 'real-person@example.com' }],
    }),
    /outside the run prefix/,
  );
  assert.throws(
    () => validateCleanupManifest({ ...manifest, projectRef: 'another-project' }),
    /project reference mismatch/,
  );
});

test('cleanup SQL proves user-reference closure and removes exact business/session rate buckets', () => {
  const manifest = {
    runId: 'newone-e2e-20260804t123456z-a1b2c3d4',
    projectRef: EXPECTED_PROJECT_REF,
    startedAt: '2026-08-04T12:34:56.000Z',
    users: [
      {
        id: '10000000-0000-4000-8000-000000000001',
        email: 'newone-e2e-20260804t123456z-a1b2c3d4-owner-a@example.invalid',
      },
    ],
    organizations: [
      {
        id: '20000000-0000-4000-8000-000000000001',
        slug: 'newone-e2e-20260804t123456z-a1b2c3d4-org-a',
      },
    ],
  };
  const sql = cleanupSql(manifest);
  assert.match(sql, /target user referenced outside target organizations/);
  assert.match(sql, /requires review for a new global user reference/);
  assert.match(sql, /organization_id::text \|\| ':' \|\| user_id::text/);
  assert.doesNotMatch(sql, /bucket\.scope like 'bff-user:%'/);
  assert.match(sql, /bucket\.scope like 'bff-session:%'/);
  assert.match(sql, /created_by_user_id = any \(target_users\)/);
  assert.match(sql, /cleanup could not satisfy organization-scoped foreign keys/);
  assert.match(sql, /set_config\('app\.allow_audit_maintenance', 'on', true\)/);
  assert.doesNotMatch(sql, /session_replication_role/);
  assert(
    sql.indexOf('requires review for a new global user reference') <
      sql.indexOf("set_config('app.allow_audit_maintenance', 'on', true)") &&
      sql.indexOf("set_config('app.allow_audit_maintenance', 'on', true)") <
      sql.indexOf('delete from private.rate_limit_buckets'),
    'Maintenance mode must be transaction-local and enabled only after closure guards',
  );
});

test('cleanup validation rejects extra identities even under the run prefix', () => {
  assert.throws(() => validateCleanupManifest({
    runId: 'newone-e2e-20260804t123456z-a1b2c3d4',
    projectRef: EXPECTED_PROJECT_REF,
    startedAt: '2026-08-04T12:34:56.000Z',
    users: [{
      id: '10000000-0000-4000-8000-000000000001',
      email: 'newone-e2e-20260804t123456z-a1b2c3d4-extra@example.invalid',
    }],
    organizations: [],
  }), /outside the run prefix/);
});

test('known API-secret forms are redacted from diagnostics', () => {
  assert.equal(
    sanitizeText('key=sb_secret_do-not-log and sk-or-v1-deadbeef'),
    'key=[REDACTED] and [REDACTED]',
  );
  assert.equal(sanitizeText('token-123', ['token-123']), '[REDACTED]');
});

test('execute path uses deployed Bootstrap and Auth gateways, not direct setup RPC redemption', async () => {
  const source = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.match(source, /functionName: BOOTSTRAP_FUNCTION/);
  assert.match(source, /functionName: AUTH_FUNCTION,[\s\S]*\/v2\/auth\/invitations\/redeem/);
  assert.doesNotMatch(source, /serviceRpc\(admin, 'bff_bootstrap_organization'/);
  assert.doesNotMatch(source, /memberAClient\.rpc\('redeem_organization_invite'/);
});
