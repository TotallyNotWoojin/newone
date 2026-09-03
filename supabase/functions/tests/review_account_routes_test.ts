import { safeEqual } from '../_shared/crypto.ts';
import { ApiError } from '../_shared/errors.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import {
  type AuthDependencies,
  createAuthHandler,
  defaultAuthDependencies,
  isReviewCredential,
  type ReviewAccountConfig,
} from '../newone-auth/handler.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const runtimeConfig: RuntimeConfig = {
  allowedOrigins: new Set(['https://app.newone.example']),
  accessCookieName: '__Host-newone_access',
  refreshCookieName: '__Host-newone_refresh',
  csrfCookieName: '__Host-newone_csrf',
  maxJsonBytes: 65536,
  networkHashKey: 'n'.repeat(32),
  allowHttpLocal: false,
};

const reviewEmail = 'appreview@newone.example';
const reviewCode = 'Review-Static-Code-2026';
const reviewAccount: ReviewAccountConfig = { email: reviewEmail, code: reviewCode };

const installationId = '00000000-0000-4000-8000-000000000099';
const sessionId = '00000000-0000-4000-8000-000000000020';

const session = {
  accessToken: 'review-access-token-that-is-long-enough',
  refreshToken: 'review-refresh-token-that-is-long-enough',
  expiresIn: 3600,
  userId: '00000000-0000-4000-8000-000000000010',
  destinationType: 'email' as const,
  destination: reviewEmail,
  email: reviewEmail,
  phone: null,
};

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
    captchaMode: 'all',
    phoneOtpEnabled: false,
    reviewAccount,
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
    requestOtp: async (destinationType) => {
      // GoTrue signInWithOtp is an SMS-only channel: its mailer would send the
      // unusable magic-link template, so no route may reach it with an email.
      if (destinationType === 'email') {
        throw new Error('email OTP delivery must never go through GoTrue signInWithOtp');
      }
    },
    generateEmailOtp: async () => '654321',
    sendCodeEmail: async () => {},
    verifyOtp: async () => session,
    generateReviewOtp: async () => {
      throw new Error('review OTP must not be generated');
    },
    redeemInvite: async () => ({
      organizationId: '00000000-0000-4000-8000-000000000001',
      role: 'member',
    }),
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
    enrollMfa: async () => ({
      id: '00000000-0000-4000-8000-000000000090',
      type: 'totp',
      friendly_name: null,
      totp: {
        qr_code: 'data:image/svg+xml;utf-8,<svg>review</svg>',
        secret: 'ABCDEFGHIJKLMNOP',
        uri: 'otpauth://totp/Newone:review?secret=ABCDEFGHIJKLMNOP',
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

Deno.test('absent review secrets leave the review email on the standard member path', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      reviewAccount: null,
      sendCodeEmail: async ({ to }) => {
        calls.push(`deliver:${to}`);
      },
      verifyOtp: async (_destinationType, _destination, code) => {
        calls.push(`verify:${code}`);
        throw new ApiError(401, 'unauthorized');
      },
      generateReviewOtp: async () => {
        calls.push('generate');
        return '999999';
      },
    })
  );
  const requested = await handler(post('/v2/auth/otp/request', {
    email: reviewEmail,
    captchaToken: 'captcha-token-that-is-long-enough',
  }));
  assertEquals(requested.status, 202);
  assertEquals(calls, [`deliver:${reviewEmail}`]);

  // The static code hits the same six-character bound as any other member's
  // malformed code and never reaches a verifier.
  const staticCode = await handler(post('/v2/auth/otp/verify', {
    email: reviewEmail,
    code: reviewCode,
  }));
  assertEquals(staticCode.status, 400);
  assertEquals(calls, [`deliver:${reviewEmail}`]);

  const sixDigit = await handler(post('/v2/auth/otp/verify', {
    email: reviewEmail,
    code: '123456',
  }));
  assertEquals(sixDigit.status, 401);
  assertEquals(calls, [`deliver:${reviewEmail}`, 'verify:123456']);
});

