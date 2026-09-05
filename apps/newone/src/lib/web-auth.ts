import { Platform } from 'react-native';
import Constants from 'expo-constants';

import {
  apiUrlFor,
  edgeSessionTransport,
  isApiConfigured,
  nativeEdgeRequestHeaders,
  publicRuntimeConfig,
} from '@/config/runtime';
// Metro selects a non-secret, platform-appropriate installation identifier.
// eslint-disable-next-line import/no-unresolved
import { getInstallationId } from '@/lib/installation-id';

export interface WebAuthUser {
  id: string;
  email?: string;
  phone?: string;
}

export interface WebAuthSession {
  authenticated: true;
  user: WebAuthUser;
  organization?: { id: string; role: string };
  csrfToken?: string;
  sessionId?: string;
  aal?: 'aal1' | 'aal2';
}

export class WebAuthError extends Error {
  /** Server-issued request identifier, kept so members can quote it to support. */
  readonly correlationId?: string;

  constructor(
    message: string,
    public readonly code: string,
    correlationId?: string,
  ) {
    super(message);
    this.name = 'WebAuthError';
    if (typeof correlationId === 'string') this.correlationId = correlationId;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function authBaseUrl() {
  if (Platform.OS !== 'web' || !isApiConfigured || !publicRuntimeConfig.apiUrl) {
    throw new WebAuthError('The secure web gateway is not configured.', 'gateway_unconfigured');
  }
  if (typeof window !== 'undefined') {
    const apiOrigin = new URL(publicRuntimeConfig.apiUrl, window.location.origin).origin;
    if (apiOrigin !== window.location.origin) {
      throw new WebAuthError(
        'Web sign-in must use the same-origin Newone gateway.',
        'gateway_origin_mismatch',
      );
    }
  }
  return publicRuntimeConfig.apiUrl;
}

function cookie(name: string) {
  if (typeof document === 'undefined') return null;
  const prefix = `${encodeURIComponent(name)}=`;
  const entry = document.cookie.split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : null;
}

export function getWebCsrfToken() {
  return cookie('__Host-newone_csrf');
}

async function webRequest(
  path: string,
  input: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; csrf?: boolean } = {},
) {
  const csrfToken = input.csrf ? getWebCsrfToken() : null;
  if (input.csrf && !csrfToken) {
    throw new WebAuthError('Your web session needs to be refreshed.', 'csrf_required');
  }
  let response: Response;
  try {
    authBaseUrl();
    const url = apiUrlFor(path as `/${string}`);
    if (!url) throw new WebAuthError('The secure web gateway is not configured.', 'gateway_unconfigured');
    response = await fetch(url, {
      method: input.method ?? 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(input.body ? { 'Content-Type': 'application/json' } : {}),
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch (error) {
    if (error instanceof WebAuthError) throw error;
    throw new WebAuthError('The secure web gateway is unreachable.', 'network_unavailable');
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // The classified error below is safe to show and does not echo upstream data.
  }
  if (!response.ok) {
    const root = objectValue(payload);
    const problem = objectValue(root.error ?? root);
    throw new WebAuthError(
      response.status === 401
        ? 'Your web session has expired.'
        : 'The secure web request was rejected.',
      typeof problem.code === 'string' ? problem.code : `http_${response.status}`,
      typeof problem.correlationId === 'string' ? problem.correlationId : undefined,
    );
  }
  return objectValue(objectValue(payload).data ?? payload);
}

function parseSession(payload: Record<string, unknown>): WebAuthSession {
  const user = objectValue(payload.user);
  const id = user.id;
  if (payload.authenticated !== true || typeof id !== 'string') {
    throw new WebAuthError('The gateway returned an invalid session.', 'invalid_response');
  }
  const organization = objectValue(payload.organization);
  return {
    authenticated: true,
    user: {
      id,
      ...(typeof user.email === 'string' ? { email: user.email } : {}),
      ...(typeof user.phone === 'string' ? { phone: user.phone } : {}),
    },
    ...(typeof organization.id === 'string' && typeof organization.role === 'string'
      ? { organization: { id: organization.id, role: organization.role } }
      : {}),
    ...(typeof payload.csrfToken === 'string' ? { csrfToken: payload.csrfToken } : {}),
    ...(typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : {}),
    ...(payload.aal === 'aal1' || payload.aal === 'aal2' ? { aal: payload.aal } : {}),
  };
}

function parseOtpRequest(payload: Record<string, unknown>) {
  const channel = objectValue(payload.channel);
  if (
    payload.accepted !== true
    || !['email', 'phone'].includes(String(channel.type))
    || typeof channel.configured !== 'boolean'
  ) {
    throw new WebAuthError('The identity gateway returned an invalid response.', 'invalid_response');
  }
  return {
    accepted: true as const,
    channel: {
      type: channel.type as 'email' | 'phone',
      configured: channel.configured,
    },
  };
}

function parseRecoverySession(payload: Record<string, unknown>) {
  const parsed = parseSession(payload);
  const recovery = objectValue(payload.recovery);
  if (
    payload.recovered !== true
    || recovery.currentSessionPreserved !== true
    || !Number.isSafeInteger(recovery.otherSessionsRevoked)
    || Number(recovery.otherSessionsRevoked) < 0
    || recovery.securityEventRecorded !== true
    || typeof recovery.securityNoticeState !== 'string'
  ) {
    throw new WebAuthError('The recovery gateway returned an invalid result.', 'invalid_response');
  }
  return {
    ...parsed,
    recovery: {
      currentSessionPreserved: true as const,
      otherSessionsRevoked: Number(recovery.otherSessionsRevoked),
      securityEventRecorded: true as const,
      securityNoticeState: recovery.securityNoticeState,
    },
  };
}

interface OtpIdentity {
  destinationType: 'email' | 'phone';
  destination: string;
  invitationToken?: string | null;
  employeeCode?: string | null;
}

export type SignupLanguage = 'en' | 'es' | 'ko';

interface SignupIdentity {
  destination: string;
  username: string;
  displayName: string;
  language: SignupLanguage;
}

function parseSignupRequest(payload: Record<string, unknown>) {
  if (payload.status !== 'code_sent') {
    throw new WebAuthError('The signup gateway returned an invalid response.', 'invalid_response');
  }
  return { status: 'code_sent' as const };
}

/** The signup receipt is absent when the server silently signed in an existing account. */
function parseSignupReceipt(payload: Record<string, unknown>) {
  const signup = objectValue(payload.signup);
  return typeof signup.username === 'string' && typeof signup.organizationId === 'string'
    ? { signup: { username: signup.username, organizationId: signup.organizationId } }
    : {};
}

export async function requestWebOtp(input: OtpIdentity & { captchaToken?: string | null }) {
  const client = await webClientBinding();
  return parseOtpRequest(
    await webRequest('/v2/auth/otp/request', {
      method: 'POST',
      body: {
        destinationType: input.destinationType,
        destination: input.destination,
        ...(input.captchaToken ? { captchaToken: input.captchaToken } : {}),
        installationId: client.installationId,
        locale: client.locale,
        appVersion: client.appVersion,
        ...(input.invitationToken ? { invitationToken: input.invitationToken } : {}),
        ...(input.employeeCode ? { employeeCode: input.employeeCode } : {}),
      },
    }),
  );
}

export async function verifyWebOtp(input: OtpIdentity & { code: string }) {
  const client = await webClientBinding();
  return parseSession(
    await webRequest('/v2/auth/otp/verify', {
      method: 'POST',
      body: {
        destinationType: input.destinationType,
        destination: input.destination,
        code: input.code,
        installationId: client.installationId,
        locale: client.locale,
        appVersion: client.appVersion,
        ...(input.invitationToken ? { invitationToken: input.invitationToken } : {}),
        ...(input.employeeCode ? { employeeCode: input.employeeCode } : {}),
      },
    }),
  );
}

export async function requestWebRecoveryOtp(input: OtpIdentity & { captchaToken?: string | null }) {
  const client = await webClientBinding();
  return parseOtpRequest(
    await webRequest('/v2/auth/recovery/otp/request', {
      method: 'POST',
      body: {
        destinationType: input.destinationType,
        destination: input.destination,
        ...(input.captchaToken ? { captchaToken: input.captchaToken } : {}),
        installationId: client.installationId,
        locale: client.locale,
        appVersion: client.appVersion,
      },
    }),
  );
}

export async function verifyWebRecoveryOtp(input: OtpIdentity & { code: string }) {
  const client = await webClientBinding();
  return parseRecoverySession(
    await webRequest('/v2/auth/recovery/otp/verify', {
      method: 'POST',
      body: {
        destinationType: input.destinationType,
        destination: input.destination,
        code: input.code,
        installationId: client.installationId,
        locale: client.locale,
        appVersion: client.appVersion,
      },
    }),
  );
}

export async function requestWebSignup(input: SignupIdentity & { captchaToken?: string | null }) {
  const client = await webClientBinding();
  return parseSignupRequest(
    await webRequest('/v2/auth/signup/request', {
      method: 'POST',
      body: {
        destination: input.destination,
        username: input.username,
        displayName: input.displayName,
        language: input.language,
        ...(input.captchaToken ? { captchaToken: input.captchaToken } : {}),
        installationId: client.installationId,
        locale: client.locale,
        appVersion: client.appVersion,
      },
    }),
  );
}

export async function verifyWebSignup(input: { destination: string; code: string }) {
  const client = await webClientBinding();
  const payload = await webRequest('/v2/auth/signup/verify', {
    method: 'POST',
    body: {
      destination: input.destination,
      code: input.code,
      installationId: client.installationId,
      locale: client.locale,
      appVersion: client.appVersion,
    },
  });
  return {
    ...parseSession(payload),
    ...parseSignupReceipt(payload),
  };
}

async function webClientBinding() {
  return {
    installationId: await getInstallationId(),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    appVersion: Constants.expoConfig?.version ?? null,
  };
}

type NativeOtpIdentity = OtpIdentity;

type NativeAuthPath =
  | '/v2/auth/native/otp/request'
  | '/v2/auth/native/otp/verify'
  | '/v2/auth/native/recovery/otp/request'
  | '/v2/auth/native/recovery/otp/verify'
  | '/v2/auth/native/signup/request'
  | '/v2/auth/native/signup/verify';

async function nativeAuthRequest(path: NativeAuthPath, body: Record<string, unknown>) {
  // A browser build in direct (bearer) mode uses the same token-returning
  // routes; it identifies itself honestly as 'web' and the server admits it
  // only from an allow-listed Origin.
  const directWeb = Platform.OS === 'web' && edgeSessionTransport === 'bearer';
  if (Platform.OS !== 'ios' && Platform.OS !== 'android' && !directWeb) {
    throw new WebAuthError('Native sign-in is unavailable on this platform.', 'gateway_unconfigured');
  }
  const installationId = await getInstallationId();
  const url = apiUrlFor(path);
  const edgeHeaders = nativeEdgeRequestHeaders();
  if (!url || url.startsWith('/') || !edgeHeaders) {
    throw new WebAuthError('The native identity gateway is not configured.', 'gateway_unconfigured');
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...edgeHeaders,
        'X-Newone-Client-Platform': Platform.OS,
        'X-Newone-Installation-Id': installationId,
      },
      body: JSON.stringify({ ...body, installationId }),
    });
  } catch {
    throw new WebAuthError('The native identity gateway is unreachable.', 'network_unavailable');
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Invalid payloads are classified without exposing upstream response text.
  }
  const data = objectValue(objectValue(payload).data ?? payload);
  if (!response.ok) {
    const problem = objectValue(objectValue(payload).error ?? payload);
    throw new WebAuthError(
      'The secure native sign-in request was rejected.',
      typeof problem.code === 'string' ? problem.code : `http_${response.status}`,
      typeof problem.correlationId === 'string' ? problem.correlationId : undefined,
    );
  }
  return data;
}

export async function requestNativeOtp(input: NativeOtpIdentity & { captchaToken?: string | null }) {
  const payload = await nativeAuthRequest('/v2/auth/native/otp/request', {
    destinationType: input.destinationType,
    destination: input.destination,
    invitationToken: input.invitationToken ?? null,
    employeeCode: input.employeeCode ?? null,
    ...(input.captchaToken ? { captchaToken: input.captchaToken } : {}),
  });
  return parseOtpRequest(payload);
}

export async function verifyNativeOtp(input: NativeOtpIdentity & { code: string }) {
  const payload = await nativeAuthRequest('/v2/auth/native/otp/verify', {
    destinationType: input.destinationType,
    destination: input.destination,
    invitationToken: input.invitationToken ?? null,
    employeeCode: input.employeeCode ?? null,
    code: input.code,
  });
  const parsed = parseSession(payload);
  const nativeSession = objectValue(payload.session);
  if (
    typeof nativeSession.accessToken !== 'string'
    || typeof nativeSession.refreshToken !== 'string'
    || !Number.isInteger(nativeSession.expiresIn)
    || !Array.isArray(payload.memberships)
  ) {
    throw new WebAuthError('The native identity gateway returned an invalid session.', 'invalid_response');
  }
  return {
    ...parsed,
    memberships: payload.memberships,
    session: {
      accessToken: nativeSession.accessToken,
      refreshToken: nativeSession.refreshToken,
      expiresIn: Number(nativeSession.expiresIn),
    },
  };
}

export async function requestNativeRecoveryOtp(input: NativeOtpIdentity & { captchaToken?: string | null }) {
  const payload = await nativeAuthRequest('/v2/auth/native/recovery/otp/request', {
    destinationType: input.destinationType,
    destination: input.destination,
    ...(input.captchaToken ? { captchaToken: input.captchaToken } : {}),
  });
  return parseOtpRequest(payload);
}

export async function verifyNativeRecoveryOtp(input: NativeOtpIdentity & { code: string }) {
  const payload = await nativeAuthRequest('/v2/auth/native/recovery/otp/verify', {
    destinationType: input.destinationType,
    destination: input.destination,
    code: input.code,
  });
  const parsed = parseRecoverySession(payload);
  const nativeSession = objectValue(payload.session);
  if (
    typeof nativeSession.accessToken !== 'string'
    || typeof nativeSession.refreshToken !== 'string'
    || !Number.isInteger(nativeSession.expiresIn)
    || !Array.isArray(payload.memberships)
  ) {
    throw new WebAuthError('The native recovery gateway returned an invalid session.', 'invalid_response');
  }
  return {
    ...parsed,
    memberships: payload.memberships,
    session: {
      accessToken: nativeSession.accessToken,
      refreshToken: nativeSession.refreshToken,
      expiresIn: Number(nativeSession.expiresIn),
    },
  };
}

export async function requestNativeSignup(input: SignupIdentity & { captchaToken?: string | null }) {
  const payload = await nativeAuthRequest('/v2/auth/native/signup/request', {
    destination: input.destination,
    username: input.username,
    displayName: input.displayName,
    language: input.language,
    ...(input.captchaToken ? { captchaToken: input.captchaToken } : {}),
  });
  return parseSignupRequest(payload);
}

export async function verifyNativeSignup(input: { destination: string; code: string }) {
  const payload = await nativeAuthRequest('/v2/auth/native/signup/verify', {
    destination: input.destination,
    code: input.code,
  });
  const parsed = parseSession(payload);
  const nativeSession = objectValue(payload.session);
  if (
    typeof nativeSession.accessToken !== 'string'
    || typeof nativeSession.refreshToken !== 'string'
    || !Number.isInteger(nativeSession.expiresIn)
    || !Array.isArray(payload.memberships)
  ) {
    throw new WebAuthError('The native signup gateway returned an invalid session.', 'invalid_response');
  }
  return {
    ...parsed,
    ...parseSignupReceipt(payload),
    memberships: payload.memberships,
    session: {
      accessToken: nativeSession.accessToken,
      refreshToken: nativeSession.refreshToken,
      expiresIn: Number(nativeSession.expiresIn),
    },
  };
}

export async function validateNativeMembership(input: { accessToken: string; userId: string }) {
  const url = apiUrlFor('/v2/bootstrap');
  const edgeHeaders = nativeEdgeRequestHeaders(input.accessToken);
  if (!url || !edgeHeaders) throw new WebAuthError('The membership service is not configured.', 'gateway_unconfigured');
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...edgeHeaders,
      },
      body: JSON.stringify({ organizationId: null }),
    });
  } catch {
    throw new WebAuthError('The membership service is unreachable.', 'network_unavailable');
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Invalid data is rejected below without exposing response text.
  }
  if (!response.ok) {
    const root = objectValue(payload);
    const problem = objectValue(root.error ?? root);
    const upstreamCode = typeof problem.code === 'string' ? problem.code.toLocaleLowerCase() : '';
    if (
      response.status === 401
      || response.status === 403
      || upstreamCode === 'forbidden'
      || upstreamCode === 'session_revoked'
      || upstreamCode === 'membership_required'
    ) {
      throw new WebAuthError(
        'This account does not have an active company membership.',
        'membership_required',
      );
    }
    throw new WebAuthError(
      'The membership service could not verify this session.',
      `http_${response.status}`,
    );
  }
  const root = objectValue(payload);
  const data = objectValue(root.data ?? root);
  // The bootstrap contract (schemaVersion 1): the caller's identity is
  // `userId`, the resolved workspace is `organizationId`, and an active
  // membership is proven by `currentUser.membershipRole`. Anything else is
  // treated as no membership. Verified against the live payload shape.
  const currentUser = objectValue(data.currentUser);
  const membershipRole = currentUser.membershipRole;
  if (
    data.userId !== input.userId ||
    typeof data.organizationId !== 'string' ||
    typeof membershipRole !== 'string' ||
    !['owner', 'admin', 'manager', 'member'].includes(membershipRole)
  ) {
    throw new WebAuthError('The membership service returned an invalid response.', 'invalid_response');
  }
  return { organizationId: data.organizationId };
}

