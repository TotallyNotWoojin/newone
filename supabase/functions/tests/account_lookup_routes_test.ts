// v3.2 returning sign-in: the account lookup that starts every sign-in, and
// the forgot-password chain (recovery code → set password) that must leave
// the recovering session alive (defect AF).
import type { RuntimeConfig } from '../_shared/http.ts';
import { ApiError } from '../_shared/errors.ts';
import { type AuthDependencies, createAuthHandler } from '../newone-auth/handler.ts';
import { assertEquals } from './assert.ts';

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
  accessToken: 'recovery-access-token-that-is-long-enough',
  refreshToken: 'recovery-refresh-token-that-is-long-enough',
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
    authorizeInviteOtp: async () => ({ allowed: true, channelConfigured: true }),
    authorizeMemberOtp: async () => ({ allowed: true, channelConfigured: true, retryAfterSeconds: 0 }),
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
    verifyOtp: async () => session,
    generateReviewOtp: async () => {
      throw new Error('review OTP must not be generated');
    },
    signInWithPassword: async () => session,
    lookupPasswordState: async () => ({ hasPassword: true }),
    setPassword: async () => {},
    redeemInvite: async () => {
      throw new Error('never redeems an invite');
    },
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
    recoveryRpc: async () => ({}),
    recoveryServiceRpc: async () => ({}),
    listAdminMfaFactors: async () => ({ factors: [] }),
    deleteAdminMfaFactor: async () => {},
    deleteAccount: async () => ({ userId: session.userId, membershipsDeactivated: 1 }),
    softDeleteAuthUser: async () => {},
    revoke: async () => {
      throw new Error('nothing in this flow may revoke a session');
    },
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

function nativeBearerPost(path: string, body: unknown, accessToken: string): Request {
  return new Request(`https://project.supabase.co/functions/v1/newone-auth${path}`, {
    method: 'POST',
    headers: {
      apikey: 'publishable',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Newone-Client-Platform': 'ios',
    },
    body: JSON.stringify(body),
  });
}

const lookupBody = {
  destinationType: 'email',
  destination: session.email,
  installationId,
};

Deno.test('native account lookup runs the member OTP request authorization, then reads the password state', async () => {
  const calls: Array<Record<string, unknown>> = [];
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
        return { allowed: true, channelConfigured: true, retryAfterSeconds: 0 };
      },
      lookupPasswordState: async (destination) => {
        calls.push({ step: 'password-state', destination });
        return { hasPassword: true };
      },
    })
  );
  const response = await handler(nativePost('/v2/auth/native/account/lookup', {
    ...lookupBody,
    appVersion: '3.2.0',
    locale: 'ko-KR',
  }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { exists: true, hasPassword: true });
  assertEquals(calls, [
    // The request purpose: the same buckets and limits a code request consumes.
    { step: 'authorize', destinationType: 'email', destination: session.email, purpose: 'request' },
    { step: 'password-state', destination: session.email },
  ]);
  assertEquals(response.headers.getSetCookie().length, 0);
});

Deno.test('an unknown address answers exists:false without touching the password state', async () => {
  let stateReads = 0;
  const handler = createAuthHandler(() =>
    dependencies({
      // The authorizer's "not a member" refusal: a short retry hint.
      authorizeMemberOtp: async () => ({ allowed: false, channelConfigured: true, retryAfterSeconds: 60 }),
      lookupPasswordState: async () => {
        stateReads += 1;
        return { hasPassword: true };
      },
    })
  );
  const response = await handler(nativePost('/v2/auth/native/account/lookup', lookupBody));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { exists: false, hasPassword: false });
  assertEquals(stateReads, 0);

  // A fake authorizer without the hint still reads as unknown, never as a rate limit.
  const bare = createAuthHandler(() =>
    dependencies({ authorizeMemberOtp: async () => ({ allowed: false, channelConfigured: true }) })
  );
  const bareResponse = await bare(nativePost('/v2/auth/native/account/lookup', lookupBody));
  assertEquals(bareResponse.status, 200);
  assertEquals(await bareResponse.json(), { exists: false, hasPassword: false });
});

