import type { RuntimeConfig } from '../_shared/http.ts';
import { ApiError } from '../_shared/errors.ts';
import { type AuthDependencies, createAuthHandler } from '../newone-auth/handler.ts';
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
  destination: 'member@example.com',
  email: 'member@example.com',
  phone: null,
  hasPassword: true,
};

const sessionId = '00000000-0000-4000-8000-000000000020';
const installationId = '00000000-0000-4000-8000-000000000099';
const memberships = [{
  organizationId: '00000000-0000-4000-8000-000000000001',
  role: 'member' as const,
}];

function activeSession() {
  return {
    userId: session.userId,
    destinationType: session.destinationType,
    destination: session.destination,
    email: session.email,
    phone: session.phone,
    hasPassword: true,
    sessionId,
    expiresAt: 9999999999,
    issuedAt: Math.floor(Date.now() / 1000),
    aal: 'aal1' as const,
    memberships,
  };
}

function dependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey: 'secret',
    },
    recoveryEvidenceHashKey: 'r'.repeat(32),
    captchaMode: 'web',
    phoneOtpEnabled: false,
    reviewAccount: null,
    settleOtpRequest: async () => {},
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
      organizationId: memberships[0]!.organizationId,
      username: 'member',
      displayName: 'Member',
      preferredLanguage: 'en',
    }),
    completeSignupUser: async () => {},
    authorizeRecoveryOtp: async () => ({ allowed: true, channelConfigured: true }),
    requestOtp: async () => {},
    generateEmailOtp: async () => '654321',
    sendCodeEmail: async () => {},
    verifyOtp: async () => {
      throw new Error('the password grant must never verify a code');
    },
    generateReviewOtp: async () => {
      throw new Error('review OTP must not be generated');
    },
    signInWithPassword: async () => session,
    lookupPasswordState: async () => ({ hasPassword: true }),
    setPassword: async () => {},
    refresh: async () => session,
    bindSessionInstallation: async () => ({ sessionId }),
    completeAccountRecovery: async () => {
      throw new Error('not used');
    },
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
    inspect: async () => activeSession(),
    listMfa: async () => ({ all: [] }),
    enrollMfa: async () => ({}),
    challengeMfa: async () => ({}),
    verifyMfa: async () => session,
    unenrollMfa: async () => {},
    ...overrides,
  };
}