Deno.test('review OTP requests authorize and rate-limit normally but skip email delivery', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      authorizeMemberOtp: async (
        _destinationType,
        destination,
        _ipHash,
        _installationHash,
        _requestId,
        purpose,
      ) => {
        calls.push(`authorize:${destination}:${purpose}`);
        return { allowed: true, channelConfigured: true };
      },
      generateEmailOtp: async (destination) => {
        calls.push(`mint:${destination}`);
        return '654321';
      },
      sendCodeEmail: async ({ to }) => {
        calls.push(`deliver:${to}`);
      },
    })
  );
  // Mixed-case input still matches: destinations are lowercased on parse.
  const review = await handler(post('/v2/auth/otp/request', {
    email: 'AppReview@Newone.example',
    captchaToken: 'captcha-token-that-is-long-enough',
  }));
  assertEquals(review.status, 202);
  const reviewBody = await review.json();

  const member = await handler(post('/v2/auth/otp/request', {
    email: 'worker@example.com',
    captchaToken: 'captcha-token-that-is-long-enough',
  }));
  assertEquals(member.status, 202);
  assertEquals(reviewBody, await member.json());
  assertEquals(calls, [
    `authorize:${reviewEmail}:request`,
    'authorize:worker@example.com:request',
    'mint:worker@example.com',
    'deliver:worker@example.com',
  ]);

  const native = await handler(nativePost('/v2/auth/native/otp/request', {
    destinationType: 'email',
    destination: reviewEmail,
    captchaToken: 'captcha-token-that-is-long-enough',
  }));
  assertEquals(native.status, 202);
  assertEquals(await native.json(), {
    accepted: true,
    channel: { type: 'email', configured: true },
  });
  // The review destination is authorized and rate limited but never minted
  // or mailed; the ordinary member gets the gateway-owned code email.
  assertEquals(calls, [
    `authorize:${reviewEmail}:request`,
    'authorize:worker@example.com:request',
    'mint:worker@example.com',
    'deliver:worker@example.com',
    `authorize:${reviewEmail}:request`,
  ]);
});

Deno.test('review verify with the static code yields a real bound session', async () => {
  const linkedOtp = '445566';
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
        calls.push(`authorize:${purpose}`);
        return { allowed: true, channelConfigured: true };
      },
      generateReviewOtp: async (destination) => {
        calls.push(`generate:${destination}`);
        return linkedOtp;
      },
      verifyOtp: async (_destinationType, destination, code) => {
        calls.push(`verify:${destination}:${code}`);
        return session;
      },
      bindSessionInstallation: async () => {
        calls.push('bind');
        return { sessionId };
      },
      inspect: async () => {
        calls.push('inspect');
        return activeSession();
      },
    })
  );
  const response = await handler(post('/v2/auth/otp/verify', {
    email: reviewEmail,
    code: reviewCode,
  }));
  assertEquals(response.status, 200);
  assertEquals(calls, [
    'authorize:verify',
    `generate:${reviewEmail}`,
    `verify:${reviewEmail}:${linkedOtp}`,
    'bind',
    'inspect',
  ]);
  const body = await response.json();
  assertEquals(body.authenticated, true);
  assertEquals(body.memberships, memberships);
  assertEquals(body.sessionId, sessionId);
  assert(!JSON.stringify(body).includes(reviewCode));
  assertEquals(response.headers.getSetCookie().length, 3);
});

Deno.test('native review verify returns bearer session credentials without cookies', async () => {
  const linkedOtp = '445566';
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      generateReviewOtp: async (destination) => {
        calls.push(`generate:${destination}`);
        return linkedOtp;
      },
      verifyOtp: async (_destinationType, destination, code) => {
        calls.push(`verify:${destination}:${code}`);
        return session;
      },
    })
  );
  const response = await handler(nativePost('/v2/auth/native/otp/verify', {
    destinationType: 'email',
    destination: reviewEmail,
    code: reviewCode,
  }));
  assertEquals(response.status, 200);
  assertEquals(calls, [`generate:${reviewEmail}`, `verify:${reviewEmail}:${linkedOtp}`]);
  assertEquals(response.headers.getSetCookie().length, 0);
  const body = await response.json();
  assertEquals(body.session, {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
  });
});

