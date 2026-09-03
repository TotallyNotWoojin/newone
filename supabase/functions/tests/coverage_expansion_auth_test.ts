import { ApiError } from '../_shared/errors.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import {
  type AuthDependencies,
  createAuthHandler,
  defaultAuthDependencies,
} from '../newone-auth/handler.ts';
import { assertEquals, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const userId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const installationId = '40000000-0000-4000-8000-000000000004';
const factorId = '50000000-0000-4000-8000-000000000005';
const challengeId = '60000000-0000-4000-8000-000000000006';
const accessToken = 'coverage-access-token-that-is-long-enough';
const refreshToken = 'coverage-refresh-token-that-is-long-enough';

const runtimeConfig: RuntimeConfig = {
  allowedOrigins: new Set(['https://app.newone.example']),
  accessCookieName: '__Host-newone_access',
  refreshCookieName: '__Host-newone_refresh',
  csrfCookieName: '__Host-newone_csrf',
  maxJsonBytes: 65536,
  networkHashKey: 'network-key-that-is-long-enough-coverage',
  allowHttpLocal: false,
};

const session = {
  accessToken,
  refreshToken,
  expiresIn: 3600,
  userId,
  destinationType: 'email' as const,
  destination: 'coverage@example.com',
  email: 'coverage@example.com',
  phone: null,
};

const memberships = [{ organizationId, role: 'admin' as const }];

function dependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'coverage-publishable-key',
      secretKey: 'coverage-secret-key',
    },
    recoveryEvidenceHashKey: 'r'.repeat(32),
    captchaMode: 'off',
    phoneOtpEnabled: true,
    reviewAccount: null,
    settleOtpRequest: async () => {},
    authorizeInviteOtp: async () => ({ allowed: true, channelConfigured: true }),
    authorizeMemberOtp: async () => ({ allowed: true, channelConfigured: true }),
    authorizeSignupOtp: async () => ({
      allowed: true,
      reason: 'ok',
      existingMember: false,
      channelConfigured: true,
      retryAfterSeconds: 0,
    }),
    ensureSignupUser: async () => {},
    redeemSignup: async () => ({
      organizationId,
      username: 'coverage_member',
      displayName: 'Coverage Member',
      preferredLanguage: 'en',
    }),
    completeSignupUser: async () => {},
    authorizeRecoveryOtp: async () => ({ allowed: true, channelConfigured: true }),
    requestOtp: async () => {},
    generateEmailOtp: async () => {
      throw new Error('signup email OTP must not be minted');
    },
    sendCodeEmail: async () => {
      throw new Error('signup code email must not be sent');
    },
    verifyOtp: async () => session,
    generateReviewOtp: async () => {
      throw new Error('review OTP must not be generated');
    },
    redeemInvite: async () => ({ organizationId, role: 'admin' }),
    refresh: async () => session,
    bindSessionInstallation: async () => ({ sessionId }),
    completeAccountRecovery: async () => ({
      recovered: true,
      currentSessionId: sessionId,
      currentSessionPreserved: true,
      otherSessionsRevoked: 1,
      securityEventRecorded: true,
      securityNoticeState: 'pending_external_delivery',
    }),
    recoveryRpc: async () => ({ schema_version: 1, items: [] }),
    recoveryServiceRpc: async () => ({ completed: true, all_sessions_revoked: true }),
    listAdminMfaFactors: async () => ({
      factors: [{ id: factorId, factor_type: 'totp', status: 'verified' }],
    }),
    deleteAdminMfaFactor: async () => {},
    deleteAccount: async () => ({ userId, membershipsDeactivated: 1 }),
    softDeleteAuthUser: async () => {},
    revoke: async () => {},
    identify: async () => ({
      userId,
      destinationType: 'email',
      destination: 'coverage@example.com',
      email: 'coverage@example.com',
      phone: null,
      expiresAt: 9999999999,
    }),
    inspect: async () => ({
      userId,
      destinationType: 'email',
      destination: 'coverage@example.com',
      email: 'coverage@example.com',
      phone: null,
      sessionId,
      expiresAt: 9999999999,
      issuedAt: Math.floor(Date.now() / 1000),
      aal: 'aal2',
      memberships,
    }),
    listMfa: async () => ({ all: [] }),
    enrollMfa: async () => ({
      id: factorId,
      type: 'totp',
      friendly_name: null,
      totp: {
        qr_code: 'data:image/svg+xml;utf-8,<svg>coverage</svg>',
        secret: 'ABCDEFGHIJKLMNOP',
        uri: 'otpauth://totp/Newone:coverage?secret=ABCDEFGHIJKLMNOP',
      },
    }),
    challengeMfa: async () => ({ id: challengeId, type: 'totp', expires_at: 9999999999 }),
    verifyMfa: async () => session,
    unenrollMfa: async () => {},
    ...overrides,
  };
}

