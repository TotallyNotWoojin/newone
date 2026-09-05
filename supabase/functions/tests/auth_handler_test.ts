import type { RuntimeConfig } from '../_shared/http.ts';
import { ApiError } from '../_shared/errors.ts';
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

const session = {
  accessToken: 'access-token-that-is-long-enough',
  refreshToken: 'refresh-token-that-is-long-enough',
  expiresIn: 3600,
  userId: '00000000-0000-4000-8000-000000000010',
  destinationType: 'email' as const,
  destination: 'worker@example.com',
  email: 'worker@example.com',
  phone: null,
};

const installationId = '00000000-0000-4000-8000-000000000099';

const memberships = [{
  organizationId: '00000000-0000-4000-8000-000000000001',
  role: 'member' as const,
}];

function dependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey: 'secret',
    },
    recoveryEvidenceHashKey: 'r'.repeat(32),
    captchaMode: 'all',
    phoneOtpEnabled: false,
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
      organizationId: '11111111-1111-4111-8111-111111111111',
      username: 'new_member',
      displayName: 'New Member',
      preferredLanguage: 'en',
    }),
    completeSignupUser: async () => {},
    authorizeRecoveryOtp: async () => ({ allowed: true, channelConfigured: true }),
    requestOtp: async () => {},
    generateEmailOtp: async () => '654321',
    sendCodeEmail: async () => {},
    verifyOtp: async () => session,
    signInWithPassword: async () => session,
    setPassword: async () => {},
    generateReviewOtp: async () => {
      throw new Error('review OTP must not be generated');
    },
    redeemInvite: async () => ({
      organizationId: '00000000-0000-4000-8000-000000000001',
      role: 'member',
    }),
    refresh: async () => session,
    bindSessionInstallation: async () => ({
      sessionId: '00000000-0000-4000-8000-000000000020',
    }),
    completeAccountRecovery: async () => ({
      recovered: true,
      currentSessionId: '00000000-0000-4000-8000-000000000020',
      currentSessionPreserved: true,
      otherSessionsRevoked: 2,
      securityEventRecorded: true,
      securityNoticeState: 'pending_external_delivery',
    }),
    recoveryRpc: async () => ({}),
    recoveryServiceRpc: async () => ({}),
    listAdminMfaFactors: async () => ({ factors: [] }),
    deleteAdminMfaFactor: async () => {},
    deleteAccount: async () => ({ userId: session.userId, membershipsDeactivated: 1 }),
    softDeleteAuthUser: async () => {},
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
      sessionId: '00000000-0000-4000-8000-000000000020',
      expiresAt: 9999999999,
      issuedAt: Math.floor(Date.now() / 1000),
      aal: 'aal1',
      memberships,
    }),
    listMfa: async () => ({ all: [] }),
    enrollMfa: async () => ({
      id: '00000000-0000-4000-8000-000000000090',
      type: 'totp',
      friendly_name: null,
      totp: {
        qr_code: 'data:image/svg+xml;utf-8,<svg>test</svg>',
        secret: 'ABCDEFGHIJKLMNOP',
        uri: 'otpauth://totp/Newone:test?secret=ABCDEFGHIJKLMNOP',
      },
    }),
    challengeMfa: async () => ({
      id: '00000000-0000-4000-8000-000000000091',
      type: 'totp',
      expires_at: 9999999999,
    }),
    verifyMfa: async () => session,
    unenrollMfa: async () => {},
    ...overrides,
  };
}

