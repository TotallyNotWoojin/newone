#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXECUTION_CONFIRMATION,
  EXPECTED_PROJECT_REF,
  REQUIRED_EXECUTION_FUNCTIONS,
  assertRunId,
  decodeJwtPayload,
  generateTotp,
  isUuid,
  makeRunId,
  parseArguments,
  realtimeApplicationPayload,
  sanitizeText,
  selectProjectKeys,
  sqlLiteral,
  validateCleanupManifest,
  validateHostedExecutionPrerequisites,
} from './lib.mjs';

const HOSTED_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HOSTED_DIRECTORY, '../..');
const ARTIFACT_DIRECTORY = join(HOSTED_DIRECTORY, '.artifacts');
const AUTH_FUNCTION = 'newone-auth';
const BOOTSTRAP_FUNCTION = 'newone-bootstrap';
const CORE_FUNCTIONS = ['newone-api', 'newone-read'];
const EDGE_FUNCTIONS = new Set(REQUIRED_EXECUTION_FUNCTIONS);
const REALTIME_EVENT = 'workspace.invalidated';
const secretsForRedaction = [];
let interruptionSignal = null;

class HarnessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HarnessError';
    this.details = details;
  }
}

function printUsage() {
  console.log(`Newone real hosted integration harness

Read-only validation (default):
  node tests/hosted/run.mjs --dry-run

Create real isolated accounts and execute hosted flows:
  NEWONE_HOSTED_E2E=1 \\
  NEWONE_HOSTED_BOOTSTRAP_TOKEN=<matching-secret> \\
  node tests/hosted/run.mjs --execute

Execute and clean up after review (the run ID must be chosen in advance):
  NEWONE_HOSTED_E2E=1 \\
  NEWONE_HOSTED_BOOTSTRAP_TOKEN=<matching-secret> \\
  NEWONE_HOSTED_E2E_CLEANUP_CONFIRM=<run-id> \\
  node tests/hosted/run.mjs --execute --cleanup --run-id <run-id>

Clean up a retained run after review:
  NEWONE_HOSTED_E2E_CLEANUP_CONFIRM=<run-id> \\
  node tests/hosted/run.mjs --cleanup-artifact tests/hosted/.artifacts/<run-id>.json

The harness obtains project API keys from the Supabase CLI and never prints them.`);
}

function log(status, name, detail = '') {
  const safeDetail = detail ? ` ${sanitizeText(detail, secretsForRedaction)}` : '';
  console.log(`${status.padEnd(7)} ${name}${safeDetail}`);
}

function safeFailure(error) {
  if (error instanceof HarnessError) {
    const status = error.details?.status ? ` status=${error.details.status}` : '';
    const code = error.details?.code ? ` code=${error.details.code}` : '';
    const reason = typeof error.details?.reason === 'string'
      ? ` reason=${error.details.reason.slice(0, 240)}`
      : '';
    return sanitizeText(`${error.message}${status}${code}${reason}`, secretsForRedaction);
  }
  const code = typeof error?.code === 'string' ? ` code=${error.code}` : '';
  return sanitizeText(`${error?.message ?? 'Unknown failure'}${code}`, secretsForRedaction);
}

function assert(condition, message, details = {}) {
  if (!condition) throw new HarnessError(message, details);
}

function publicErrorCode(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const nested = body.error;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return typeof nested.code === 'string' ? nested.code : undefined;
  }
  return typeof body.code === 'string' ? body.code : undefined;
}

function checkInterrupted() {
  if (interruptionSignal) throw new HarnessError(`Interrupted by ${interruptionSignal}`);
}

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectWait) => {
        timer = setTimeout(() => rejectWait(new HarnessError(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      interruptionSignal = signal;
      log('STOP', 'signal_received', signal);
    });
  }
}

function loadAccessToken() {
  const configured = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (configured) return configured;
  if (process.platform !== 'darwin') {
    throw new HarnessError('SUPABASE_ACCESS_TOKEN is required outside macOS');
  }
  try {
    const token = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Supabase CLI', '-a', 'supabase', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!token) throw new Error('empty token');
    return token;
  } catch {
    throw new HarnessError('Supabase CLI access token was not found in the environment or Keychain');
  }
}