export async function getWebSession() {
  return parseSession(
    await webRequest('/v2/auth/session', { method: 'POST', body: {}, csrf: true }),
  );
}

export async function refreshWebSession() {
  const client = await webClientBinding();
  return parseSession(
    await webRequest('/v2/auth/session/refresh', {
      method: 'POST',
      body: {
        installationId: client.installationId,
        locale: client.locale,
        appVersion: client.appVersion,
      },
      csrf: true,
    }),
  );
}

export async function getWebRealtimeToken() {
  const payload = await webRequest('/v2/auth/realtime-token', {
    method: 'POST',
    body: {},
    csrf: true,
  });
  if (typeof payload.accessToken !== 'string' || typeof payload.expiresAt !== 'string') {
    throw new WebAuthError('The gateway returned an invalid realtime token.', 'invalid_response');
  }
  return { accessToken: payload.accessToken, expiresAt: payload.expiresAt };
}

export async function listWebMfaFactors() {
  const payload = await webRequest('/v2/auth/mfa/factors', {
    method: 'POST',
    body: {},
    csrf: true,
  });
  return Array.isArray(payload.factors)
    ? payload.factors.map((entry) => {
        const factor = objectValue(entry);
        return {
          id: typeof factor.id === 'string' ? factor.id : '',
          friendlyName: typeof factor.friendlyName === 'string' ? factor.friendlyName : undefined,
          status: factor.status === 'verified' ? 'verified' as const : 'unverified' as const,
        };
      }).filter((factor) => factor.id)
    : [];
}