Deno.test('an exhausted OTP request bucket answers 429 rate_limited with the authorizer window, not "no account"', async () => {
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeMemberOtp: async () => ({ allowed: false, channelConfigured: true, retryAfterSeconds: 900 }),
    })
  );
  const response = await handler(nativePost('/v2/auth/native/account/lookup', lookupBody));
  assertEquals(response.status, 429);
  assertEquals(response.headers.get('Retry-After'), '900');
  const body = await response.json();
  assertEquals(body.error.code, 'rate_limited');
  assertEquals(body.error.retryAfterSeconds, 900);
});

Deno.test('hasPassword follows the password stamp, and a listing miss assumes a password', async () => {
  const noStamp = createAuthHandler(() =>
    dependencies({ lookupPasswordState: async () => ({ hasPassword: false }) })
  );
  const noStampResponse = await noStamp(nativePost('/v2/auth/native/account/lookup', lookupBody));
  assertEquals(await noStampResponse.json(), { exists: true, hasPassword: false });

  const miss = createAuthHandler(() => dependencies({ lookupPasswordState: async () => null }));
  const missResponse = await miss(nativePost('/v2/auth/native/account/lookup', lookupBody));
  assertEquals(await missResponse.json(), { exists: true, hasPassword: true });

  const outage = createAuthHandler(() =>
    dependencies({
      lookupPasswordState: async () => {
        throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      },
    })
  );
  const outageResponse = await outage(nativePost('/v2/auth/native/account/lookup', lookupBody));
  assertEquals(outageResponse.status, 503);
  assertEquals((await outageResponse.json()).error.code, 'dependency_unavailable');
});

Deno.test('lookup is email-only and keeps the native OTP request rules: installation match, CAPTCHA mode, apikey, exact keys', async () => {
  let authorizations = 0;
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeMemberOtp: async () => {
        authorizations += 1;
        return { allowed: true, channelConfigured: true, retryAfterSeconds: 0 };
      },
    })
  );

  const phone = await handler(nativePost('/v2/auth/native/account/lookup', {
    destinationType: 'phone',
    destination: '+12025550123',
    installationId,
  }));
  assertEquals(phone.status, 400, 'phone paths stay inert');

  const mismatch = await handler(nativePost('/v2/auth/native/account/lookup', {
    ...lookupBody,
    installationId: '00000000-0000-4000-8000-000000000011',
  }));
  assertEquals(mismatch.status, 400);

  const invite = await handler(nativePost('/v2/auth/native/account/lookup', {
    ...lookupBody,
    invitationToken: 'a'.repeat(64),
  }));
  assertEquals(invite.status, 400, 'invitation keys are not part of the lookup');

  const extra = await handler(nativePost('/v2/auth/native/account/lookup', {
    ...lookupBody,
    password: 'never here',
  }));
  assertEquals(extra.status, 400);

  const wrongKey = await handler(nativePost('/v2/auth/native/account/lookup', lookupBody, {
    apikey: 'wrong',
  }));
  assertEquals(wrongKey.status, 403);

  const noOrigin = await handler(
    new Request('https://project.supabase.co/functions/v1/newone-auth/v2/auth/account/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lookupBody),
    }),
  );
  assertEquals(noOrigin.status, 403, 'the web variant needs an allow-listed Origin');
  assertEquals(authorizations, 0, 'every refusal above happens before any authorization');

  // captchaMode 'web': the browser path must carry a token, native is exempt.
  const webWithoutToken = await handler(webPost('/v2/auth/account/lookup', lookupBody));
  assertEquals(webWithoutToken.status, 400);
  const webWithToken = await handler(webPost('/v2/auth/account/lookup', {
    ...lookupBody,
    captchaToken: 'controlled-captcha-token-value',
  }));
  assertEquals(webWithToken.status, 200);
  assertEquals(await webWithToken.json(), { exists: true, hasPassword: true });
  assertEquals(webWithToken.headers.getSetCookie().length, 0, 'a lookup never issues a session');
  const nativeWithoutToken = await handler(nativePost('/v2/auth/native/account/lookup', lookupBody));
  assertEquals(nativeWithoutToken.status, 200);
  assertEquals(authorizations, 2);

  const strict = createAuthHandler(() => dependencies({ captchaMode: 'all' }));
  const strictNative = await strict(nativePost('/v2/auth/native/account/lookup', lookupBody));
  assertEquals(strictNative.status, 400, "'all' still requires a token on the native path");
});

