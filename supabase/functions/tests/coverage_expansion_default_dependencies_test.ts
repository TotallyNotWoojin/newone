import type { AuthenticatedActor } from '../_shared/clients.ts';
import { sha256Hex } from '../_shared/crypto.ts';
import { protectPushToken } from '../_shared/device-secrets.ts';
import { ApiError } from '../_shared/errors.ts';
import type { SummaryResult } from '../_shared/openrouter.ts';
import { defaultAiWorkerDependencies } from '../newone-ai-worker/handler.ts';
import { defaultDependencies as defaultApiDependencies } from '../newone-api/handler.ts';
import {
  type AttachmentScanJob,
  type AttachmentScanWorkerDependencies,
  createAttachmentScanWorkerHandler,
  defaultAttachmentScanWorkerDependencies,
  signatureMimeCandidates,
} from '../newone-attachment-scan-worker/handler.ts';
import { createAuthHandler, defaultAuthDependencies } from '../newone-auth/handler.ts';
import { defaultBootstrapDependencies } from '../newone-bootstrap/handler.ts';
import { defaultMaintenanceWorkerDependencies } from '../newone-maintenance-worker/handler.ts';
import {
  defaultOutboxWorkerDependencies,
  type DynamicGroupSyncJob,
  type ModerationFanoutJob,
  type PushJob,
  type RealtimeControlJob,
  type SessionRevokeJob,
  type StoragePurgeJob,
} from '../newone-outbox-worker/handler.ts';
import { defaultPushReceiptWorkerDependencies } from '../newone-push-receipt-worker/handler.ts';
import { defaultReadDependencies } from '../newone-read/handler.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const actorUserId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const conversationId = '40000000-0000-4000-8000-000000000004';
const attachmentId = '50000000-0000-4000-8000-000000000005';
const deviceId = '60000000-0000-4000-8000-000000000006';
const policyId = '70000000-0000-4000-8000-000000000007';
const workerId = '80000000-0000-4000-8000-000000000008';
const sha = 'a'.repeat(64);
const accessToken = `eyJhbGciOiJub25lIn0.${
  btoa(JSON.stringify({
    sub: actorUserId,
    session_id: sessionId,
    aal: 'aal2',
    iat: Math.floor(Date.now() / 1000),
    exp: 9999999999,
  })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}.coverage-signature`;
const refreshToken = 'refresh-token-that-is-long-enough-for-coverage';
let protectedPushToken = '';

const openRouterPolicy = {
  $schema: './ai-route-policy.schema.json',
  policyVersion: '2026-08-04.2',
  employeeDataEgressEnabled: true,
  model: 'qwen/qwen3-235b-a22b-2507',
  providerTag: 'google-vertex/us-south1',
  providerMetadataName: 'Google',
  requirements: {
    zeroDataRetention: true,
    structuredOutputs: true,
    responseFormat: true,
    allowFallbacks: false,
    dataCollection: 'deny',
    cache: false,
    implicitCaching: false,
    bringYourOwnKeys: false,
    managementControlPlanePreflight: true,
    syntheticRouteProbe: true,
    plugins: false,
    webSearch: false,
    tools: false,
  },
  priceCeilingsUsdPerMillionTokens: { prompt: 0.25, completion: 1 },
};