function post(path: string, body: unknown, headers: HeadersInit = {}): Request {
  const payload = path.includes('/otp/') && body !== null && typeof body === 'object' &&
      !Array.isArray(body)
    ? { installationId, ...body as Record<string, unknown> }
    : body;
  return new Request(`https://app.newone.example/api/newone${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://app.newone.example',
      ...headers,
    },
    body: JSON.stringify(payload),
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

Deno.test('invite OTP request is enumeration-resistant and rate authorization runs before delivery', async () => {
  assertEquals(OTP_SHOULD_CREATE_USER, false);
  let requested = false;
  let fingerprint = '';
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeInviteOtp: async (
        _token,
        _destinationType,
        _destination,
        _employeeCode,
        ipHash,
        _installationHash,
        _requestId,
        purpose,
      ) => {
        fingerprint = ipHash;
        assertEquals(purpose, 'request');
        return { allowed: false, channelConfigured: true };
      },
      requestOtp: async () => {
        requested = true;
      },
    })
  );
  const response = await handler(post('/v2/auth/otp/request', {
    email: 'worker@example.com',
    invitationToken: 'a'.repeat(64),
    captchaToken: 'captcha-token-that-is-long-enough',
  }, { 'CF-Connecting-IP': '203.0.113.7' }));
  assertEquals(response.status, 202);
  assertEquals(await response.json(), {
    accepted: true,
    channel: { type: 'email', configured: true },
  });
  assertEquals(requested, false);
  assertEquals(fingerprint.length, 64);

  const eligible = createAuthHandler(() =>
    dependencies({
      authorizeInviteOtp: async () => ({ allowed: true, channelConfigured: true }),
    })
  );
  const eligibleResponse = await eligible(post('/v2/auth/otp/request', {
    email: 'worker@example.com',
    invitationToken: 'a'.repeat(64),
    captchaToken: 'captcha-token-that-is-long-enough',
  }));
  assertEquals(eligibleResponse.status, response.status);
  assertEquals(await eligibleResponse.json(), {
    accepted: true,
    channel: { type: 'email', configured: true },
  });
});

Deno.test('OTP CAPTCHA is required, bounded, and passed only through the delivery boundary', async () => {
  // Email OTP delivery is gateway-owned mail (generateEmailOtp + sendCodeEmail)
  // and never reaches requestOtp; only the phone channel forwards the CAPTCHA
  // token through to the delivery dependency, so that is what this exercises.
  const delivered: Array<string | null> = [];
  const handler = createAuthHandler(() =>
    dependencies({
      phoneOtpEnabled: true,
      requestOtp: async (_destinationType, _destination, token) => {
        delivered.push(token);
      },
    })
  );
  assertEquals(
    (await handler(post('/v2/auth/otp/request', {
      destinationType: 'phone',
      destination: '+12025550123',
      invitationToken: 'a'.repeat(64),
    }))).status,
    400,
  );
  assertEquals(
    (await handler(post('/v2/auth/otp/request', {
      destinationType: 'phone',
      destination: '+12025550123',
      invitationToken: 'a'.repeat(64),
      captchaToken: 'short',
    }))).status,
    400,
  );
  const token = 'turnstile-token-that-is-long-enough';
  assertEquals(
    (await handler(post('/v2/auth/otp/request', {
      destinationType: 'phone',
      destination: '+12025550123',
      invitationToken: 'a'.repeat(64),
      captchaToken: token,
    }))).status,
    202,
  );
  assertEquals(delivered, [token]);
});

Deno.test('web CAPTCHA mode exempts origin-less native paths while web requests still need a token', async () => {
  // Every email path (plain OTP, recovery OTP, and signup) is gateway-owned
  // mail -- generateEmailOtp + sendCodeEmail -- never GoTrue signInWithOtp,
  // so delivery is observed through that dependency for all three.
  let mailSent = 0;
  const handler = createAuthHandler(() =>
    dependencies({
      captchaMode: 'web',
      sendCodeEmail: async () => {
        mailSent += 1;
      },
    })
  );

  // Native origin-less request paths accept requests without a captchaToken.
  assertEquals(
    (await handler(nativePost('/v2/auth/native/otp/request', {
      destinationType: 'email',
      destination: session.email,
    }))).status,
    202,
  );
  assertEquals(
    (await handler(nativePost('/v2/auth/native/recovery/otp/request', {
      destinationType: 'email',
      destination: session.email,
    }))).status,
    202,
  );
  assertEquals(
    (await handler(nativePost('/v2/auth/native/signup/request', {
      destination: session.email,
      username: 'new_member',
      displayName: 'New Member',
      language: 'en',
    }))).status,
    202,
  );
  assertEquals(mailSent, 3);

  // Requests arriving with a browser Origin still require token presence.
  assertEquals(
    (await handler(post('/v2/auth/otp/request', { email: session.email }))).status,
    400,
  );
  assertEquals(
    (await handler(post('/v2/auth/recovery/otp/request', { email: session.email }))).status,
    400,
  );
  assertEquals(
    (await handler(post('/v2/auth/signup/request', {
      destination: session.email,
      username: 'new_member',
      displayName: 'New Member',
      language: 'en',
      installationId,
    }))).status,
    400,
  );
  assertEquals(mailSent, 3);
});

Deno.test('all CAPTCHA mode still requires token presence on native paths', async () => {
  let requested = false;
  const handler = createAuthHandler(() =>
    dependencies({
      requestOtp: async () => {
        requested = true;
      },
    })
  );
  assertEquals(
    (await handler(nativePost('/v2/auth/native/otp/request', {
      destinationType: 'email',
      destination: session.email,
    }))).status,
    400,
  );
  assertEquals(
    (await handler(nativePost('/v2/auth/native/recovery/otp/request', {
      destinationType: 'email',
      destination: session.email,
    }))).status,
    400,
  );
  assertEquals(
    (await handler(nativePost('/v2/auth/native/signup/request', {
      destination: session.email,
      username: 'new_member',
      displayName: 'New Member',
      language: 'en',
    }))).status,
    400,
  );
  assertEquals(requested, false);
});

Deno.test('a provided CAPTCHA token is shape-validated in every mode', async () => {
  for (const captchaMode of ['all', 'web', 'off'] as const) {
    let requested = false;
    const handler = createAuthHandler(() =>
      dependencies({
        captchaMode,
        requestOtp: async () => {
          requested = true;
        },
      })
    );
    assertEquals(
      (await handler(post('/v2/auth/otp/request', {
        email: session.email,
        captchaToken: 'short',
      }))).status,
      400,
    );
    assertEquals(
      (await handler(nativePost('/v2/auth/native/otp/request', {
        destinationType: 'email',
        destination: session.email,
        captchaToken: 'short',
      }))).status,
      400,
    );
    assertEquals(requested, false);
  }
});

Deno.test('returning active members authenticate without invitation redemption', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeMemberOtp: async (
        _destinationType,
        _destination,
        _ipHash,
        _installationHash,
        _requestId,
        purpose,
      ) => {
        assertEquals(purpose, 'verify');
        calls.push('authorize-member');
        return { allowed: true, channelConfigured: true };
      },
      verifyOtp: async () => {
        calls.push('verify');
        return session;
      },
      bindSessionInstallation: async () => {
        calls.push('bind');
        return { sessionId: '00000000-0000-4000-8000-000000000020' };
      },
      inspect: async () => {
        calls.push('active-memberships');
        return {
          userId: session.userId,
          destinationType: session.destinationType,
          destination: session.destination,
          email: session.email,
          phone: session.phone,
          sessionId: '00000000-0000-4000-8000-000000000020',
          expiresAt: 9999999999,
          issuedAt: Math.floor(Date.now() / 1000),
          aal: 'aal1',
          memberships,
        };
      },
      redeemInvite: async () => {
        calls.push('unexpected-redeem');
        throw new Error('must not redeem');
      },
    })
  );
  const response = await handler(post('/v2/auth/otp/verify', {
    email: session.email,
    code: '123456',
  }, { 'CF-Connecting-IP': '203.0.113.7' }));
  assertEquals(response.status, 200);
  assertEquals(calls, ['authorize-member', 'verify', 'bind', 'active-memberships']);
  const body = await response.json();
  assertEquals(body.memberships, memberships);
  assertEquals(body.sessionId, '00000000-0000-4000-8000-000000000020');
  assertEquals(body.aal, 'aal1');
  assertEquals(response.headers.getSetCookie().length, 3);
});

Deno.test('returning suspended or unknown accounts fail without membership cookies', async () => {
  let delivered = false;
  const unknown = createAuthHandler(() =>
    dependencies({
      authorizeMemberOtp: async () => ({ allowed: false, channelConfigured: true }),
      requestOtp: async () => {
        delivered = true;
      },
    })
  );
  const requestResponse = await unknown(post('/v2/auth/otp/request', {
    email: session.email,
    captchaToken: 'captcha-token-that-is-long-enough',
  }));
  assertEquals(requestResponse.status, 202);
  assertEquals(delivered, false);
  assertEquals(
    (await unknown(post('/v2/auth/otp/verify', {
      email: session.email,
      code: '123456',
    }))).status,
    401,
  );

  let revoked = false;
  const suspended = createAuthHandler(() =>
    dependencies({
      inspect: async () => {
        throw new ApiError(403, 'forbidden');
      },
      revoke: async () => {
        revoked = true;
      },
    })
  );
  const denied = await suspended(post('/v2/auth/otp/verify', {
    email: session.email,
    code: '123456',
  }));
  assertEquals(denied.status, 401);
  assertEquals(denied.headers.getSetCookie().length, 0);
  assertEquals(revoked, true);
});

Deno.test('OTP verification settles success, denial, and invalid-code timing paths', async () => {
  let settled = 0;
  const purposes: string[] = [];
  const authorize = async (
    _destinationType: 'email' | 'phone',
    _destination: string,
    _ipHash: string,
    _installationHash: string,
    _requestId: string,
    purpose: 'request' | 'verify',
  ) => {
    purposes.push(purpose);
    return { allowed: true, channelConfigured: true };
  };
  const settleOtpRequest = async () => {
    settled += 1;
  };
  const body = { email: session.email, code: '123456' };

  const success = createAuthHandler(() =>
    dependencies({ authorizeMemberOtp: authorize, settleOtpRequest })
  );
  assertEquals((await success(post('/v2/auth/otp/verify', body))).status, 200);

  const denied = createAuthHandler(() =>
    dependencies({
      authorizeMemberOtp: async (...args) => {
        purposes.push(args[5]);
        return { allowed: false, channelConfigured: true };
      },
      settleOtpRequest,
    })
  );
  assertEquals((await denied(post('/v2/auth/otp/verify', body))).status, 401);

  const invalid = createAuthHandler(() =>
    dependencies({
      authorizeMemberOtp: authorize,
      verifyOtp: async () => {
        throw new ApiError(401, 'unauthorized');
      },
      settleOtpRequest,
    })
  );
  assertEquals((await invalid(post('/v2/auth/otp/verify', body))).status, 401);
  assertEquals(settled, 3);
  assertEquals(purposes, ['verify', 'verify', 'verify']);
});

Deno.test('OTP session binding failure revokes the new session and never emits cookies', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      verifyOtp: async () => {
        calls.push('verify');
        return session;
      },
      bindSessionInstallation: async () => {
        calls.push('bind');
        throw new ApiError(503, 'dependency_unavailable');
      },
      revoke: async () => {
        calls.push('revoke');
      },
    })
  );
  const response = await handler(post('/v2/auth/otp/verify', {
    email: session.email,
    code: '123456',
  }));
  assertEquals(response.status, 401);
  assertEquals(response.headers.getSetCookie().length, 0);
  assertEquals(calls, ['verify', 'bind', 'revoke']);
});

Deno.test('OTP verification redeems the invite before setting protected session cookies', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      verifyOtp: async () => {
        calls.push('verify');
        return session;
      },
      bindSessionInstallation: async () => {
        calls.push('bind');
        return { sessionId: '00000000-0000-4000-8000-000000000020' };
      },
      redeemInvite: async () => {
        calls.push('redeem');
        return {
          organizationId: '00000000-0000-4000-8000-000000000001',
          role: 'member',
        };
      },
    })
  );
  const response = await handler(post('/v2/auth/otp/verify', {
    email: 'worker@example.com',
    invitationToken: 'a'.repeat(64),
    code: '123456',
  }, { 'CF-Connecting-IP': '203.0.113.7' }));
  assertEquals(response.status, 200);
  assertEquals(calls, ['verify', 'bind', 'redeem']);
  const body = await response.json();
  assertEquals(body.authenticated, true);
  assertEquals(body.sessionId, '00000000-0000-4000-8000-000000000020');
  assertEquals(body.aal, 'aal1');
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
  assert(
    cookies.some((value) =>
      value.startsWith('__Host-newone_refresh=') && value.includes('HttpOnly')
    ),
  );
  assert(
    cookies.some((value) => value.startsWith('__Host-newone_csrf=') && !value.includes('HttpOnly')),
  );
});

Deno.test('refresh rotates tokens and CSRF while sign-out revokes before clearing cookies', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      refresh: async (token) => {
        calls.push(`refresh:${token}`);
        return session;
      },
      bindSessionInstallation: async () => {
        calls.push('bind');
        return { sessionId: '00000000-0000-4000-8000-000000000020' };
      },
      revoke: async (token) => {
        calls.push(`revoke:${token}`);
      },
    })
  );
  const refresh = await handler(post('/v2/auth/session/refresh', { installationId }, {
    Cookie: '__Host-newone_refresh=old-refresh-token-that-is-long; __Host-newone_csrf=csrf-token',
    'X-CSRF-Token': 'csrf-token',
  }));
  assertEquals(refresh.status, 200);
  assertEquals(calls, ['refresh:old-refresh-token-that-is-long', 'bind']);
  const refreshBody = await refresh.json();
  assertEquals(refreshBody.sessionId, '00000000-0000-4000-8000-000000000020');
  assertEquals(refreshBody.aal, 'aal1');
  assertEquals(refresh.headers.getSetCookie().length, 3);

  const signOut = await handler(post('/v2/auth/sign-out', {}, {
    Cookie: '__Host-newone_access=access-token-that-is-long-enough; __Host-newone_csrf=csrf-token',
    'X-CSRF-Token': 'csrf-token',
  }));
  assertEquals(signOut.status, 200);
  assertEquals(calls, [
    'refresh:old-refresh-token-that-is-long',
    'bind',
    'revoke:access-token-that-is-long-enough',
  ]);
  assert(signOut.headers.getSetCookie().every((value) => value.includes('Max-Age=0')));
});

Deno.test('web account deletion tombstones before the Auth soft delete and clears cookies', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      identify: async () => {
        calls.push('identify');
        return {
          userId: session.userId,
          destinationType: session.destinationType,
          destination: session.destination,
          email: session.email,
          phone: session.phone,
          expiresAt: 9999999999,
        };
      },
      deleteAccount: async (userId, requestId) => {
        assert(typeof requestId === 'string' && requestId.length > 0);
        calls.push(`tombstone:${userId}`);
        return { userId, membershipsDeactivated: 2 };
      },
      softDeleteAuthUser: async (userId) => {
        calls.push(`soft-delete:${userId}`);
      },
      revoke: async (token) => {
        calls.push(`revoke:${token}`);
      },
    })
  );
  const response = await handler(post('/v2/auth/account/delete', {}, {
    Cookie: '__Host-newone_access=access-token-that-is-long-enough; __Host-newone_csrf=csrf-token',
    'X-CSRF-Token': 'csrf-token',
  }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { status: 'deleted' });
  assertEquals(calls, [
    'identify',
    `tombstone:${session.userId}`,
    `soft-delete:${session.userId}`,
    'revoke:access-token-that-is-long-enough',
  ]);
  const cookies = response.headers.getSetCookie();
  assertEquals(cookies.length, 3);
  assert(cookies.every((value) => value.includes('Max-Age=0')));
});

Deno.test('native bearer account deletion skips CSRF and tolerates revocation failure', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      deleteAccount: async (userId) => {
        calls.push('tombstone');
        return { userId, membershipsDeactivated: 1 };
      },
      softDeleteAuthUser: async () => {
        calls.push('soft-delete');
      },
      revoke: async () => {
        calls.push('revoke');
        throw new ApiError(503, 'dependency_unavailable');
      },
    })
  );
  const response = await handler(post('/v2/auth/account/delete', {}, {
    Authorization: 'Bearer access-token-that-is-long-enough',
  }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { status: 'deleted' });
  assertEquals(calls, ['tombstone', 'soft-delete', 'revoke']);
});

Deno.test('native origin-less bearer account deletion is accepted by the request-context guard', async () => {
  // The real native client sends apikey + bearer with no Origin and no
  // cookie. The account-delete route must clear requireAllowedRequestContext
  // exactly as native invitation redemption does, or deletion 403s on device.
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      deleteAccount: async (userId) => {
        calls.push('tombstone');
        return { userId, membershipsDeactivated: 1 };
      },
      softDeleteAuthUser: async () => {
        calls.push('soft-delete');
      },
    })
  );
  const request = new Request(
    'https://project.supabase.co/functions/v1/newone-auth/v2/auth/account/delete',
    {
      method: 'POST',
      headers: {
        apikey: 'publishable',
        'Content-Type': 'application/json',
        Authorization: 'Bearer access-token-that-is-long-enough',
      },
      body: JSON.stringify({}),
    },
  );
  const response = await handler(request);
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { status: 'deleted' });
  assert(calls.includes('tombstone') && calls.includes('soft-delete'));
});

Deno.test('origin-less account deletion without a bearer is refused by the context guard', async () => {
  const handler = createAuthHandler(() => dependencies({}));
  const request = new Request(
    'https://project.supabase.co/functions/v1/newone-auth/v2/auth/account/delete',
    {
      method: 'POST',
      headers: { apikey: 'publishable', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  const response = await handler(request);
  assertEquals(response.status, 403);
});

Deno.test('account deletion requires an authenticated session and an intact CSRF pair', async () => {
  let deleted = false;
  const handler = createAuthHandler(() =>
    dependencies({
      deleteAccount: async (userId) => {
        deleted = true;
        return { userId, membershipsDeactivated: 0 };
      },
    })
  );
  const unauthenticated = await handler(post('/v2/auth/account/delete', {}));
  assertEquals(unauthenticated.status, 401);
  const missingCsrf = await handler(post('/v2/auth/account/delete', {}, {
    Cookie: '__Host-newone_access=access-token-that-is-long-enough; __Host-newone_csrf=csrf-token',
  }));
  assertEquals(missingCsrf.status, 403);
  assertEquals(deleted, false);
});

Deno.test('a failed deletion tombstone never reaches the Auth soft delete', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      deleteAccount: async () => {
        calls.push('tombstone');
        throw new ApiError(503, 'dependency_unavailable');
      },
      softDeleteAuthUser: async () => {
        calls.push('soft-delete');
      },
      revoke: async () => {
        calls.push('revoke');
      },
    })
  );
  const response = await handler(post('/v2/auth/account/delete', {}, {
    Authorization: 'Bearer access-token-that-is-long-enough',
  }));
  assertEquals(response.status, 503);
  assertEquals(calls, ['tombstone']);
  assertEquals(response.headers.getSetCookie().length, 0);
});

Deno.test('web auth endpoints reject requests without an allowlisted browser origin', async () => {
  const handler = createAuthHandler(() => dependencies());
  const getResponse = await handler(
    new Request('https://app.newone.example/v2/auth/session', {
      headers: { Authorization: 'Bearer access-token-that-is-long-enough' },
    }),
  );
  assertEquals(getResponse.status, 403);
  const postResponse = await handler(
    new Request('https://app.newone.example/v2/auth/session', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token-that-is-long-enough',
        'Content-Type': 'application/json',
      },
      body: '{}',
    }),
  );
  assertEquals(postResponse.status, 403);
});

Deno.test('native OTP is preauthorized with CAPTCHA and installation rate binding', async () => {
  // Phone is the only channel whose CAPTCHA token travels to a delivery
  // dependency (requestOtp, into GoTrue) -- email OTP is gateway-owned mail
  // and never reaches it.
  const calls: Array<Record<string, unknown>> = [];
  const handler = createAuthHandler(() =>
    dependencies({
      phoneOtpEnabled: true,
      authorizeInviteOtp: async (
        token,
        destinationType,
        destination,
        employeeCode,
        _ipHash,
        installationHash,
        _requestId,
        purpose,
      ) => {
        calls.push({
          token,
          destinationType,
          destination,
          employeeCode,
          installationHash,
          purpose,
        });
        return { allowed: true, channelConfigured: true };
      },
      requestOtp: async (destinationType, destination, captcha) => {
        calls.push({ destinationType, destination, captcha });
      },
    })
  );
  const response = await handler(nativePost('/v2/auth/native/otp/request', {
    destinationType: 'phone',
    destination: '+12025550123',
    invitationToken: 'a'.repeat(64),
    employeeCode: 'EMP-1042',
    captchaToken: 'native-turnstile-token-long-enough',
  }));
  assertEquals(response.status, 202);
  assertEquals(await response.json(), {
    accepted: true,
    channel: { type: 'phone', configured: true },
  });
  assertEquals(calls[0]?.destinationType, 'phone');
  assertEquals(calls[0]?.employeeCode, 'EMP-1042');
  assertEquals(calls[0]?.purpose, 'request');
  assertEquals((calls[0]?.installationHash as string).length, 64);
  assertEquals(calls[1], {
    destinationType: 'phone',
    destination: '+12025550123',
    captcha: 'native-turnstile-token-long-enough',
  });

  const missingPublicKey = await handler(nativePost('/v2/auth/native/otp/request', {
    destinationType: 'email',
    destination: session.email,
    captchaToken: 'native-turnstile-token-long-enough',
  }, { apikey: 'wrong' }));
  assertEquals(missingPublicKey.status, 403);
});

Deno.test('native OTP verification returns a bounded session only after Newone authorization', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeMemberOtp: async (
        _destinationType,
        _destination,
        _ipHash,
        _installationHash,
        _requestId,
        purpose,
      ) => {
        assertEquals(purpose, 'verify');
        calls.push('authorize');
        return { allowed: true, channelConfigured: true };
      },
      verifyOtp: async () => {
        calls.push('verify');
        return session;
      },
      bindSessionInstallation: async () => {
        calls.push('bind');
        return { sessionId: '00000000-0000-4000-8000-000000000020' };
      },
      inspect: async () => {
        calls.push('inspect');
        return {
          userId: session.userId,
          destinationType: session.destinationType,
          destination: session.destination,
          email: session.email,
          phone: session.phone,
          sessionId: '00000000-0000-4000-8000-000000000020',
          expiresAt: 9999999999,
          issuedAt: Math.floor(Date.now() / 1000),
          aal: 'aal1',
          memberships,
        };
      },
    })
  );
  const response = await handler(nativePost('/v2/auth/native/otp/verify', {
    destinationType: 'email',
    destination: session.email,
    code: '123456',
  }));
  assertEquals(response.status, 200);
  assertEquals(calls, ['authorize', 'verify', 'bind', 'inspect']);
  assertEquals(response.headers.getSetCookie().length, 0);
  const body = await response.json();
  assertEquals(body.session, {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
  });
  assertEquals(body.memberships, memberships);
});

Deno.test('phone OTP exposes a generic configured-false state and never calls SMS while disabled', async () => {
  let delivered = false;
  const handler = createAuthHandler(() =>
    dependencies({
      phoneOtpEnabled: false,
      authorizeMemberOtp: async () => ({ allowed: true, channelConfigured: false }),
      requestOtp: async () => {
        delivered = true;
      },
    })
  );
  const response = await handler(nativePost('/v2/auth/native/otp/request', {
    destinationType: 'phone',
    destination: '+12025550123',
    captchaToken: 'native-turnstile-token-long-enough',
  }));
  assertEquals(response.status, 202);
  assertEquals(await response.json(), {
    accepted: true,
    channel: { type: 'phone', configured: false },
  });
  assertEquals(delivered, false);
});

Deno.test('Edge phone provider switch enables SMS independently of the database authorizer flag', async () => {
  let delivered = false;
  const handler = createAuthHandler(() =>
    dependencies({
      phoneOtpEnabled: true,
      // Database authorization is identity/rate-limit scoped and does not own
      // the runtime SMS provider switch.
      authorizeMemberOtp: async () => ({ allowed: true, channelConfigured: false }),
      requestOtp: async (destinationType, destination) => {
        assertEquals(destinationType, 'phone');
        assertEquals(destination, '+12025550123');
        delivered = true;
      },
    })
  );
  const response = await handler(nativePost('/v2/auth/native/otp/request', {
    destinationType: 'phone',
    destination: '+12025550123',
    captchaToken: 'native-turnstile-token-long-enough',
  }));
  assertEquals(response.status, 202);
  assertEquals(await response.json(), {
    accepted: true,
    channel: { type: 'phone', configured: true },
  });
  assertEquals(delivered, true);
});

Deno.test('native invite activation allows bearer context but revokes a mismatched principal', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      identify: async () => ({
        userId: session.userId,
        destinationType: session.destinationType,
        destination: session.destination,
        email: session.email,
        phone: session.phone,
        sessionId: '00000000-0000-4000-8000-000000000020',
        expiresAt: 9999999999,
      }),
      redeemInvite: async () => {
        calls.push('redeem');
        throw new ApiError(403, 'forbidden');
      },
      revoke: async () => {
        calls.push('revoke');
      },
    })
  );
  const response = await handler(
    new Request('https://api.newone.example/v2/auth/invitations/redeem', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer native-pkce-access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ invitationToken: 'a'.repeat(64) }),
    }),
  );
  assertEquals(response.status, 401);
  assertEquals(calls, ['redeem', 'revoke']);
});

Deno.test('session refresh rejects a suspended member and realtime token never exposes refresh credentials', async () => {
  const suspended = createAuthHandler(() =>
    dependencies({
      refresh: async () => {
        throw new ApiError(403, 'forbidden');
      },
    })
  );
  const denied = await suspended(post('/v2/auth/session/refresh', { installationId }, {
    Cookie: '__Host-newone_refresh=old-refresh-token-that-is-long; __Host-newone_csrf=csrf-token',
    'X-CSRF-Token': 'csrf-token',
  }));
  assertEquals(denied.status, 403);
  assertEquals(denied.headers.getSetCookie().length, 0);

  const handler = createAuthHandler(() => dependencies());
  const realtime = await handler(post('/v2/auth/realtime-token', {}, {
    Cookie: '__Host-newone_access=access-token-that-is-long-enough; __Host-newone_csrf=csrf-token',
    'X-CSRF-Token': 'csrf-token',
  }));
  assertEquals(realtime.status, 200);
  const body = await realtime.json();
  assertEquals(body.accessToken, 'access-token-that-is-long-enough');
  assertEquals(body.expiresAt, 9999999999);
  assert(!JSON.stringify(body).includes(session.refreshToken));
});

Deno.test('session identity returns only safe current session metadata', async () => {
  const handler = createAuthHandler(() => dependencies());
  const response = await handler(post('/v2/auth/session', {}, {
    Cookie: '__Host-newone_access=access-token-that-is-long-enough; __Host-newone_csrf=csrf-token',
    'X-CSRF-Token': 'csrf-token',
  }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.sessionId, '00000000-0000-4000-8000-000000000020');
  assertEquals(body.aal, 'aal1');
  const serialized = JSON.stringify(body);
  assert(!serialized.includes(session.accessToken));
  assert(!serialized.includes(session.refreshToken));
});

Deno.test('web TOTP enrollment exposes its secret once and verification rotates only cookies', async () => {
  const factorId = '00000000-0000-4000-8000-000000000090';
  const challengeId = '00000000-0000-4000-8000-000000000091';
  const aal2Session = {
    ...session,
    accessToken: 'aal2-access-token-that-is-long-enough',
    refreshToken: 'aal2-refresh-token-that-is-long-enough',
  };
  const handler = createAuthHandler(() =>
    dependencies({
      verifyMfa: async () => aal2Session,
      inspect: async (token) => ({
        userId: session.userId,
        destinationType: session.destinationType,
        destination: session.destination,
        email: session.email,
        phone: session.phone,
        sessionId: '00000000-0000-4000-8000-000000000020',
        expiresAt: 9999999999,
        issuedAt: Math.floor(Date.now() / 1000),
        aal: token === aal2Session.accessToken ? 'aal2' : 'aal1',
        memberships,
      }),
    })
  );
  const cookieHeaders = {
    Cookie:
      '__Host-newone_access=access-token-that-is-long-enough; __Host-newone_refresh=refresh-token-that-is-long-enough; __Host-newone_csrf=csrf-token',
    'X-CSRF-Token': 'csrf-token',
  };
  const enrollment = await handler(post('/v2/auth/mfa/enroll', {
    friendlyName: 'Work authenticator',
  }, cookieHeaders));
  assertEquals(enrollment.status, 201);
  const enrollmentBody = await enrollment.json();
  assertEquals(enrollmentBody.factor.id, factorId);
  assertEquals(enrollmentBody.factor.totp.secret, 'ABCDEFGHIJKLMNOP');

  const verified = await handler(post('/v2/auth/mfa/verify', {
    factorId,
    challengeId,
    code: '123456',
  }, cookieHeaders));
  assertEquals(verified.status, 200);
  const verifiedBody = await verified.json();
  assertEquals(verifiedBody.aal, 'aal2');
  assert(!JSON.stringify(verifiedBody).includes(aal2Session.accessToken));
  assert(!JSON.stringify(verifiedBody).includes(aal2Session.refreshToken));
  assertEquals(verified.headers.getSetCookie().length, 3);
});

Deno.test('account recovery OTP request is CAPTCHA protected, generic, and uses independent recovery buckets', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeRecoveryOtp: async (
        destinationType,
        destination,
        ipHash,
        installationHash,
        _requestId,
        purpose,
      ) => {
        calls.push({ destinationType, destination, ipHash, installationHash, purpose });
        return { allowed: false, channelConfigured: true };
      },
      requestOtp: async () => {
        throw new Error('ineligible recovery must not deliver');
      },
    })
  );
  const denied = await handler(post('/v2/auth/recovery/otp/request', {
    email: session.email,
    captchaToken: 'recovery-captcha-token-long-enough',
  }));
  assertEquals(denied.status, 202);
  assertEquals(await denied.json(), {
    accepted: true,
    channel: { type: 'email', configured: true },
  });
  assertEquals(calls[0]?.purpose, 'request');
  assertEquals((calls[0]?.ipHash as string).length, 64);
  assertEquals((calls[0]?.installationHash as string).length, 64);

  // An allowed recovery for an email destination delivers through the same
  // gateway-owned mail dependency as every other email OTP path, never
  // requestOtp -- the CAPTCHA gate above already ran before this point.
  let mailSent = 0;
  const allowed = createAuthHandler(() =>
    dependencies({
      authorizeRecoveryOtp: async () => ({ allowed: true, channelConfigured: true }),
      sendCodeEmail: async () => {
        mailSent += 1;
      },
    })
  );
  const accepted = await allowed(post('/v2/auth/recovery/otp/request', {
    email: session.email,
    captchaToken: 'recovery-captcha-token-long-enough',
  }));
  assertEquals(accepted.status, denied.status);
  assertEquals(await accepted.json(), {
    accepted: true,
    channel: { type: 'email', configured: true },
  });
  assertEquals(mailSent, 1);
});

Deno.test('account recovery verification binds first, revokes every other session, and preserves only the new session', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeRecoveryOtp: async (...args) => {
        calls.push(`authorize:${args[5]}`);
        return { allowed: true, channelConfigured: true };
      },
      verifyOtp: async () => {
        calls.push('verify');
        return session;
      },
      bindSessionInstallation: async () => {
        calls.push('bind');
        return { sessionId: '00000000-0000-4000-8000-000000000020' };
      },
      inspect: async () => {
        calls.push('inspect');
        return {
          userId: session.userId,
          destinationType: session.destinationType,
          destination: session.destination,
          email: session.email,
          phone: session.phone,
          sessionId: '00000000-0000-4000-8000-000000000020',
          expiresAt: 9999999999,
          issuedAt: Math.floor(Date.now() / 1000),
          aal: 'aal1',
          memberships,
        };
      },
      completeAccountRecovery: async () => {
        calls.push('complete-and-revoke-others');
        return {
          recovered: true,
          currentSessionId: '00000000-0000-4000-8000-000000000020',
          currentSessionPreserved: true,
          otherSessionsRevoked: 3,
          securityEventRecorded: true,
          securityNoticeState: 'pending_external_delivery',
        };
      },
    })
  );
  const malformed = await handler(post('/v2/auth/recovery/otp/verify', {
    email: session.email,
    code: 'bad',
  }));
  assertEquals(malformed.status, 401);
  assertEquals(calls, ['authorize:verify']);
  calls.length = 0;

  const response = await handler(post('/v2/auth/recovery/otp/verify', {
    email: session.email,
    code: '123456',
  }));
  assertEquals(response.status, 200);
  assertEquals(calls, [
    'authorize:verify',
    'verify',
    'bind',
    'inspect',
    'complete-and-revoke-others',
  ]);
  const body = await response.json();
  assertEquals(body.recovered, true);
  assertEquals(body.recovery, {
    currentSessionPreserved: true,
    otherSessionsRevoked: 3,
    securityEventRecorded: true,
    securityNoticeState: 'pending_external_delivery',
  });
  assertEquals(response.headers.getSetCookie().length, 3);
});

Deno.test('partial recovery completion fails closed by revoking the new session and emitting no credentials', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      completeAccountRecovery: async () => {
        calls.push('complete');
        throw new ApiError(503, 'dependency_unavailable');
      },
      revoke: async () => {
        calls.push('revoke-new-session');
      },
    })
  );
  const response = await handler(post('/v2/auth/recovery/otp/verify', {
    email: session.email,
    code: '123456',
  }));
  assertEquals(response.status, 401);
  assertEquals(response.headers.getSetCookie().length, 0);
  assertEquals(calls, ['complete', 'revoke-new-session']);
});

Deno.test('native account recovery uses the bound installation and returns credentials only after revocation completion', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeRecoveryOtp: async (...args) => {
        calls.push(`authorize:${args[5]}`);
        return { allowed: true, channelConfigured: true };
      },
      completeAccountRecovery: async () => {
        calls.push('complete');
        return {
          recovered: true,
          currentSessionId: '00000000-0000-4000-8000-000000000020',
          currentSessionPreserved: true,
          otherSessionsRevoked: 1,
          securityEventRecorded: true,
          securityNoticeState: 'pending_external_delivery',
        };
      },
    })
  );
  const response = await handler(nativePost('/v2/auth/native/recovery/otp/verify', {
    destinationType: 'email',
    destination: session.email,
    code: '123456',
  }));
  assertEquals(response.status, 200);
  assertEquals(calls, ['authorize:verify', 'complete']);
  assertEquals(response.headers.getSetCookie().length, 0);
  const body = await response.json();
  assertEquals(body.session.accessToken, session.accessToken);
  assertEquals(body.recovery.currentSessionPreserved, true);
});

Deno.test('lost-TOTP case creation requires a verified target factor and preserves idempotency metadata', async () => {
  const factorId = '00000000-0000-4000-8000-000000000090';
  const calls: Array<Record<string, unknown>> = [];
  const handler = createAuthHandler(() =>
    dependencies({
      listAdminMfaFactors: async () => ({
        factors: [{ id: factorId, factor_type: 'totp', status: 'verified' }],
      }),
      recoveryRpc: async (_token, name, args) => {
        calls.push({ name, ...args });
        return {
          case_id: '00000000-0000-4000-8000-000000000092',
          status: 'awaiting_external_verification',
          privileged_target: false,
          required_approvals: 1,
          approvals_recorded: 0,
        };
      },
    })
  );
  const response = await handler(post('/v2/auth/recovery/cases', {
    organizationId: memberships[0]!.organizationId,
    factorId,
    reason: 'I lost access to the company authenticator device.',
  }, {
    Cookie: '__Host-newone_access=access-token-that-is-long-enough; __Host-newone_csrf=csrf-token',
    'X-CSRF-Token': 'csrf-token',
    'Idempotency-Key': 'recovery-case-create-0001',
  }));
  assertEquals(response.status, 201);
  assertEquals(calls[0]?.name, 'bff_create_account_recovery_case');
  assertEquals(calls[0]?.p_factor_status, 'verified');
  assertEquals(calls[0]?.p_idempotency_key, 'recovery-case-create-0001');
  assertEquals((calls[0]?.p_request_sha256 as string).length, 64);

  const missing = createAuthHandler(() => dependencies());
  const denied = await missing(post('/v2/auth/recovery/cases', {
    organizationId: memberships[0]!.organizationId,
    factorId,
    reason: 'I lost access to the company authenticator device.',
  }, {
    Cookie: '__Host-newone_access=access-token-that-is-long-enough; __Host-newone_csrf=csrf-token',
    'X-CSRF-Token': 'csrf-token',
    'Idempotency-Key': 'recovery-case-create-0002',
  }));
  assertEquals(denied.status, 409);
});

Deno.test('helpdesk verification hashes external evidence and routes independent approval/rejection commands', async () => {
  const caseId = '00000000-0000-4000-8000-000000000092';
  const calls: Array<Record<string, unknown>> = [];
  const handler = createAuthHandler(() =>
    dependencies({
      recoveryRpc: async (_token, name, args) => {
        calls.push({ name, ...args });
        return { case_id: caseId, status: 'awaiting_approval' };
      },
    })
  );
  const headers = {
    Cookie: '__Host-newone_access=access-token-that-is-long-enough; __Host-newone_csrf=csrf-token',
    'X-CSRF-Token': 'csrf-token',
    'Idempotency-Key': 'recovery-review-command-0001',
  };
  const verified = await handler(post(`/v2/auth/recovery/cases/${caseId}/verify`, {
    organizationId: memberships[0]!.organizationId,
    method: 'manager_callback',
    evidenceReference: 'private-helpdesk-ticket-8742',
  }, headers));
  assertEquals(verified.status, 200);
  assertEquals(calls[0]?.name, 'bff_record_account_recovery_verification');
  assertEquals((calls[0]?.p_verification_reference_hash as string).length, 64);
  assert(!(calls[0]?.p_verification_reference_hash as string).includes('8742'));

  const approved = await handler(post(`/v2/auth/recovery/cases/${caseId}/approve`, {
    organizationId: memberships[0]!.organizationId,
  }, { ...headers, 'Idempotency-Key': 'recovery-review-command-0002' }));
  assertEquals(approved.status, 200);
  assertEquals(calls[1]?.name, 'bff_approve_account_recovery_case');

  const rejected = await handler(post(`/v2/auth/recovery/cases/${caseId}/reject`, {
    organizationId: memberships[0]!.organizationId,
    reason: 'External identity verification did not match.',
  }, { ...headers, 'Idempotency-Key': 'recovery-review-command-0003' }));
  assertEquals(rejected.status, 200);
  assertEquals(calls[2]?.name, 'bff_reject_account_recovery_case');
});

Deno.test('helpdesk execution deletes the exact verified factor before atomic finalization', async () => {
  const caseId = '00000000-0000-4000-8000-000000000092';
  const factorId = '00000000-0000-4000-8000-000000000090';
  const executionVersion = '00000000-0000-4000-8000-000000000093';
  const targetUserId = '00000000-0000-4000-8000-000000000094';
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      recoveryRpc: async (_token, name) => {
        calls.push(name);
        return {
          case_id: caseId,
          status: 'executing',
          target_user_id: targetUserId,
          factor_id: factorId,
          factor_type: 'totp',
          execution_version: executionVersion,
          resumed: false,
          factor_deletion_required: true,
          finalization_required: true,
        };
      },
      listAdminMfaFactors: async () => {
        calls.push('list-factor');
        return { factors: [{ id: factorId, factor_type: 'totp', status: 'verified' }] };
      },
      deleteAdminMfaFactor: async (userId, deletedFactorId) => {
        calls.push(`delete-factor:${userId}:${deletedFactorId}`);
      },
      recoveryServiceRpc: async (name, args) => {
        calls.push(name);
        assertEquals(args.p_execution_version, executionVersion);
        return {
          case_id: caseId,
          status: 'completed',
          completed: true,
          factor_deleted: true,
          all_sessions_revoked: true,
          security_notice_state: 'pending_external_delivery',
        };
      },
    })
  );
  const response = await handler(post(`/v2/auth/recovery/cases/${caseId}/execute`, {
    organizationId: memberships[0]!.organizationId,
  }, {
    Cookie: '__Host-newone_access=access-token-that-is-long-enough; __Host-newone_csrf=csrf-token',
    'X-CSRF-Token': 'csrf-token',
    'Idempotency-Key': 'recovery-execute-command-0001',
  }));
  assertEquals(response.status, 200);
  assertEquals(calls, [
    'bff_prepare_account_recovery_execution',
    'list-factor',
    `delete-factor:${targetUserId}:${factorId}`,
    'bff_finalize_account_recovery_execution',
  ]);
});

Deno.test('ambiguous factor deletion stays executing for safe retry; resumed absence finalizes without a second delete', async () => {
  const caseId = '00000000-0000-4000-8000-000000000092';
  const factorId = '00000000-0000-4000-8000-000000000090';
  const executionVersion = '00000000-0000-4000-8000-000000000093';
  const targetUserId = '00000000-0000-4000-8000-000000000094';
  const prepared = {
    case_id: caseId,
    status: 'executing',
    target_user_id: targetUserId,
    factor_id: factorId,
    factor_type: 'totp',
    execution_version: executionVersion,
    resumed: false,
    factor_deletion_required: true,
    finalization_required: true,
  };
  let finalized = false;
  let cancelled = false;
  const uncertain = createAuthHandler(() =>
    dependencies({
      recoveryRpc: async () => prepared,
      listAdminMfaFactors: async () => ({
        factors: [{ id: factorId, factor_type: 'totp', status: 'verified' }],
      }),
      deleteAdminMfaFactor: async () => {
        throw new ApiError(503, 'dependency_unavailable');
      },
      recoveryServiceRpc: async (name) => {
        finalized ||= name === 'bff_finalize_account_recovery_execution';
        cancelled ||= name === 'bff_cancel_account_recovery_execution';
        return {};
      },
    })
  );
  const headers = {
    Cookie: '__Host-newone_access=access-token-that-is-long-enough; __Host-newone_csrf=csrf-token',
    'X-CSRF-Token': 'csrf-token',
    'Idempotency-Key': 'recovery-execute-command-0002',
  };
  const failed = await uncertain(post(`/v2/auth/recovery/cases/${caseId}/execute`, {
    organizationId: memberships[0]!.organizationId,
  }, headers));
  assertEquals(failed.status, 503);
  assertEquals(finalized, false);
  assertEquals(cancelled, false);

  let deleteCalled = false;
  const resumed = createAuthHandler(() =>
    dependencies({
      recoveryRpc: async () => ({ ...prepared, resumed: true }),
      listAdminMfaFactors: async () => ({ factors: [] }),
      deleteAdminMfaFactor: async () => {
        deleteCalled = true;
      },
      recoveryServiceRpc: async (name) => {
        assertEquals(name, 'bff_finalize_account_recovery_execution');
        return {
          case_id: caseId,
          status: 'completed',
          completed: true,
          all_sessions_revoked: true,
          security_notice_state: 'pending_external_delivery',
        };
      },
    })
  );
  const recovered = await resumed(post(`/v2/auth/recovery/cases/${caseId}/execute`, {
    organizationId: memberships[0]!.organizationId,
  }, { ...headers, 'Idempotency-Key': 'recovery-execute-command-0003' }));
  assertEquals(recovered.status, 200);
  assertEquals(deleteCalled, false);
});

Deno.test('a direct-mode browser may use the native token routes only from an allow-listed Origin and only as web', async () => {
  const handler = createAuthHandler(() => dependencies());
  const browserVerify = (platform: string, headers: HeadersInit = {}) =>
    new Request('https://project.supabase.co/functions/v1/newone-auth/v2/auth/native/otp/verify', {
      method: 'POST',
      headers: {
        apikey: 'publishable',
        'Content-Type': 'application/json',
        Origin: 'https://app.newone.example',
        'X-Newone-Client-Platform': platform,
        'X-Newone-Installation-Id': installationId,
        ...headers,
      },
      body: JSON.stringify({
        installationId,
        destinationType: 'email',
        destination: session.email,
        code: '123456',
      }),
    });

  // Allow-listed Origin, honest platform: tokens come back in the body, never as cookies.
  const accepted = await handler(browserVerify('web'));
  assertEquals(accepted.status, 200);
  assertEquals(accepted.headers.get('access-control-allow-origin'), 'https://app.newone.example');
  assertEquals(accepted.headers.getSetCookie().length, 0);
  const body = await accepted.json();
  assertEquals(body.session, {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
  });
  assertEquals(body.memberships, memberships);

  // A browser may not claim to be a native app.
  const impersonating = await handler(browserVerify('ios'));
  assertEquals(impersonating.status, 400);
  assertEquals((await impersonating.json()).error.code, 'bad_request');

  // Without an Origin the native routes stay native-only.
  const originless = await handler(nativePost('/v2/auth/native/otp/verify', {
    destinationType: 'email',
    destination: session.email,
    code: '123456',
  }, { 'X-Newone-Client-Platform': 'web' }));
  assertEquals(originless.status, 403);
  assertEquals((await originless.json()).error.code, 'origin_not_allowed');

  // A foreign Origin is refused before any OTP work happens.
  const foreign = await handler(browserVerify('web', { Origin: 'https://evil.example' }));
  assertEquals(foreign.status, 403);
  assertEquals((await foreign.json()).error.code, 'origin_not_allowed');
});

Deno.test('a direct-mode browser binds its recovery session installation as web', async () => {
  const platforms: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      bindSessionInstallation: async (_token, installation) => {
        platforms.push(installation.platform);
        return { sessionId: '00000000-0000-4000-8000-000000000020' };
      },
    })
  );
  const response = await handler(
    new Request('https://project.supabase.co/functions/v1/newone-auth/v2/auth/native/recovery/otp/verify', {
      method: 'POST',
      headers: {
        apikey: 'publishable',
        'Content-Type': 'application/json',
        Origin: 'https://app.newone.example',
        'X-Newone-Client-Platform': 'web',
        'X-Newone-Installation-Id': installationId,
      },
      body: JSON.stringify({
        installationId,
        destinationType: 'email',
        destination: session.email,
        code: '123456',
      }),
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.getSetCookie().length, 0);
  const body = await response.json();
  assertEquals(body.session.accessToken, session.accessToken);
  assertEquals(body.recovery.currentSessionPreserved, true);
  assertEquals(platforms, ['web']);
});