Deno.test('forgot password: the recovery code signs in, the password is set through that session, and the session stays valid', async () => {
  const calls: Array<string | Record<string, unknown>> = [];
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeRecoveryOtp: async (...args) => {
        calls.push(`recovery-authorize:${args[5]}`);
        return { allowed: true, channelConfigured: true };
      },
      generateEmailOtp: async () => {
        calls.push('mint-code');
        return '654321';
      },
      sendCodeEmail: async () => {
        calls.push('send-code');
      },
      verifyOtp: async (_type, _destination, code) => {
        calls.push({ step: 'verify', code });
        return session;
      },
      completeAccountRecovery: async () => {
        calls.push('complete-recovery');
        return {
          recovered: true,
          currentSessionId: sessionId,
          currentSessionPreserved: true,
          otherSessionsRevoked: 2,
          securityEventRecorded: true,
          securityNoticeState: 'pending_external_delivery',
        };
      },
      setPassword: async (accessToken, userId, password) => {
        calls.push({ step: 'set-password', accessToken, userId, password });
      },
      inspect: async (accessToken) => {
        calls.push({ step: 'inspect', accessToken });
        return activeSession();
      },
    })
  );

  const requested = await handler(nativePost('/v2/auth/native/recovery/otp/request', lookupBody));
  assertEquals(requested.status, 202);

  const verified = await handler(nativePost('/v2/auth/native/recovery/otp/verify', {
    ...lookupBody,
    code: '654321',
  }));
  assertEquals(verified.status, 200);
  const recovered = await verified.json();
  assertEquals(recovered.recovery.currentSessionPreserved, true);
  const accessToken = recovered.session.accessToken as string;
  assertEquals(accessToken, session.accessToken);

  const set = await handler(nativeBearerPost('/v2/auth/password/set', {
    password: 'brand new password',
  }, accessToken));
  assertEquals(set.status, 200);
  assertEquals(await set.json(), { passwordSet: true });

  // The same bearer keeps working after the write: the session was preserved.
  // (Native bearers are accepted on the password route, not the cookie-only
  // /v2/auth/session; the hosted smoke proves liveness the same way.)
  const alive = await handler(nativeBearerPost('/v2/auth/password/set', {
    password: 'brand new password',
  }, accessToken));
  assertEquals(alive.status, 200);

  assertEquals(calls, [
    'recovery-authorize:request',
    'mint-code',
    'send-code',
    'recovery-authorize:verify',
    { step: 'verify', code: '654321' },
    { step: 'inspect', accessToken: session.accessToken },
    'complete-recovery',
    { step: 'inspect', accessToken: session.accessToken },
    // The write goes through the recovering member's own token (defect AF),
    // never an admin update that would revoke the session it just created.
    { step: 'set-password', accessToken: session.accessToken, userId: session.userId, password: 'brand new password' },
    { step: 'inspect', accessToken: session.accessToken },
    { step: 'set-password', accessToken: session.accessToken, userId: session.userId, password: 'brand new password' },
  ]);
});

Deno.test('a weak new password after recovery is refused by name and leaves the recovery session untouched', async () => {
  let sets = 0;
  const handler = createAuthHandler(() =>
    dependencies({
      setPassword: async () => {
        sets += 1;
      },
    })
  );
  const verified = await handler(nativePost('/v2/auth/native/recovery/otp/verify', {
    ...lookupBody,
    code: '654321',
  }));
  assertEquals(verified.status, 200);
  const accessToken = (await verified.json()).session.accessToken as string;

  const short = await handler(nativeBearerPost('/v2/auth/password/set', { password: 'seven77' }, accessToken));
  assertEquals(short.status, 400);
  assertEquals((await short.json()).error.code, 'weak_password');
  assertEquals(sets, 0);

  // The recovery session is still accepted for a second, valid attempt.
  const retry = await handler(nativeBearerPost('/v2/auth/password/set', {
    password: 'long enough now',
  }, accessToken));
  assertEquals(retry.status, 200);
  assertEquals(sets, 1);
});