const environment: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key-for-coverage',
  SUPABASE_SECRET_KEY: 'server-secret-key-for-coverage',
  NEWONE_ALLOWED_WEB_ORIGINS: 'https://app.newone.example',
  NEWONE_NETWORK_HASH_KEY: 'network-key-that-is-long-enough-for-coverage',
  NEWONE_CURSOR_SIGNING_KEY: 'cursor-key-that-is-long-enough-for-coverage',
  NEWONE_PUBLIC_APP_URL: 'https://app.newone.example',
  NEWONE_WORKER_TOKEN: 'worker-token-that-is-long-enough-for-coverage',
  NEWONE_BOOTSTRAP_TOKEN: 'bootstrap-token-that-is-long-enough-for-coverage',
  NEWONE_EXPO_ACCESS_TOKEN: 'expo-token-that-is-long-enough',
  NEWONE_EXPO_PROJECT_ID: '90000000-0000-4000-8000-000000000009',
  NEWONE_PUSH_ENVIRONMENT: 'production',
  NEWONE_PUSH_TOKEN_KEY_V1: btoa('k'.repeat(32)).replaceAll('+', '-').replaceAll('/', '_').replace(
    /=+$/,
    '',
  ),
  NEWONE_OUTBOX_TOPICS:
    'realtime_control,moderation,storage_purge,session_revoke,dynamic_group_sync',
  NEWONE_ATTACHMENT_SCANNER_URL: 'https://scanner.newone.example/v1/scan',
  NEWONE_ATTACHMENT_SCANNER_TOKEN: 'scanner-token-that-is-long-enough-for-coverage',
  NEWONE_AI_DATA_EGRESS_APPROVED: 'true',
  OPENROUTER_API_KEY: 'openrouter-key-that-is-long-enough',
  NEWONE_OPENROUTER_POLICY_JSON: JSON.stringify(openRouterPolicy),
  OPENROUTER_MANAGEMENT_API_KEY: 'management-key-that-is-long-enough',
  NEWONE_OPENROUTER_API_KEY_HASH: 'b'.repeat(64),
  NEWONE_OPENROUTER_WORKSPACE_ID: 'a0000000-0000-4000-8000-00000000000a',
  NEWONE_AI_WORKLOADS: 'language_detection,translation,summary',
  NEWONE_RECOVERY_EVIDENCE_HASH_KEY: 'recovery-evidence-key-that-is-long-enough',
  NEWONE_AUTH_CAPTCHA_REQUIRED: 'true',
  NEWONE_AUTH_PHONE_OTP_ENABLED: 'true',
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function urlOf(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function rpcResponse(name: string): unknown {
  switch (name) {
    case 'bff_bootstrap_organization':
      return { bootstrapped: true };
    case 'bff_record_push_receipt':
      return { attempt_id: '11', status: 'recorded' };
    case 'bff_resolve_push_job':
      return {
        job_id: '50',
        event: {
          event_type: 'message.changed',
          organization_id: organizationId,
          conversation_id: conversationId,
          message_id: '99',
          announcement_id: undefined,
          announcement_version_id: undefined,
          handoff_id: undefined,
          state: 'published',
        },
        deliveries: [{
          device_id: deviceId,
          attempt_id: '51',
          dispatch_status: 'pending',
          dispatchable: true,
          next_attempt_at: null,
          user_id: actorUserId,
          installation_id: policyId,
          platform: 'ios',
          push_token_type: 'expo',
          push_project_id: environment.NEWONE_EXPO_PROJECT_ID,
          push_environment: 'production',
          push_token_ciphertext: protectedPushToken,
          locale: 'ko-KR',
          app_version: '1.0.0',
          currently_off_shift: false,
          notification_class: 'urgent',
          critical_category: null,
          quiet_hours_override: false,
          quiet_hours_override_reason: null,
          preferences: {
            notification_preview: 'generic',
            sound_enabled: true,
            vibration_enabled: true,
            shift_aware_suppression: true,
            time_zone: 'America/Denver',
            quiet_hours_start: null,
            quiet_hours_end: null,
            quiet_days: [],
          },
        }],
        has_more: false,
        next_device_id: null,
      };
    case 'bff_record_push_submission':
      return { attempt_id: '51', status: 'accepted' };
    case 'bff_complete_push_dispatch_job':
      return { job_id: '50', dispatch_completed: true, provider_delivery_pending: 1 };
    case 'bff_authorize_invite_otp':
    case 'bff_authorize_member_otp':
    case 'bff_authorize_account_recovery_otp':
      return { allowed: true, channel_configured: true };
    case 'bff_authorize_signup_otp':
      return {
        allowed: true,
        reason: 'ok',
        existing_member: false,
        channel_configured: true,
        retry_after_seconds: 0,
      };
    case 'bff_redeem_signup':
      return {
        organization_id: '11111111-1111-4111-8111-111111111111',
        user_id: actorUserId,
        username: 'coverage_member',
        display_name: 'Coverage Member',
        preferred_language: 'en',
      };
    case 'bff_delete_account':
      return { user_id: actorUserId, memberships_deactivated: 1 };
    case 'redeem_organization_invite':
      return {
        redeemed: true,
        user_id: actorUserId,
        organization_id: organizationId,
        role: 'admin',
      };
    case 'bff_bind_session_installation':
      return {
        bound: true,
        session_id: sessionId,
        installation_id: deviceId,
        platform: 'ios',
      };
    case 'bff_complete_account_recovery':
      return {
        recovered: true,
        current_session_preserved: true,
        security_event_recorded: true,
        current_session_id: sessionId,
        security_notice_state: 'pending_external_delivery',
        other_sessions_revoked: 2,
      };
    case 'bff_resolve_principal_context':
      return {
        schema_version: 1,
        organizations: [{ organization_id: organizationId, membership_role: 'admin' }],
      };
    case 'bff_expand_moderation_fanout':
      return {
        job_id: '21',
        eligible_count: 2,
        enqueued_count: 2,
        current_authorization_applied: true,
        replay_safe: true,
      };
    case 'bff_execute_session_revoke_job':
      return { job_id: '31', completed: true, revoked_session_count: 1 };
    case 'bff_resolve_realtime_fanout':
      return {
        schema_version: 1,
        deliveries: [{
          topic: `org:${organizationId}:user:${actorUserId}:inbox`,
          event: 'workspace.invalidated',
          payload: {
            schema_version: 1,
            event_id: deviceId,
            event: 'workspace.invalidated',
            organization_id: organizationId,
            occurred_at: '2026-08-04T12:00:00.000Z',
            conversation_id: conversationId,
            entity_type: 'conversation',
            entity_id: conversationId,
            version_id: '2',
            reason: 'dynamic_group_membership_changed',
          },
        }],
      };
    case 'bff_resolve_language_detection_job_source':
      return {
        authorized: true,
        provider_egress_allowed: true,
        organization_id: organizationId,
        processor_id: openRouterPolicy.providerTag,
        route_policy: 'approved_zero_retention',
        provider_route_policy: 'zero_retention_only',
        ai_policy_version: 2,
        message_id: '1',
        conversation_id: conversationId,
        source_body: 'Source body',
        source_sha256: sha,
      };
    case 'bff_resolve_translation_job_for_egress':
      return {
        authorized: true,
        provider_egress_allowed: true,
        organization_id: organizationId,
        processor_id: openRouterPolicy.providerTag,
        route_policy: 'approved_zero_retention',
        provider_route_policy: 'zero_retention_only',
        ai_policy_version: 2,
        message_id: '1',
        translation_id: '2',
        conversation_id: conversationId,
        source_body: 'Source body',
        source_language: 'en',
        target_language: 'es',
        source_sha256: sha,
      };
    case 'bff_resolve_summary_job_sources':
      return {
        authorized: true,
        provider_egress_allowed: true,
        organization_id: organizationId,
        processor_id: openRouterPolicy.providerTag,
        route_policy: 'approved_zero_retention',
        provider_route_policy: 'zero_retention_only',
        ai_policy_version: 2,
        summary_id: policyId,
        conversation_id: conversationId,
        requested_by_user_id: actorUserId,
        source_fingerprint: sha,
        language_code: 'en',
        messages: [{ message_id: '3', body: 'Evidence body' }],
      };
    case 'bff_claim_language_detection_jobs':
    case 'bff_claim_translation_jobs':
    case 'bff_claim_summary_jobs':
      return { jobs: [] };
    default:
      return { ok: true };
  }
}

const mockFetch: typeof fetch = async (input, init) => {
  const url = urlOf(input);
  if (url.hostname === 'scanner.newone.example') {
    return json({
      result: 'clean',
      digestSha256: sha,
      detectedMimeType: 'text/plain',
      polyglotDetected: false,
      scannerName: 'coverage-scanner',
      scannerVersion: 'v1',
    });
  }
  if (url.hostname === 'exp.host') {
    if (url.pathname.endsWith('/send')) {
      const body = JSON.parse(String(init?.body)) as unknown[];
      return json({
        data: body.map((_entry, index) => ({ status: 'ok', id: `submission-${index + 1}` })),
        errors: [],
      });
    }
    return json({ data: { 'ticket-1': { status: 'ok' } }, errors: [] });
  }
  if (url.pathname.startsWith('/realtime/v1/')) return json({ ok: true });
  if (url.pathname === '/auth/v1/otp') return json({});
  if (url.pathname === '/auth/v1/verify' || url.pathname === '/auth/v1/token') {
    return json({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      token_type: 'bearer',
      user: {
        id: actorUserId,
        email: 'owner@example.com',
        phone: '+15555550123',
      },
    });
  }
  if (url.pathname === '/auth/v1/user') {
    // Hosted GoTrue returns an empty string for an email-only user's unused
    // phone identity. Keep the real wire shape in the default dependency test.
    return json({ id: actorUserId, email: 'owner@example.com', phone: '' });
  }
  if (url.pathname.endsWith('/factors') && init?.method === 'GET') {
    return json({ all: [], totp: [], phone: [] });
  }
  if (url.pathname.endsWith('/factors') && init?.method === 'POST') {
    return json({
      id: policyId,
      type: 'totp',
      status: 'unverified',
      friendly_name: 'Coverage factor',
      created_at: '2026-08-04T00:00:00.000Z',
      updated_at: '2026-08-04T00:00:00.000Z',
      totp: {
        qr_code: 'data:image/svg+xml,coverage-qr-code',
        secret: 'COVERAGESECRET123456',
        uri: 'otpauth://totp/Newone:coverage?secret=COVERAGESECRET123456',
      },
    });
  }
  if (url.pathname.endsWith('/challenge')) {
    return json({ id: deviceId, type: 'totp', expires_at: 9999999999 });
  }
  if (url.pathname.endsWith('/verify')) {
    return json({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      token_type: 'bearer',
      user: { id: actorUserId, email: 'owner@example.com', phone: '+15555550123' },
    });
  }
  if (url.pathname.includes('/factors/') && init?.method === 'DELETE') {
    return json({ id: policyId });
  }
  if (url.pathname.endsWith('/logout')) return json({});
  if (url.pathname === '/auth/v1/admin/users' && init?.method === 'POST') {
    return json({ id: actorUserId, email: 'newcomer@example.com' });
  }
  if (url.pathname.startsWith('/auth/v1/admin/users/')) {
    if (url.pathname.endsWith('/factors')) return json({ factors: [] });
    return json({
      id: actorUserId,
      email: 'OWNER@EXAMPLE.COM',
      email_confirmed_at: '2026-08-04T00:00:00.000Z',
      deleted_at: null,
    });
  }
  if (url.pathname.includes('/storage/v1/object/info/')) return json({ size: 3 });
  if (
    url.pathname.includes('/storage/v1/object/message-attachments/') && init?.method !== 'DELETE'
  ) {
    return new Response(new Uint8Array([65, 66, 67]), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }
  if (url.pathname.startsWith('/storage/v1/object/')) return json({ message: 'ok' });
  if (url.pathname === '/rest/v1/message_attachments') {
    return json([{
      bucket_id: 'message-attachments',
      storage_path: `${organizationId}/objects/${attachmentId}`,
      scan_status: 'quarantined',
      purge_requested_at: '2026-08-04T00:00:00.000Z',
    }]);
  }
  const rpcMarker = '/rest/v1/rpc/';
  const index = url.pathname.indexOf(rpcMarker);
  if (index >= 0) {
    return json(rpcResponse(decodeURIComponent(url.pathname.slice(index + rpcMarker.length))));
  }
  if (url.pathname === '/rest/v1/organizations') return json([]);
  throw new Error(`Unexpected coverage fetch: ${init?.method ?? 'GET'} ${url}`);
};

async function withDefaultEnvironment(run: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test('default API, bootstrap, maintenance, receipt, and scanner dependencies execute', async () => {
  await withDefaultEnvironment(async () => {
    const api = defaultApiDependencies();
    assertEquals(api.publicAppUrl, 'https://app.newone.example');
    await api.checkReadiness?.(deviceId);
    await api.recordAuditDenial?.(
      {
        user: { id: actorUserId },
        claims: { sub: actorUserId, sessionId, aal: 'aal2', issuedAt: 1, expiresAt: 9999999999 },
        token: 'token',
        userClient: {},
        adminClient: {
          rpc(name: string, args: Record<string, unknown>) {
            assertEquals(name, 'bff_record_audit_access_denial');
            assertEquals(args.p_organization_id, organizationId);
            return Promise.resolve({ data: { recorded: true }, error: null });
          },
        },
      } as unknown as AuthenticatedActor,
      organizationId,
      'audit.export',
    );

    const bootstrap = defaultBootstrapDependencies();
    bootstrap.setCorrelationId?.(deviceId);
    const owner = await bootstrap.inspectOwner(actorUserId);
    assertEquals(owner.email, 'owner@example.com');
    assertEquals(owner.confirmed, true);
    assertEquals(owner.deleted, false);
    await bootstrap.bootstrap({
      ownerUserId: actorUserId,
      ownerEmail: 'owner@example.com',
      organizationName: 'Coverage Org',
      organizationSlug: 'coverage-org',
      idempotencyKey: 'coverage-key',
      requestDigest: sha,
    });

    const maintenance = defaultMaintenanceWorkerDependencies();
    maintenance.setCorrelationId?.(deviceId);
    await maintenance.promote(workerId, 5);
    await maintenance.processAnnouncementObligations(workerId, 5);
    await maintenance.processOverdueHandoffs(workerId, 5);

    const receipts = defaultPushReceiptWorkerDependencies();
    receipts.setCorrelationId?.(deviceId);
    await receipts.claim(workerId, 5);
    assert((await receipts.poll(['ticket-1']))[0]?.result === 'delivered');
    await receipts.record(workerId, {
      attemptId: '11',
      organizationId,
      jobId: '12',
      deviceId,
      providerTicketId: 'ticket-1',
      providerAcceptedAt: '2026-08-04T00:00:00.000Z',
    }, { providerTicketId: 'ticket-1', result: 'delivered', errorCode: null });
    assert(receipts.now() instanceof Date);

    const scanner = defaultAttachmentScanWorkerDependencies();
    scanner.setCorrelationId?.(deviceId);
    const job: AttachmentScanJob = {
      id: '41',
      organizationId,
      attachmentId,
      bucketId: 'message-attachments',
      storagePath: `${organizationId}/${actorUserId}/${deviceId}/${attachmentId}/upload`,
      byteSize: 3,
      sha256Hex: sha,
      declaredMimeType: 'text/plain',
    };
    await scanner.claim(workerId, 3);
    const bytes = await scanner.download(job);
    assertEquals(Array.from(bytes), [65, 66, 67]);
    const verdict = await scanner.scan(job, bytes, deviceId);
    assertEquals(verdict.result, 'clean');
    await scanner.complete(workerId, job, verdict);
    await scanner.fail(workerId, job, 'x'.repeat(200));
  });
});

Deno.test('attachment signature gate recognizes every explicitly supported container family', () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const cases: Array<[Uint8Array, string[]]> = [
    [new Uint8Array([0xff, 0xd8, 0xff]), ['image/jpeg']],
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ['image/png']],
    [encode('RIFFxxxxWEBP'), ['image/webp']],
    [encode('%PDF-1.7'), ['application/pdf']],
    [encode('OggSdata'), ['audio/ogg']],
    [encode('ID3data'), ['audio/mpeg']],
    [new Uint8Array([0xff, 0xe1]), ['audio/mpeg']],
    [encode('xxxxftypheic'), ['image/heic']],
    [encode('xxxxftypM4A '), ['audio/mp4']],
    [encode('xxxxftypqt  '), ['video/quicktime']],
    [encode('xxxxftypmp42'), ['audio/mp4', 'video/mp4']],
    [
      new Uint8Array([
        0x50,
        0x4b,
        0x03,
        0x04,
        ...encode('[Content_Types].xml word/ xl/'),
      ]),
      [
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ],
    ],
    [
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      ['application/msword', 'application/vnd.ms-excel'],
    ],
    [encode('plain,csv'), ['text/plain', 'text/csv']],
  ];
  for (const [bytes, expected] of cases) {
    assertEquals([...signatureMimeCandidates(bytes)], expected);
  }
  assertEquals([...signatureMimeCandidates(new Uint8Array([0xff, 0x00, 0x01]))], []);
  assertEquals([...signatureMimeCandidates(new Uint8Array())], []);
});

Deno.test('attachment worker rejects malformed claims and preserves terminal integrity handling', async () => {
  const source = new TextEncoder().encode('coverage attachment');
  const digest = await sha256Hex(source);
  const validClaim = {
    jobs: [{
      id: '71',
      organization_id: organizationId,
      topic: 'storage_scan',
      payload: {
        attachment_id: attachmentId,
        bucket_id: 'message-attachments',
        storage_path: `${organizationId}/${conversationId}/${actorUserId}/${attachmentId}/upload`,
        byte_size: source.byteLength,
        sha256_hex: digest,
        declared_mime_type: 'text/plain',
      },
      attempts: 1,
    }],
  };
  const validJob = validClaim.jobs[0]!;
  const injected = (
    claimValue: unknown,
    overrides: Partial<AttachmentScanWorkerDependencies> = {},
  ): AttachmentScanWorkerDependencies => ({
    runtimeConfig: {
      allowedOrigins: new Set(),
      accessCookieName: '__Host-newone_access',
      refreshCookieName: '__Host-newone_refresh',
      csrfCookieName: '__Host-newone_csrf',
      maxJsonBytes: 65_536,
      networkHashKey: environment.NEWONE_NETWORK_HASH_KEY!,
      allowHttpLocal: false,
    },
    clientEnvironment: {
      url: environment.SUPABASE_URL!,
      publishableKey: environment.SUPABASE_PUBLISHABLE_KEY!,
      secretKey: environment.SUPABASE_SECRET_KEY!,
    },
    workerToken: environment.NEWONE_WORKER_TOKEN!,
    claim: async () => claimValue,
    download: async () => source,
    scan: async () => ({
      result: 'clean',
      detectedMimeType: 'text/plain',
      policyCode: null,
      scannerName: 'coverage-scanner',
      scannerVersion: 'v1',
    }),
    complete: async () => {},
    fail: async () => {},
    ...overrides,
  });
  const workerRequest = (extraHeaders: HeadersInit = {}, method = 'POST') =>
    new Request('https://project.supabase.co/functions/v1/newone-attachment-scan-worker', {
      method,
      headers: {
        apikey: environment.SUPABASE_SECRET_KEY!,
        'X-Newone-Worker-Token': environment.NEWONE_WORKER_TOKEN!,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      ...(method === 'POST' ? { body: JSON.stringify({ limit: 3 }) } : {}),
    });

  assertEquals(
    (await createAttachmentScanWorkerHandler(() => injected(validClaim))(
      workerRequest({}, 'GET'),
    )).status,
    405,
  );
  assertEquals(
    (await createAttachmentScanWorkerHandler(() => injected(validClaim))(
      workerRequest({ Origin: 'https://browser.example' }),
    )).status,
    403,
  );

  const malformed: unknown[] = [
    { jobs: 'not-an-array' },
    { jobs: [{}, {}, {}, {}] },
    { jobs: [{ ...validJob, topic: 'wrong_topic' }] },
    {
      jobs: [{
        ...validJob,
        payload: { ...validJob.payload, bucket_id: 'other-bucket' },
      }],
    },
    {
      jobs: [{
        ...validJob,
        payload: { ...validJob.payload, storage_path: 'not/a/valid/path' },
      }],
    },
    {
      jobs: [{
        ...validJob,
        payload: { ...validJob.payload, sha256_hex: 'not-a-digest'.padEnd(64, 'x') },
      }],
    },
    {
      jobs: [{
        ...validJob,
        payload: { ...validJob.payload, declared_mime_type: 'application/x-msdownload' },
      }],
    },
  ];
  for (const value of malformed) {
    const response = await createAttachmentScanWorkerHandler(() => injected(value))(
      workerRequest(),
    );
    assertEquals(response.status, 503);
  }

  const verdicts: string[] = [];
  const integrity = await createAttachmentScanWorkerHandler(() =>
    injected(validClaim, {
      download: async () => {
        throw new ApiError(422, 'attachment_integrity_failed');
      },
      complete: async (_worker, _job, verdict) => {
        verdicts.push(`${verdict.result}:${verdict.policyCode}`);
      },
    })
  )(workerRequest());
  assertEquals(integrity.status, 200);
  assertEquals(verdicts, ['quarantined:digest_mismatch']);

  const failed = await createAttachmentScanWorkerHandler(() =>
    injected(validClaim, {
      scan: async () => {
        throw new Error('scanner failed');
      },
      fail: async () => {
        throw new Error('terminal write failed');
      },
    })
  )(workerRequest());
  assertEquals(failed.status, 200);
  assertEquals((await failed.json()).failed, 1);
});

Deno.test('default AI dependencies execute every workload and persistence branch', async () => {
  await withDefaultEnvironment(async () => {
    const dependencies = defaultAiWorkerDependencies();
    dependencies.setCorrelationId?.(deviceId);
    assertEquals(dependencies.workloads, ['language_detection', 'translation', 'summary']);

    const detectionJob = {
      id: '1',
      organizationId,
      topic: 'language_detection' as const,
      attempts: 1,
    };
    const translationJob = { id: '2', organizationId, topic: 'translation' as const, attempts: 1 };
    const summaryJob = { id: '3', organizationId, topic: 'summary' as const, attempts: 1 };
    await dependencies.claim(workerId, detectionJob.topic, 3);
    await dependencies.claim(workerId, translationJob.topic, 3);
    await dependencies.claim(workerId, summaryJob.topic, 3);

    const detection = await dependencies.resolveDetection(workerId, detectionJob);
    const translation = await dependencies.resolveTranslation(workerId, translationJob);
    const summary = await dependencies.resolveSummary(workerId, summaryJob);
    assert(detection.authorized && translation.authorized && summary.authorized);
    if (!detection.authorized || !translation.authorized || !summary.authorized) return;

    await dependencies.completeDetection(workerId, detectionJob, detection.source, {
      detectedSourceLanguage: 'en',
      confidence: 0.99,
      ambiguous: false,
      sourceSha256: sha,
      method: 'deterministic:script-v1',
      model: null,
      providerRoute: null,
      policyVersion: openRouterPolicy.policyVersion,
      generationId: null,
    });
    await dependencies.completeDetection(workerId, detectionJob, detection.source, {
      detectedSourceLanguage: 'und',
      confidence: 0.5,
      ambiguous: true,
      sourceSha256: sha,
      method: 'openrouter:structured-v1',
      model: openRouterPolicy.model,
      providerRoute: openRouterPolicy.providerTag,
      policyVersion: openRouterPolicy.policyVersion,
      generationId: 'detection-generation',
    });
    await dependencies.completeTranslation(workerId, translationJob, translation.source, {
      translatedText: 'Texto traducido',
      sourceLanguage: 'en',
      targetLanguage: 'es',
      sourceSha256: sha,
      model: openRouterPolicy.model,
      providerRoute: openRouterPolicy.providerTag,
      policyVersion: openRouterPolicy.policyVersion,
      generationId: 'translation-generation',
      promptTokens: 10,
      completionTokens: 5,
      protectedTokenCount: 0,
      invariantStatus: 'passed',
    });
    const summaryResult: SummaryResult = {
      primaryTopic: 'Coverage',
      summary: 'Coverage summary.',
      keyTopics: [{ text: 'Topic', sourceRefs: ['s0001'] }],
      decisions: [{ text: 'Decision', sourceRefs: ['s0001'] }],
      actionItems: [{ text: 'Action', sourceRefs: ['s0001'], owner: null, due: null }],
      ambiguities: [{ text: 'Unknown', sourceRefs: ['s0001'] }],
      sourceFingerprint: sha,
      sourceMap: { s0001: '3' },
      model: openRouterPolicy.model,
      providerRoute: openRouterPolicy.providerTag,
      policyVersion: openRouterPolicy.policyVersion,
      generationId: 'summary-generation',
      promptTokens: 10,
      completionTokens: 5,
    };
    await dependencies.completeSummary(workerId, summaryJob, summary.source, summaryResult);
    await dependencies.terminalFailure(workerId, detectionJob, sha, 'failed');
    await dependencies.terminalFailure(workerId, summaryJob, null, 'failed');
    await dependencies.terminalFailure(workerId, translationJob, sha, 'failed');
    await assertRejects(
      () => dependencies.terminalFailure(workerId, detectionJob, null, 'failed'),
      (error) => error instanceof ApiError && error.code === 'dependency_unavailable',
    );
    await assertRejects(
      () => dependencies.terminalFailure(workerId, translationJob, null, 'failed'),
      (error) => error instanceof ApiError && error.code === 'dependency_unavailable',
    );
    await dependencies.retryFailure(workerId, translationJob, 'retry', 30);
    assert(dependencies.processorFactory(dependencies.openRouterEnvironment));
  });
});

Deno.test('default auth dependencies execute OTP, session, recovery, and MFA boundaries', async () => {
  await withDefaultEnvironment(async () => {
    const dependencies = defaultAuthDependencies();
    assertEquals(dependencies.captchaMode, 'all');
    assertEquals(dependencies.phoneOtpEnabled, true);
    await dependencies.settleOtpRequest(Date.now() - 2_000);

    assertEquals(
      await dependencies.authorizeInviteOtp(
        'invite-token',
        'email',
        'owner@example.com',
        null,
        sha,
        sha,
        deviceId,
        'request',
      ),
      { allowed: true, channelConfigured: true },
    );
    assertEquals(
      await dependencies.authorizeMemberOtp(
        'email',
        'owner@example.com',
        sha,
        sha,
        deviceId,
        'verify',
      ),
      { allowed: true, channelConfigured: true },
    );
    assertEquals(
      await dependencies.authorizeRecoveryOtp(
        'phone',
        '+15555550123',
        sha,
        sha,
        deviceId,
        'request',
      ),
      { allowed: true, channelConfigured: true },
    );
    assertEquals(
      await dependencies.authorizeSignupOtp(
        'email',
        'newcomer@example.com',
        'coverage_member',
        'Coverage Member',
        'en',
        sha,
        sha,
        deviceId,
        'request',
      ),
      {
        allowed: true,
        reason: 'ok',
        existingMember: false,
        channelConfigured: true,
        retryAfterSeconds: 0,
      },
    );
    await dependencies.ensureSignupUser('newcomer@example.com', 'Coverage Member');
    assertEquals(
      await dependencies.redeemSignup(actorUserId, 'email', 'newcomer@example.com', deviceId),
      {
        organizationId: '11111111-1111-4111-8111-111111111111',
        username: 'coverage_member',
        displayName: 'Coverage Member',
        preferredLanguage: 'en',
      },
    );
    await dependencies.completeSignupUser(actorUserId);

    await dependencies.requestOtp('email', 'owner@example.com', 'captcha-token');
    await dependencies.requestOtp('phone', '+15555550123', null);
    const emailSession = await dependencies.verifyOtp(
      'email',
      'owner@example.com',
      '123456',
    );
    assertEquals(emailSession.userId, actorUserId);
    const phoneSession = await dependencies.verifyOtp('phone', '+15555550123', '123456');
    assertEquals(phoneSession.destinationType, 'email');

    assertEquals(
      await dependencies.redeemInvite(accessToken, actorUserId, 'invite-token', null),
      { organizationId, role: 'admin' },
    );
    assertEquals((await dependencies.refresh(refreshToken)).userId, actorUserId);
    assertEquals(
      await dependencies.bindSessionInstallation(accessToken, {
        installationId: deviceId,
        platform: 'ios',
        appVersion: '1.0.0',
        locale: 'en-US',
        userAgent: 'Mozilla/5.0 (iPhone)',
      }),
      { sessionId },
    );
    const recovery = await dependencies.completeAccountRecovery(accessToken, deviceId);
    assertEquals(recovery.otherSessionsRevoked, 2);
    assertEquals(
      await dependencies.recoveryRpc(
        accessToken,
        'bff_list_account_recovery_cases',
        { p_limit: 10 },
        deviceId,
      ),
      { ok: true },
    );
    assertEquals(
      await dependencies.recoveryServiceRpc(
        'bff_cancel_account_recovery_execution',
        { p_case_id: policyId },
        deviceId,
      ),
      { ok: true },
    );

    await dependencies.listAdminMfaFactors(actorUserId);
    await dependencies.deleteAdminMfaFactor(actorUserId, policyId);
    assertEquals(
      await dependencies.deleteAccount(actorUserId, deviceId),
      { userId: actorUserId, membershipsDeactivated: 1 },
    );
    await dependencies.softDeleteAuthUser(actorUserId);
    await dependencies.revoke(accessToken);
    const identity = await dependencies.identify(accessToken);
    assertEquals(identity.userId, actorUserId);
    const inspected = await dependencies.inspect(accessToken);
    assertEquals(inspected.memberships, [{ organizationId, role: 'admin' }]);
    await dependencies.listMfa(accessToken, refreshToken);
    await dependencies.enrollMfa(accessToken, refreshToken, 'Coverage factor');
    await dependencies.enrollMfa(accessToken, refreshToken, null);
    await dependencies.challengeMfa(accessToken, refreshToken, policyId);
    const verified = await dependencies.verifyMfa(
      accessToken,
      refreshToken,
      policyId,
      deviceId,
      '123456',
    );
    assertEquals(verified.userId, actorUserId);
    await dependencies.unenrollMfa(accessToken, refreshToken, policyId);
  });
});

Deno.test('auth handler executes factor list, enrollment, challenge, verification, and unenrollment', async () => {
  await withDefaultEnvironment(async () => {
    const handler = createAuthHandler();
    const headers = {
      Origin: 'https://app.newone.example',
      Authorization: `Bearer ${accessToken}`,
      Cookie: `__Host-newone_refresh=${encodeURIComponent(refreshToken)}`,
      'Content-Type': 'application/json',
    };
    const call = (path: string, body: Record<string, unknown>) =>
      handler(
        new Request(`https://project.supabase.co${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
      );

    const preflight = await handler(
      new Request('https://project.supabase.co/v2/auth/mfa/factors', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.newone.example',
          'Access-Control-Request-Method': 'POST',
        },
      }),
    );
    assertEquals(preflight.status, 204);

    const factors = await call('/v2/auth/mfa/factors', {});
    assertEquals(factors.status, 200);
    assertEquals(await factors.json(), { factors: [] });

    const enrollment = await call('/v2/auth/mfa/enroll', { friendlyName: 'Coverage factor' });
    assertEquals(enrollment.status, 201);
    assertEquals((await enrollment.json()).factor.id, policyId);

    const challenge = await call('/v2/auth/mfa/challenge', { factorId: policyId });
    assertEquals(challenge.status, 200);
    assertEquals((await challenge.json()).challenge.id, deviceId);

    const verification = await call('/v2/auth/mfa/verify', {
      factorId: policyId,
      challengeId: deviceId,
      code: '123456',
    });
    assertEquals(verification.status, 200);
    assertEquals((await verification.json()).verified, true);

    const unenroll = await call('/v2/auth/mfa/unenroll', { factorId: policyId });
    assertEquals(unenroll.status, 200);
    assertEquals(await unenroll.json(), { unenrolled: true, factorId: policyId });
  });
});

Deno.test('default read dependencies resolve, authorize, rate-limit, and load every read model', async () => {
  await withDefaultEnvironment(async () => {
    const calls: string[] = [];
    const readActor = {
      user: { id: actorUserId, email: 'owner@example.com' },
      claims: { sub: actorUserId, sessionId, aal: 'aal2', issuedAt: 1, expiresAt: 9999999999 },
      token: accessToken,
      userClient: {},
      adminClient: {
        rpc(name: string) {
          calls.push(name);
          const data = name === 'bff_resolve_principal_context'
            ? {
              schema_version: 1,
              selected_organization_id: organizationId,
              organizations: [{ organization_id: organizationId, membership_role: 'admin' }],
            }
            : name === 'bff_authorize_request'
            ? { allowed: true, membership_status: 'active', role: 'admin' }
            : name === 'bff_consume_rate_limit'
            ? { allowed: true, retry_after_seconds: 0 }
            : name === 'bff_bootstrap_messaging_state'
            ? { selected_conversation: { conversation_id: conversationId }, conversations: [] }
            : name === 'bff_get_organization_preferences'
            ? { ui_language: 'en', quiet_days: [1, 2] }
            : name === 'bff_read_conversation_page'
            ? { messages: [{ message_id: '1', sender_user_id: actorUserId }] }
            : name === 'bff_search'
            ? { results: [], next_cursor: null, has_more: false }
            : name === 'bff_query_audit_events'
            ? {
              schema_version: 1,
              items: [],
              next_cursor: null,
              has_more: false,
              snapshot_at: '2026-08-04T00:00:00.000Z',
              filter_sha256: sha,
              receipt_id: deviceId,
            }
            : { recorded: true };
          return Promise.resolve({ data, error: null });
        },
      },
    } as unknown as AuthenticatedActor;
    const dependencies = defaultReadDependencies();
    assertEquals(
      (await dependencies.authenticateActor(dependencies.clientEnvironment, accessToken)).user.id,
      actorUserId,
    );
    const resolved = await dependencies.resolveOrganization(readActor, organizationId);
    assertEquals(resolved.organizationId, organizationId);
    assertEquals(
      await dependencies.authorize(readActor, organizationId, { operation: 'read.coverage' }),
      { role: 'admin', membershipStatus: 'active' },
    );
    await dependencies.rateLimit(
      new Request('https://api.newone.example/v2/bootstrap'),
      dependencies.runtimeConfig,
      readActor,
      organizationId,
      'read.coverage',
    );
    assertEquals(
      await dependencies.loadBootstrap(readActor, resolved, {
        selectedConversationId: conversationId,
        beforeMessageId: null,
        conversationLimit: 20,
        timelineLimit: 50,
      }),
      { selectedConversation: { conversationId }, conversations: [] },
    );
    assertEquals(
      await dependencies.loadPreferences(readActor, organizationId),
      { uiLanguage: 'en', quietDays: [1, 2] },
    );
    assertEquals(
      await dependencies.loadMessages(readActor, {
        organizationId,
        conversationId,
        beforeMessageId: null,
        limit: 50,
      }),
      { messages: [{ messageId: '1', senderUserId: actorUserId }] },
    );
    assertEquals(
      await dependencies.loadSearch(readActor, {
        organizationId,
        query: 'coverage',
        types: ['messages'],
        cursor: null,
        limit: 50,
        senderUserId: null,
        dateFrom: null,
        dateTo: null,
        matchSources: ['original'],
        conversationId,
        language: 'en',
      }),
      { results: [], nextCursor: null, hasMore: false },
    );
    await dependencies.loadAudit(readActor, {
      organizationId,
      reasonCode: 'security_review',
      dateFrom: '2026-08-03T00:00:00.000Z',
      dateTo: '2026-08-04T00:00:00.000Z',
      eventTypes: [],
      actorUserId: null,
      targetType: null,
      targetId: null,
      cursor: null,
      limit: 50,
    });
    await dependencies.recordAuditDenial(readActor, organizationId, 'audit.query');
    assert(calls.includes('bff_bootstrap_messaging_state'));
    assert(calls.includes('bff_record_audit_access_denial'));
  });
});

Deno.test('default outbox dependencies execute each non-push durable dispatcher', async () => {
  await withDefaultEnvironment(async () => {
    const dependencies = defaultOutboxWorkerDependencies();
    dependencies.setCorrelationId?.(deviceId);
    await dependencies.claim(workerId, dependencies.topics, 10);

    const push: PushJob = { id: '10', organizationId, attempts: 1, topic: 'push' };
    await assertRejects(
      () => dependencies.dispatchPush(workerId, push, deviceId),
      (error) => error instanceof ApiError && error.code === 'dependency_unavailable',
    );

    const realtime: RealtimeControlJob = {
      id: '11',
      organizationId,
      attempts: 1,
      topic: 'realtime_control',
      payload: {
        event: 'membership.revoked',
        controlTopic: `org:${organizationId}:user:${actorUserId}:control`,
        organizationId,
        userId: actorUserId,
        revocationGeneration: 2,
      },
    };
    await dependencies.dispatchRealtime(realtime, deviceId);

    const moderation: ModerationFanoutJob = {
      id: '21',
      organizationId,
      attempts: 1,
      topic: 'moderation',
      payload: {
        schemaVersion: 1,
        caseId: policyId,
        state: 'open',
        reason: 'case_available',
        version: 1,
      },
    };
    await dependencies.expandModeration(workerId, moderation);

    const purge: StoragePurgeJob = {
      id: '22',
      organizationId,
      attempts: 1,
      topic: 'storage_purge',
      payload: { attachmentId },
    };
    await dependencies.purgeStorage(purge);

    const revoke: SessionRevokeJob = {
      id: '31',
      organizationId,
      attempts: 1,
      topic: 'session_revoke',
    };
    await dependencies.executeSessionRevoke(workerId, revoke);

    const dynamic: DynamicGroupSyncJob = {
      id: '32',
      organizationId,
      attempts: 1,
      topic: 'dynamic_group_sync',
      payload: { policyId, conversationId, policyVersion: 2, addedCount: 1, removedCount: 0 },
    };
    await dependencies.dispatchDynamicGroup(dynamic, deviceId);
    await dependencies.complete(workerId, dynamic);
    await dependencies.fail(workerId, dynamic, 'retry', 30);
  });
});

Deno.test('default outbox push dispatch decrypts, submits, records, and completes delivery', async () => {
  await withDefaultEnvironment(async () => {
    Deno.env.set('NEWONE_OUTBOX_TOPICS', 'push');
    protectedPushToken = await protectPushToken('ExpoPushToken[abcdefgh12345678]', {
      organizationId,
      userId: actorUserId,
      installationId: policyId,
    });
    const dependencies = defaultOutboxWorkerDependencies();
    assertEquals(dependencies.topics, ['push']);
    const job: PushJob = { id: '50', organizationId, attempts: 1, topic: 'push' };
    await dependencies.dispatchPush(workerId, job, deviceId);
  });
});