Deno.test('a wrong review code follows the invalid-code path without minting a link', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      generateReviewOtp: async () => {
        calls.push('generate');
        return '445566';
      },
      verifyOtp: async (_destinationType, _destination, code) => {
        calls.push(`verify:${code}`);
        throw new ApiError(401, 'unauthorized');
      },
    })
  );
  const wrongStatic = await handler(post('/v2/auth/otp/verify', {
    email: reviewEmail,
    code: 'Review-Static-Code-9999',
  }));
  assertEquals(wrongStatic.status, 401);
  assertEquals(calls, []);

  // A six-digit guess for the review account still takes the normal GoTrue
  // verification path and fails there.
  const wrongSixDigit = await handler(post('/v2/auth/otp/verify', {
    email: reviewEmail,
    code: '654321',
  }));
  assertEquals(wrongSixDigit.status, 401);
  assertEquals(calls, ['verify:654321']);
});

Deno.test('the static review code never crosses to another destination or invite flow', async () => {
  const calls: string[] = [];
  const handler = createAuthHandler(() =>
    dependencies({
      generateReviewOtp: async () => {
        calls.push('generate');
        return '445566';
      },
      verifyOtp: async (_destinationType, destination, code) => {
        calls.push(`verify:${destination}:${code}`);
        throw new ApiError(401, 'unauthorized');
      },
    })
  );
  // Another member submitting the static code hits the standard six-character
  // bound exactly as if the feature did not exist.
  const other = await handler(post('/v2/auth/otp/verify', {
    email: 'worker@example.com',
    code: reviewCode,
  }));
  assertEquals(other.status, 400);
  assertEquals(calls, []);

  // Invitation flows never bypass: the static code is forwarded to the
  // normal verifier and fails like any invalid code.
  const invited = await handler(post('/v2/auth/otp/verify', {
    email: reviewEmail,
    invitationToken: 'a'.repeat(64),
    code: reviewCode,
  }));
  assertEquals(invited.status, 401);
  assertEquals(calls, [`verify:${reviewEmail}:${reviewCode}`]);
});

Deno.test('review sign-in still honors authorization denial and a missing account', async () => {
  const calls: string[] = [];
  const denied = createAuthHandler(() =>
    dependencies({
      authorizeMemberOtp: async () => ({ allowed: false, channelConfigured: true }),
      generateReviewOtp: async () => {
        calls.push('generate');
        return '445566';
      },
    })
  );
  const deniedResponse = await denied(post('/v2/auth/otp/verify', {
    email: reviewEmail,
    code: reviewCode,
  }));
  assertEquals(deniedResponse.status, 401);
  assertEquals(calls, []);

  // The pre-existing review account is absent: generateLink failure maps to
  // the invalid-code response and the normal verifier is never reached.
  const missing = createAuthHandler(() =>
    dependencies({
      generateReviewOtp: async () => {
        throw new ApiError(401, 'unauthorized');
      },
      verifyOtp: async () => {
        calls.push('verify');
        return session;
      },
    })
  );
  const missingResponse = await missing(post('/v2/auth/otp/verify', {
    email: reviewEmail,
    code: reviewCode,
  }));
  assertEquals(missingResponse.status, 401);
  assertEquals(missingResponse.headers.getSetCookie().length, 0);
  assertEquals(calls, []);
});

Deno.test('review credential matching mirrors constant-time safeEqual semantics', () => {
  const emailIdentity = { destinationType: 'email' as const, destination: reviewEmail };
  const candidates = [
    reviewCode,
    reviewCode.slice(0, -1),
    `${reviewCode}x`,
    reviewCode.toUpperCase(),
    reviewCode.toLowerCase(),
    `${reviewCode.slice(0, -1)}7`,
    'Review',
    '',
  ];
  for (const candidate of candidates) {
    assertEquals(
      isReviewCredential(reviewAccount, emailIdentity, candidate),
      safeEqual(candidate, reviewCode),
    );
  }
  assertEquals(isReviewCredential(null, emailIdentity, reviewCode), false);
  assertEquals(
    isReviewCredential(reviewAccount, {
      destinationType: 'email',
      destination: 'worker@example.com',
    }, reviewCode),
    false,
  );
  assertEquals(
    isReviewCredential(reviewAccount, {
      destinationType: 'phone',
      destination: '+12025550123',
    }, reviewCode),
    false,
  );
});