export async function enrollWebMfa(friendlyName?: string) {
  const payload = await webRequest('/v2/auth/mfa/enroll', {
    method: 'POST',
    body: { friendlyName: friendlyName ?? null },
    csrf: true,
  });
  const factor = objectValue(payload.factor);
  const totp = objectValue(factor.totp);
  if (
    typeof factor.id !== 'string' ||
    typeof totp.qrCode !== 'string' ||
    typeof totp.secret !== 'string'
  ) {
    throw new WebAuthError('The gateway returned an invalid authenticator enrollment.', 'invalid_response');
  }
  return { factorId: factor.id, qrCode: totp.qrCode, secret: totp.secret };
}

export async function challengeWebMfa(factorId: string) {
  const payload = await webRequest('/v2/auth/mfa/challenge', {
    method: 'POST',
    body: { factorId },
    csrf: true,
  });
  const challenge = objectValue(payload.challenge);
  if (typeof challenge.id !== 'string') {
    throw new WebAuthError('The gateway returned an invalid authenticator challenge.', 'invalid_response');
  }
  return { challengeId: challenge.id };
}

export async function verifyWebMfa(input: {
  factorId: string;
  challengeId: string;
  code: string;
}) {
  const payload = await webRequest('/v2/auth/mfa/verify', {
    method: 'POST',
    body: input,
    csrf: true,
  });
  if (payload.verified !== true || payload.aal !== 'aal2') {
    throw new WebAuthError('The gateway returned an invalid authenticator result.', 'invalid_response');
  }
}

