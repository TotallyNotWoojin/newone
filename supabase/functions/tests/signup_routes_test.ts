import { ApiError } from '../_shared/errors.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import {
  type AuthDependencies,
  createAuthHandler,
  OTP_SHOULD_CREATE_USER,
} from '../newone-auth/handler.ts';
import { assert, assertEquals } from './assert.ts';

const runtimeConfig: RuntimeConfig = {
  allowedOrigins: new Set(['https://app.newone.example']),
  accessCookieName: '__Host-newone_access',
  refreshCookieName: '__Host-newone_refresh',
  csrfCookieName: '__Host-newone_csrf',
  maxJsonBytes: 65536,
  networkHashKey: 'n'.repeat(32),
  allowHttpLocal: false,
};

const personalRealmId = '11111111-1111-4111-8111-111111111111';
const installationId = '00000000-0000-4000-8000-000000000099';
const sessionId = '00000000-0000-4000-8000-000000000020';

const session = {
  accessToken: 'signup-access-token-that-is-long-enough',
  refreshToken: 'AbC123dEf456',
  expiresIn: 3600,
  userId: '00000000-0000-4000-8000-000000000010',
  destinationType: 'email' as const,
  destination: 'newcomer@example.com',
  email: 'newcomer@example.com',
  phone: null,
};

const memberships = [{ organizationId: personalRealmId, role: 'member' as const }];

const requestBody = {
  destination: session.email,
  username: 'new_member',
  displayName: 'New Member',
  language: 'en',
  installationId,
  captchaToken: 'turnstile-token-that-is-long-enough',
};

const verifyBody = { destination: session.email, code: '123456', installationId };

function dependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey: 'secret',
    },
    recoveryEvidenceHashKey: 'r'.repeat(32),
    captchaRequired: true,
    phoneOtpEnabled: false,
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
      organizationId: personalRealmId,
      username: 'new_member',
      displayName: 'New Member',
      preferredLanguage: 'en',
    }),
    completeSignupUser: async () => {},
    authorizeRecoveryOtp: async () => ({ allowed: true, channelConfigured: true }),
    requestOtp: async () => {},
    verifyOtp: async () => session,
    redeemInvite: async () => {
      throw new Error('signup flows must not redeem invitations');
    },
    refresh: async () => session,
    bindSessionInstallation: async () => ({ sessionId }),
    completeAccountRecovery: async () => ({
      recovered: true,
      currentSessionId: sessionId,
      currentSessionPreserved: true,
      otherSessionsRevoked: 0,
      securityEventRecorded: true,
      securityNoticeState: 'pending_external_delivery',
    }),
    recoveryRpc: async () => ({}),
    recoveryServiceRpc: async () => ({}),
    listAdminMfaFactors: async () => ({ factors: [] }),
    deleteAdminMfaFactor: async () => {},
    revoke: async () => {},
    identify: async () => ({
      userId: session.userId,
      destinationType: session.destinationType,
      destination: session.destination,
      email: session.email,
      phone: session.phone,
      expiresAt: 9999999999,
    }),
    inspect: async () => ({
      userId: session.userId,
      destinationType: session.destinationType,
      destination: session.destination,
      email: session.email,
      phone: session.phone,
      sessionId,
      expiresAt: 9999999999,
      issuedAt: Math.floor(Date.now() / 1000),
      aal: 'aal1',
      memberships,
    }),
    listMfa: async () => ({ all: [] }),
    enrollMfa: async () => ({}),
    challengeMfa: async () => ({}),
    verifyMfa: async () => session,
    unenrollMfa: async () => {},
    ...overrides,
  };
}