const reviewEnvironment: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'review-publishable-key',
  SUPABASE_SECRET_KEY: 'review-secret-key',
  NEWONE_ALLOWED_WEB_ORIGINS: 'https://app.newone.example',
  NEWONE_NETWORK_HASH_KEY: 'n'.repeat(32),
  NEWONE_RECOVERY_EVIDENCE_HASH_KEY: 'r'.repeat(32),
  NEWONE_AUTH_CAPTCHA_REQUIRED: 'true',
  NEWONE_AUTH_PHONE_OTP_ENABLED: 'false',
};

async function withReviewEnvironment(
  values: Record<string, string>,
  run: () => Promise<void> | void,
): Promise<void> {
  const names = [
    ...Object.keys(reviewEnvironment),
    'NEWONE_ALLOW_HTTP_LOCAL',
    'NEWONE_REVIEW_ACCOUNT_EMAIL',
    'NEWONE_REVIEW_ACCOUNT_CODE',
  ];
  const before = new Map(names.map((name) => [name, Deno.env.get(name)]));
  try {
    for (const name of names) Deno.env.delete(name);
    for (const [key, value] of Object.entries({ ...reviewEnvironment, ...values })) {
      Deno.env.set(key, value);
    }
    await run();
  } finally {
    for (const name of names) {
      const value = before.get(name);
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

Deno.test('review account configuration stays dead unless both secrets are well-formed', async () => {
  await withReviewEnvironment({}, () => {
    assertEquals(defaultAuthDependencies().reviewAccount, null);
  });
  await withReviewEnvironment({
    NEWONE_REVIEW_ACCOUNT_EMAIL: 'AppReview@Newone.example',
    NEWONE_REVIEW_ACCOUNT_CODE: reviewCode,
  }, () => {
    assertEquals(defaultAuthDependencies().reviewAccount, {
      email: reviewEmail,
      code: reviewCode,
    });
  });
  const malformed: Array<Record<string, string>> = [
    { NEWONE_REVIEW_ACCOUNT_EMAIL: reviewEmail },
    { NEWONE_REVIEW_ACCOUNT_CODE: reviewCode },
    { NEWONE_REVIEW_ACCOUNT_EMAIL: 'not-an-email', NEWONE_REVIEW_ACCOUNT_CODE: reviewCode },
    { NEWONE_REVIEW_ACCOUNT_EMAIL: reviewEmail, NEWONE_REVIEW_ACCOUNT_CODE: 'short' },
    { NEWONE_REVIEW_ACCOUNT_EMAIL: reviewEmail, NEWONE_REVIEW_ACCOUNT_CODE: 'x'.repeat(33) },
    { NEWONE_REVIEW_ACCOUNT_EMAIL: reviewEmail, NEWONE_REVIEW_ACCOUNT_CODE: 'has a space code' },
  ];
  for (const values of malformed) {
    await withReviewEnvironment(values, async () => {
      await assertRejects(async () => defaultAuthDependencies());
    });
  }
});

Deno.test('default review OTP generation mints a magic-link OTP and maps failure to 401', async () => {
  await withReviewEnvironment({
    NEWONE_REVIEW_ACCOUNT_EMAIL: reviewEmail,
    NEWONE_REVIEW_ACCOUNT_CODE: reviewCode,
  }, async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let respondWithError = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: URL | Request | string, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      assertEquals(url.pathname, '/auth/v1/admin/generate_link');
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (respondWithError) {
        return Promise.resolve(
          new Response(JSON.stringify({ code: 404, msg: 'user not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            action_link: 'https://project.supabase.co/auth/v1/verify?token=linked',
            email_otp: '445566',
            hashed_token: 'hashed-token-value',
            redirect_to: 'https://app.newone.example',
            verification_type: 'magiclink',
            id: session.userId,
            email: reviewEmail,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }) as typeof fetch;
    try {
      const defaults = defaultAuthDependencies();
      assertEquals(await defaults.generateReviewOtp(reviewEmail), '445566');
      assertEquals(bodies[0]?.type, 'magiclink');
      assertEquals(bodies[0]?.email, reviewEmail);
      respondWithError = true;
      await assertRejects(
        () => defaults.generateReviewOtp(reviewEmail),
        (error) =>
          error instanceof ApiError && error.status === 401 && error.code === 'unauthorized',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