function supabaseJson(accessToken, args) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const output = execFileSync('supabase', args, {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken },
      });
      return JSON.parse(output);
    } catch {
      if (attempt === 3) {
        throw new HarnessError(`Supabase CLI command failed: supabase ${args[0] ?? ''}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    }
  }
  throw new HarnessError('Supabase CLI command failed');
}

async function managementRequest(accessToken, projectRef, path, init = {}) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    throw new HarnessError(`Supabase Management API request failed for ${path}`, {
      status: response.status,
      code: publicErrorCode(body),
      reason: typeof body?.message === 'string' ? body.message : undefined,
    });
  }
  return body;
}

async function managementSql(accessToken, projectRef, query) {
  return await managementRequest(accessToken, projectRef, 'database/query', {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
}

function loadSupabaseSdk() {
  try {
    const requireFromApp = createRequire(join(REPOSITORY_ROOT, 'apps/newone/package.json'));
    return requireFromApp('@supabase/supabase-js');
  } catch {
    throw new HarnessError('Install apps/newone dependencies before running the hosted harness');
  }
}

function createClients(url, keys) {
  const { createClient } = loadSupabaseSdk();
  const publicFetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (headers.get('authorization') === `Bearer ${keys.publishableKey}`) {
      headers.delete('authorization');
    }
    return await fetch(input, { ...init, headers });
  };
  const adminFetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (headers.get('authorization') === `Bearer ${keys.secretKey}`) {
      headers.delete('authorization');
    }
    return await fetch(input, { ...init, headers });
  };
  const sharedAuth = {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  };
  return {
    createPublicClient() {
      return createClient(url, keys.publishableKey, {
        auth: sharedAuth,
        global: { fetch: publicFetch, headers: { apikey: keys.publishableKey } },
      });
    },
    admin: createClient(url, keys.secretKey, {
      auth: sharedAuth,
      global: {
        fetch: adminFetch,
        headers: { apikey: keys.secretKey, 'X-Newone-Server': 'edge-function' },
      },
    }),
  };
}

function sdkData(result, operation) {
  if (result?.error || result?.data === null || result?.data === undefined) {
    throw new HarnessError(`${operation} failed`, {
      status: result?.error?.status,
      code: result?.error?.code,
    });
  }
  return result.data;
}

async function serviceRpc(admin, name, parameters) {
  return sdkData(await admin.rpc(name, parameters), `RPC ${name}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function randomPassword() {
  return `${randomBytes(30).toString('base64url')}Aa1!`;
}

function validateProjectRef(projectRef) {
  if (projectRef !== EXPECTED_PROJECT_REF) {
    throw new HarnessError(`Hosted tests are allowlisted only for ${EXPECTED_PROJECT_REF}`);
  }
}

async function loadConfiguration(projectRef) {
  validateProjectRef(projectRef);
  const accessToken = loadAccessToken();
  secretsForRedaction.push(accessToken);
  const keyInventory = supabaseJson(accessToken, [
    'projects',
    'api-keys',
    '--project-ref',
    projectRef,
    '--reveal',
    '--output',
    'json',
  ]);
  const keys = selectProjectKeys(keyInventory);
  secretsForRedaction.push(keys.publishableKey, keys.secretKey);
  const functions = supabaseJson(accessToken, [
    'functions',
    'list',
    '--project-ref',
    projectRef,
    '--output',
    'json',
  ]);
  const activeFunctions = new Set(
    functions
      .filter((entry) => entry?.status === 'ACTIVE' && typeof entry?.name === 'string')
      .map((entry) => entry.name),
  );
  const functionDeployments = functions
    .filter((entry) => activeFunctions.has(entry?.name))
    .map((entry) => ({
      name: entry.name,
      version: Number.isSafeInteger(entry.version) ? entry.version : null,
      updatedAt: typeof entry.updated_at === 'string'
        ? entry.updated_at
        : Number.isSafeInteger(entry.updated_at)
        ? new Date(entry.updated_at).toISOString()
        : null,
      sha256: typeof entry.ezbr_sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.ezbr_sha256)
        ? entry.ezbr_sha256
        : null,
      verifyJwt: typeof entry.verify_jwt === 'boolean' ? entry.verify_jwt : null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const functionName of CORE_FUNCTIONS) {
    assert(activeFunctions.has(functionName), `Required deployed function is unavailable: ${functionName}`);
  }
  const authConfig = await managementRequest(accessToken, projectRef, 'config/auth');
  assert(authConfig?.mfa_totp_enroll_enabled === true, 'Hosted TOTP enrollment is disabled');
  assert(authConfig?.mfa_totp_verify_enabled === true, 'Hosted TOTP verification is disabled');
  const url = `https://${projectRef}.supabase.co`;
  return {
    accessToken,
    activeFunctions,
    authConfig,
    functionDeployments,
    keys,
    projectRef,
    url,
  };
}

function unsupportedScenarios() {
  const scenarios = [];
  scenarios.push(
    {
      scenario: 'email_otp_delivery',
      status: 'SKIP',
      reason: 'production SMTP, redirect URLs, and CAPTCHA are not configured for delivery testing',
    },
    {
      scenario: 'attachment_malware_scan',
      status: 'SKIP',
      reason: 'attachment scanner provider and newone-attachment-scan-worker are unavailable',
    },
    {
      scenario: 'ai_translation_completion',
      status: 'SKIP',
      reason: 'AI worker deployment and approved employee-data egress are unavailable; original messages remain in scope',
    },
    {
      scenario: 'push_delivery_receipts',
      status: 'SKIP',
      reason: 'signed device builds, provider credentials, and newone-push-receipt-worker are unavailable',
    },
    {
      scenario: 'same_origin_web_gateway',
      status: 'SKIP',
      reason: 'no deployed public web host and same-origin /api gateway are configured',
    },
  );
  return scenarios;
}

async function validateHostedConfiguration(configuration) {
  const rows = await managementSql(
    configuration.accessToken,
    configuration.projectRef,
    `select json_build_object(
      'bootstrap_rpc', to_regprocedure('public.bff_bootstrap_organization(uuid,text,text,text,text)') is not null,
      'bind_rpc', to_regprocedure('public.bff_bind_session_installation(uuid,uuid,uuid,text,text,text,text,text)') is not null,
      'redeem_rpc', to_regprocedure('public.redeem_organization_invite(text,text)') is not null,
      'rate_limit_organization_column', exists (
        select 1
        from pg_attribute attribute
        where attribute.attrelid = 'private.rate_limit_buckets'::regclass
          and attribute.attname = 'organization_id'
          and attribute.atttypid = 'uuid'::regtype
          and not attribute.attnotnull
          and not attribute.attisdropped
      ),
      'rate_limit_organization_fk', exists (
        select 1
        from pg_constraint constraint_row
        where constraint_row.conrelid = 'private.rate_limit_buckets'::regclass
          and constraint_row.confrelid = 'public.organizations'::regclass
          and constraint_row.contype = 'f'
          and constraint_row.confdeltype = 'c'
          and constraint_row.conkey = array[
            (
              select attribute.attnum
              from pg_attribute attribute
              where attribute.attrelid = 'private.rate_limit_buckets'::regclass
                and attribute.attname = 'organization_id'
                and not attribute.attisdropped
            )
          ]::smallint[]
      ),
      'cleanup_function_contract', (
        select count(*) = 6
        from pg_proc routine
        join pg_namespace namespace_row on namespace_row.oid = routine.pronamespace
        where namespace_row.nspname = 'private'
          and routine.proname = any (array[
            'block_message_version_mutation',
            'block_preservation_hold_delete',
            'prevent_immutable_record_mutation',
            'prevent_audit_mutation',
            'prevent_moderation_evidence_mutation',
            'prevent_audit_export_receipt_mutation'
          ])
          and routine.pronargs = 0
          and not routine.prosecdef
          and pg_get_userbyid(routine.proowner) in ('postgres', 'supabase_admin')
          and position('app.allow_audit_maintenance' in routine.prosrc) > 0
          and position('current_user' in routine.prosrc) > 0
          and not has_function_privilege('anon', routine.oid, 'execute')
          and not has_function_privilege('authenticated', routine.oid, 'execute')
          and not has_function_privilege('service_role', routine.oid, 'execute')
      ),
      'organization_count', (select count(*) from public.organizations),
      'auth_user_count', (select count(*) from auth.users)
    ) as readiness`,
  );
  const readiness = rows?.[0]?.readiness;
  assert(readiness?.bootstrap_rpc === true, 'Hosted bootstrap RPC is unavailable');
  assert(readiness?.bind_rpc === true, 'Hosted session binding RPC is unavailable');
  assert(readiness?.redeem_rpc === true, 'Hosted invitation redemption RPC is unavailable');
  assert(
    readiness?.rate_limit_organization_column === true,
    'Hosted organization-scoped rate-limit migration is unavailable',
  );
  assert(
    readiness?.rate_limit_organization_fk === true,
    'Hosted rate-limit organization cleanup FK is unavailable',
  );
  assert(
    readiness?.cleanup_function_contract === true,
    'Hosted privileged evidence-cleanup function contract is unavailable',
  );
  return readiness;
}

async function edgeRequest(configuration, input) {
  checkInterrupted();
  const functionName = input.functionName;
  assert(EDGE_FUNCTIONS.has(functionName), `Unsupported Edge function target: ${functionName}`);
  const headers = new Headers({
    apikey: input.apiKey ?? configuration.keys.publishableKey,
    'Content-Type': 'application/json',
  });
  if (typeof input.accessToken === 'string') {
    headers.set('Authorization', `Bearer ${input.accessToken}`);
  }
  if (input.idempotencyKey) headers.set('Idempotency-Key', input.idempotencyKey);
  for (const [name, value] of Object.entries(input.headers ?? {})) headers.set(name, value);
  const response = await fetch(`${configuration.url}/functions/v1/${functionName}${input.path}`, {
    method: input.method ?? 'POST',
    headers,
    body: JSON.stringify(input.body ?? {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { body, headers: response.headers, status: response.status };
}

async function expectEdge(configuration, input, expectedStatus) {
  const result = await edgeRequest(configuration, input);
  if (result.status !== expectedStatus) {
    throw new HarnessError(`${input.method ?? 'POST'} ${input.path} returned an unexpected response`, {
      status: result.status,
      code: publicErrorCode(result.body),
    });
  }
  return result.body;
}

async function expectDenied(configuration, input, expectedStatus = 403) {
  const result = await edgeRequest(configuration, input);
  if (result.status !== expectedStatus) {
    throw new HarnessError(`${input.method ?? 'POST'} ${input.path} was not denied as expected`, {
      status: result.status,
      code: publicErrorCode(result.body),
    });
  }
  return result.body;
}

async function expectDeniedWithStatus(configuration, input, expectedStatuses) {
  const result = await edgeRequest(configuration, input);
  if (!expectedStatuses.includes(result.status)) {
    throw new HarnessError(`${input.method ?? 'POST'} ${input.path} was not denied as expected`, {
      status: result.status,
      code: publicErrorCode(result.body),
    });
  }
  return result;
}

function forgedAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: randomUUID(),
    session_id: randomUUID(),
    aal: 'aal1',
    role: 'authenticated',
    iat: now,
    exp: now + 3600,
  })}.${randomBytes(32).toString('base64url')}`;
}

async function bindSession(admin, runId, userId, accessToken, installationId) {
  const claims = decodeJwtPayload(accessToken);
  assert(claims.sub === userId && isUuid(claims.session_id), 'Auth token has invalid user/session claims');
  const result = await serviceRpc(admin, 'bff_bind_session_installation', {
    p_actor_user_id: userId,
    p_session_id: claims.session_id,
    p_installation_id: installationId,
    p_platform: 'web',
    p_app_version: 'hosted-e2e/1',
    p_locale: 'en-US',
    p_user_agent_hash: sha256(`newone-hosted-e2e:${runId}:${userId}`),
    p_user_agent_family: 'desktop',
  });
  assert(result?.bound === true && result?.session_id === claims.session_id, 'Session binding was not persisted');
  return claims;
}

async function signIn(client, identity) {
  const data = sdkData(
    await client.auth.signInWithPassword({ email: identity.email, password: identity.password }),
    `Hosted Auth sign-in for ${identity.role}`,
  );
  assert(data.user?.id === identity.id && data.session?.access_token, 'Hosted Auth returned the wrong principal');
  return data.session;
}

async function waitForStableTotpWindow() {
  const seconds = Math.floor(Date.now() / 1000);
  const remaining = 30 - (seconds % 30);
  if (remaining <= 3) await new Promise((resolveWait) => setTimeout(resolveWait, (remaining + 1) * 1000));
}

async function elevateWithTotp(client, runId, session) {
  const enrollment = sdkData(
    await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `${runId}-owner` }),
    'Hosted TOTP enrollment',
  );
  assert(isUuid(enrollment.id) && typeof enrollment.totp?.secret === 'string', 'TOTP enrollment response is invalid');
  await waitForStableTotpWindow();
  const challenge = sdkData(
    await client.auth.mfa.challenge({ factorId: enrollment.id }),
    'Hosted TOTP challenge',
  );
  const verified = sdkData(
    await client.auth.mfa.verify({
      factorId: enrollment.id,
      challengeId: challenge.id,
      code: generateTotp(enrollment.totp.secret),
    }),
    'Hosted TOTP verification',
  );
  assert(verified.access_token && verified.refresh_token, 'TOTP verification did not issue a session');
  const claims = decodeJwtPayload(verified.access_token);
  assert(claims.aal === 'aal2', 'TOTP verification did not produce AAL2');
  return {
    ...session,
    access_token: verified.access_token,
    refresh_token: verified.refresh_token,
    user: verified.user,
  };
}

function identityDefinitions(runId) {
  return {
    ownerA: {
      role: 'owner_a',
      email: `${runId}-owner-a@example.invalid`,
      displayName: `Operations Owner A ${runId.slice(-8)}`,
      password: randomPassword(),
    },
    ownerB: {
      role: 'owner_b',
      email: `${runId}-owner-b@example.invalid`,
      displayName: `Operations Owner B ${runId.slice(-8)}`,
      password: randomPassword(),
    },
    memberA: {
      role: 'member_a',
      email: `${runId}-member-a@example.invalid`,
      displayName: `Shift Member A ${runId.slice(-8)}`,
      password: randomPassword(),
    },
  };
}

function publicIdentity(identity) {
  return { role: identity.role, id: identity.id, email: identity.email };
}

async function createAdminUser(admin, runId, identity) {
  const data = sdkData(
    await admin.auth.admin.createUser({
      email: identity.email,
      password: identity.password,
      email_confirm: true,
      user_metadata: { display_name: identity.displayName },
      app_metadata: { newone_e2e_run: runId },
    }),
    `Create real Auth user ${identity.role}`,
  );
  assert(isUuid(data.user?.id), `Auth user ID is invalid for ${identity.role}`);
  identity.id = data.user.id;
  return identity;
}

async function bootstrapOrganization(configuration, bootstrapToken, runId, owner, suffix) {
  const name = `Newone Hosted E2E ${suffix.toUpperCase()} ${runId.slice(-8)}`;
  const slug = `${runId}-org-${suffix}`;
  const result = await expectEdge(configuration, {
    functionName: BOOTSTRAP_FUNCTION,
    path: '',
    apiKey: configuration.keys.secretKey,
    idempotencyKey: `${runId}-bootstrap-${suffix}`,
    headers: { 'X-Newone-Bootstrap-Token': bootstrapToken },
    body: {
      ownerUserId: owner.id,
      ownerEmail: owner.email,
      organizationName: name,
      organizationSlug: slug,
    },
  }, 201);
  assert(
    result?.bootstrapped === true && result?.ownerUserId === owner.id &&
      result?.membershipRole === 'owner' && result?.membershipStatus === 'active' &&
      isUuid(result?.organizationId) && isUuid(result?.rootUnitId),
    'Organization bootstrap gateway returned an invalid receipt',
  );
  return { id: result.organizationId, slug, ownerUserId: owner.id };
}

async function assertBootstrapRejectsMissingToken(configuration, runId, owner) {
  const result = await edgeRequest(configuration, {
    functionName: BOOTSTRAP_FUNCTION,
    path: '',
    apiKey: configuration.keys.secretKey,
    idempotencyKey: `${runId}-bootstrap-unauthorized`,
    body: {
      ownerUserId: owner.id,
      ownerEmail: owner.email,
      organizationName: `Unauthorized bootstrap ${runId.slice(-8)}`,
      organizationSlug: `${runId}-unauthorized`,
    },
  });
  assert(
    result.status === 401 && publicErrorCode(result.body) === 'unauthorized',
    'Bootstrap gateway accepted a request without its shared secret',
    { status: result.status, code: publicErrorCode(result.body) },
  );
}

async function redeemInvitationThroughGateway(
  configuration,
  accessToken,
  invitationToken,
  employeeCode,
) {
  return await expectEdge(configuration, {
    functionName: AUTH_FUNCTION,
    path: '/v2/auth/invitations/redeem',
    accessToken,
    body: { invitationToken, employeeCode },
  }, 200);
}

function realtimeEvent(value, expected) {
  const payload = realtimeApplicationPayload(value);
  assert(
    payload.schema_version === 1 && payload.event === REALTIME_EVENT &&
      payload.organization_id === expected.organizationId &&
      payload.conversation_id === expected.conversationId &&
      payload.entity_type === 'message' && String(payload.entity_id) === String(expected.messageId) &&
      typeof payload.event_id === 'string' && isUuid(payload.event_id) &&
      typeof payload.occurred_at === 'string' && !Number.isNaN(Date.parse(payload.occurred_at)),
    'Private Realtime delivered an invalid workspace invalidation envelope',
  );
  return payload;
}

async function subscribePrivateRealtime(client, accessToken, topic, onEvent) {
  await client.realtime.setAuth(accessToken);
  let subscriptionResolve;
  let subscriptionReject;
  const subscribed = new Promise((resolveSubscription, rejectSubscription) => {
    subscriptionResolve = resolveSubscription;
    subscriptionReject = rejectSubscription;
  });
  const channel = client.channel(topic, {
    config: { private: true, broadcast: { ack: true, self: false } },
  });
  channel.on('broadcast', { event: REALTIME_EVENT }, onEvent);
  channel.subscribe((status, error) => {
    if (status === 'SUBSCRIBED') subscriptionResolve();
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      subscriptionReject(new HarnessError(`Private Realtime subscription failed: ${status}`, {
        code: error?.code,
      }));
    }
  });
  await withTimeout(subscribed, 20_000, 'Private Realtime subscription timed out');
  return channel;
}

async function expectPrivateRealtimeDenied(client, accessToken, topic) {
  await client.realtime.setAuth(accessToken);
  const channel = client.channel(topic, {
    config: { private: true, broadcast: { ack: true, self: false } },
  });
  try {
    await new Promise((resolveDenial, rejectDenial) => {
      const timer = setTimeout(
        () => rejectDenial(new HarnessError('Cross-tenant Realtime denial was not observed')),
        20_000,
      );
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer);
          rejectDenial(new HarnessError('Cross-tenant principal subscribed to a private topic'));
        }
        if (status === 'CHANNEL_ERROR') {
          clearTimeout(timer);
          resolveDenial();
        }
      });
    });
  } finally {
    await client.removeChannel(channel);
  }
}

async function exhaustDirectConversationRateLimit(configuration, input) {
  const attempts = Array.from({ length: 14 }, (_, index) => {
    return {
      response: edgeRequest(configuration, {
        functionName: 'newone-api',
        path: '/v2/conversations/direct',
        accessToken: input.accessToken,
        idempotencyKey: randomUUID(),
        body: {
          organizationId: input.organizationId,
          targetMembershipId: input.targetMembershipId,
        },
      }),
      sequence: index + 1,
    };
  });
  const results = await Promise.all(attempts.map(async (attempt) => ({
    sequence: attempt.sequence,
    result: await attempt.response,
  })));
  const successful = results.filter(({ result }) => result.status === 201);
  const denied = results.filter(({ result }) => result.status === 429);
  const unexpected = results.find(({ result }) => ![201, 429].includes(result.status));
  assert(!unexpected, 'Rate-limit burst returned an unexpected status', {
    status: unexpected?.result.status,
    code: publicErrorCode(unexpected?.result.body),
  });
  assert(successful.length > 0, 'Rate-limit burst did not execute any real commands');
  assert(denied.length > 0, 'Rate-limit burst did not exhaust the hosted budget');
  for (const { result } of successful) {
    assert(
      result.body?.conversationId === input.expectedConversationId,
      'Rate-limit command returned a different direct conversation',
    );
  }
  for (const { result } of denied) {
    const retryAfter = Number(result.headers.get('retry-after'));
    assert(
      publicErrorCode(result.body) === 'rate_limited' &&
        Number.isInteger(retryAfter) && retryAfter >= 1,
      'Rate-limit denial omitted its public code or Retry-After contract',
      { status: result.status, code: publicErrorCode(result.body) },
    );
  }
  return { attempted: results.length, committed: successful.length, denied: denied.length };
}

async function saveArtifact(state, artifactPath) {
  const temporaryPath = `${artifactPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, artifactPath);
}

async function runStep(state, artifactPath, name, operation) {
  checkInterrupted();
  const record = { name, status: 'running', startedAt: new Date().toISOString() };
  state.steps.push(record);
  await saveArtifact(state, artifactPath);
  log('RUN', name);
  try {
    const result = await operation();
    record.status = 'passed';
    record.completedAt = new Date().toISOString();
    await saveArtifact(state, artifactPath);
    log('PASS', name);
    return result;
  } catch (error) {
    record.status = 'failed';
    record.completedAt = new Date().toISOString();
    record.error = safeFailure(error);
    await saveArtifact(state, artifactPath);
    log('FAIL', name, record.error);
    throw error;
  }
}

function assertExecutionGates(options, runId) {
  if (process.env.NEWONE_HOSTED_E2E !== EXECUTION_CONFIRMATION) {
    throw new HarnessError('Set NEWONE_HOSTED_E2E=1 to permit creation of real hosted test data');
  }
  if (options.cleanup && process.env.NEWONE_HOSTED_E2E_CLEANUP_CONFIRM !== runId) {
    throw new HarnessError('Cleanup confirmation must exactly equal the selected run ID');
  }
}

async function rawTableAccess(configuration, accessToken, organizationId) {
  const response = await fetch(
    `${configuration.url}/rest/v1/messages?select=id&organization_id=eq.${encodeURIComponent(organizationId)}`,
    {
      headers: {
        apikey: configuration.keys.publishableKey,
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (response.ok) {
    assert(Array.isArray(body) && body.length === 0, 'Raw table endpoint exposed message rows');
  } else {
    assert([401, 403, 404].includes(response.status), 'Raw table endpoint failed in an unexpected way', {
      status: response.status,
    });
  }
}

function aggregateEvidenceSql(context) {
  const orgA = sqlLiteral(context.orgA.id);
  const orgB = sqlLiteral(context.orgB.id);
  const ownerA = sqlLiteral(context.identities.ownerA.id);
  const ownerB = sqlLiteral(context.identities.ownerB.id);
  const memberA = sqlLiteral(context.identities.memberA.id);
  const directId = sqlLiteral(context.directConversationId);
  const groupId = sqlLiteral(context.groupConversationId);
  const idempotentNonce = sqlLiteral(context.idempotentClientMessageId);
  return `select json_build_object(
    'organizations', (select count(*) from public.organizations where id in (${orgA}::uuid, ${orgB}::uuid)),
    'profiles', (select count(*) from public.profiles where user_id in (${ownerA}::uuid, ${ownerB}::uuid, ${memberA}::uuid)),
    'org_a_memberships', (select count(*) from public.organization_memberships where organization_id = ${orgA}::uuid and status = 'active'),
    'org_b_memberships', (select count(*) from public.organization_memberships where organization_id = ${orgB}::uuid and status = 'active'),
    'accepted_contacts', (select count(*) from public.contact_connections where organization_id = ${orgA}::uuid and status = 'accepted'),
    'direct_conversations', (select count(*) from public.conversations where organization_id = ${orgA}::uuid and id = ${directId}::uuid and kind = 'direct'),
    'group_conversations', (select count(*) from public.conversations where organization_id = ${orgA}::uuid and id = ${groupId}::uuid and kind = 'group'),
    'text_messages', (select count(*) from public.messages where organization_id = ${orgA}::uuid and conversation_id in (${directId}::uuid, ${groupId}::uuid) and kind = 'text' and deleted_at is null),
    'idempotent_nonce_rows', (select count(*) from public.messages where organization_id = ${orgA}::uuid and client_nonce = ${idempotentNonce}::uuid),
    'idempotency_ledger_rows', (select count(*) from private.api_idempotency_keys where organization_id = ${orgA}::uuid),
    'cross_tenant_message_rows', (select count(*) from public.messages where organization_id = ${orgB}::uuid and conversation_id in (${directId}::uuid, ${groupId}::uuid))
  ) as evidence`;
}

function assertAggregateEvidence(evidence) {
  assert(Number(evidence?.organizations) === 2, 'Aggregate proof did not find both organizations');
  assert(Number(evidence?.profiles) === 3, 'Aggregate proof did not find all Auth-backed profiles');
  assert(Number(evidence?.org_a_memberships) === 2, 'Organization A membership count is incorrect');
  assert(Number(evidence?.org_b_memberships) === 1, 'Organization B membership count is incorrect');
  assert(Number(evidence?.accepted_contacts) === 1, 'Accepted contact was not persisted');
  assert(Number(evidence?.direct_conversations) === 1, 'Direct conversation was not persisted');
  assert(Number(evidence?.group_conversations) === 1, 'Group conversation was not persisted');
  assert(Number(evidence?.text_messages) >= 3, 'Persisted text-message count is too low');
  assert(Number(evidence?.idempotent_nonce_rows) === 1, 'Idempotent retry created duplicate messages');
  assert(Number(evidence?.idempotency_ledger_rows) >= 1, 'Idempotency ledger was not persisted');
  assert(Number(evidence?.cross_tenant_message_rows) === 0, 'Cross-tenant message linkage was persisted');
}

export function cleanupSql(manifest) {
  const validated = validateCleanupManifest(manifest);
  const userRows = validated.users.length === 0
    ? null
    : validated.users.map((user) => `(${sqlLiteral(user.id)}::uuid, ${sqlLiteral(user.email)})`).join(', ');
  const organizationRows = validated.organizations.length === 0
    ? null
    : validated.organizations.map((organization) =>
      `(${sqlLiteral(organization.id)}::uuid, ${sqlLiteral(organization.slug)})`
    ).join(', ');
  const userArray = validated.users.length === 0
    ? 'array[]::uuid[]'
    : `array[${validated.users.map((user) => `${sqlLiteral(user.id)}::uuid`).join(', ')}]`;
  const organizationArray = validated.organizations.length === 0
    ? 'array[]::uuid[]'
    : `array[${validated.organizations.map((organization) => `${sqlLiteral(organization.id)}::uuid`).join(', ')}]`;
  const userValidation = userRows
    ? `if exists (
        select 1 from auth.users auth_user
        join (values ${userRows}) expected(id, email) on expected.id = auth_user.id
        where lower(auth_user.email) <> expected.email
          or auth_user.created_at is null
          or auth_user.created_at < ${sqlLiteral(validated.startedAt)}::timestamptz - interval '5 minutes'
      ) then raise exception 'hosted E2E cleanup user guard failed'; end if;`
    : '';
  const organizationValidation = organizationRows
    ? `if exists (
        select 1 from public.organizations organization
        join (values ${organizationRows}) expected(id, slug) on expected.id = organization.id
        where organization.slug <> expected.slug
          or not (organization.created_by_user_id = any (target_users))
          or organization.created_at < ${sqlLiteral(validated.startedAt)}::timestamptz - interval '5 minutes'
      ) then raise exception 'hosted E2E cleanup organization guard failed'; end if;`
    : '';
  return `begin;
  select pg_advisory_xact_lock(hashtextextended(${sqlLiteral(`cleanup:${validated.runId}`)}, 0));
  do $newone_hosted_cleanup$
  declare
    target_users uuid[] := ${userArray};
    target_organizations uuid[] := ${organizationArray};
    target_sessions uuid[] := array[]::uuid[];
    scoped_table record;
    scoped_user_column record;
    unexpected_global_user_column record;
    leaked_reference boolean;
    cleanup_progress boolean;
    deleted_rows bigint;
    remaining bigint;
  begin
    ${userValidation}
    ${organizationValidation}
    if exists (
      select 1
      from public.organizations organization
      where organization.created_by_user_id = any (target_users)
        and not (organization.id = any (target_organizations))
    ) then raise exception 'hosted E2E cleanup found a target user owning a non-target organization'; end if;
    for scoped_user_column in
      select user_column.table_schema, user_column.table_name, user_column.column_name
      from information_schema.columns user_column
      join information_schema.tables base_table
        on base_table.table_schema = user_column.table_schema
       and base_table.table_name = user_column.table_name
       and base_table.table_type = 'BASE TABLE'
      where user_column.table_schema in ('public', 'private')
        and user_column.data_type = 'uuid'
        and (user_column.column_name = 'user_id' or user_column.column_name like '%\\_user_id' escape '\\')
        and exists (
          select 1 from information_schema.columns organization_column
          where organization_column.table_schema = user_column.table_schema
            and organization_column.table_name = user_column.table_name
            and organization_column.column_name = 'organization_id'
        )
      order by user_column.table_schema, user_column.table_name, user_column.column_name
    loop
      execute format(
        'select exists (select 1 from %I.%I where %I = any ($1) and (organization_id is null or not (organization_id = any ($2))))',
        scoped_user_column.table_schema,
        scoped_user_column.table_name,
        scoped_user_column.column_name
      ) into leaked_reference using target_users, target_organizations;
      if leaked_reference then
        raise exception 'hosted E2E cleanup found a target user referenced outside target organizations';
      end if;
    end loop;
    select user_column.table_schema, user_column.table_name, user_column.column_name
      into unexpected_global_user_column
    from information_schema.columns user_column
    join information_schema.tables base_table
      on base_table.table_schema = user_column.table_schema
     and base_table.table_name = user_column.table_name
     and base_table.table_type = 'BASE TABLE'
    where user_column.table_schema in ('public', 'private')
      and user_column.data_type = 'uuid'
      and (user_column.column_name = 'user_id' or user_column.column_name like '%\\_user_id' escape '\\')
      and not exists (
        select 1 from information_schema.columns organization_column
        where organization_column.table_schema = user_column.table_schema
          and organization_column.table_name = user_column.table_name
          and organization_column.column_name = 'organization_id'
      )
      and (user_column.table_schema, user_column.table_name, user_column.column_name) not in (
        ('private', 'account_recovery_execution_sessions', 'user_id'),
        ('private', 'bootstrap_idempotency_keys', 'owner_user_id'),
        ('private', 'session_installations', 'user_id'),
        ('public', 'organizations', 'created_by_user_id'),
        ('public', 'profiles', 'user_id')
      )
    limit 1;
    if unexpected_global_user_column.table_name is not null then
      raise exception 'hosted E2E cleanup requires review for a new global user reference';
    end if;
    select coalesce(array_agg(distinct installation.session_id), array[]::uuid[])
      into target_sessions
    from private.session_installations installation
    where installation.user_id = any (target_users);
    perform set_config('app.allow_audit_maintenance', 'on', true);
    delete from private.rate_limit_buckets bucket
    where (
      exists (
        select 1
        from unnest(target_organizations) as organization_ids(organization_id)
        cross join unnest(target_users) as user_ids(user_id)
        where bucket.key_hash = extensions.digest(
          organization_id::text || ':' || user_id::text,
          'sha256'
        )
      )
    ) or (
      bucket.scope like 'bff-session:%'
      and exists (
        select 1
        from unnest(target_organizations) as organization_ids(organization_id)
        cross join unnest(target_users) as user_ids(user_id)
        cross join unnest(target_sessions) as session_ids(session_id)
        where bucket.key_hash = extensions.digest(
          organization_id::text || ':' || user_id::text || ':' || session_id::text,
          'sha256'
        )
      )
    );
    loop
      cleanup_progress := false;
      remaining := 0;
      for scoped_table in
        select schema_column.table_schema, schema_column.table_name
        from information_schema.columns schema_column
        join information_schema.tables base_table
          on base_table.table_schema = schema_column.table_schema
         and base_table.table_name = schema_column.table_name
         and base_table.table_type = 'BASE TABLE'
        where schema_column.table_schema in ('public', 'private')
          and schema_column.column_name = 'organization_id'
        order by schema_column.table_schema, schema_column.table_name
      loop
        begin
          execute format(
            'delete from %I.%I where organization_id = any ($1)',
            scoped_table.table_schema,
            scoped_table.table_name
          ) using target_organizations;
          get diagnostics deleted_rows = row_count;
          if deleted_rows > 0 then cleanup_progress := true; end if;
        exception when foreign_key_violation then
          null;
        end;
      end loop;
      for scoped_table in
        select schema_column.table_schema, schema_column.table_name
        from information_schema.columns schema_column
        join information_schema.tables base_table
          on base_table.table_schema = schema_column.table_schema
         and base_table.table_name = schema_column.table_name
         and base_table.table_type = 'BASE TABLE'
        where schema_column.table_schema in ('public', 'private')
          and schema_column.column_name = 'organization_id'
        order by schema_column.table_schema, schema_column.table_name
      loop
        execute format(
          'select count(*) from %I.%I where organization_id = any ($1)',
          scoped_table.table_schema,
          scoped_table.table_name
        ) into deleted_rows using target_organizations;
        remaining := remaining + deleted_rows;
      end loop;
      exit when remaining = 0;
      if not cleanup_progress then
        raise exception 'hosted E2E cleanup could not satisfy organization-scoped foreign keys';
      end if;
    end loop;
    delete from private.session_installations where user_id = any (target_users);
    delete from private.account_recovery_execution_sessions where user_id = any (target_users);
    delete from private.bootstrap_idempotency_keys where owner_user_id = any (target_users);
    delete from public.organizations where id = any (target_organizations);
    delete from public.profiles where user_id = any (target_users);
    for scoped_table in
      select schema_column.table_schema, schema_column.table_name
      from information_schema.columns schema_column
      join information_schema.tables base_table
        on base_table.table_schema = schema_column.table_schema
       and base_table.table_name = schema_column.table_name
       and base_table.table_type = 'BASE TABLE'
      where schema_column.table_schema in ('public', 'private')
        and schema_column.column_name = 'organization_id'
      order by schema_column.table_schema, schema_column.table_name
    loop
      execute format('select count(*) from %I.%I where organization_id = any ($1)', scoped_table.table_schema, scoped_table.table_name)
        into remaining using target_organizations;
      if remaining <> 0 then raise exception 'hosted E2E cleanup left organization-scoped rows'; end if;
    end loop;
    if exists (select 1 from public.organizations where id = any (target_organizations))
      or exists (select 1 from public.profiles where user_id = any (target_users))
      or exists (select 1 from private.session_installations where user_id = any (target_users))
      or exists (
        select 1 from private.rate_limit_buckets bucket
        where bucket.organization_id = any (target_organizations)
      )
      or exists (
        select 1 from private.rate_limit_buckets bucket
        where exists (
            select 1
            from unnest(target_organizations) as organization_ids(organization_id)
            cross join unnest(target_users) as user_ids(user_id)
            where bucket.key_hash = extensions.digest(
              organization_id::text || ':' || user_id::text,
              'sha256'
            )
          )
      )
      or exists (
        select 1 from private.rate_limit_buckets bucket
        where bucket.scope like 'bff-session:%'
          and exists (
            select 1
            from unnest(target_organizations) as organization_ids(organization_id)
            cross join unnest(target_users) as user_ids(user_id)
            cross join unnest(target_sessions) as session_ids(session_id)
            where bucket.key_hash = extensions.digest(
              organization_id::text || ':' || user_id::text || ':' || session_id::text,
              'sha256'
            )
          )
      )
    then raise exception 'hosted E2E cleanup postcondition failed'; end if;
  end
  $newone_hosted_cleanup$;
  commit;`;
}

async function expandCleanupManifest(configuration, manifest) {
  const validated = validateCleanupManifest(manifest, configuration.projectRef);
  const runPrefix = `${validated.runId}-%@example.invalid`;
  const organizationPrefix = `${validated.runId}-org-%`;
  const rows = await managementSql(configuration.accessToken, configuration.projectRef, `
    select 'user' as kind, id::text as id, lower(email) as value
    from auth.users
    where lower(email) like ${sqlLiteral(runPrefix)}
      and created_at >= ${sqlLiteral(validated.startedAt)}::timestamptz - interval '5 minutes'
    union all
    select 'organization' as kind, id::text as id, slug as value
    from public.organizations
    where slug like ${sqlLiteral(organizationPrefix)}
      and created_at >= ${sqlLiteral(validated.startedAt)}::timestamptz - interval '5 minutes'
    order by kind, id`);
  const users = new Map(validated.users.map((user) => [user.id, user]));
  const organizations = new Map(
    validated.organizations.map((organization) => [organization.id, organization]),
  );
  for (const row of rows ?? []) {
    if (row.kind === 'user') users.set(row.id, { id: row.id, email: row.value });
    if (row.kind === 'organization') {
      organizations.set(row.id, { id: row.id, slug: row.value });
    }
  }
  manifest.users = [...users.values()];
  manifest.organizations = [...organizations.values()];
  validateCleanupManifest(manifest, configuration.projectRef);
  return manifest;
}

async function cleanupRun(configuration, manifest) {
  await expandCleanupManifest(configuration, manifest);
  const validated = validateCleanupManifest(manifest, configuration.projectRef);
  if (process.env.NEWONE_HOSTED_E2E_CLEANUP_CONFIRM !== validated.runId) {
    throw new HarnessError('Cleanup confirmation must exactly equal the manifest run ID');
  }
  log('RUN', 'guarded_database_cleanup');
  await managementSql(configuration.accessToken, configuration.projectRef, cleanupSql(manifest));
  const { admin } = createClients(configuration.url, configuration.keys);
  for (const user of validated.users) {
    const result = await admin.auth.admin.deleteUser(user.id, false);
    if (result.error && result.error.status !== 404) {
      throw new HarnessError('Auth user cleanup failed', {
        status: result.error.status,
        code: result.error.code,
      });
    }
  }
  const userIds = validated.users.map((user) => `${sqlLiteral(user.id)}::uuid`).join(', ') || 'null::uuid';
  const organizationIds = validated.organizations
    .map((organization) => `${sqlLiteral(organization.id)}::uuid`).join(', ') || 'null::uuid';
  const rows = await managementSql(configuration.accessToken, configuration.projectRef, `select
    (select count(*) from auth.users where id in (${userIds})) as auth_users,
    (select count(*) from public.organizations where id in (${organizationIds})) as organizations,
    (select count(*) from public.profiles where user_id in (${userIds})) as profiles`);
  assert(Number(rows?.[0]?.auth_users) === 0, 'Auth cleanup postcondition failed');
  assert(Number(rows?.[0]?.organizations) === 0, 'Organization cleanup postcondition failed');
  assert(Number(rows?.[0]?.profiles) === 0, 'Profile cleanup postcondition failed');
  log('PASS', 'guarded_database_cleanup');
}

async function executeHostedRun(options, configuration) {
  const runId = assertRunId(options.runId ?? makeRunId());
  assertExecutionGates(options, runId);
  const bootstrapToken = validateHostedExecutionPrerequisites(
    configuration.activeFunctions,
    process.env.NEWONE_HOSTED_BOOTSTRAP_TOKEN,
    configuration.functionDeployments,
  );
  secretsForRedaction.push(bootstrapToken);
  const artifactPath = join(ARTIFACT_DIRECTORY, `${runId}.json`);
  const state = {
    schemaVersion: 1,
    runId,
    projectRef: configuration.projectRef,
    startedAt: new Date().toISOString(),
    status: 'running',
    functionDeployments: configuration.functionDeployments.filter((entry) =>
      REQUIRED_EXECUTION_FUNCTIONS.includes(entry.name)
    ),
    users: [],
    organizations: [],
    conversations: [],
    messages: [],
    steps: [],
    skips: unsupportedScenarios(),
  };
  await saveArtifact(state, artifactPath);

  const identities = identityDefinitions(runId);
  const { admin, createPublicClient } = createClients(configuration.url, configuration.keys);
  const runtime = {
    ownerAClient: null,
    ownerBClient: null,
    memberAClient: null,
    sessions: {},
    installations: {
      ownerA: randomUUID(),
      ownerB: randomUUID(),
      memberA: randomUUID(),
    },
  };
  const context = { identities };

  try {
    await runStep(state, artifactPath, 'real_auth_owner_creation', async () => {
      await createAdminUser(admin, runId, identities.ownerA);
      state.users.push(publicIdentity(identities.ownerA));
      await saveArtifact(state, artifactPath);
      await createAdminUser(admin, runId, identities.ownerB);
      state.users.push(publicIdentity(identities.ownerB));
      await saveArtifact(state, artifactPath);
    });

    await runStep(state, artifactPath, 'real_bootstrap_gateway_secret_denial', async () => {
      await assertBootstrapRejectsMissingToken(configuration, runId, identities.ownerA);
    });

    await runStep(state, artifactPath, 'real_organization_bootstrap', async () => {
      context.orgA = await bootstrapOrganization(
        configuration,
        bootstrapToken,
        runId,
        identities.ownerA,
        'a',
      );
      state.organizations.push(context.orgA);
      await saveArtifact(state, artifactPath);
      context.orgB = await bootstrapOrganization(
        configuration,
        bootstrapToken,
        runId,
        identities.ownerB,
        'b',
      );
      state.organizations.push(context.orgB);
      await saveArtifact(state, artifactPath);
    });

    await runStep(state, artifactPath, 'real_missing_and_forged_auth_denial', async () => {
      const request = {
        functionName: 'newone-read',
        path: '/v2/bootstrap',
        body: {
          organizationId: context.orgA.id,
          selectedConversationId: null,
          beforeMessageId: null,
          conversationLimit: 1,
          timelineLimit: 1,
        },
      };
      const missing = await expectDeniedWithStatus(configuration, request, [401]);
      assert(publicErrorCode(missing.body) === 'unauthorized', 'Missing-auth denial used the wrong public code');
      const forged = await expectDeniedWithStatus(configuration, {
        ...request,
        accessToken: forgedAccessToken(),
      }, [401]);
      assert(publicErrorCode(forged.body) === 'unauthorized', 'Forged-auth denial used the wrong public code');
    });

    await runStep(state, artifactPath, 'real_auth_password_sessions', async () => {
      runtime.ownerAClient = createPublicClient();
      runtime.ownerBClient = createPublicClient();
      runtime.sessions.ownerA = await signIn(runtime.ownerAClient, identities.ownerA);
      runtime.sessions.ownerB = await signIn(runtime.ownerBClient, identities.ownerB);
      assert(
        decodeJwtPayload(runtime.sessions.ownerA.access_token).aal === 'aal1',
        'Fresh password session did not begin at AAL1',
      );
    });

    await runStep(state, artifactPath, 'real_unbound_session_denial', async () => {
      const denial = await expectDeniedWithStatus(configuration, {
        functionName: 'newone-read',
        path: '/v2/bootstrap',
        accessToken: runtime.sessions.ownerA.access_token,
        body: {
          organizationId: context.orgA.id,
          selectedConversationId: null,
          beforeMessageId: null,
          conversationLimit: 1,
          timelineLimit: 1,
        },
      }, [403]);
      assert(publicErrorCode(denial.body) === 'forbidden', 'Unbound-session denial used the wrong public code');
    });

    await runStep(state, artifactPath, 'real_session_binding', async () => {
      await bindSession(
        admin,
        runId,
        identities.ownerA.id,
        runtime.sessions.ownerA.access_token,
        runtime.installations.ownerA,
      );
      await bindSession(
        admin,
        runId,
        identities.ownerB.id,
        runtime.sessions.ownerB.access_token,
        runtime.installations.ownerB,
      );
    });

    await runStep(state, artifactPath, 'real_aal1_privileged_denial', async () => {
      const denial = await expectDeniedWithStatus(configuration, {
        functionName: 'newone-api',
        path: '/v2/admin/invitations',
        accessToken: runtime.sessions.ownerA.access_token,
        idempotencyKey: randomUUID(),
        body: {
          organizationId: context.orgA.id,
          destinationType: 'email',
          destination: `${runId}-aal1-denied@example.invalid`,
          employeeCode: `DENIED-${runId.slice(-8)}`,
          activationMode: 'manual',
          role: 'member',
          expiresInSeconds: 3600,
          membershipType: 'employee',
          membershipAccessExpiresAt: null,
          guestSponsorUserId: null,
        },
      }, [403]);
      assert(publicErrorCode(denial.body) === 'forbidden', 'AAL1 privilege denial used the wrong public code');
    });

    await runStep(state, artifactPath, 'real_totp_aal2', async () => {
      runtime.sessions.ownerA = await elevateWithTotp(
        runtime.ownerAClient,
        runId,
        runtime.sessions.ownerA,
      );
      const claims = await bindSession(
        admin,
        runId,
        identities.ownerA.id,
        runtime.sessions.ownerA.access_token,
        runtime.installations.ownerA,
      );
      const authorization = await serviceRpc(admin, 'bff_authorize_request', {
        p_actor_user_id: identities.ownerA.id,
        p_organization_id: context.orgA.id,
        p_session_id: claims.session_id,
        p_operation: 'invite.issue',
        p_require_aal2: true,
        p_recent_auth_seconds: 300,
      });
      assert(authorization?.allowed === true, 'Canonical database authorization rejected the verified AAL2 session', {
        code: authorization?.reason,
      });
      const invitePrincipalProbe = await serviceRpc(admin, 'bff_resolve_invite_principal', {
        p_actor_user_id: identities.ownerA.id,
        p_organization_id: context.orgA.id,
        p_session_id: claims.session_id,
        p_destination_type: 'email',
        p_destination: identities.memberA.email,
      });
      assert(
        invitePrincipalProbe?.authorized === true && invitePrincipalProbe?.user_id === null,
        'Canonical invitation permission or principal resolution rejected the verified owner',
      );
      await expectEdge(configuration, {
        functionName: 'newone-api',
        path: '/v2/admin/role-assignments/query',
        accessToken: runtime.sessions.ownerA.access_token,
        body: {
          organizationId: context.orgA.id,
          targetMembershipId: identities.ownerA.id,
          limit: 10,
        },
      }, 200);
    });

    await runStep(state, artifactPath, 'real_invitation_and_membership_redemption', async () => {
      await createAdminUser(admin, runId, identities.memberA);
      state.users.push(publicIdentity(identities.memberA));
      await saveArtifact(state, artifactPath);
      const employeeCode = `E2E-${runId.slice(-8)}`;
      const ownerSessionId = decodeJwtPayload(runtime.sessions.ownerA.access_token).session_id;
      const provisionedPrincipal = await serviceRpc(admin, 'bff_resolve_invite_principal', {
        p_actor_user_id: identities.ownerA.id,
        p_organization_id: context.orgA.id,
        p_session_id: ownerSessionId,
        p_destination_type: 'email',
        p_destination: identities.memberA.email,
      });
      assert(
        provisionedPrincipal?.authorized === true &&
          provisionedPrincipal?.user_id === identities.memberA.id,
        'Canonical invitation principal lookup did not find the pre-provisioned Auth account',
      );
      const rateProbe = await serviceRpc(admin, 'bff_consume_rate_limit', {
        p_actor_user_id: identities.ownerA.id,
        p_organization_id: context.orgA.id,
        p_session_id: ownerSessionId,
        p_operation: 'invite.issue',
        p_ip_hash: sha256(`${runId}:invite-rate-probe`),
      });
      assert(rateProbe?.allowed === true, 'Canonical invitation rate-limit boundary rejected the owner', {
        code: rateProbe?.reason,
      });
      await managementSql(configuration.accessToken, configuration.projectRef, `begin;
        select set_config('request.jwt.claims', '{"role":"service_role"}', true);
        select public.bff_issue_organization_invite_v2(
          ${sqlLiteral(identities.ownerA.id)}::uuid,
          ${sqlLiteral(context.orgA.id)}::uuid,
          ${sqlLiteral(ownerSessionId)}::uuid,
          'email',
          ${sqlLiteral(identities.memberA.email)},
          ${sqlLiteral(identities.memberA.id)}::uuid,
          ${sqlLiteral(employeeCode)},
          'manual',
          'member',
          3600,
          'employee',
          null::timestamptz,
          null::uuid,
          ${sqlLiteral(`${runId}-invite-rpc-probe`)},
          ${sqlLiteral(sha256(`${runId}:invite-rpc-probe`))}
        );
        rollback;`);
      const invitation = await expectEdge(configuration, {
        functionName: 'newone-api',
        path: '/v2/admin/invitations',
        accessToken: runtime.sessions.ownerA.access_token,
        idempotencyKey: randomUUID(),
        body: {
          organizationId: context.orgA.id,
          destinationType: 'email',
          destination: identities.memberA.email,
          employeeCode,
          activationMode: 'manual',
          role: 'member',
          expiresInSeconds: 3600,
          membershipType: 'employee',
          membershipAccessExpiresAt: null,
          guestSponsorUserId: null,
        },
      }, 201);
      assert(
        invitation?.tokenAvailable === true && /^[0-9a-f]{64}$/.test(invitation?.activationToken),
        'Manual invitation did not return its one-time activation token',
      );
      const principal = await serviceRpc(admin, 'bff_resolve_invite_principal', {
        p_actor_user_id: identities.ownerA.id,
        p_organization_id: context.orgA.id,
        p_session_id: decodeJwtPayload(runtime.sessions.ownerA.access_token).session_id,
        p_destination_type: 'email',
        p_destination: identities.memberA.email,
      });
      assert(principal?.authorized === true && isUuid(principal?.user_id), 'Invited Auth principal was not resolved');
      assert(
        principal.user_id === identities.memberA.id,
        'Invitation resolved a different pre-provisioned Auth principal',
      );
      sdkData(
        await admin.auth.admin.updateUserById(identities.memberA.id, {
          password: identities.memberA.password,
          email_confirm: true,
          user_metadata: { display_name: identities.memberA.displayName },
          app_metadata: { newone_invite_state: 'invited', newone_e2e_run: runId },
        }),
        'Prepare invited test principal for password activation',
      );
      runtime.memberAClient = createPublicClient();
      runtime.sessions.memberA = await signIn(runtime.memberAClient, identities.memberA);
      const revokedAccessToken = runtime.sessions.memberA.access_token;
      const redemption = await redeemInvitationThroughGateway(
        configuration,
        revokedAccessToken,
        invitation.activationToken,
        employeeCode,
      );
      assert(
        redemption?.activated === true && redemption?.user?.id === identities.memberA.id &&
          redemption?.organization?.id === context.orgA.id &&
          redemption?.organization?.role === 'member',
        'Auth gateway invitation redemption did not create the expected membership',
      );
      const revokedClaims = await bindSession(
        admin,
        runId,
        identities.memberA.id,
        revokedAccessToken,
        runtime.installations.memberA,
      );
      await expectEdge(configuration, {
        functionName: 'newone-read',
        path: '/v2/bootstrap',
        accessToken: revokedAccessToken,
        body: {
          organizationId: context.orgA.id,
          selectedConversationId: null,
          beforeMessageId: null,
          conversationLimit: 1,
          timelineLimit: 1,
        },
      }, 200);
      const replay = await edgeRequest(configuration, {
        functionName: AUTH_FUNCTION,
        path: '/v2/auth/invitations/redeem',
        accessToken: revokedAccessToken,
        body: { invitationToken: invitation.activationToken, employeeCode },
      });
      assert(
        replay.status === 401 && publicErrorCode(replay.body) === 'unauthorized',
        'One-time invitation replay was not rejected by the Auth gateway',
        { status: replay.status, code: publicErrorCode(replay.body) },
      );
      const revokedSessionEvidence = await managementSql(
        configuration.accessToken,
        configuration.projectRef,
        `select count(*)::integer as active_sessions
         from auth.sessions
         where id = ${sqlLiteral(revokedClaims.session_id)}::uuid`,
      );
      assert(
        Number(revokedSessionEvidence?.[0]?.active_sessions) === 0,
        'Invitation replay did not revoke the previously valid Auth session',
      );
      const revoked = await expectDeniedWithStatus(configuration, {
        functionName: 'newone-read',
        path: '/v2/bootstrap',
        accessToken: revokedAccessToken,
        body: {
          organizationId: context.orgA.id,
          selectedConversationId: null,
          beforeMessageId: null,
          conversationLimit: 1,
          timelineLimit: 1,
        },
      }, [401, 403]);
      assert(
        ['unauthorized', 'forbidden'].includes(publicErrorCode(revoked.body)),
        'Revoked-session denial used the wrong public code',
      );
      runtime.sessions.memberA = await signIn(runtime.memberAClient, identities.memberA);
      await bindSession(
        admin,
        runId,
        identities.memberA.id,
        runtime.sessions.memberA.access_token,
        runtime.installations.memberA,
      );
      const bootstrap = await expectEdge(configuration, {
        functionName: 'newone-read',
        path: '/v2/bootstrap',
        accessToken: runtime.sessions.memberA.access_token,
        body: {
          organizationId: context.orgA.id,
          selectedConversationId: null,
          beforeMessageId: null,
          conversationLimit: 100,
          timelineLimit: 50,
        },
      }, 200);
      assert(
        bootstrap?.organization?.organizationId === context.orgA.id &&
          bootstrap?.currentUser?.userId === identities.memberA.id,
        'Read bootstrap did not project the redeemed member',
      );
    });

    await runStep(state, artifactPath, 'real_contact_request_and_acceptance', async () => {
      await expectEdge(configuration, {
        functionName: 'newone-api',
        path: '/v2/contacts/connections',
        accessToken: runtime.sessions.ownerA.access_token,
        idempotencyKey: randomUUID(),
        body: { organizationId: context.orgA.id, targetMembershipId: identities.memberA.id },
      }, 201);
      await expectEdge(configuration, {
        functionName: 'newone-api',
        path: `/v2/contacts/connections/${identities.ownerA.id}/respond`,
        accessToken: runtime.sessions.memberA.access_token,
        idempotencyKey: randomUUID(),
        body: { organizationId: context.orgA.id, decision: 'accepted' },
      }, 200);
      const bootstrap = await expectEdge(configuration, {
        functionName: 'newone-read',
        path: '/v2/bootstrap',
        accessToken: runtime.sessions.ownerA.access_token,
        body: {
          organizationId: context.orgA.id,
          selectedConversationId: null,
          beforeMessageId: null,
          conversationLimit: 100,
          timelineLimit: 50,
        },
      }, 200);
      const connection = bootstrap?.connections?.find((entry) =>
        entry.counterpartUserId === identities.memberA.id
      );
      assert(connection?.status === 'accepted', 'Accepted contact is missing from authoritative bootstrap');
    });

    await runStep(state, artifactPath, 'real_direct_and_group_conversations', async () => {
      const direct = await expectEdge(configuration, {
        functionName: 'newone-api',
        path: '/v2/conversations/direct',
        accessToken: runtime.sessions.ownerA.access_token,
        idempotencyKey: randomUUID(),
        body: { organizationId: context.orgA.id, targetMembershipId: identities.memberA.id },
      }, 201);
      assert(isUuid(direct?.conversationId), 'Direct conversation ID is invalid');
      context.directConversationId = direct.conversationId;
      const group = await expectEdge(configuration, {
        functionName: 'newone-api',
        path: '/v2/conversations/group',
        accessToken: runtime.sessions.ownerA.access_token,
        idempotencyKey: randomUUID(),
        body: {
          organizationId: context.orgA.id,
          name: `Warehouse Shift Coordination ${runId.slice(-8)}`,
          description: 'Real hosted E2E shift coordination channel',
          memberAssignments: [{ membershipId: identities.memberA.id, role: 'member' }],
          kind: 'group',
          unitId: null,
          historyPolicy: 'all',
          postingMode: 'all_members',
          joinPolicy: 'invite_only',
          incidentSeverity: null,
          incidentClassification: null,
        },
      }, 201);
      assert(isUuid(group?.conversationId) && group?.memberCount === 2, 'Group conversation receipt is invalid');
      context.groupConversationId = group.conversationId;
      state.conversations.push(
        { id: context.directConversationId, kind: 'direct', organizationId: context.orgA.id },
        { id: context.groupConversationId, kind: 'group', organizationId: context.orgA.id },
      );
      await saveArtifact(state, artifactPath);
    });

    await runStep(state, artifactPath, 'real_private_realtime_delivery_and_tenant_denial', async () => {
      const topic = `org:${context.orgA.id}:user:${identities.memberA.id}:inbox`;
      const crossTenantClient = createPublicClient();
      try {
        await expectPrivateRealtimeDenied(
          crossTenantClient,
          runtime.sessions.ownerB.access_token,
          topic,
        );
      } finally {
        crossTenantClient.realtime.disconnect();
      }

      const realtimeClient = createPublicClient();
      let resolveEvent;
      const delivered = new Promise((resolveDelivery) => {
        resolveEvent = resolveDelivery;
      });
      let channel = null;
      try {
        channel = await subscribePrivateRealtime(
          realtimeClient,
          runtime.sessions.memberA.access_token,
          topic,
          resolveEvent,
        );
        const clientMessageId = randomUUID();
        const body = `Realtime delivery verification. Ref ${runId}.`;
        const receipt = await expectEdge(configuration, {
          functionName: 'newone-api',
          path: `/v2/conversations/${context.groupConversationId}/messages`,
          accessToken: runtime.sessions.ownerA.access_token,
          idempotencyKey: randomUUID(),
          body: {
            organizationId: context.orgA.id,
            clientMessageId,
            kind: 'text',
            body,
            languageCode: 'en',
            replyToMessageId: null,
            threadRootMessageId: null,
            mentionUserIds: [],
          },
        }, 201);
        const rawEvent = await withTimeout(
          delivered,
          20_000,
          'Private Realtime event delivery timed out',
        );
        realtimeEvent(rawEvent, {
          organizationId: context.orgA.id,
          conversationId: context.groupConversationId,
          messageId: receipt.messageId,
        });
        const page = await expectEdge(configuration, {
          functionName: 'newone-read',
          path: `/v2/conversations/${context.groupConversationId}/messages/query`,
          accessToken: runtime.sessions.memberA.access_token,
          body: { organizationId: context.orgA.id, beforeMessageId: null, limit: 100 },
        }, 200);
        const persisted = page?.messages?.find((message) => message.clientNonce === clientMessageId);
        assert(
          persisted?.body === body &&
            String(persisted?.messageId) === String(receipt.messageId),
          'Realtime-triggering message was not durably readable by the subscriber',
        );
        state.messages.push({
          id: String(receipt.messageId),
          conversationId: context.groupConversationId,
        });
        await saveArtifact(state, artifactPath);
      } finally {
        if (channel) await realtimeClient.removeChannel(channel);
        realtimeClient.realtime.disconnect();
      }
    });

    await runStep(state, artifactPath, 'real_message_persistence_and_idempotent_replay', async () => {
      const sentAt = new Date().toISOString();
      const directBody = `Dock 3 inventory check completed at ${sentAt}. No discrepancies found. Ref ${runId}.`;
      const groupBodyA = `Shift handoff: loading bay inspection is complete. Ref ${runId}.`;
      const groupBodyB = `Confirmado: el equipo del turno recibió la actualización. Ref ${runId}.`;
      context.idempotentClientMessageId = randomUUID();
      context.idempotentKey = randomUUID();
      const directRequest = {
        organizationId: context.orgA.id,
        clientMessageId: context.idempotentClientMessageId,
        kind: 'text',
        body: directBody,
        languageCode: 'en',
        replyToMessageId: null,
        threadRootMessageId: null,
        mentionUserIds: [],
      };
      const first = await expectEdge(configuration, {
        functionName: 'newone-api',
        path: `/v2/conversations/${context.directConversationId}/messages`,
        accessToken: runtime.sessions.ownerA.access_token,
        idempotencyKey: context.idempotentKey,
        body: directRequest,
      }, 201);
      const replay = await expectEdge(configuration, {
        functionName: 'newone-api',
        path: `/v2/conversations/${context.directConversationId}/messages`,
        accessToken: runtime.sessions.ownerA.access_token,
        idempotencyKey: context.idempotentKey,
        body: directRequest,
      }, 201);
      assert(
        first?.messageId === replay?.messageId &&
          first?.clientMessageId === context.idempotentClientMessageId &&
          replay?.clientMessageId === context.idempotentClientMessageId,
        'Idempotent replay did not return the original committed message',
      );
      const groupClientA = randomUUID();
      const groupClientB = randomUUID();
      const groupA = await expectEdge(configuration, {
        functionName: 'newone-api',
        path: `/v2/conversations/${context.groupConversationId}/messages`,
        accessToken: runtime.sessions.ownerA.access_token,
        idempotencyKey: randomUUID(),
        body: {
          organizationId: context.orgA.id,
          clientMessageId: groupClientA,
          kind: 'text',
          body: groupBodyA,
          languageCode: 'en',
          replyToMessageId: null,
          threadRootMessageId: null,
          mentionUserIds: [identities.memberA.id],
        },
      }, 201);
      const groupB = await expectEdge(configuration, {
        functionName: 'newone-api',
        path: `/v2/conversations/${context.groupConversationId}/messages`,
        accessToken: runtime.sessions.memberA.access_token,
        idempotencyKey: randomUUID(),
        body: {
          organizationId: context.orgA.id,
          clientMessageId: groupClientB,
          kind: 'text',
          body: groupBodyB,
          languageCode: 'es',
          replyToMessageId: null,
          threadRootMessageId: null,
          mentionUserIds: [],
        },
      }, 201);
      state.messages.push(
        { id: String(first.messageId), conversationId: context.directConversationId },
        { id: String(groupA.messageId), conversationId: context.groupConversationId },
        { id: String(groupB.messageId), conversationId: context.groupConversationId },
      );
      await saveArtifact(state, artifactPath);
      const directPage = await expectEdge(configuration, {
        functionName: 'newone-read',
        path: `/v2/conversations/${context.directConversationId}/messages/query`,
        accessToken: runtime.sessions.memberA.access_token,
        body: { organizationId: context.orgA.id, beforeMessageId: null, limit: 100 },
      }, 200);
      const directMessage = directPage?.messages?.find((message) =>
        message.clientNonce === context.idempotentClientMessageId
      );
      assert(
        directMessage?.body === directBody && directMessage?.sender?.userId === identities.ownerA.id,
        'Direct message body/sender was not retrieved from persisted state',
      );
      const groupPage = await expectEdge(configuration, {
        functionName: 'newone-read',
        path: `/v2/conversations/${context.groupConversationId}/messages/query`,
        accessToken: runtime.sessions.memberA.access_token,
        body: { organizationId: context.orgA.id, beforeMessageId: null, limit: 100 },
      }, 200);
      const groupBodies = new Set(groupPage?.messages?.map((message) => message.body));
      assert(groupBodies.has(groupBodyA) && groupBodies.has(groupBodyB), 'Group messages were not persisted/read');
    });

    await runStep(state, artifactPath, 'real_cross_tenant_and_raw_table_denial', async () => {
      await expectDenied(configuration, {
        functionName: 'newone-read',
        path: '/v2/bootstrap',
        accessToken: runtime.sessions.ownerB.access_token,
        body: {
          organizationId: context.orgA.id,
          selectedConversationId: null,
          beforeMessageId: null,
          conversationLimit: 100,
          timelineLimit: 50,
        },
      });
      await expectDenied(configuration, {
        functionName: 'newone-api',
        path: '/v2/conversations/direct',
        accessToken: runtime.sessions.ownerB.access_token,
        idempotencyKey: randomUUID(),
        body: { organizationId: context.orgA.id, targetMembershipId: identities.memberA.id },
      });
      await expectDenied(configuration, {
        functionName: 'newone-read',
        path: `/v2/conversations/${context.groupConversationId}/messages/query`,
        accessToken: runtime.sessions.ownerB.access_token,
        body: { organizationId: context.orgA.id, beforeMessageId: null, limit: 100 },
      });
      await rawTableAccess(configuration, runtime.sessions.ownerB.access_token, context.orgA.id);
    });

    await runStep(state, artifactPath, 'guarded_persistence_aggregate_assertions', async () => {
      const rows = await managementSql(
        configuration.accessToken,
        configuration.projectRef,
        aggregateEvidenceSql(context),
      );
      const evidence = rows?.[0]?.evidence;
      assertAggregateEvidence(evidence);
      state.aggregateEvidence = evidence;
      await saveArtifact(state, artifactPath);
    });

    await runStep(state, artifactPath, 'real_idempotency_digest_conflict', async () => {
      const conflict = await edgeRequest(configuration, {
        functionName: 'newone-api',
        path: `/v2/conversations/${context.directConversationId}/messages`,
        accessToken: runtime.sessions.ownerA.access_token,
        idempotencyKey: context.idempotentKey,
        body: {
          organizationId: context.orgA.id,
          clientMessageId: context.idempotentClientMessageId,
          kind: 'text',
          body: `Changed payload must be rejected. Ref ${runId}.`,
          languageCode: 'en',
          replyToMessageId: null,
          threadRootMessageId: null,
          mentionUserIds: [],
        },
      });
      assert(conflict.status === 409, 'Changed payload with a reused idempotency key was not a 409', {
        status: conflict.status,
        code: publicErrorCode(conflict.body),
      });
      assert(publicErrorCode(conflict.body) === 'idempotency_conflict', 'Idempotency conflict used the wrong public error code', {
        status: conflict.status,
        code: publicErrorCode(conflict.body),
      });
    });

    await runStep(state, artifactPath, 'real_command_rate_limit_exhaustion', async () => {
      const evidence = await exhaustDirectConversationRateLimit(configuration, {
        organizationId: context.orgA.id,
        targetMembershipId: identities.memberA.id,
        expectedConversationId: context.directConversationId,
        accessToken: runtime.sessions.ownerA.access_token,
      });
      state.rateLimitEvidence = {
        operation: 'conversation.direct.create',
        ...evidence,
      };
      await saveArtifact(state, artifactPath);
    });

    state.status = 'passed';
    state.completedAt = new Date().toISOString();
    await saveArtifact(state, artifactPath);
    log('PASS', 'hosted_core_suite', `run=${runId}`);
  } catch (error) {
    state.status = 'failed';
    state.completedAt = new Date().toISOString();
    state.failure = safeFailure(error);
    await saveArtifact(state, artifactPath);
    throw error;
  } finally {
    if (options.cleanup) {
      try {
        await cleanupRun(configuration, state);
        state.cleanedAt = new Date().toISOString();
        await saveArtifact(state, artifactPath);
      } catch (cleanupError) {
        state.cleanupFailure = safeFailure(cleanupError);
        await saveArtifact(state, artifactPath);
        log('FAIL', 'guarded_cleanup', state.cleanupFailure);
        if (state.status === 'passed') throw cleanupError;
      }
    } else {
      log('KEEP', 'test_data_retained', `artifact=${relative(REPOSITORY_ROOT, artifactPath)}`);
    }
  }
}

async function cleanupArtifactRun(options, configuration) {
  const candidatePath = isAbsolute(options.cleanupArtifact)
    ? resolve(options.cleanupArtifact)
    : resolve(REPOSITORY_ROOT, options.cleanupArtifact);
  const relativePath = relative(ARTIFACT_DIRECTORY, candidatePath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath) || !relativePath.endsWith('.json')) {
    throw new HarnessError('Cleanup artifact must be a JSON file under tests/hosted/.artifacts');
  }
  const manifest = JSON.parse(await readFile(candidatePath, 'utf8'));
  validateCleanupManifest(manifest, configuration.projectRef);
  await cleanupRun(configuration, manifest);
  manifest.cleanedAt = new Date().toISOString();
  await saveArtifact(manifest, candidatePath);
}

async function main() {
  installSignalHandlers();
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  validateProjectRef(options.projectRef);
  log('RUN', 'hosted_configuration_validation');
  const configuration = await loadConfiguration(options.projectRef);
  const readiness = await validateHostedConfiguration(configuration);
  log(
    'PASS',
    'hosted_configuration_validation',
    `active_functions=${configuration.activeFunctions.size} existing_orgs=${readiness.organization_count} existing_users=${readiness.auth_user_count}`,
  );
  for (const functionName of REQUIRED_EXECUTION_FUNCTIONS) {
    if (!configuration.activeFunctions.has(functionName)) {
      log('BLOCK', 'hosted_execute_gateway', `missing=${functionName}`);
    }
  }
  for (const skipped of unsupportedScenarios()) {
    log('SKIP', skipped.scenario, skipped.reason);
  }
  if (options.mode === 'dry-run') {
    log('PASS', 'dry_run', 'No hosted data was created, changed, or deleted');
    return;
  }
  if (options.mode === 'cleanup-artifact') {
    await cleanupArtifactRun(options, configuration);
    return;
  }
  await executeHostedRun(options, configuration);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    log('FAIL', 'hosted_harness', safeFailure(error));
    process.exitCode = 1;
  });
}