function webPost(path: string, body: unknown, headers: HeadersInit = {}): Request {
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

function nativePost(path: string, body: Record<string, unknown>, headers: HeadersInit = {}): Request {
  return new Request(`https://project.supabase.co/functions/v1/newone-auth${path}`, {
    method: 'POST',
    headers: {
      apikey: 'publishable',
      'Content-Type': 'application/json',
      'X-Newone-Client-Platform': 'ios',
      'X-Newone-Installation-Id': installationId,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function nativeBearerPost(path: string, body: unknown, headers: HeadersInit = {}): Request {
  // The real native client: apikey + bearer, no Origin, no cookie.
  return new Request(`https://project.supabase.co/functions/v1/newone-auth${path}`, {
    method: 'POST',
    headers: {
      apikey: 'publishable',
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
      'X-Newone-Client-Platform': 'ios',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const passwordBody = {
  destinationType: 'email',
  destination: session.email,
  password: 'correct horse battery',
  installationId,
};

Deno.test('native password sign-in runs member authorization, the password grant, binding, and inspection in order', async () => {
  const calls: Array<string | Record<string, unknown>> = [];
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeMemberOtp: async (
        destinationType,
        destination,
        ipHash,
        installationHash,
        _requestId,
        purpose,
      ) => {
        calls.push({ step: 'authorize', destinationType, destination, purpose });
        assertEquals(ipHash.length, 64);
        assertEquals(installationHash.length, 64);
        return { allowed: true, channelConfigured: true };
      },
      signInWithPassword: async (destinationType, destination, password) => {
        calls.push({ step: 'password', destinationType, destination, password });
        return session;
      },
      bindSessionInstallation: async (accessToken, installation) => {
        calls.push({ step: 'bind', accessToken, platform: installation.platform });
        return { sessionId };
      },
      inspect: async () => {
        calls.push('inspect');
        return activeSession();
      },
    })
  );
  const response = await handler(nativePost('/v2/auth/native/password/verify', {
    ...passwordBody,
    appVersion: '3.0.0',
    locale: 'es-MX',
  }));
  assertEquals(response.status, 200);
  assertEquals(calls, [
    { step: 'authorize', destinationType: 'email', destination: session.email, purpose: 'verify' },
    {
      step: 'password',
      destinationType: 'email',
      destination: session.email,
      password: 'correct horse battery',
    },
    { step: 'bind', accessToken: session.accessToken, platform: 'ios' },
    'inspect',
  ]);
  assertEquals(response.headers.getSetCookie().length, 0);
  const body = await response.json();
  assertEquals(body.authenticated, true);
  assertEquals(body.session, {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
  });
  assertEquals(body.user, {
    id: session.userId,
    destinationType: 'email',
    email: session.email,
    phone: null,
    hasPassword: true,
  });
  assertEquals(body.memberships, memberships);
  assertEquals(body.sessionId, sessionId);
});

Deno.test('web password sign-in sets the protected cookie triple and exposes hasPassword from the identity', async () => {
  const handler = createAuthHandler(() =>
    dependencies({
      inspect: async () => ({ ...activeSession(), hasPassword: undefined }),
    })
  );
  const response = await handler(webPost('/v2/auth/password/verify', passwordBody));
  assertEquals(response.status, 200);
  assertEquals(response.headers.getSetCookie().length, 3);
  const body = await response.json();
  assertEquals(body.csrfToken.length > 20, true);
  assertEquals(body.session, undefined);
  assertEquals(body.user.hasPassword, false);
});

Deno.test('a wrong password, a short password, and a denied authorization all collapse into the same 401', async () => {
  let grants = 0;
  let authorizations = 0;
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeMemberOtp: async (destinationType) => {
        authorizations += 1;
        return { allowed: destinationType !== 'phone', channelConfigured: true };
      },
      signInWithPassword: async () => {
        grants += 1;
        throw new ApiError(401, 'unauthorized');
      },
    })
  );

  const wrong = await handler(nativePost('/v2/auth/native/password/verify', passwordBody));
  assertEquals(wrong.status, 401);
  assertEquals((await wrong.json()).error.code, 'unauthorized');
  assertEquals(grants, 1);

  const short = await handler(nativePost('/v2/auth/native/password/verify', {
    ...passwordBody,
    password: 'short',
  }));
  assertEquals(short.status, 401);
  assertEquals((await short.json()).error.code, 'unauthorized');
  assertEquals(grants, 1, 'a short password never reaches GoTrue');

  const denied = await handler(nativePost('/v2/auth/native/password/verify', {
    destinationType: 'phone',
    destination: '+12025550123',
    password: 'correct horse battery',
    installationId,
  }));
  assertEquals(denied.status, 401);
  assertEquals(grants, 1, 'a denied authorization never reaches GoTrue');
  assertEquals(authorizations, 2, 'a short password is refused before any authorization');
});

Deno.test('password sign-in rejects invitation fields, oversized passwords, and a mismatched installation', async () => {
  const handler = createAuthHandler(() => dependencies());
  const invite = await handler(nativePost('/v2/auth/native/password/verify', {
    ...passwordBody,
    invitationToken: 'a'.repeat(64),
  }));
  assertEquals(invite.status, 400);

  const oversized = await handler(nativePost('/v2/auth/native/password/verify', {
    ...passwordBody,
    password: 'p'.repeat(129),
  }));
  assertEquals(oversized.status, 400);

  const mismatch = await handler(nativePost('/v2/auth/native/password/verify', {
    ...passwordBody,
    installationId: '00000000-0000-4000-8000-000000000011',
  }));
  assertEquals(mismatch.status, 400);

  const missingKey = await handler(nativePost('/v2/auth/native/password/verify', passwordBody, {
    apikey: 'wrong',
  }));
  assertEquals(missingKey.status, 403);
});

Deno.test('a password grant whose session belongs to another destination is revoked and refused', async () => {
  const revoked: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      signInWithPassword: async () => ({
        ...session,
        email: 'someone-else@example.com',
        destination: 'someone-else@example.com',
      }),
      revoke: async (token) => {
        revoked.push(token);
      },
    })
  );
  const response = await handler(nativePost('/v2/auth/native/password/verify', passwordBody));
  assertEquals(response.status, 401);
  assertEquals(revoked, [session.accessToken]);
});