function browserPost(
  path: string,
  body: unknown,
  headers: HeadersInit = {},
): Request {
  return new Request(`https://app.newone.example/api/newone${path}`, {
    method: 'POST',
    headers: {
      Origin: 'https://app.newone.example',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function nativePost(
  path: string,
  body: Record<string, unknown>,
  headers: HeadersInit = {},
): Request {
  return new Request(`https://project.supabase.co/functions/v1/newone-auth${path}`, {
    method: 'POST',
    headers: {
      apikey: 'coverage-publishable-key',
      'Content-Type': 'application/json',
      'X-Newone-Client-Platform': 'ios',
      'X-Newone-Installation-Id': installationId,
      ...headers,
    },
    body: JSON.stringify({ installationId, ...body }),
  });
}

async function status(
  overrides: Partial<AuthDependencies>,
  request: Request,
): Promise<number> {
  return (await createAuthHandler(() => dependencies(overrides))(request)).status;
}

Deno.test('auth default configuration rejects malformed recovery, CAPTCHA, and phone switches', async () => {
  const names = [
    'SUPABASE_URL',
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SECRET_KEY',
    'NEWONE_ALLOWED_WEB_ORIGINS',
    'NEWONE_NETWORK_HASH_KEY',
    'NEWONE_RECOVERY_EVIDENCE_HASH_KEY',
    'NEWONE_AUTH_CAPTCHA_REQUIRED',
    'NEWONE_AUTH_PHONE_OTP_ENABLED',
    'NEWONE_ALLOW_HTTP_LOCAL',
  ] as const;
  const before = new Map(names.map((name) => [name, Deno.env.get(name)]));
  const base: Record<string, string> = {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'coverage-publishable-key',
    SUPABASE_SECRET_KEY: 'coverage-secret-key',
    NEWONE_ALLOWED_WEB_ORIGINS: 'https://app.newone.example',
    NEWONE_NETWORK_HASH_KEY: 'n'.repeat(32),
    NEWONE_RECOVERY_EVIDENCE_HASH_KEY: 'r'.repeat(32),
    NEWONE_AUTH_CAPTCHA_REQUIRED: 'true',
    NEWONE_AUTH_PHONE_OTP_ENABLED: 'false',
  };
  try {
    for (const [key, value] of Object.entries(base)) Deno.env.set(key, value);
    Deno.env.delete('NEWONE_ALLOW_HTTP_LOCAL');
    assertEquals(defaultAuthDependencies().captchaMode, 'all');
    Deno.env.set('NEWONE_AUTH_CAPTCHA_REQUIRED', 'web');
    assertEquals(defaultAuthDependencies().captchaMode, 'web');
    Deno.env.set('NEWONE_AUTH_CAPTCHA_REQUIRED', 'true');
    for (const invalid of ['', 'short', `${'r'.repeat(32)}\n`]) {
      Deno.env.set('NEWONE_RECOVERY_EVIDENCE_HASH_KEY', invalid);
      await assertRejects(async () => defaultAuthDependencies());
    }
    Deno.env.set('NEWONE_RECOVERY_EVIDENCE_HASH_KEY', 'r'.repeat(32));
    Deno.env.set('NEWONE_AUTH_CAPTCHA_REQUIRED', 'false');
    await assertRejects(async () => defaultAuthDependencies());
    Deno.env.set('NEWONE_ALLOW_HTTP_LOCAL', 'true');
    assertEquals(defaultAuthDependencies().captchaMode, 'off');
    Deno.env.set('NEWONE_AUTH_PHONE_OTP_ENABLED', 'invalid');
    await assertRejects(async () => defaultAuthDependencies());
  } finally {
    for (const name of names) {
      const value = before.get(name);
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test('auth request context and OTP identity parsing reject every ambiguous credential form', async () => {
  const handler = createAuthHandler(() => dependencies());
  assertEquals(
    (await handler(
      new Request('https://project.supabase.co/v2/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    )).status,
    403,
  );
  assertEquals(
    (await handler(nativePost('/v2/auth/native/otp/request', {
      destinationType: 'email',
      destination: 'coverage@example.com',
    }, { apikey: 'wrong' }))).status,
    403,
  );
  assertEquals(
    (await handler(nativePost('/v2/auth/native/otp/request', {
      destinationType: 'email',
      destination: 'coverage@example.com',
    }, { 'X-Newone-Client-Platform': 'web' }))).status,
    403,
  );
  assertEquals(
    (await handler(nativePost('/v2/auth/native/otp/request', {
      destinationType: 'email',
      destination: 'coverage@example.com',
    }, { Authorization: 'Bearer unexpected' }))).status,
    403,
  );
  assertEquals(
    (await handler(nativePost('/v2/auth/native/otp/request', {
      destinationType: 'email',
      destination: 'coverage@example.com',
    }, { Cookie: 'unexpected=true' }))).status,
    403,
  );

  const otp = '/v2/auth/otp/request';
  for (
    const body of [
      {
        installationId,
        email: 'coverage@example.com',
        destinationType: 'email',
        destination: 'coverage@example.com',
      },
      { installationId, email: 'not-an-email' },
      { installationId, destinationType: 'phone', destination: 'not-phone' },
      {
        installationId,
        destinationType: 'email',
        destination: 'coverage@example.com',
        employeeCode: '*bad',
      },
      {
        installationId,
        destinationType: 'email',
        destination: 'coverage@example.com',
        invitationToken: 'x'.repeat(64),
      },
      {
        installationId,
        destinationType: 'email',
        destination: 'coverage@example.com',
        locale: 'bad locale',
      },
      {
        installationId,
        destinationType: 'email',
        destination: 'coverage@example.com',
        captchaToken: 'x'.repeat(20) + '\n',
      },
    ]
  ) {
    assertEquals((await handler(browserPost(otp, body))).status, 400);
  }
  assertEquals(
    (await handler(nativePost('/v2/auth/native/otp/request', {
      destinationType: 'email',
      destination: 'coverage@example.com',
      installationId: factorId,
    }))).status,
    400,
  );
});

Deno.test('auth OTP and recovery authentication cover suppressed delivery and session mismatch cleanup', async () => {
  const otpBody = {
    email: 'coverage@example.com',
    installationId,
  };
  assertEquals(
    await status({
      requestOtp: async () => {
        throw new Error('delivery failure');
      },
    }, browserPost('/v2/auth/otp/request', otpBody)),
    202,
  );
  assertEquals(
    await status(
      { authorizeMemberOtp: async () => ({ allowed: false, channelConfigured: true }) },
      browserPost('/v2/auth/otp/request', otpBody),
    ),
    202,
  );
  assertEquals(
    await status(
      { phoneOtpEnabled: false },
      browserPost('/v2/auth/otp/request', {
        destinationType: 'phone',
        destination: '+15551234567',
        installationId,
      }),
    ),
    202,
  );
  assertEquals(
    await status({}, browserPost('/v2/auth/otp/verify', { ...otpBody, code: 'abcdef' })),
    401,
  );
  assertEquals(
    await status(
      { authorizeMemberOtp: async () => ({ allowed: false, channelConfigured: true }) },
      browserPost('/v2/auth/otp/verify', { ...otpBody, code: '123456' }),
    ),
    401,
  );
  assertEquals(
    await status({
      verifyOtp: async () => ({
        ...session,
        email: 'other@example.com',
        destination: 'other@example.com',
      }),
      revoke: async () => {
        throw new Error('cleanup unavailable');
      },
    }, browserPost('/v2/auth/otp/verify', { ...otpBody, code: '123456' })),
    401,
  );
  assertEquals(
    await status(
      {},
      browserPost('/v2/auth/otp/verify', {
        ...otpBody,
        employeeCode: 'EMP-1',
        code: '123456',
      }),
    ),
    401,
  );
  assertEquals(
    await status({
      inspect: async () => ({
        ...(await dependencies().inspect(accessToken)),
        userId: factorId,
      }),
      revoke: async () => {
        throw new Error('cleanup unavailable');
      },
    }, browserPost('/v2/auth/otp/verify', { ...otpBody, code: '123456' })),
    401,
  );

  const recoveryRequest = '/v2/auth/recovery/otp/request';
  assertEquals(
    await status({
      requestOtp: async () => {
        throw new Error('delivery failure');
      },
    }, browserPost(recoveryRequest, otpBody)),
    202,
  );
  assertEquals(
    await status({
      authorizeRecoveryOtp: async () => ({ allowed: false, channelConfigured: true }),
    }, browserPost('/v2/auth/recovery/otp/verify', { ...otpBody, code: '123456' })),
    401,
  );
  assertEquals(
    await status(
      {},
      browserPost('/v2/auth/recovery/otp/verify', {
        ...otpBody,
        employeeCode: 'EMP-1',
        code: '123456',
      }),
    ),
    400,
  );
  assertEquals(
    await status({}, browserPost('/v2/auth/recovery/otp/verify', { ...otpBody, code: 'bad' })),
    401,
  );
  assertEquals(
    await status({
      completeAccountRecovery: async () => ({
        ...(await dependencies().completeAccountRecovery(accessToken, challengeId)),
        currentSessionId: factorId,
      }),
      revoke: async () => {
        throw new Error('cleanup unavailable');
      },
    }, browserPost('/v2/auth/recovery/otp/verify', { ...otpBody, code: '123456' })),
    401,
  );
});

Deno.test('auth MFA response parsers and recent-auth gates fail closed', async () => {
  const authHeaders = {
    Cookie: `${runtimeConfig.refreshCookieName}=${encodeURIComponent(refreshToken)}`,
  };
  for (const value of [{ all: 'invalid' }, { all: Array(51).fill({}) }]) {
    assertEquals(
      await status(
        { listMfa: async () => value },
        browserPost('/v2/auth/mfa/factors', {}, authHeaders),
      ),
      503,
    );
  }
  assertEquals(
    await status({
      listMfa: async () => ({
        all: [
          { factor_type: 'phone' },
          {
            id: factorId,
            factor_type: 'totp',
            status: 'verified',
            friendly_name: 'Coverage',
            created_at: '2026-08-04T00:00:00Z',
            updated_at: '2026-08-04T00:00:00Z',
          },
        ],
      }),
    }, browserPost('/v2/auth/mfa/factors', {}, authHeaders)),
    200,
  );
  assertEquals(
    await status({
      listMfa: async () => ({
        all: Array(21).fill({
          id: factorId,
          factor_type: 'totp',
          status: 'verified',
          friendly_name: null,
          created_at: '2026-08-04T00:00:00Z',
          updated_at: '2026-08-04T00:00:00Z',
        }),
      }),
    }, browserPost('/v2/auth/mfa/factors', {}, authHeaders)),
    503,
  );
  assertEquals(
    await status({
      challengeMfa: async () => ({ id: challengeId, type: 'totp', expires_at: 'bad' }),
    }, browserPost('/v2/auth/mfa/challenge', { factorId }, authHeaders)),
    503,
  );
  assertEquals(
    await status(
      {},
      browserPost('/v2/auth/mfa/verify', {
        factorId,
        challengeId,
        code: 'abcdef',
      }, authHeaders),
    ),
    401,
  );
  assertEquals(
    await status(
      {
        inspect: async () => ({ ...(await dependencies().inspect(accessToken)), aal: 'aal1' }),
      },
      browserPost('/v2/auth/mfa/verify', {
        factorId,
        challengeId,
        code: '123456',
      }, authHeaders),
    ),
    401,
  );
  assertEquals(
    await status({
      inspect: async () => ({
        ...(await dependencies().inspect(accessToken)),
        aal: 'aal2',
        issuedAt: Math.floor(Date.now() / 1000) - 301,
      }),
    }, browserPost('/v2/auth/mfa/unenroll', { factorId }, authHeaders)),
    403,
  );
});

Deno.test('auth refresh, recovery responses, and invitation cleanup cover negative receipts', async () => {
  const csrf = 'coverage-csrf';
  const refreshHeaders = {
    Cookie: `${runtimeConfig.refreshCookieName}=${
      encodeURIComponent(refreshToken)
    }; ${runtimeConfig.csrfCookieName}=${csrf}`,
    'X-CSRF-Token': csrf,
  };
  assertEquals(
    await status({
      inspect: async () => ({
        ...(await dependencies().inspect(accessToken)),
        memberships: [],
      }),
      revoke: async () => {
        throw new Error('cleanup unavailable');
      },
    }, browserPost('/v2/auth/session/refresh', { installationId }, refreshHeaders)),
    401,
  );
  assertEquals(
    await status(
      {},
      browserPost('/v2/auth/session/refresh', { installationId }, {
        Cookie:
          `${runtimeConfig.refreshCookieName}=%E0%A4%A; ${runtimeConfig.csrfCookieName}=${csrf}`,
        'X-CSRF-Token': csrf,
      }),
    ),
    400,
  );

  for (
    const value of [
      { secret: { access_token: 'leak' } },
      { nested: [[[[[[[[[{}]]]]]]]]] },
      { values: Array(101).fill(null) },
      { content: 'x'.repeat(65537) },
    ]
  ) {
    assertEquals(
      await status(
        { recoveryRpc: async () => value },
        browserPost(
          '/v2/auth/recovery/cases/query',
          { organizationId, includeOrganization: true },
        ),
      ),
      503,
    );
  }
  assertEquals(
    await status(
      {},
      browserPost(
        '/v2/auth/recovery/cases/query',
        { organizationId, includeOrganization: 'true' },
      ),
    ),
    400,
  );

  assertEquals(
    await status(
      {
        redeemInvite: async () => {
          throw new Error('redemption failed');
        },
        revoke: async () => {
          throw new Error('cleanup unavailable');
        },
      },
      browserPost('/v2/auth/invitations/redeem', {
        invitationToken: 'a'.repeat(64),
        employeeCode: null,
      }),
    ),
    401,
  );
});