function post(path: string, body: unknown, headers: HeadersInit = {}): Request {
  return new Request(`https://app.newone.example/api/newone${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://app.newone.example',
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
      apikey: 'publishable',
      'Content-Type': 'application/json',
      'X-Newone-Client-Platform': 'ios',
      'X-Newone-Installation-Id': installationId,
      ...headers,
    },
    body: JSON.stringify({ installationId, ...body }),
  });
}

Deno.test('signup request authorizes, provisions the pending user, and returns a generic receipt', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeSignupOtp: async (
        destinationType,
        destination,
        username,
        displayName,
        language,
        ipHash,
        installationHash,
        _requestId,
        purpose,
      ) => {
        calls.push({
          event: 'authorize',
          destinationType,
          destination,
          username,
          displayName,
          language,
          ipHashLength: ipHash.length,
          installationHashLength: installationHash.length,
          purpose,
        });
        return {
          allowed: true,
          reason: 'ok',
          existingMember: false,
          channelConfigured: true,
          retryAfterSeconds: 0,
        };
      },
      ensureSignupUser: async (destination, displayName) => {
        calls.push({ event: 'create-user', destination, displayName });
      },
      requestOtp: async (destinationType, destination, captcha) => {
        calls.push({ event: 'deliver', destinationType, destination, captcha });
      },
    })
  );
  const response = await handler(post('/v2/auth/signup/request', requestBody));
  assertEquals(response.status, 202);
  assertEquals(await response.json(), { status: 'code_sent' });
  assertEquals(calls, [
    {
      event: 'authorize',
      destinationType: 'email',
      destination: session.email,
      username: 'new_member',
      displayName: 'New Member',
      language: 'en',
      ipHashLength: 64,
      installationHashLength: 64,
      purpose: 'request',
    },
    { event: 'create-user', destination: session.email, displayName: 'New Member' },
    {
      event: 'deliver',
      destinationType: 'email',
      destination: session.email,
      captcha: requestBody.captchaToken,
    },
  ]);
});

Deno.test('signup request CAPTCHA is enforced before authorization or user creation', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeSignupOtp: async () => {
        calls.push('authorize');
        return {
          allowed: true,
          reason: 'ok',
          existingMember: false,
          channelConfigured: true,
          retryAfterSeconds: 0,
        };
      },
      ensureSignupUser: async () => {
        calls.push('create-user');
      },
      requestOtp: async () => {
        calls.push('deliver');
      },
    })
  );
  const { captchaToken: _ignored, ...withoutCaptcha } = requestBody;
  assertEquals((await handler(post('/v2/auth/signup/request', withoutCaptcha))).status, 400);
  assertEquals(
    (await handler(post('/v2/auth/signup/request', { ...requestBody, captchaToken: 'short' })))
      .status,
    400,
  );
  assertEquals(calls, []);
  assertEquals((await handler(post('/v2/auth/signup/request', requestBody))).status, 202);
  assertEquals(calls, ['authorize', 'create-user', 'deliver']);
});

Deno.test('signup request with an existing account silently falls back to member sign-in', async () => {
  const calls: string[] = [];
  const fallback = createAuthHandler(() =>
    dependencies({
      authorizeSignupOtp: async () => ({
        allowed: false,
        reason: 'account_exists',
        existingMember: true,
        channelConfigured: true,
        retryAfterSeconds: 0,
      }),
      authorizeMemberOtp: async (
        _destinationType,
        _destination,
        _ipHash,
        _installationHash,
        _requestId,
        purpose,
      ) => {
        calls.push(`member-authorize:${purpose}`);
        return { allowed: true, channelConfigured: true };
      },
      ensureSignupUser: async () => {
        calls.push('unexpected-create-user');
        throw new Error('existing accounts must not be recreated');
      },
      requestOtp: async (_destinationType, _destination, captcha) => {
        calls.push(`deliver:${captcha}`);
      },
    })
  );
  const fallbackResponse = await fallback(post('/v2/auth/signup/request', requestBody));
  assertEquals(fallbackResponse.status, 202);
  assertEquals(calls, ['member-authorize:request', `deliver:${requestBody.captchaToken}`]);

  const fresh = createAuthHandler(() => dependencies());
  const freshResponse = await fresh(post('/v2/auth/signup/request', requestBody));
  assertEquals(freshResponse.status, fallbackResponse.status);
  assertEquals(await fallbackResponse.json(), await freshResponse.json());
});

Deno.test('signup request returns machine-readable availability and validation conflicts', async () => {
  const cases = [
    ['username_taken', 409],
    ['username_reserved', 409],
    ['invalid_username', 400],
    ['invalid_display_name', 400],
    ['invalid_language', 400],
  ] as const;
  for (const [reason, status] of cases) {
    const handler = createAuthHandler(() =>
      dependencies({
        authorizeSignupOtp: async () => ({
          allowed: false,
          reason,
          existingMember: false,
          channelConfigured: true,
          retryAfterSeconds: 60,
        }),
        ensureSignupUser: async () => {
          throw new Error('denied signups must not create users');
        },
      })
    );
    const response = await handler(post('/v2/auth/signup/request', requestBody));
    assertEquals(response.status, status);
    assertEquals((await response.json()).error.code, reason);
  }

  const parseOnly = createAuthHandler(() =>
    dependencies({
      authorizeSignupOtp: async () => {
        throw new Error('malformed profiles must not reach the authorizer');
      },
    })
  );
  const malformedUsername = await parseOnly(
    post('/v2/auth/signup/request', { ...requestBody, username: 'Bad Name!' }),
  );
  assertEquals(malformedUsername.status, 400);
  assertEquals((await malformedUsername.json()).error.code, 'invalid_username');
  const malformedLanguage = await parseOnly(
    post('/v2/auth/signup/request', { ...requestBody, language: 'fr' }),
  );
  assertEquals(malformedLanguage.status, 400);
  assertEquals((await malformedLanguage.json()).error.code, 'invalid_language');
});

Deno.test('signup rate limiting and malformed destinations mirror the member flow envelopes', async () => {
  const rateLimited = createAuthHandler(() =>
    dependencies({
      authorizeSignupOtp: async () => ({
        allowed: false,
        reason: 'rate_limited',
        existingMember: false,
        channelConfigured: true,
        retryAfterSeconds: 900,
      }),
      ensureSignupUser: async () => {
        throw new Error('rate-limited signups must not create users');
      },
    })
  );
  const limited = await rateLimited(post('/v2/auth/signup/request', requestBody));
  assertEquals(limited.status, 429);
  assertEquals(limited.headers.get('Retry-After'), '900');
  const limitedBody = await limited.json();
  assertEquals(limitedBody.error.code, 'rate_limited');
  assertEquals(limitedBody.error.retryAfterSeconds, 900);

  const invalidDestination = createAuthHandler(() =>
    dependencies({
      authorizeSignupOtp: async () => ({
        allowed: false,
        reason: 'invalid_destination',
        existingMember: false,
        channelConfigured: true,
        retryAfterSeconds: 60,
      }),
    })
  );
  const rejected = await invalidDestination(post('/v2/auth/signup/request', requestBody));
  assertEquals(rejected.status, 400);
  assertEquals((await rejected.json()).error.code, 'bad_request');
  assertEquals(
    (await invalidDestination(
      post('/v2/auth/signup/request', { ...requestBody, destination: 'not-an-email' }),
    )).status,
    400,
  );
});

Deno.test('GoTrue public signup stays disabled and denied signups never create auth users', async () => {
  assertEquals(OTP_SHOULD_CREATE_USER, false);
  let created = false;
  let delivered = false;
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeSignupOtp: async () => ({
        allowed: false,
        reason: 'rate_limited',
        existingMember: false,
        channelConfigured: true,
        retryAfterSeconds: 900,
      }),
      ensureSignupUser: async () => {
        created = true;
      },
      requestOtp: async () => {
        delivered = true;
      },
    })
  );
  assertEquals((await handler(post('/v2/auth/signup/request', requestBody))).status, 429);
  assertEquals(created, false);
  assertEquals(delivered, false);
});

Deno.test('signup verification redeems the reservation before issuing session cookies', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeSignupOtp: async (
        _destinationType,
        _destination,
        username,
        displayName,
        language,
        _ipHash,
        _installationHash,
        _requestId,
        purpose,
      ) => {
        calls.push({ event: 'authorize', username, displayName, language, purpose });
        return {
          allowed: true,
          reason: 'ok',
          existingMember: false,
          channelConfigured: true,
          retryAfterSeconds: 0,
        };
      },
      verifyOtp: async () => {
        calls.push({ event: 'verify' });
        return session;
      },
      redeemSignup: async (userId, destinationType, destination) => {
        calls.push({ event: 'redeem', userId, destinationType, destination });
        return {
          organizationId: personalRealmId,
          username: 'new_member',
          displayName: 'New Member',
          preferredLanguage: 'en',
        };
      },
      completeSignupUser: async (userId) => {
        calls.push({ event: 'complete-user', userId });
      },
      bindSessionInstallation: async () => {
        calls.push({ event: 'bind' });
        return { sessionId };
      },
      inspect: async () => {
        calls.push({ event: 'inspect' });
        return {
          userId: session.userId,
          destinationType: session.destinationType,
          destination: session.destination,
          email: session.email,
          phone: session.phone,
          sessionId,
          expiresAt: 9999999999,
          issuedAt: Math.floor(Date.now() / 1000),
          aal: 'aal1',
          memberships,
        };
      },
    })
  );
  const response = await handler(post('/v2/auth/signup/verify', verifyBody));
  assertEquals(response.status, 200);
  assertEquals(calls, [
    { event: 'authorize', username: null, displayName: null, language: null, purpose: 'verify' },
    { event: 'verify' },
    {
      event: 'redeem',
      userId: session.userId,
      destinationType: 'email',
      destination: session.email,
    },
    { event: 'complete-user', userId: session.userId },
    { event: 'bind' },
    { event: 'inspect' },
  ]);
  const body = await response.json();
  assertEquals(body.authenticated, true);
  assertEquals(body.signup, { username: 'new_member', organizationId: personalRealmId });
  assertEquals(body.memberships, memberships);
  assertEquals(body.sessionId, sessionId);
  assert(typeof body.csrfToken === 'string' && body.csrfToken.length >= 32);
  const serialized = JSON.stringify(body);
  assert(!serialized.includes(session.accessToken));
  assert(!serialized.includes(session.refreshToken));
  const cookies = response.headers.getSetCookie();
  assertEquals(cookies.length, 3);
  assert(
    cookies.some((value) =>
      value.startsWith('__Host-newone_access=') && value.includes('HttpOnly') &&
      value.includes('SameSite=Strict')
    ),
  );
});

Deno.test('signup verification with an existing account completes plain member sign-in', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeSignupOtp: async () => ({
        allowed: false,
        reason: 'account_exists',
        existingMember: true,
        channelConfigured: true,
        retryAfterSeconds: 0,
      }),
      authorizeMemberOtp: async (
        _destinationType,
        _destination,
        _ipHash,
        _installationHash,
        _requestId,
        purpose,
      ) => {
        calls.push(`member-authorize:${purpose}`);
        return { allowed: true, channelConfigured: true };
      },
      verifyOtp: async () => {
        calls.push('verify');
        return session;
      },
      redeemSignup: async () => {
        calls.push('unexpected-redeem');
        throw new Error('existing members must not redeem signup');
      },
      completeSignupUser: async () => {
        calls.push('unexpected-complete-user');
      },
    })
  );
  const response = await handler(post('/v2/auth/signup/verify', verifyBody));
  assertEquals(response.status, 200);
  assertEquals(calls, ['member-authorize:verify', 'verify']);
  const body = await response.json();
  assertEquals(body.authenticated, true);
  assertEquals(body.signup, undefined);
  assertEquals(body.memberships, memberships);
  assertEquals(response.headers.getSetCookie().length, 3);
});

Deno.test('expired signup reservations return 410 without issuing credentials', async () => {
  const calls: string[] = [];
  const expiredBeforeVerify = createAuthHandler(() =>
    dependencies({
      authorizeSignupOtp: async () => ({
        allowed: false,
        reason: 'reservation_expired',
        existingMember: false,
        channelConfigured: true,
        retryAfterSeconds: 60,
      }),
      verifyOtp: async () => {
        calls.push('unexpected-verify');
        return session;
      },
    })
  );
  const expired = await expiredBeforeVerify(post('/v2/auth/signup/verify', verifyBody));
  assertEquals(expired.status, 410);
  assertEquals((await expired.json()).error.code, 'signup_expired');
  assertEquals(expired.headers.getSetCookie().length, 0);
  assertEquals(calls, []);

  const expiredAtRedemption = createAuthHandler(() =>
    dependencies({
      verifyOtp: async () => {
        calls.push('verify');
        return session;
      },
      redeemSignup: async () => {
        calls.push('redeem');
        throw new ApiError(410, 'signup_expired');
      },
      completeSignupUser: async () => {
        calls.push('unexpected-complete-user');
      },
      bindSessionInstallation: async () => {
        calls.push('unexpected-bind');
        return { sessionId };
      },
      revoke: async () => {
        calls.push('revoke');
      },
    })
  );
  const failed = await expiredAtRedemption(post('/v2/auth/signup/verify', verifyBody));
  assertEquals(failed.status, 410);
  assertEquals((await failed.json()).error.code, 'signup_expired');
  assertEquals(failed.headers.getSetCookie().length, 0);
  assertEquals(calls, ['verify', 'redeem', 'revoke']);
});

Deno.test('username conflicts at redemption fail closed with 409 and no session', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      redeemSignup: async () => {
        calls.push('redeem');
        throw new ApiError(409, 'username_taken');
      },
      completeSignupUser: async () => {
        calls.push('unexpected-complete-user');
      },
      revoke: async () => {
        calls.push('revoke');
      },
    })
  );
  const response = await handler(post('/v2/auth/signup/verify', verifyBody));
  assertEquals(response.status, 409);
  assertEquals((await response.json()).error.code, 'username_taken');
  assertEquals(response.headers.getSetCookie().length, 0);
  assertEquals(calls, ['redeem', 'revoke']);
});

Deno.test('native signup mirrors web with installation binding and bounded tokens', async () => {
  const platforms: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      bindSessionInstallation: async (_accessToken, installation) => {
        platforms.push(installation.platform);
        return { sessionId };
      },
    })
  );
  const requested = await handler(nativePost('/v2/auth/native/signup/request', requestBody));
  assertEquals(requested.status, 202);
  assertEquals(await requested.json(), { status: 'code_sent' });

  const mismatched = await handler(nativePost('/v2/auth/native/signup/request', {
    ...requestBody,
    installationId: '00000000-0000-4000-8000-000000000098',
  }));
  assertEquals(mismatched.status, 400);

  const wrongKey = await handler(
    nativePost('/v2/auth/native/signup/request', requestBody, { apikey: 'wrong' }),
  );
  assertEquals(wrongKey.status, 403);

  const verified = await handler(nativePost('/v2/auth/native/signup/verify', verifyBody));
  assertEquals(verified.status, 200);
  assertEquals(verified.headers.getSetCookie().length, 0);
  const body = await verified.json();
  assertEquals(body.signup, { username: 'new_member', organizationId: personalRealmId });
  assertEquals(body.session, {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
  });
  assertEquals(platforms, ['ios']);
});