export async function unenrollWebMfa(factorId: string) {
  await webRequest('/v2/auth/mfa/unenroll', {
    method: 'POST',
    body: { factorId },
    csrf: true,
  });
}

export async function signOutWebSession() {
  await webRequest('/v2/auth/sign-out', { method: 'POST', body: {}, csrf: true });
}

/** Account deletion succeeds only on an explicit server receipt. */
function parseAccountDeletion(payload: Record<string, unknown>) {
  if (payload.status !== 'deleted') {
    throw new WebAuthError('The account deletion service returned an invalid receipt.', 'invalid_response');
  }
  return { status: 'deleted' as const };
}

export async function deleteWebAccount() {
  return parseAccountDeletion(
    await webRequest('/v2/auth/account/delete', { method: 'POST', body: {}, csrf: true }),
  );
}

export async function deleteNativeAccount(input: { accessToken: string }) {
  const url = apiUrlFor('/v2/auth/account/delete');
  const edgeHeaders = nativeEdgeRequestHeaders(input.accessToken);
  if (!url || url.startsWith('/') || !edgeHeaders) {
    throw new WebAuthError('The native identity gateway is not configured.', 'gateway_unconfigured');
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...edgeHeaders,
      },
      body: JSON.stringify({}),
    });
  } catch {
    throw new WebAuthError('The account deletion service is unreachable.', 'network_unavailable');
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Invalid payloads are classified without echoing upstream content.
  }
  if (!response.ok) {
    const problem = objectValue(objectValue(payload).error ?? payload);
    throw new WebAuthError(
      'The secure account deletion request was rejected.',
      typeof problem.code === 'string' ? problem.code : `http_${response.status}`,
    );
  }
  return parseAccountDeletion(objectValue(objectValue(payload).data ?? payload));
}

export async function redeemNativeInvitation(input: {
  accessToken: string;
  invitationToken: string;
}) {
  const url = apiUrlFor('/v2/auth/invitations/redeem');
  const edgeHeaders = nativeEdgeRequestHeaders(input.accessToken);
  if (!url || url.startsWith('/') || !edgeHeaders) {
    throw new WebAuthError('The native identity gateway is not configured.', 'gateway_unconfigured');
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...edgeHeaders,
      },
      body: JSON.stringify({ invitationToken: input.invitationToken }),
    });
  } catch {
    throw new WebAuthError('The invitation activation service is unreachable.', 'network_unavailable');
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Invalid payloads are classified without echoing upstream content.
  }
  const data = objectValue(objectValue(payload).data ?? payload);
  if (!response.ok || data.activated !== true) {
    throw new WebAuthError('That invitation is invalid, expired, or belongs to another account.', 'invitation_rejected');
  }
  return data;
}