Deno.test('a binding failure after the password grant revokes the new session and emits no credentials', async () => {
  const revoked: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      bindSessionInstallation: async () => {
        throw new ApiError(503, 'dependency_unavailable');
      },
      revoke: async (token) => {
        revoked.push(token);
      },
    })
  );
  const response = await handler(webPost('/v2/auth/password/verify', passwordBody));
  assertEquals(response.status, 401);
  assertEquals(response.headers.getSetCookie().length, 0);
  assertEquals(revoked, [session.accessToken]);
});

Deno.test('native bearer password set inspects the live session and updates exactly that user', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const handler = createAuthHandler(() =>
    dependencies({
      inspect: async (accessToken) => {
        calls.push({ step: 'inspect', accessToken });
        return activeSession();
      },
      setPassword: async (accessToken, userId, password) => {
        calls.push({ step: 'set', accessToken, userId, password });
      },
    })
  );
  const response = await handler(nativeBearerPost('/v2/auth/password/set', {
    password: 'brand new password',
  }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { passwordSet: true });
  assertEquals(calls, [
    { step: 'inspect', accessToken: session.accessToken },
    // The write goes through the member's own token so their session survives.
    { step: 'set', accessToken: session.accessToken, userId: session.userId, password: 'brand new password' },
  ]);
  assertEquals(response.headers.getSetCookie().length, 0);
});

Deno.test('password set names the only rule, refuses extra keys, and never runs without a live session', async () => {
  let sets = 0;
  const handler = createAuthHandler(() =>
    dependencies({
      setPassword: async () => {
        sets += 1;
      },
    })
  );
  const short = await handler(nativeBearerPost('/v2/auth/password/set', { password: 'seven77' }));
  assertEquals(short.status, 400);
  assertEquals((await short.json()).error.code, 'weak_password');

  const extra = await handler(nativeBearerPost('/v2/auth/password/set', {
    password: 'brand new password',
    email: 'other@example.com',
  }));
  assertEquals(extra.status, 400);

  const anonymous = await handler(nativePost('/v2/auth/password/set', {
    password: 'brand new password',
  }));
  assertEquals(anonymous.status, 403, 'origin-less requests need a bearer');
  assertEquals(sets, 0);
});

Deno.test('web password set requires the CSRF pair, refuses sessions without membership, and maps a weak GoTrue verdict', async () => {
  let sets = 0;
  const handler = createAuthHandler(() =>
    dependencies({
      setPassword: async () => {
        sets += 1;
        throw new ApiError(400, 'weak_password');
      },
    })
  );
  const cookies = `__Host-newone_access=${session.accessToken}; __Host-newone_csrf=csrf-token`;
  const noCsrf = await handler(webPost('/v2/auth/password/set', { password: 'brand new password' }, {
    Cookie: cookies,
  }));
  assertEquals(noCsrf.status, 403);
  assertEquals(sets, 0);

  const weak = await handler(webPost('/v2/auth/password/set', { password: 'brand new password' }, {
    Cookie: cookies,
    'X-CSRF-Token': 'csrf-token',
  }));
  assertEquals(weak.status, 400);
  assertEquals((await weak.json()).error.code, 'weak_password');
  assertEquals(sets, 1);

  const noMembership = createAuthHandler(() =>
    dependencies({
      inspect: async () => ({ ...activeSession(), memberships: [] }),
      setPassword: async () => {
        throw new Error('must not run');
      },
    })
  );
  const refused = await noMembership(webPost('/v2/auth/password/set', {
    password: 'brand new password',
  }, { Cookie: cookies, 'X-CSRF-Token': 'csrf-token' }));
  assertEquals(refused.status, 401);
  assert(refused.headers.getSetCookie().length === 0);
});
