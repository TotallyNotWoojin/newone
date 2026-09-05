import {
  authenticate,
  type ClientEnvironment,
  createAdminClient,
  createPublicClient,
  createUserClient,
  loadClientEnvironment,
} from '../_shared/clients.ts';
import { hmacSha256Hex, randomBase64Url, safeEqual } from '../_shared/crypto.ts';
import { ApiError, asApiError, fromDatabaseError } from '../_shared/errors.ts';
import {
  accessCredential,
  buildRequestMeta,
  cookie,
  ensureSecureTransport,
  errorResponse,
  jsonResponse,
  loadRuntimeConfig,
  parseJson,
  preflight,
  requestId,
  type RequestMeta,
  type RuntimeConfig,
  verifyCsrf,
} from '../_shared/http.ts';
import {
  sendCodeEmail as sendCodeEmailViaResend,
  type SendCodeEmailInput,
} from '../_shared/mail.ts';
import { asRpcClient, firstRow, invokeRpc } from '../_shared/rpc.ts';
import { networkFingerprint, requireIdempotencyKey } from '../_shared/security.ts';
import { asObject, normalizedString, oneOf, onlyKeys, uuid } from '../_shared/validation.ts';

const INVITE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const OTP_PATTERN = /^[0-9]{6}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const EMPLOYEE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_]{2,28}[a-z0-9]$/;
const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
export const OTP_SHOULD_CREATE_USER = false;

type DestinationType = 'email' | 'phone';

interface AuthIdentity {
  destinationType: DestinationType;
  destination: string;
  email: string | null;
  phone: string | null;
}

interface SessionTokens extends AuthIdentity {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string;
}

interface InviteAuthorization {
  allowed?: boolean;
  channel_configured?: boolean;
  retry_after_seconds?: number;
}

interface OtpAuthorization {
  allowed: boolean;
  channelConfigured: boolean;
}

const SIGNUP_AUTHORIZATION_REASONS = [
  'ok',
  'rate_limited',
  'invalid_destination',
  'invalid_username',
  'username_reserved',
  'invalid_language',
  'invalid_display_name',
  'username_taken',
  'account_exists',
  'reservation_expired',
] as const;

type SignupAuthorizationReason = (typeof SIGNUP_AUTHORIZATION_REASONS)[number];

interface SignupAuthorizationRow {
  allowed?: boolean;
  reason?: string;
  existing_member?: boolean;
  channel_configured?: boolean;
  retry_after_seconds?: number;
}

export interface SignupAuthorization {
  allowed: boolean;
  reason: SignupAuthorizationReason;
  existingMember: boolean;
  channelConfigured: boolean;
  retryAfterSeconds: number;
}

export interface RedeemedSignup {
  organizationId: string;
  username: string;
  displayName: string;
  preferredLanguage: 'en' | 'es' | 'ko';
}

interface DeletedAccountRow {
  user_id?: string;
  memberships_deactivated?: number;
}

interface AccountRecoveryCompletion {
  recovered: boolean;
  currentSessionId: string;
  currentSessionPreserved: boolean;
  otherSessionsRevoked: number;
  securityEventRecorded: boolean;
  securityNoticeState: 'pending_external_delivery';
}

type RecoveryRpcName =
  | 'bff_create_account_recovery_case'
  | 'bff_record_account_recovery_verification'
  | 'bff_approve_account_recovery_case'
  | 'bff_reject_account_recovery_case'
  | 'bff_list_account_recovery_cases'
  | 'bff_prepare_account_recovery_execution';

type RecoveryServiceRpcName =
  | 'bff_cancel_account_recovery_execution'
  | 'bff_finalize_account_recovery_execution';

type OtpPurpose = 'request' | 'verify';

interface SessionInstallationInput {
  installationId: string;
  platform: 'ios' | 'android' | 'web';
  appVersion: string | null;
  locale: string | null;
  userAgent: string;
}

type UserAgentFamily = 'iphone' | 'ipad' | 'android' | 'mobile' | 'desktop' | 'unknown';

interface RedeemedInvite {
  organizationId: string;
  role: 'admin' | 'manager' | 'member';
}

interface ActiveMembership {
  organizationId: string;
  role: 'owner' | 'admin' | 'manager' | 'member';
}

interface ActiveSession extends AuthIdentity {
  userId: string;
  sessionId: string;
  expiresAt: number;
  issuedAt: number;
  aal: 'aal1' | 'aal2';
  memberships: ActiveMembership[];
}

export interface ReviewAccountConfig {
  email: string;
  code: string;
}

/**
 * CAPTCHA token-presence policy. 'all' requires a token on every OTP request
 * route; 'web' requires it only for requests arriving with a browser Origin
 * (the web BFF path) while the origin-less native paths are exempt; 'off' is
 * the explicit local-development escape and never boots outside
 * allowHttpLocal. A provided token is shape-validated in every mode.
 */
export type CaptchaMode = 'all' | 'web' | 'off';

export interface AuthDependencies {
  runtimeConfig: RuntimeConfig;
  clientEnvironment: ClientEnvironment;
  recoveryEvidenceHashKey: string;
  captchaMode: CaptchaMode;
  phoneOtpEnabled: boolean;
  reviewAccount: ReviewAccountConfig | null;
  settleOtpRequest(startedAt: number): Promise<void>;
  authorizeInviteOtp(
    inviteToken: string,
    destinationType: DestinationType,
    destination: string,
    employeeCode: string | null,
    ipHash: string,
    installationHash: string,
    requestId: string,
    purpose: OtpPurpose,
  ): Promise<OtpAuthorization>;
  authorizeMemberOtp(
    destinationType: DestinationType,
    destination: string,
    ipHash: string,
    installationHash: string,
    requestId: string,
    purpose: OtpPurpose,
  ): Promise<OtpAuthorization>;
  authorizeSignupOtp(
    destinationType: DestinationType,
    destination: string,
    username: string | null,
    displayName: string | null,
    language: string | null,
    ipHash: string,
    installationHash: string,
    requestId: string,
    purpose: OtpPurpose,
  ): Promise<SignupAuthorization>;
  ensureSignupUser(destination: string, displayName: string): Promise<void>;
  redeemSignup(
    userId: string,
    destinationType: DestinationType,
    destination: string,
    requestId: string,
  ): Promise<RedeemedSignup>;
  completeSignupUser(userId: string): Promise<void>;
  authorizeRecoveryOtp(
    destinationType: DestinationType,
    destination: string,
    ipHash: string,
    installationHash: string,
    requestId: string,
    purpose: OtpPurpose,
  ): Promise<OtpAuthorization>;
  /**
   * GoTrue signInWithOtp. Only the SMS channel goes through it: GoTrue's own
   * mailer sends its default magic-link template, which the code-based apps
   * can never consume, so every email code is gateway-owned instead
   * (generateEmailOtp + sendCodeEmail). Route code must never call this with
   * an email destination.
   */
  requestOtp(
    destinationType: DestinationType,
    destination: string,
    captchaToken: string | null,
  ): Promise<void>;
  generateEmailOtp(destination: string): Promise<string>;
  sendCodeEmail(input: SendCodeEmailInput): Promise<void>;
  verifyOtp(
    destinationType: DestinationType,
    destination: string,
    code: string,
  ): Promise<SessionTokens>;
  generateReviewOtp(destination: string): Promise<string>;
  redeemInvite(
    accessToken: string,
    expectedUserId: string,
    inviteToken: string,
    employeeCode: string | null,
  ): Promise<RedeemedInvite>;
  refresh(refreshToken: string): Promise<SessionTokens>;
  bindSessionInstallation(
    accessToken: string,
    installation: SessionInstallationInput,
  ): Promise<{ sessionId: string }>;
  completeAccountRecovery(
    accessToken: string,
    requestId: string,
  ): Promise<AccountRecoveryCompletion>;
  recoveryRpc(
    accessToken: string,
    name: RecoveryRpcName,
    args: Record<string, unknown>,
    requestId: string,
  ): Promise<Record<string, unknown>>;
  recoveryServiceRpc(
    name: RecoveryServiceRpcName,
    args: Record<string, unknown>,
    requestId: string,
  ): Promise<Record<string, unknown>>;
  listAdminMfaFactors(userId: string): Promise<unknown>;
  deleteAdminMfaFactor(userId: string, factorId: string): Promise<void>;
  deleteAccount(
    userId: string,
    requestId: string,
  ): Promise<{ userId: string; membershipsDeactivated: number }>;
  softDeleteAuthUser(userId: string): Promise<void>;
  revoke(accessToken: string): Promise<void>;
  identify(
    accessToken: string,
  ): Promise<AuthIdentity & { userId: string; expiresAt: number }>;
  inspect(accessToken: string): Promise<ActiveSession>;
  listMfa(accessToken: string, refreshToken: string): Promise<unknown>;
  enrollMfa(
    accessToken: string,
    refreshToken: string,
    friendlyName: string | null,
  ): Promise<unknown>;
  challengeMfa(accessToken: string, refreshToken: string, factorId: string): Promise<unknown>;
  verifyMfa(
    accessToken: string,
    refreshToken: string,
    factorId: string,
    challengeId: string,
    code: string,
  ): Promise<SessionTokens>;
  unenrollMfa(accessToken: string, refreshToken: string, factorId: string): Promise<void>;
}

function authIdentity(user: Record<string, unknown>): AuthIdentity {
  // GoTrue serializes the unused identity field as an empty string for some
  // hosted email/phone users. Treat only that exact wire value as absent;
  // malformed non-empty identities must still fail validation.
  const email = user.email === null || user.email === undefined || user.email === ''
    ? null
    : parseEmail(user.email);
  const phone = user.phone === null || user.phone === undefined || user.phone === ''
    ? null
    : parsePhone(user.phone);
  if (email === null && phone === null) throw new ApiError(401, 'unauthorized');
  return {
    destinationType: email === null ? 'phone' : 'email',
    destination: email ?? phone as string,
    email,
    phone,
  };
}

function sessionTokens(value: unknown): SessionTokens {
  const session = asObject(value);
  const user = asObject(session.user);
  const accessToken = normalizedString(session.access_token, {
    min: 20,
    max: 8192,
    trim: false,
  }) as string;
  // GoTrue issues short opaque refresh tokens (observed at 12 characters on
  // hosted projects); the floor exists only to reject empty or truncated
  // values, never to assume a token format.
  const refreshToken = normalizedString(session.refresh_token, {
    min: 10,
    max: 2048,
    trim: false,
  }) as string;
  const userId = uuid(user.id);
  const identity = authIdentity(user);
  const expiresIn =
    typeof session.expires_in === 'number' && Number.isSafeInteger(session.expires_in)
      ? Math.max(60, Math.min(86400, session.expires_in))
      : 3600;
  return { accessToken, refreshToken, expiresIn, userId, ...identity };
}

function signupAuthorization(row: SignupAuthorizationRow): SignupAuthorization {
  const reason = row.reason;
  if (
    typeof reason !== 'string' ||
    !(SIGNUP_AUTHORIZATION_REASONS as readonly string[]).includes(reason)
  ) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  return {
    allowed: row.allowed === true,
    reason: reason as SignupAuthorizationReason,
    existingMember: row.existing_member === true,
    channelConfigured: row.channel_configured === true,
    retryAfterSeconds: typeof row.retry_after_seconds === 'number' &&
        Number.isSafeInteger(row.retry_after_seconds) && row.retry_after_seconds >= 0
      ? Math.min(86400, row.retry_after_seconds)
      : 60,
  };
}

function boundedCount(value: unknown, max = 100000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  return value;
}

function accountRecoveryCompletion(
  value: Record<string, unknown>,
  expectedSessionId: string,
): AccountRecoveryCompletion {
  const currentSessionId = uuid(value.current_session_id);
  if (
    value.recovered !== true || value.current_session_preserved !== true ||
    value.security_event_recorded !== true || currentSessionId !== expectedSessionId ||
    value.security_notice_state !== 'pending_external_delivery'
  ) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  return {
    recovered: true,
    currentSessionId,
    currentSessionPreserved: true,
    otherSessionsRevoked: boundedCount(value.other_sessions_revoked),
    securityEventRecorded: true,
    securityNoticeState: 'pending_external_delivery',
  };
}

export function defaultAuthDependencies(): AuthDependencies {
  const runtimeConfig = loadRuntimeConfig();
  const clientEnvironment = loadClientEnvironment();
  const recoveryEvidenceHashKey = Deno.env.get('NEWONE_RECOVERY_EVIDENCE_HASH_KEY') ?? '';
  if (
    recoveryEvidenceHashKey.length < 32 || recoveryEvidenceHashKey.length > 4096 ||
    /[\r\n\0]/.test(recoveryEvidenceHashKey)
  ) {
    throw new Error(
      'NEWONE_RECOVERY_EVIDENCE_HASH_KEY must contain between 32 and 4096 characters',
    );
  }
  const captchaSetting = Deno.env.get('NEWONE_AUTH_CAPTCHA_REQUIRED')?.trim();
  // 'true' keeps token presence mandatory everywhere; 'web' scopes it to
  // browser-Origin requests because the native app has no CAPTCHA surface;
  // 'false' remains valid only alongside explicit local development.
  const captchaMode: CaptchaMode = captchaSetting === 'true'
    ? 'all'
    : captchaSetting === 'web'
    ? 'web'
    : 'off';
  if (captchaMode === 'off' && !(captchaSetting === 'false' && runtimeConfig.allowHttpLocal)) {
    throw new Error(
      "NEWONE_AUTH_CAPTCHA_REQUIRED must be 'true' or 'web' outside explicit local development",
    );
  }
  const phoneSetting = Deno.env.get('NEWONE_AUTH_PHONE_OTP_ENABLED')?.trim() ?? 'false';
  if (phoneSetting !== 'true' && phoneSetting !== 'false') {
    throw new Error('NEWONE_AUTH_PHONE_OTP_ENABLED must be true or false');
  }
  const phoneOtpEnabled = phoneSetting === 'true';
  // App Store review sign-in stays dead unless both optional secrets are
  // deployed together and well-formed; a half-configured pair must fail at
  // boot instead of silently shipping a live static credential.
  const reviewEmailSetting = Deno.env.get('NEWONE_REVIEW_ACCOUNT_EMAIL')?.trim() ?? '';
  const reviewCodeSetting = Deno.env.get('NEWONE_REVIEW_ACCOUNT_CODE')?.trim() ?? '';
  let reviewAccount: ReviewAccountConfig | null = null;
  if (reviewEmailSetting !== '' || reviewCodeSetting !== '') {
    const reviewEmail = reviewEmailSetting.toLowerCase();
    if (
      reviewEmail.length < 3 || reviewEmail.length > 254 || !EMAIL_PATTERN.test(reviewEmail) ||
      reviewCodeSetting.length < 6 || reviewCodeSetting.length > 32 ||
      !/^[\x21-\x7e]+$/.test(reviewCodeSetting)
    ) {
      // The message never echoes the configured secret values.
      throw new Error(
        'NEWONE_REVIEW_ACCOUNT_EMAIL and NEWONE_REVIEW_ACCOUNT_CODE must be configured together ' +
          'as a valid email address and a 6-32 character printable code',
      );
    }
    reviewAccount = { email: reviewEmail, code: reviewCodeSetting };
  }
  const activeMemberships = async (
    accessToken: string,
    expectedUserId: string,
  ): Promise<ActiveMembership[]> => {
    const actor = await authenticate(clientEnvironment, accessToken);
    if (actor.user.id !== expectedUserId) throw new ApiError(401, 'unauthorized');
    const context = asObject(
      await invokeRpc(
        asRpcClient(createAdminClient(clientEnvironment)),
        'bff_resolve_principal_context',
        {
          p_actor_user_id: actor.user.id,
          p_session_id: actor.claims.sessionId,
          p_requested_organization_id: null,
        },
      ),
    );
    if (
      context.schema_version !== 1 || !Array.isArray(context.organizations) ||
      context.organizations.length > 20
    ) {
      throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    }
    const memberships = context.organizations.map((entry) => {
      const row = asObject(entry);
      return {
        organizationId: uuid(row.organization_id),
        role: oneOf(
          row.membership_role,
          ['owner', 'admin', 'manager', 'member'] as const,
        ),
      };
    });
    if (memberships.length === 0) throw new ApiError(403, 'forbidden');
    return memberships;
  };
  const mfaClient = async (accessToken: string, refreshToken: string) => {
    const client = createUserClient(clientEnvironment, accessToken);
    const { data, error } = await client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error || !data.session || data.session.access_token !== accessToken) {
      throw new ApiError(401, 'unauthorized');
    }
    return client;
  };
  return {
    runtimeConfig,
    clientEnvironment,
    recoveryEvidenceHashKey,
    captchaMode,
    phoneOtpEnabled,
    reviewAccount,
    async settleOtpRequest(startedAt) {
      const jitter = crypto.getRandomValues(new Uint16Array(1))[0]! % 201;
      const remaining = 900 + jitter - (Date.now() - startedAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
    },
    async authorizeInviteOtp(
      inviteToken,
      destinationType,
      destination,
      employeeCode,
      ipHash,
      installationHash,
      correlationId,
      purpose,
    ) {
      const result = firstRow(
        await invokeRpc<InviteAuthorization | InviteAuthorization[]>(
          asRpcClient(createAdminClient(clientEnvironment, { 'X-Request-Id': correlationId })),
          'bff_authorize_invite_otp',
          {
            p_invite_token: inviteToken,
            p_destination_type: destinationType,
            p_destination: destination,
            p_employee_code: employeeCode,
            p_ip_hash: ipHash,
            p_installation_hash: installationHash,
            p_purpose: purpose,
          },
        ),
      );
      return {
        allowed: result.allowed === true,
        channelConfigured: result.channel_configured === true,
      };
    },
    async authorizeMemberOtp(
      destinationType,
      destination,
      ipHash,
      installationHash,
      correlationId,
      purpose,
    ) {
      const result = firstRow(
        await invokeRpc<InviteAuthorization | InviteAuthorization[]>(
          asRpcClient(createAdminClient(clientEnvironment, { 'X-Request-Id': correlationId })),
          'bff_authorize_member_otp',
          {
            p_destination_type: destinationType,
            p_destination: destination,
            p_ip_hash: ipHash,
            p_installation_hash: installationHash,
            p_purpose: purpose,
          },
        ),
      );
      return {
        allowed: result.allowed === true,
        channelConfigured: result.channel_configured === true,
      };
    },
    async authorizeSignupOtp(
      destinationType,
      destination,
      username,
      displayName,
      language,
      ipHash,
      installationHash,
      correlationId,
      purpose,
    ) {
      const result = firstRow(
        await invokeRpc<SignupAuthorizationRow | SignupAuthorizationRow[]>(
          asRpcClient(createAdminClient(clientEnvironment, { 'X-Request-Id': correlationId })),
          'bff_authorize_signup_otp',
          {
            p_destination_type: destinationType,
            p_destination: destination,
            p_username: username,
            p_display_name: displayName,
            p_language: language,
            p_ip_hash: ipHash,
            p_installation_hash: installationHash,
            p_purpose: purpose,
          },
        ),
      );
      return signupAuthorization(result);
    },
    async ensureSignupUser(destination, displayName) {
      // Public GoTrue signup stays disabled; the trusted gateway provisions the
      // pending auth user through the admin API only after signup authorization.
      const { error } = await createAdminClient(clientEnvironment).auth.admin.createUser({
        email: destination,
        email_confirm: false,
        app_metadata: { newone_signup_state: 'pending' },
        user_metadata: { display_name: displayName },
      });
      // A prior abandoned signup leaves an unconfirmed auth user behind;
      // recreating it must stay indistinguishable from first creation.
      if (error && error.code !== 'email_exists' && error.status !== 422) {
        throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      }
    },
    async redeemSignup(userId, destinationType, destination, correlationId) {
      const { data, error } = await asRpcClient(
        createAdminClient(clientEnvironment, { 'X-Request-Id': correlationId }),
      ).rpc('bff_redeem_signup', {
        p_user_id: userId,
        p_destination_type: destinationType,
        p_destination: destination,
      });
      if (error) {
        const code = (error as { code?: string }).code;
        if (code === 'P0002') throw new ApiError(410, 'signup_expired');
        if (code === '23505') throw new ApiError(409, 'username_taken');
        throw fromDatabaseError(error);
      }
      if (data === null || data === undefined) {
        throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      }
      const result = asObject(firstRow(data));
      if (uuid(result.user_id) !== userId) {
        throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      }
      return {
        organizationId: uuid(result.organization_id),
        username: normalizedString(result.username, { min: 4, max: 30 }) as string,
        displayName: normalizedString(result.display_name, { min: 1, max: 120 }) as string,
        preferredLanguage: oneOf(result.preferred_language, ['en', 'es', 'ko'] as const),
      };
    },
    async completeSignupUser(userId) {
      const { data, error } = await createAdminClient(clientEnvironment).auth.admin.updateUserById(
        userId,
        { app_metadata: { newone_signup_state: 'complete' } },
      );
      if (error || !data.user) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    },
    async authorizeRecoveryOtp(
      destinationType,
      destination,
      ipHash,
      installationHash,
      correlationId,
      purpose,
    ) {
      const result = firstRow(
        await invokeRpc<InviteAuthorization | InviteAuthorization[]>(
          asRpcClient(createAdminClient(clientEnvironment, { 'X-Request-Id': correlationId })),
          'bff_authorize_account_recovery_otp',
          {
            p_destination_type: destinationType,
            p_destination: destination,
            p_ip_hash: ipHash,
            p_installation_hash: installationHash,
            p_purpose: purpose,
          },
        ),
      );
      return {
        allowed: result.allowed === true,
        channelConfigured: result.channel_configured === true,
      };
    },
    async requestOtp(destinationType, destination, captchaToken) {
      if (destinationType === 'phone' && !phoneOtpEnabled) {
        throw new ApiError(503, 'dependency_unavailable', undefined, 60);
      }
      const client = createPublicClient(clientEnvironment);
      const options = {
        shouldCreateUser: OTP_SHOULD_CREATE_USER,
        ...(captchaToken ? { captchaToken } : {}),
      };
      const { error } = destinationType === 'email'
        ? await client.auth.signInWithOtp({ email: destination, options })
        : await client.auth.signInWithOtp({ phone: destination, options });
      if (error) throw new ApiError(503, 'dependency_unavailable', undefined, 30);
    },
    async generateEmailOtp(destination) {
      // Signup-code minting: GoTrue's public /otp endpoint refuses OTP
      // requests for unconfirmed users while public signups stay disabled
      // (signup_disabled), so the trusted gateway mints the linked email OTP
      // itself. generateLink never creates users, and verifyOtp accepts these
      // link-minted codes unchanged (the review flow relies on the same
      // property).
      const { data, error } = await createAdminClient(clientEnvironment).auth.admin.generateLink({
        type: 'magiclink',
        email: destination,
      });
      const linkedOtp = data.properties?.email_otp;
      if (error || typeof linkedOtp !== 'string' || linkedOtp.length === 0) {
        throw new ApiError(503, 'dependency_unavailable', undefined, 30);
      }
      return linkedOtp;
    },
    async sendCodeEmail(input) {
      await sendCodeEmailViaResend(input);
    },
    async verifyOtp(destinationType, destination, code) {
      if (destinationType === 'phone' && !phoneOtpEnabled) {
        throw new ApiError(503, 'dependency_unavailable', undefined, 60);
      }
      const client = createPublicClient(clientEnvironment);
      const { data, error } = destinationType === 'email'
        ? await client.auth.verifyOtp({ email: destination, token: code, type: 'email' })
        : await client.auth.verifyOtp({ phone: destination, token: code, type: 'sms' });
      if (error || !data.session || !data.user) throw new ApiError(401, 'unauthorized');
      const parsed = sessionTokens(data.session);
      if (
        (destinationType === 'email' ? parsed.email : parsed.phone) !== destination
      ) throw new ApiError(401, 'unauthorized');
      return parsed;
    },
    async generateReviewOtp(destination) {
      // App Store review sign-in: mint a linked email OTP for the designated,
      // pre-existing review account without any email delivery. generateLink
      // never creates users, so a missing or ineligible account stays
      // indistinguishable from an invalid code.
      const { data, error } = await createAdminClient(clientEnvironment).auth.admin.generateLink({
        type: 'magiclink',
        email: destination,
      });
      const linkedOtp = data.properties?.email_otp;
      if (error || typeof linkedOtp !== 'string' || linkedOtp.length === 0) {
        throw new ApiError(401, 'unauthorized');
      }
      return linkedOtp;
    },
    async redeemInvite(accessToken, expectedUserId, inviteToken, employeeCode) {
      const result = asObject(
        await invokeRpc(
          asRpcClient(createUserClient(clientEnvironment, accessToken)),
          'redeem_organization_invite',
          { p_token: inviteToken, p_employee_code: employeeCode },
        ),
      );
      if (result.redeemed !== true || uuid(result.user_id) !== expectedUserId) {
        throw new ApiError(401, 'unauthorized');
      }
      return {
        organizationId: uuid(result.organization_id),
        role: oneOf(result.role, ['admin', 'manager', 'member'] as const),
      };
    },
    async refresh(refreshToken) {
      const client = createPublicClient(clientEnvironment);
      const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
      if (error || !data.session || !data.user) throw new ApiError(401, 'unauthorized');
      return sessionTokens(data.session);
    },
    async bindSessionInstallation(accessToken, installation) {
      const actor = await authenticate(clientEnvironment, accessToken);
      const userAgent = installation.userAgent.slice(0, 1024) || 'unavailable';
      const userAgentHash = await hmacSha256Hex(
        runtimeConfig.networkHashKey,
        `user-agent:${userAgent}`,
      );
      const result = asObject(
        await invokeRpc(
          asRpcClient(createAdminClient(clientEnvironment)),
          'bff_bind_session_installation',
          {
            p_actor_user_id: actor.user.id,
            p_session_id: actor.claims.sessionId,
            p_installation_id: installation.installationId,
            p_platform: installation.platform,
            p_app_version: installation.appVersion,
            p_locale: installation.locale,
            p_user_agent_hash: userAgentHash,
            p_user_agent_family: userAgentFamily(userAgent),
          },
        ),
      );
      if (
        result.bound !== true || uuid(result.session_id) !== actor.claims.sessionId ||
        uuid(result.installation_id) !== installation.installationId ||
        result.platform !== installation.platform
      ) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      return { sessionId: actor.claims.sessionId };
    },
    async completeAccountRecovery(accessToken, correlationId) {
      const actor = await authenticate(clientEnvironment, accessToken);
      const result = asObject(
        await invokeRpc(
          asRpcClient(createAdminClient(clientEnvironment, { 'X-Request-Id': correlationId })),
          'bff_complete_account_recovery',
          {
            p_actor_user_id: actor.user.id,
            p_current_session_id: actor.claims.sessionId,
          },
        ),
      );
      return accountRecoveryCompletion(result, actor.claims.sessionId);
    },
    async recoveryRpc(accessToken, name, args, correlationId) {
      const actor = await authenticate(clientEnvironment, accessToken);
      return asObject(
        await invokeRpc(
          asRpcClient(createAdminClient(clientEnvironment, { 'X-Request-Id': correlationId })),
          name,
          {
            p_actor_user_id: actor.user.id,
            p_session_id: actor.claims.sessionId,
            ...args,
          },
        ),
      );
    },
    async recoveryServiceRpc(name, args, correlationId) {
      return asObject(
        await invokeRpc(
          asRpcClient(createAdminClient(clientEnvironment, { 'X-Request-Id': correlationId })),
          name,
          args,
        ),
      );
    },
    async listAdminMfaFactors(userId) {
      const { data, error } = await createAdminClient(clientEnvironment).auth.admin.mfa.listFactors(
        {
          userId,
        },
      );
      if (error || !data) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      return data;
    },
    async deleteAdminMfaFactor(userId, factorId) {
      const { error } = await createAdminClient(clientEnvironment).auth.admin.mfa.deleteFactor({
        userId,
        id: factorId,
      });
      if (error) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    },
    async deleteAccount(userId, correlationId) {
      const result = firstRow(
        await invokeRpc<DeletedAccountRow | DeletedAccountRow[]>(
          asRpcClient(createAdminClient(clientEnvironment, { 'X-Request-Id': correlationId })),
          'bff_delete_account',
          { p_user_id: userId },
        ),
      );
      if (uuid(result.user_id) !== userId) {
        throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      }
      return {
        userId,
        membershipsDeactivated: boundedCount(result.memberships_deactivated, 1000),
      };
    },
    async softDeleteAuthUser(userId) {
      // shouldSoftDelete: auth.users.deleted_at is set while the account row
      // is preserved; every authorizer and the token lifecycle hook already
      // fail closed on it.
      const { error } = await createAdminClient(clientEnvironment).auth.admin.deleteUser(
        userId,
        true,
      );
      if (error) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    },
    async revoke(accessToken) {
      const { error } = await createAdminClient(clientEnvironment).auth.admin.signOut(
        accessToken,
        'local',
      );
      if (error) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    },
    async identify(accessToken) {
      const actor = await authenticate(clientEnvironment, accessToken);
      return {
        userId: actor.user.id,
        ...authIdentity(actor.user as unknown as Record<string, unknown>),
        sessionId: actor.claims.sessionId,
        expiresAt: actor.claims.expiresAt,
      };
    },
    async inspect(accessToken) {
      const actor = await authenticate(clientEnvironment, accessToken);
      return {
        userId: actor.user.id,
        ...authIdentity(actor.user as unknown as Record<string, unknown>),
        sessionId: actor.claims.sessionId,
        expiresAt: actor.claims.expiresAt,
        issuedAt: actor.claims.issuedAt,
        aal: actor.claims.aal,
        memberships: await activeMemberships(accessToken, actor.user.id),
      };
    },
    async listMfa(accessToken, refreshToken) {
      const { data, error } = await (await mfaClient(accessToken, refreshToken)).auth.mfa
        .listFactors();
      if (error || !data) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      return data;
    },
    async enrollMfa(accessToken, refreshToken, friendlyName) {
      const { data, error } = await (await mfaClient(accessToken, refreshToken)).auth.mfa.enroll({
        factorType: 'totp',
        ...(friendlyName ? { friendlyName } : {}),
      });
      if (error || !data) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      return data;
    },
    async challengeMfa(accessToken, refreshToken, factorId) {
      const { data, error } = await (await mfaClient(accessToken, refreshToken)).auth.mfa.challenge(
        {
          factorId,
        },
      );
      if (error || !data) throw new ApiError(401, 'unauthorized');
      return data;
    },
    async verifyMfa(accessToken, refreshToken, factorId, challengeId, code) {
      const { data, error } = await (await mfaClient(accessToken, refreshToken)).auth.mfa.verify({
        factorId,
        challengeId,
        code,
      });
      if (error || !data) throw new ApiError(401, 'unauthorized');
      return sessionTokens(data);
    },
    async unenrollMfa(accessToken, refreshToken, factorId) {
      const { error } = await (await mfaClient(accessToken, refreshToken)).auth.mfa.unenroll({
        factorId,
      });
      if (error) throw new ApiError(401, 'unauthorized');
    },
  };
}

function parseEmail(value: unknown): string {
  const email = (normalizedString(value, { min: 3, max: 254 }) as string).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new ApiError(400, 'bad_request');
  return email;
}

function parsePhone(value: unknown): string {
  const phone = normalizedString(value, { min: 9, max: 16 }) as string;
  if (!PHONE_PATTERN.test(phone)) throw new ApiError(400, 'bad_request');
  return phone;
}

function parseDestination(destinationType: DestinationType, value: unknown): string {
  return destinationType === 'email' ? parseEmail(value) : parsePhone(value);
}

function optionalEmployeeCode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const code = normalizedString(value, { min: 3, max: 64, trim: false }) as string;
  if (!EMPLOYEE_CODE_PATTERN.test(code)) throw new ApiError(400, 'bad_request');
  return code;
}

interface ParsedOtpIdentity {
  destinationType: DestinationType;
  destination: string;
  inviteToken: string | null;
  employeeCode: string | null;
  installationId: string;
  appVersion: string | null;
  locale: string | null;
}

const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function optionalClientText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  return normalizedString(value, { min: 1, max, trim: false }) as string;
}

function optionalLocale(value: unknown): string | null {
  const locale = optionalClientText(value, 35);
  if (locale !== null && !LOCALE_PATTERN.test(locale)) throw new ApiError(400, 'bad_request');
  return locale;
}

function parseOtpIdentity(body: Record<string, unknown>): ParsedOtpIdentity {
  const legacyEmail = body.email !== null && body.email !== undefined;
  if (legacyEmail && (body.destinationType !== undefined || body.destination !== undefined)) {
    throw new ApiError(400, 'bad_request');
  }
  const destinationType = legacyEmail
    ? 'email'
    : oneOf(body.destinationType, ['email', 'phone'] as const);
  const destination = parseDestination(
    destinationType,
    legacyEmail ? body.email : body.destination,
  );
  return {
    destinationType,
    destination,
    inviteToken: optionalInviteToken(body.invitationToken),
    employeeCode: optionalEmployeeCode(body.employeeCode),
    installationId: uuid(body.installationId),
    appVersion: optionalClientText(body.appVersion, 80),
    locale: optionalLocale(body.locale),
  };
}

async function installationFingerprint(config: RuntimeConfig, installationId: string) {
  return await hmacSha256Hex(config.networkHashKey, `installation:${installationId}`);
}

function publicUser(userId: string, identity: AuthIdentity): Record<string, unknown> {
  return {
    id: userId,
    destinationType: identity.destinationType,
    email: identity.email,
    phone: identity.phone,
  };
}

function identityMatches(
  identity: AuthIdentity,
  destinationType: DestinationType,
  destination: string,
): boolean {
  return (destinationType === 'email' ? identity.email : identity.phone) === destination;
}

function isReviewDestination(
  review: ReviewAccountConfig | null,
  identity: Pick<ParsedOtpIdentity, 'destinationType' | 'destination'>,
): boolean {
  // App Store review sign-in destination. parseEmail already lowercased the
  // destination, so this equality is case-insensitive.
  return review !== null && identity.destinationType === 'email' &&
    safeEqual(identity.destination, review.email);
}

export function isReviewCredential(
  review: ReviewAccountConfig | null,
  identity: Pick<ParsedOtpIdentity, 'destinationType' | 'destination'>,
  code: string,
): boolean {
  if (review === null) return false;
  // Both factors use the constant-time comparison: a submitted code must
  // never leak the configured static code through timing.
  return isReviewDestination(review, identity) && safeEqual(code, review.code);
}

async function authorizeOtp(
  dependencies: AuthDependencies,
  identity: ParsedOtpIdentity,
  ipHash: string,
  installationHash: string,
  correlationId: string,
  purpose: OtpPurpose,
): Promise<OtpAuthorization> {
  return identity.inviteToken
    ? await dependencies.authorizeInviteOtp(
      identity.inviteToken,
      identity.destinationType,
      identity.destination,
      identity.employeeCode,
      ipHash,
      installationHash,
      correlationId,
      purpose,
    )
    : await dependencies.authorizeMemberOtp(
      identity.destinationType,
      identity.destination,
      ipHash,
      installationHash,
      correlationId,
      purpose,
    );
}

interface CompletedOtpAuthentication {
  session: SessionTokens;
  active: ActiveSession;
  invite: RedeemedInvite | null;
}

function otpChannelConfigured(
  dependencies: AuthDependencies,
  identity: ParsedOtpIdentity,
  _authorization: OtpAuthorization,
): boolean {
  // This public bit is global channel configuration only. It must never vary
  // with invitation, employee, membership, suspension, or rate-limit state.
  // The database authorizer predates the Edge-owned phone provider switch and
  // intentionally does not have access to runtime secrets. The Edge setting is
  // therefore the single source of truth for global SMS availability.
  return identity.destinationType === 'email'
    ? true
    : dependencies.phoneOtpEnabled;
}

type OtpMailFailureCode = 'otp_mail_failed' | 'recovery_mail_failed' | 'signup_mail_failed';

interface OtpDeliveryContext {
  path: string;
  correlationId: string;
  failureCode: OtpMailFailureCode;
}

/**
 * Gateway-owned email code delivery. GoTrue's signInWithOtp mailer sends its
 * default magic-link template (a link at the project Site URL) that the
 * code-based apps can never consume, so every email code is minted through
 * the admin generateLink API and delivered as the branded Resend mail in the
 * caller's language.
 *
 * Minting and delivery failures are never masked: the caller receives an
 * explicit 503 code_delivery_failed (a delivery outage must be visible to
 * users, not hidden behind a generic receipt) and the send-site-specific
 * outcome is recorded without addresses or codes. Only eligible destinations
 * reach this point, so unknown or ineligible accounts still get the generic
 * envelope from their route.
 */
async function deliverEmailOtp(
  dependencies: AuthDependencies,
  destination: string,
  locale: string | null,
  context: OtpDeliveryContext,
): Promise<void> {
  try {
    const code = await dependencies.generateEmailOtp(destination);
    await dependencies.sendCodeEmail({ to: destination, code, locale: locale ?? 'en' });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'newone_auth_failure',
      correlation_id: context.correlationId,
      path: context.path,
      status: asApiError(error).status,
      code: context.failureCode,
    }));
    throw new ApiError(503, 'code_delivery_failed');
  }
}

/**
 * OTP delivery for the member and recovery request routes. Email codes are
 * gateway-owned (deliverEmailOtp). SMS stays a GoTrue channel behind the
 * phoneOtpEnabled switch, and the caller's CAPTCHA token only travels with it.
 */
async function deliverOtp(
  dependencies: AuthDependencies,
  identity: Pick<ParsedOtpIdentity, 'destinationType' | 'destination'>,
  locale: string | null,
  captcha: string | null,
  context: OtpDeliveryContext,
): Promise<void> {
  if (identity.destinationType === 'phone') {
    try {
      await dependencies.requestOtp('phone', identity.destination, captcha);
    } catch {
      // SMS delivery and CAPTCHA failures are deliberately indistinguishable
      // from unknown or ineligible accounts.
    }
    return;
  }
  await deliverEmailOtp(dependencies, identity.destination, locale, context);
}

async function completeOtpAuthentication(
  dependencies: AuthDependencies,
  identity: ParsedOtpIdentity,
  code: string,
  ipHash: string,
  installationHash: string,
  correlationId: string,
  installation: SessionInstallationInput,
): Promise<CompletedOtpAuthentication> {
  const authorization = await authorizeOtp(
    dependencies,
    identity,
    ipHash,
    installationHash,
    correlationId,
    'verify',
  );
  if (!otpChannelConfigured(dependencies, identity, authorization)) {
    throw new ApiError(409, 'delivery_channel_unavailable');
  }
  if (!authorization.allowed) throw new ApiError(401, 'unauthorized');
  // App Store review sign-in: the static code never reaches GoTrue. A linked
  // email OTP minted for the pre-existing review account is verified through
  // the normal dependency instead, so every downstream check (identity match,
  // installation binding, revocation, lifecycle hook) applies unchanged.
  const session = await dependencies.verifyOtp(
    identity.destinationType,
    identity.destination,
    identity.inviteToken === null &&
      isReviewCredential(dependencies.reviewAccount, identity, code)
      ? await dependencies.generateReviewOtp(identity.destination)
      : code,
  );
  if (!identityMatches(session, identity.destinationType, identity.destination)) {
    try {
      await dependencies.revoke(session.accessToken);
    } catch {
      // A mismatched session cannot pass the BFF destination checks.
    }
    throw new ApiError(401, 'unauthorized');
  }

  let invite: RedeemedInvite | null = null;
  try {
    const binding = await dependencies.bindSessionInstallation(session.accessToken, installation);
    if (identity.inviteToken) {
      invite = await dependencies.redeemInvite(
        session.accessToken,
        session.userId,
        identity.inviteToken,
        identity.employeeCode,
      );
    } else if (identity.employeeCode !== null) {
      throw new ApiError(401, 'unauthorized');
    }
    const active = await dependencies.inspect(session.accessToken);
    if (
      active.userId !== session.userId || active.sessionId !== binding.sessionId ||
      !identityMatches(active, identity.destinationType, identity.destination) ||
      (invite !== null &&
        !active.memberships.some((membership) =>
          membership.organizationId === invite?.organizationId
        ))
    ) throw new ApiError(401, 'unauthorized');
    return { session, active, invite };
  } catch (error) {
    try {
      await dependencies.revoke(session.accessToken);
    } catch {
      // No Newone data path accepts a session without active membership.
    }
    if (error instanceof ApiError && error.code === 'rate_limited') throw error;
    throw new ApiError(401, 'unauthorized');
  }
}

interface SignupProfile {
  username: string;
  displayName: string;
  language: 'en' | 'es' | 'ko';
}

function parseSignupIdentity(body: Record<string, unknown>): ParsedOtpIdentity {
  return {
    destinationType: 'email',
    destination: parseEmail(body.destination),
    inviteToken: null,
    employeeCode: null,
    installationId: uuid(body.installationId),
    appVersion: optionalClientText(body.appVersion, 80),
    locale: optionalLocale(body.locale),
  };
}

function parseSignupProfile(body: Record<string, unknown>): SignupProfile {
  if (typeof body.username !== 'string') throw new ApiError(400, 'invalid_username');
  const username = body.username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) throw new ApiError(400, 'invalid_username');
  if (typeof body.displayName !== 'string') throw new ApiError(400, 'invalid_display_name');
  const displayName = body.displayName.trim().normalize('NFC');
  const displayNameLength = Array.from(displayName).length;
  if (displayNameLength < 1 || displayNameLength > 120) {
    throw new ApiError(400, 'invalid_display_name');
  }
  if (body.language !== 'en' && body.language !== 'es' && body.language !== 'ko') {
    throw new ApiError(400, 'invalid_language');
  }
  return { username, displayName, language: body.language };
}

function requireSignupAuthorization(authorization: SignupAuthorization): void {
  if (authorization.allowed && authorization.reason === 'ok') return;
  switch (authorization.reason) {
    case 'rate_limited':
      throw new ApiError(
        429,
        'rate_limited',
        undefined,
        Math.max(1, authorization.retryAfterSeconds || 60),
      );
    case 'invalid_destination':
      // Mirrors the member flow: malformed destinations fail with the same
      // generic validation error regardless of account state.
      throw new ApiError(400, 'bad_request');
    case 'invalid_username':
      throw new ApiError(400, 'invalid_username');
    case 'username_reserved':
      throw new ApiError(409, 'username_reserved');
    case 'invalid_language':
      throw new ApiError(400, 'invalid_language');
    case 'invalid_display_name':
      throw new ApiError(400, 'invalid_display_name');
    case 'username_taken':
      throw new ApiError(409, 'username_taken');
    case 'reservation_expired':
      throw new ApiError(410, 'signup_expired');
    default:
      throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

interface CompletedSignupAuthentication {
  session: SessionTokens;
  active: ActiveSession;
  signup: RedeemedSignup;
}

async function completeSignupAuthentication(
  dependencies: AuthDependencies,
  identity: ParsedOtpIdentity,
  code: string,
  correlationId: string,
  installation: SessionInstallationInput,
): Promise<CompletedSignupAuthentication> {
  const session = await dependencies.verifyOtp(
    identity.destinationType,
    identity.destination,
    code,
  );
  if (!identityMatches(session, identity.destinationType, identity.destination)) {
    try {
      await dependencies.revoke(session.accessToken);
    } catch {
      // A mismatched session cannot pass the BFF destination checks.
    }
    throw new ApiError(401, 'unauthorized');
  }
  let signup: RedeemedSignup;
  try {
    // OTP verification just confirmed the destination; redemption requires the
    // confirmed account. A redemption failure must never issue a session: the
    // confirmed but memberless auth user stays inert until signup restarts.
    signup = await dependencies.redeemSignup(
      session.userId,
      identity.destinationType,
      identity.destination,
      correlationId,
    );
    await dependencies.completeSignupUser(session.userId);
  } catch (error) {
    try {
      await dependencies.revoke(session.accessToken);
    } catch {
      // No Newone data path accepts a session without active membership.
    }
    throw asApiError(error);
  }
  try {
    const binding = await dependencies.bindSessionInstallation(session.accessToken, installation);
    const active = await dependencies.inspect(session.accessToken);
    if (
      active.userId !== session.userId || active.sessionId !== binding.sessionId ||
      !identityMatches(active, identity.destinationType, identity.destination) ||
      !active.memberships.some((membership) =>
        membership.organizationId === signup.organizationId
      )
    ) throw new ApiError(401, 'unauthorized');
    return { session, active, signup };
  } catch (error) {
    try {
      await dependencies.revoke(session.accessToken);
    } catch {
      // No Newone data path accepts a session without active membership.
    }
    if (error instanceof ApiError && error.code === 'rate_limited') throw error;
    throw new ApiError(401, 'unauthorized');
  }
}

function completedAuthResponse(
  meta: RequestMeta,
  config: RuntimeConfig,
  native: boolean,
  session: SessionTokens,
  active: ActiveSession,
  extra: Record<string, unknown>,
): Response {
  const responseBody: Record<string, unknown> = {
    authenticated: true,
    user: publicUser(session.userId, active),
    memberships: active.memberships,
    sessionId: active.sessionId,
    aal: active.aal,
    ...extra,
  };
  if (native) {
    responseBody.session = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
    };
    return jsonResponse(meta, 200, responseBody);
  }
  const csrfToken = randomBase64Url();
  responseBody.csrfToken = csrfToken;
  return appendSessionCookies(jsonResponse(meta, 200, responseBody), config, session, csrfToken);
}

interface CompletedRecoveryAuthentication {
  session: SessionTokens;
  active: ActiveSession;
  completion: AccountRecoveryCompletion;
}

async function completeRecoveryAuthentication(
  dependencies: AuthDependencies,
  identity: ParsedOtpIdentity,
  code: string,
  ipHash: string,
  installationHash: string,
  correlationId: string,
  installation: SessionInstallationInput,
): Promise<CompletedRecoveryAuthentication> {
  if (identity.inviteToken !== null || identity.employeeCode !== null) {
    throw new ApiError(400, 'bad_request');
  }
  const authorization = await dependencies.authorizeRecoveryOtp(
    identity.destinationType,
    identity.destination,
    ipHash,
    installationHash,
    correlationId,
    'verify',
  );
  if (!otpChannelConfigured(dependencies, identity, authorization)) {
    throw new ApiError(401, 'unauthorized');
  }
  if (!authorization.allowed) throw new ApiError(401, 'unauthorized');
  // Syntactically invalid code attempts still consume the recovery-verify
  // budgets, but never reach the Auth provider.
  if (!OTP_PATTERN.test(code)) throw new ApiError(401, 'unauthorized');
  const session = await dependencies.verifyOtp(
    identity.destinationType,
    identity.destination,
    code,
  );
  if (!identityMatches(session, identity.destinationType, identity.destination)) {
    try {
      await dependencies.revoke(session.accessToken);
    } catch {
      // The mismatched principal never receives a Newone session response.
    }
    throw new ApiError(401, 'unauthorized');
  }
  try {
    const binding = await dependencies.bindSessionInstallation(session.accessToken, installation);
    const active = await dependencies.inspect(session.accessToken);
    if (
      active.userId !== session.userId || active.sessionId !== binding.sessionId ||
      !identityMatches(active, identity.destinationType, identity.destination) ||
      active.memberships.length === 0
    ) throw new ApiError(401, 'unauthorized');
    const completion = await dependencies.completeAccountRecovery(
      session.accessToken,
      correlationId,
    );
    if (completion.currentSessionId !== active.sessionId) {
      throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    }
    return { session, active, completion };
  } catch (error) {
    try {
      await dependencies.revoke(session.accessToken);
    } catch {
      // A partial recovery never leaves an unbound data-plane session usable.
    }
    if (error instanceof ApiError && error.code === 'rate_limited') throw error;
    throw new ApiError(401, 'unauthorized');
  }
}

function userAgentFamily(userAgent: string): UserAgentFamily {
  const value = userAgent.toLowerCase();
  if (value.includes('iphone')) return 'iphone';
  if (value.includes('ipad')) return 'ipad';
  if (value.includes('android')) return 'android';
  if (value.includes('mobile')) return 'mobile';
  if (value === 'unavailable') return 'unknown';
  return 'desktop';
}

function sessionInstallation(
  request: Request,
  identity: Pick<ParsedOtpIdentity, 'installationId' | 'appVersion' | 'locale'>,
  platform: SessionInstallationInput['platform'],
): SessionInstallationInput {
  return {
    installationId: identity.installationId,
    platform,
    appVersion: identity.appVersion,
    locale: identity.locale,
    userAgent: (request.headers.get('user-agent') ?? 'unavailable').slice(0, 1024),
  };
}

function parseInviteToken(value: unknown): string {
  const token = normalizedString(value, { min: 64, max: 64 }) as string;
  if (!INVITE_TOKEN_PATTERN.test(token)) throw new ApiError(400, 'bad_request');
  return token;
}

function optionalInviteToken(value: unknown): string | null {
  return value === null || value === undefined ? null : parseInviteToken(value);
}

function captchaRequiredFor(mode: CaptchaMode, native: boolean): boolean {
  // 'web' waives token presence only on the origin-less native paths; the
  // browser BFF path keeps proving a challenge token. A provided token is
  // still shape-validated in every mode by captchaToken below.
  return mode === 'all' || (mode === 'web' && !native);
}

function captchaToken(value: unknown, required: boolean): string | null {
  if (value === null || value === undefined) {
    if (required) throw new ApiError(400, 'bad_request');
    return null;
  }
  const token = normalizedString(value, { min: 20, max: 4096, trim: false }) as string;
  if (!/^[\x21-\x7e]+$/.test(token)) throw new ApiError(400, 'bad_request');
  return token;
}

function authPath(url: string): string {
  const pathname = new URL(url).pathname;
  const marker = pathname.indexOf('/v2/auth/');
  return marker >= 0 ? pathname.slice(marker) : pathname;
}

function fallbackMeta(request: Request): RequestMeta {
  return { requestId: requestId(request), origin: null, corsHeaders: new Headers() };
}

function isNativeOtpPath(path: string): boolean {
  return path === '/v2/auth/native/otp/request' || path === '/v2/auth/native/otp/verify' ||
    path === '/v2/auth/native/recovery/otp/request' ||
    path === '/v2/auth/native/recovery/otp/verify' ||
    path === '/v2/auth/native/signup/request' ||
    path === '/v2/auth/native/signup/verify';
}

function nativeInstallationId(request: Request): string {
  return uuid(request.headers.get('x-newone-installation-id'));
}

function requireAllowedRequestContext(
  request: Request,
  meta: RequestMeta,
  path: string,
  clientEnvironment: ClientEnvironment,
): void {
  if (meta.origin) return;
  if (isNativeOtpPath(path)) {
    const platform = request.headers.get('x-newone-client-platform');
    const apiKey = request.headers.get('apikey') ?? '';
    if (
      (platform !== 'ios' && platform !== 'android') || request.headers.has('authorization') ||
      request.headers.has('cookie') || !safeEqual(apiKey, clientEnvironment.publishableKey)
    ) throw new ApiError(403, 'origin_not_allowed');
    nativeInstallationId(request);
    return;
  }
  if (
    (path === '/v2/auth/invitations/redeem' ||
      path === '/v2/auth/account/delete' ||
      path.startsWith('/v2/auth/recovery/cases')) &&
    /^Bearer\s+[^\s]+$/i.test(request.headers.get('authorization') ?? '') &&
    !request.headers.has('cookie')
  ) return;
  throw new ApiError(403, 'origin_not_allowed');
}

function appendSessionCookies(
  response: Response,
  config: RuntimeConfig,
  session: SessionTokens,
  csrfToken: string,
): Response {
  response.headers.append(
    'Set-Cookie',
    cookie(config.accessCookieName, session.accessToken, { maxAge: session.expiresIn }),
  );
  response.headers.append(
    'Set-Cookie',
    cookie(config.refreshCookieName, session.refreshToken, { maxAge: REFRESH_COOKIE_MAX_AGE }),
  );
  response.headers.append(
    'Set-Cookie',
    cookie(config.csrfCookieName, csrfToken, {
      maxAge: REFRESH_COOKIE_MAX_AGE,
      httpOnly: false,
    }),
  );
  return response;
}

function clearSessionCookies(response: Response, config: RuntimeConfig): Response {
  response.headers.append('Set-Cookie', cookie(config.accessCookieName, '', { maxAge: 0 }));
  response.headers.append('Set-Cookie', cookie(config.refreshCookieName, '', { maxAge: 0 }));
  response.headers.append(
    'Set-Cookie',
    cookie(config.csrfCookieName, '', { maxAge: 0, httpOnly: false }),
  );
  return response;
}

function refreshCredential(request: Request, config: RuntimeConfig): string {
  const raw = request.headers.get('cookie') ?? '';
  const encodedName = `${config.refreshCookieName}=`;
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(encodedName)) continue;
    let value: string;
    try {
      value = decodeURIComponent(trimmed.slice(encodedName.length));
    } catch {
      throw new ApiError(401, 'unauthorized');
    }
    if (value.length >= 20 && value.length <= 2048) return value;
  }
  throw new ApiError(401, 'unauthorized');
}

async function emptyJson(request: Request, config: RuntimeConfig): Promise<void> {
  const body = asObject((await parseJson(request, config)).value);
  onlyKeys(body, []);
}

function mfaFactor(value: unknown): Record<string, unknown> {
  const row = asObject(value);
  return {
    id: uuid(row.id),
    type: oneOf(row.factor_type, ['totp'] as const),
    status: oneOf(row.status, ['unverified', 'verified'] as const),
    friendlyName: row.friendly_name === null || row.friendly_name === undefined
      ? null
      : normalizedString(row.friendly_name, { max: 100 }),
    createdAt: normalizedString(row.created_at, { min: 10, max: 40 }),
    updatedAt: normalizedString(row.updated_at, { min: 10, max: 40 }),
  };
}

interface AdminMfaFactor {
  id: string;
  type: 'totp';
  status: 'unverified' | 'verified';
}

function adminMfaFactors(value: unknown): AdminMfaFactor[] {
  const row = asObject(value);
  if (!Array.isArray(row.factors) || row.factors.length > 50) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  const factors: AdminMfaFactor[] = [];
  for (const entry of row.factors) {
    const factor = asObject(entry);
    if (factor.factor_type !== 'totp') continue;
    factors.push({
      id: uuid(factor.id),
      type: 'totp',
      status: oneOf(factor.status, ['unverified', 'verified'] as const),
    });
  }
  return factors;
}

function recoveryResponse(value: Record<string, unknown>): Record<string, unknown> {
  const visit = (entry: unknown, depth: number): void => {
    if (depth > 8) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    if (Array.isArray(entry)) {
      if (entry.length > 100) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      for (const child of entry) visit(child, depth + 1);
      return;
    }
    if (entry === null || typeof entry !== 'object') return;
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      if (
        ['verification_reference_hash', 'execution_token', 'access_token', 'refresh_token']
          .includes(key)
      ) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  if (JSON.stringify(value).length > 65536) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  return value;
}

interface RecoveryExecution {
  caseId: string;
  status: 'executing';
  targetUserId: string;
  factorId: string;
  factorType: 'totp';
  executionVersion: string;
  resumed: boolean;
}

function recoveryExecution(value: Record<string, unknown>): RecoveryExecution | null {
  if (value.status === 'completed' && value.already_completed === true) return null;
  if (
    value.status !== 'executing' || typeof value.resumed !== 'boolean' ||
    value.factor_deletion_required !== true || value.finalization_required !== true
  ) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  return {
    caseId: uuid(value.case_id),
    status: 'executing',
    targetUserId: uuid(value.target_user_id),
    factorId: uuid(value.factor_id),
    factorType: oneOf(value.factor_type, ['totp'] as const),
    executionVersion: uuid(value.execution_version),
    resumed: value.resumed,
  };
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ApiError(400, 'bad_request');
  return value;
}

function recoveryCaseRoute(path: string): { caseId: string; action: string } | null {
  const match = path.match(
    /^\/v2\/auth\/recovery\/cases\/([0-9a-f-]{36})\/(verify|approve|reject|execute)$/i,
  );
  return match ? { caseId: uuid(match[1]), action: match[2]!.toLowerCase() } : null;
}

function mfaFactors(value: unknown): unknown {
  const row = asObject(value);
  if (!Array.isArray(row.all) || row.all.length > 50) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  const totp = row.all.filter((entry) => {
    const factor = asObject(entry);
    return factor.factor_type === 'totp';
  });
  if (totp.length > 20) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  return { factors: totp.map(mfaFactor) };
}

function mfaEnrollment(value: unknown): unknown {
  const row = asObject(value);
  const totp = asObject(row.totp);
  return {
    factor: {
      id: uuid(row.id),
      type: oneOf(row.type, ['totp'] as const),
      friendlyName: row.friendly_name === null || row.friendly_name === undefined
        ? null
        : normalizedString(row.friendly_name, { max: 100 }),
      totp: {
        qrCode: normalizedString(totp.qr_code, { min: 20, max: 100000, trim: false }),
        secret: normalizedString(totp.secret, { min: 16, max: 512, trim: false }),
        uri: normalizedString(totp.uri, { min: 20, max: 4096, trim: false }),
      },
    },
  };
}

function mfaChallenge(value: unknown): unknown {
  const row = asObject(value);
  if (!Number.isSafeInteger(row.expires_at)) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  return {
    challenge: {
      id: uuid(row.id),
      type: oneOf(row.type, ['totp'] as const),
      expiresAt: row.expires_at,
    },
  };
}

export function createAuthHandler(
  dependencyFactory: () => AuthDependencies = defaultAuthDependencies,
): (request: Request) => Promise<Response> {
  let dependencies: AuthDependencies | undefined;
  return async (request: Request): Promise<Response> => {
    let meta = fallbackMeta(request);
    try {
      dependencies ??= dependencyFactory();
      const config = dependencies.runtimeConfig;
      ensureSecureTransport(request, config);
      meta = buildRequestMeta(request, config);
      const path = authPath(request.url);
      requireAllowedRequestContext(request, meta, path, dependencies.clientEnvironment);
      if (request.method === 'OPTIONS') return preflight(meta);

      if (
        request.method === 'POST' &&
        (path === '/v2/auth/recovery/otp/request' ||
          path === '/v2/auth/native/recovery/otp/request')
      ) {
        const startedAt = Date.now();
        try {
          const native = path === '/v2/auth/native/recovery/otp/request';
          const body = asObject((await parseJson(request, config)).value);
          onlyKeys(body, [
            ...(native ? [] : ['email']),
            'destinationType',
            'destination',
            'installationId',
            'appVersion',
            'locale',
            'captchaToken',
          ]);
          const identity = parseOtpIdentity(body);
          if (
            identity.inviteToken !== null || identity.employeeCode !== null ||
            (native && identity.installationId !== nativeInstallationId(request))
          ) throw new ApiError(400, 'bad_request');
          const captcha = captchaToken(
            body.captchaToken,
            captchaRequiredFor(dependencies.captchaMode, native),
          );
          const ipHash = await networkFingerprint(request, config);
          const installationHash = await installationFingerprint(
            config,
            identity.installationId,
          );
          const authorization = await dependencies.authorizeRecoveryOtp(
            identity.destinationType,
            identity.destination,
            ipHash,
            installationHash,
            meta.requestId,
            'request',
          );
          const channelConfigured = otpChannelConfigured(
            dependencies,
            identity,
            authorization,
          );
          if (authorization.allowed && channelConfigured) {
            // Rate, membership, and identity state share the same signed-out
            // envelope; an email delivery failure for an eligible account is
            // surfaced by deliverOtp as 503 code_delivery_failed.
            await deliverOtp(dependencies, identity, identity.locale, captcha, {
              path,
              correlationId: meta.requestId,
              failureCode: 'recovery_mail_failed',
            });
          }
          return jsonResponse(meta, 202, {
            accepted: true,
            channel: { type: identity.destinationType, configured: channelConfigured },
          });
        } finally {
          await dependencies.settleOtpRequest(startedAt);
        }
      }

      if (
        request.method === 'POST' &&
        (path === '/v2/auth/recovery/otp/verify' ||
          path === '/v2/auth/native/recovery/otp/verify')
      ) {
        const startedAt = Date.now();
        try {
          const native = path === '/v2/auth/native/recovery/otp/verify';
          const body = asObject((await parseJson(request, config)).value);
          onlyKeys(body, [
            ...(native ? [] : ['email']),
            'destinationType',
            'destination',
            'installationId',
            'appVersion',
            'locale',
            'code',
          ]);
          const identity = parseOtpIdentity(body);
          if (native && identity.installationId !== nativeInstallationId(request)) {
            throw new ApiError(400, 'bad_request');
          }
          const code = normalizedString(body.code, { min: 1, max: 64, trim: false }) as string;
          const ipHash = await networkFingerprint(request, config);
          const installationHash = await installationFingerprint(
            config,
            identity.installationId,
          );
          const completed = await completeRecoveryAuthentication(
            dependencies,
            identity,
            code,
            ipHash,
            installationHash,
            meta.requestId,
            sessionInstallation(
              request,
              identity,
              native
                ? oneOf(
                  request.headers.get('x-newone-client-platform'),
                  ['ios', 'android'] as const,
                )
                : 'web',
            ),
          );
          const { session, active, completion } = completed;
          const responseBody: Record<string, unknown> = {
            authenticated: true,
            recovered: true,
            user: publicUser(session.userId, active),
            memberships: active.memberships,
            sessionId: active.sessionId,
            aal: active.aal,
            recovery: {
              currentSessionPreserved: completion.currentSessionPreserved,
              otherSessionsRevoked: completion.otherSessionsRevoked,
              securityEventRecorded: completion.securityEventRecorded,
              securityNoticeState: completion.securityNoticeState,
            },
          };
          if (native) {
            responseBody.session = {
              accessToken: session.accessToken,
              refreshToken: session.refreshToken,
              expiresIn: session.expiresIn,
            };
            return jsonResponse(meta, 200, responseBody);
          }
          const csrfToken = randomBase64Url();
          responseBody.csrfToken = csrfToken;
          return appendSessionCookies(
            jsonResponse(meta, 200, responseBody),
            config,
            session,
            csrfToken,
          );
        } finally {
          await dependencies.settleOtpRequest(startedAt);
        }
      }

      if (
        request.method === 'POST' &&
        (path === '/v2/auth/signup/request' || path === '/v2/auth/native/signup/request')
      ) {
        const startedAt = Date.now();
        try {
          const native = path === '/v2/auth/native/signup/request';
          const body = asObject((await parseJson(request, config)).value);
          onlyKeys(body, [
            'destination',
            'username',
            'displayName',
            'language',
            'installationId',
            'appVersion',
            'locale',
            'captchaToken',
          ]);
          const identity = parseSignupIdentity(body);
          if (native && identity.installationId !== nativeInstallationId(request)) {
            throw new ApiError(400, 'bad_request');
          }
          const profile = parseSignupProfile(body);
          // Token presence and shape are enforced before any authorization or
          // delivery. Signup is email-only and email delivery is gateway-owned,
          // so the token has no downstream consumer on this route.
          captchaToken(body.captchaToken, captchaRequiredFor(dependencies.captchaMode, native));
          const ipHash = await networkFingerprint(request, config);
          const installationHash = await installationFingerprint(
            config,
            identity.installationId,
          );
          const authorization = await dependencies.authorizeSignupOtp(
            identity.destinationType,
            identity.destination,
            profile.username,
            profile.displayName,
            profile.language,
            ipHash,
            installationHash,
            meta.requestId,
            'request',
          );
          if (authorization.reason === 'account_exists') {
            // Silent downgrade to the member sign-in flow: the generic signup
            // response must never reveal whether an account already exists.
            const memberAuthorization = await dependencies.authorizeMemberOtp(
              identity.destinationType,
              identity.destination,
              ipHash,
              installationHash,
              meta.requestId,
              'request',
            );
            if (
              memberAuthorization.allowed &&
              otpChannelConfigured(dependencies, identity, memberAuthorization)
            ) {
              // The returning member receives the same branded code email, in
              // the same signup language, as a fresh signup would: a different
              // sender, template, or language would reveal account existence.
              await deliverEmailOtp(dependencies, identity.destination, profile.language, {
                path,
                correlationId: meta.requestId,
                failureCode: 'otp_mail_failed',
              });
            }
            return jsonResponse(meta, 202, { status: 'code_sent' });
          }
          requireSignupAuthorization(authorization);
          await dependencies.ensureSignupUser(identity.destination, profile.displayName);
          // Mid-signup users are unconfirmed, so GoTrue's public /otp endpoint
          // would reject them with signup_disabled. The gateway owns
          // signup-code delivery end to end instead.
          await deliverEmailOtp(dependencies, identity.destination, profile.language, {
            path,
            correlationId: meta.requestId,
            failureCode: 'signup_mail_failed',
          });
          return jsonResponse(meta, 202, { status: 'code_sent' });
        } finally {
          await dependencies.settleOtpRequest(startedAt);
        }
      }

      if (
        request.method === 'POST' &&
        (path === '/v2/auth/signup/verify' || path === '/v2/auth/native/signup/verify')
      ) {
        const startedAt = Date.now();
        try {
          const native = path === '/v2/auth/native/signup/verify';
          const body = asObject((await parseJson(request, config)).value);
          onlyKeys(body, ['destination', 'installationId', 'appVersion', 'locale', 'code']);
          const identity = parseSignupIdentity(body);
          if (native && identity.installationId !== nativeInstallationId(request)) {
            throw new ApiError(400, 'bad_request');
          }
          const code = normalizedString(body.code, { min: 6, max: 6, trim: false }) as string;
          if (!OTP_PATTERN.test(code)) throw new ApiError(401, 'unauthorized');
          const ipHash = await networkFingerprint(request, config);
          const installationHash = await installationFingerprint(
            config,
            identity.installationId,
          );
          const installation = sessionInstallation(
            request,
            identity,
            native
              ? oneOf(
                request.headers.get('x-newone-client-platform'),
                ['ios', 'android'] as const,
              )
              : 'web',
          );
          const authorization = await dependencies.authorizeSignupOtp(
            identity.destinationType,
            identity.destination,
            null,
            null,
            null,
            ipHash,
            installationHash,
            meta.requestId,
            'verify',
          );
          if (authorization.reason === 'account_exists') {
            // The destination already belongs to an active member: complete a
            // plain member sign-in with the member verify response shape.
            const { session, active } = await completeOtpAuthentication(
              dependencies,
              identity,
              code,
              ipHash,
              installationHash,
              meta.requestId,
              installation,
            );
            return completedAuthResponse(meta, config, native, session, active, {});
          }
          requireSignupAuthorization(authorization);
          const { session, active, signup } = await completeSignupAuthentication(
            dependencies,
            identity,
            code,
            meta.requestId,
            installation,
          );
          return completedAuthResponse(meta, config, native, session, active, {
            signup: { username: signup.username, organizationId: signup.organizationId },
          });
        } finally {
          await dependencies.settleOtpRequest(startedAt);
        }
      }

      if (request.method === 'POST' && path === '/v2/auth/otp/request') {
        const startedAt = Date.now();
        const body = asObject((await parseJson(request, config)).value);
        onlyKeys(body, [
          'email',
          'destinationType',
          'destination',
          'invitationToken',
          'employeeCode',
          'installationId',
          'appVersion',
          'locale',
          'captchaToken',
        ]);
        const identity = parseOtpIdentity(body);
        const captcha = captchaToken(
          body.captchaToken,
          captchaRequiredFor(dependencies.captchaMode, false),
        );
        const ipHash = await networkFingerprint(request, config);
        const installationHash = await installationFingerprint(config, identity.installationId);
        const authorization = await authorizeOtp(
          dependencies,
          identity,
          ipHash,
          installationHash,
          meta.requestId,
          'request',
        );
        const channelConfigured = otpChannelConfigured(dependencies, identity, authorization);
        // App Store review sign-in: authorization and rate limiting above ran
        // unchanged, but the designated review destination never receives OTP
        // email. The generic envelope below is identical either way.
        try {
          if (
            authorization.allowed && channelConfigured &&
            !isReviewDestination(dependencies.reviewAccount, identity)
          ) {
            // Unknown and ineligible accounts share the generic envelope below;
            // an email delivery failure for an eligible account is surfaced by
            // deliverOtp as 503 code_delivery_failed instead of being masked.
            await deliverOtp(dependencies, identity, identity.locale, captcha, {
              path,
              correlationId: meta.requestId,
              failureCode: 'otp_mail_failed',
            });
          }
          return jsonResponse(meta, 202, {
            accepted: true,
            channel: {
              type: identity.destinationType,
              configured: channelConfigured,
            },
          });
        } finally {
          await dependencies.settleOtpRequest(startedAt);
        }
      }

      if (request.method === 'POST' && path === '/v2/auth/native/otp/request') {
        const startedAt = Date.now();
        const body = asObject((await parseJson(request, config)).value);
        onlyKeys(body, [
          'destinationType',
          'destination',
          'invitationToken',
          'employeeCode',
          'installationId',
          'appVersion',
          'locale',
          'captchaToken',
        ]);
        const identity = parseOtpIdentity(body);
        if (identity.installationId !== nativeInstallationId(request)) {
          throw new ApiError(400, 'bad_request');
        }
        const captcha = captchaToken(
          body.captchaToken,
          captchaRequiredFor(dependencies.captchaMode, true),
        );
        const ipHash = await networkFingerprint(request, config);
        const installationHash = await installationFingerprint(config, identity.installationId);
        const authorization = await authorizeOtp(
          dependencies,
          identity,
          ipHash,
          installationHash,
          meta.requestId,
          'request',
        );
        const channelConfigured = otpChannelConfigured(dependencies, identity, authorization);
        // App Store review sign-in: authorization and rate limiting above ran
        // unchanged, but the designated review destination never receives OTP
        // email. The generic envelope below is identical either way.
        try {
          if (
            authorization.allowed && channelConfigured &&
            !isReviewDestination(dependencies.reviewAccount, identity)
          ) {
            // The generic response cannot reveal account, invitation, or CAPTCHA
            // state; an email delivery failure for an eligible account is
            // surfaced by deliverOtp as 503 code_delivery_failed.
            await deliverOtp(dependencies, identity, identity.locale, captcha, {
              path,
              correlationId: meta.requestId,
              failureCode: 'otp_mail_failed',
            });
          }
          return jsonResponse(meta, 202, {
            accepted: true,
            channel: {
              type: identity.destinationType,
              configured: channelConfigured,
            },
          });
        } finally {
          await dependencies.settleOtpRequest(startedAt);
        }
      }

      if (
        request.method === 'POST' &&
        (path === '/v2/auth/otp/verify' || path === '/v2/auth/native/otp/verify')
      ) {
        const startedAt = Date.now();
        try {
          const native = path === '/v2/auth/native/otp/verify';
          const body = asObject((await parseJson(request, config)).value);
          onlyKeys(body, [
            ...(native ? [] : ['email']),
            'destinationType',
            'destination',
            'invitationToken',
            'employeeCode',
            'installationId',
            'appVersion',
            'locale',
            'code',
          ]);
          const identity = parseOtpIdentity(body);
          if (native && identity.installationId !== nativeInstallationId(request)) {
            throw new ApiError(400, 'bad_request');
          }
          // The designated review account may submit its 6-32 character static
          // code; every other destination keeps the exact six-digit contract.
          const reviewDestination = isReviewDestination(dependencies.reviewAccount, identity);
          const code = normalizedString(body.code, {
            min: 6,
            max: reviewDestination ? 64 : 6,
            trim: false,
          }) as string;
          if (
            !OTP_PATTERN.test(code) &&
            !isReviewCredential(dependencies.reviewAccount, identity, code)
          ) throw new ApiError(401, 'unauthorized');
          const ipHash = await networkFingerprint(request, config);
          const installationHash = await installationFingerprint(config, identity.installationId);
          const completed = await completeOtpAuthentication(
            dependencies,
            identity,
            code,
            ipHash,
            installationHash,
            meta.requestId,
            sessionInstallation(
              request,
              identity,
              native
                ? oneOf(
                  request.headers.get('x-newone-client-platform'),
                  ['ios', 'android'] as const,
                )
                : 'web',
            ),
          );
          const { session, active, invite } = completed;
          const responseBody: Record<string, unknown> = {
            authenticated: true,
            user: publicUser(session.userId, active),
            memberships: active.memberships,
            sessionId: active.sessionId,
            aal: active.aal,
            ...(invite === null
              ? {}
              : { organization: { id: invite.organizationId, role: invite.role } }),
          };
          if (native) {
            responseBody.session = {
              accessToken: session.accessToken,
              refreshToken: session.refreshToken,
              expiresIn: session.expiresIn,
            };
            return jsonResponse(meta, 200, responseBody);
          }
          const csrfToken = randomBase64Url();
          responseBody.csrfToken = csrfToken;
          return appendSessionCookies(
            jsonResponse(meta, 200, responseBody),
            config,
            session,
            csrfToken,
          );
        } finally {
          await dependencies.settleOtpRequest(startedAt);
        }
      }

      if (request.method === 'POST' && path === '/v2/auth/session/refresh') {
        const body = asObject((await parseJson(request, config)).value);
        onlyKeys(body, ['installationId', 'appVersion', 'locale']);
        const installation = sessionInstallation(
          request,
          {
            installationId: uuid(body.installationId),
            appVersion: optionalClientText(body.appVersion, 80),
            locale: optionalLocale(body.locale),
          },
          'web',
        );
        verifyCsrf(request, config, true);
        const session = await dependencies.refresh(refreshCredential(request, config));
        try {
          const binding = await dependencies.bindSessionInstallation(
            session.accessToken,
            installation,
          );
          const active = await dependencies.inspect(session.accessToken);
          if (
            active.userId !== session.userId || active.sessionId !== binding.sessionId ||
            !identityMatches(active, session.destinationType, session.destination) ||
            active.memberships.length === 0
          ) throw new ApiError(401, 'unauthorized');
          const csrfToken = randomBase64Url();
          return appendSessionCookies(
            jsonResponse(meta, 200, {
              authenticated: true,
              user: publicUser(session.userId, session),
              memberships: active.memberships,
              sessionId: active.sessionId,
              aal: active.aal,
              csrfToken,
            }),
            config,
            session,
            csrfToken,
          );
        } catch (error) {
          try {
            await dependencies.revoke(session.accessToken);
          } catch {
            // The database authorization boundary still denies an unbound session.
          }
          throw error;
        }
      }

      if (request.method === 'POST' && path === '/v2/auth/recovery/cases') {
        const parsed = await parseJson(request, config);
        const body = asObject(parsed.value);
        onlyKeys(body, ['organizationId', 'factorId', 'reason']);
        const organizationId = uuid(body.organizationId);
        const factorId = uuid(body.factorId);
        const reason = normalizedString(body.reason, { min: 10, max: 1000 }) as string;
        const credential = accessCredential(request, config);
        verifyCsrf(request, config, credential.viaCookie);
        const current = await dependencies.inspect(credential.token);
        if (!current.memberships.some((entry) => entry.organizationId === organizationId)) {
          throw new ApiError(403, 'forbidden');
        }
        const factor = adminMfaFactors(
          await dependencies.listAdminMfaFactors(current.userId),
        ).find((entry) => entry.id === factorId);
        if (!factor || factor.type !== 'totp' || factor.status !== 'verified') {
          throw new ApiError(409, 'conflict');
        }
        const result = await dependencies.recoveryRpc(
          credential.token,
          'bff_create_account_recovery_case',
          {
            p_organization_id: organizationId,
            p_factor_id: factor.id,
            p_factor_type: factor.type,
            p_factor_status: factor.status,
            p_reason: reason,
            p_idempotency_key: requireIdempotencyKey(request),
            p_request_sha256: parsed.digest,
          },
          meta.requestId,
        );
        return jsonResponse(meta, 201, recoveryResponse(result));
      }

      if (request.method === 'POST' && path === '/v2/auth/recovery/cases/query') {
        const body = asObject((await parseJson(request, config)).value);
        onlyKeys(body, ['organizationId', 'includeOrganization']);
        const credential = accessCredential(request, config);
        verifyCsrf(request, config, credential.viaCookie);
        const result = await dependencies.recoveryRpc(
          credential.token,
          'bff_list_account_recovery_cases',
          {
            p_organization_id: uuid(body.organizationId),
            p_include_organization: booleanValue(body.includeOrganization),
          },
          meta.requestId,
        );
        return jsonResponse(meta, 200, recoveryResponse(result));
      }

      const recoveryCase = recoveryCaseRoute(path);
      if (request.method === 'POST' && recoveryCase !== null) {
        const parsed = await parseJson(request, config);
        const body = asObject(parsed.value);
        const credential = accessCredential(request, config);
        verifyCsrf(request, config, credential.viaCookie);
        const organizationId = uuid(body.organizationId);
        const idempotencyKey = requireIdempotencyKey(request);

        if (recoveryCase.action === 'verify') {
          onlyKeys(body, ['organizationId', 'method', 'evidenceReference']);
          const method = oneOf(
            body.method,
            ['in_person', 'manager_callback', 'hr_record_match', 'approved_provider'] as const,
          );
          const evidenceReference = normalizedString(body.evidenceReference, {
            min: 8,
            max: 500,
          }) as string;
          const result = await dependencies.recoveryRpc(
            credential.token,
            'bff_record_account_recovery_verification',
            {
              p_organization_id: organizationId,
              p_case_id: recoveryCase.caseId,
              p_verification_method: method,
              p_verification_reference_hash: await hmacSha256Hex(
                dependencies.recoveryEvidenceHashKey,
                `recovery-verification:${evidenceReference}`,
              ),
              p_idempotency_key: idempotencyKey,
              p_request_sha256: parsed.digest,
            },
            meta.requestId,
          );
          return jsonResponse(meta, 200, recoveryResponse(result));
        }

        if (recoveryCase.action === 'approve') {
          onlyKeys(body, ['organizationId']);
          const result = await dependencies.recoveryRpc(
            credential.token,
            'bff_approve_account_recovery_case',
            {
              p_organization_id: organizationId,
              p_case_id: recoveryCase.caseId,
              p_idempotency_key: idempotencyKey,
              p_request_sha256: parsed.digest,
            },
            meta.requestId,
          );
          return jsonResponse(meta, 200, recoveryResponse(result));
        }

        if (recoveryCase.action === 'reject') {
          onlyKeys(body, ['organizationId', 'reason']);
          const result = await dependencies.recoveryRpc(
            credential.token,
            'bff_reject_account_recovery_case',
            {
              p_organization_id: organizationId,
              p_case_id: recoveryCase.caseId,
              p_reason: normalizedString(body.reason, { min: 3, max: 500 }),
              p_idempotency_key: idempotencyKey,
              p_request_sha256: parsed.digest,
            },
            meta.requestId,
          );
          return jsonResponse(meta, 200, recoveryResponse(result));
        }

        onlyKeys(body, ['organizationId']);
        const current = await dependencies.inspect(credential.token);
        const prepared = await dependencies.recoveryRpc(
          credential.token,
          'bff_prepare_account_recovery_execution',
          {
            p_organization_id: organizationId,
            p_case_id: recoveryCase.caseId,
            p_idempotency_key: idempotencyKey,
            p_request_sha256: parsed.digest,
          },
          meta.requestId,
        );
        const execution = recoveryExecution(prepared);
        if (execution === null) {
          return jsonResponse(meta, 200, recoveryResponse(prepared));
        }
        if (execution.caseId !== recoveryCase.caseId) {
          throw new ApiError(503, 'dependency_unavailable', undefined, 5);
        }
        const factor = adminMfaFactors(
          await dependencies.listAdminMfaFactors(execution.targetUserId),
        ).find((entry) => entry.id === execution.factorId);
        if (!factor) {
          if (!execution.resumed) {
            await dependencies.recoveryServiceRpc(
              'bff_cancel_account_recovery_execution',
              {
                p_case_id: execution.caseId,
                p_execution_version: execution.executionVersion,
                p_actor_user_id: current.userId,
                p_failure_code: 'factor_missing_before_delete',
              },
              meta.requestId,
            );
            throw new ApiError(409, 'conflict');
          }
        } else if (factor.type !== 'totp' || factor.status !== 'verified') {
          await dependencies.recoveryServiceRpc(
            'bff_cancel_account_recovery_execution',
            {
              p_case_id: execution.caseId,
              p_execution_version: execution.executionVersion,
              p_actor_user_id: current.userId,
              p_failure_code: 'factor_not_verified_totp',
            },
            meta.requestId,
          );
          throw new ApiError(409, 'conflict');
        } else {
          // Auth factor deletion is outside the Postgres transaction. Supabase
          // logs out verified-factor sessions; if the response is lost, the
          // executing case remains retryable and the next attempt proves the
          // factor is absent before finalizing database revocation/audit.
          await dependencies.deleteAdminMfaFactor(
            execution.targetUserId,
            execution.factorId,
          );
        }
        const finalized = await dependencies.recoveryServiceRpc(
          'bff_finalize_account_recovery_execution',
          {
            p_case_id: execution.caseId,
            p_execution_version: execution.executionVersion,
            p_actor_user_id: current.userId,
            p_target_user_id: execution.targetUserId,
            p_factor_id: execution.factorId,
          },
          meta.requestId,
        );
        if (finalized.completed !== true || finalized.all_sessions_revoked !== true) {
          throw new ApiError(503, 'dependency_unavailable', undefined, 5);
        }
        return jsonResponse(meta, 200, recoveryResponse(finalized));
      }

      if (request.method === 'POST' && path === '/v2/auth/mfa/factors') {
        await emptyJson(request, config);
        const credential = accessCredential(request, config);
        verifyCsrf(request, config, credential.viaCookie);
        await dependencies.inspect(credential.token);
        return jsonResponse(
          meta,
          200,
          mfaFactors(
            await dependencies.listMfa(
              credential.token,
              refreshCredential(request, config),
            ),
          ),
        );
      }

      if (request.method === 'POST' && path === '/v2/auth/mfa/enroll') {
        const body = asObject((await parseJson(request, config)).value);
        onlyKeys(body, ['friendlyName']);
        const friendlyName = body.friendlyName === null || body.friendlyName === undefined
          ? null
          : normalizedString(body.friendlyName, { min: 1, max: 100 });
        const credential = accessCredential(request, config);
        verifyCsrf(request, config, credential.viaCookie);
        await dependencies.inspect(credential.token);
        return jsonResponse(
          meta,
          201,
          mfaEnrollment(
            await dependencies.enrollMfa(
              credential.token,
              refreshCredential(request, config),
              friendlyName,
            ),
          ),
        );
      }

      if (request.method === 'POST' && path === '/v2/auth/mfa/challenge') {
        const body = asObject((await parseJson(request, config)).value);
        onlyKeys(body, ['factorId']);
        const factorId = uuid(body.factorId);
        const credential = accessCredential(request, config);
        verifyCsrf(request, config, credential.viaCookie);
        await dependencies.inspect(credential.token);
        return jsonResponse(
          meta,
          200,
          mfaChallenge(
            await dependencies.challengeMfa(
              credential.token,
              refreshCredential(request, config),
              factorId,
            ),
          ),
        );
      }

      if (request.method === 'POST' && path === '/v2/auth/mfa/verify') {
        const body = asObject((await parseJson(request, config)).value);
        onlyKeys(body, ['factorId', 'challengeId', 'code']);
        const factorId = uuid(body.factorId);
        const challengeId = uuid(body.challengeId);
        const code = normalizedString(body.code, { min: 6, max: 6, trim: false }) as string;
        if (!OTP_PATTERN.test(code)) throw new ApiError(401, 'unauthorized');
        const credential = accessCredential(request, config);
        verifyCsrf(request, config, credential.viaCookie);
        await dependencies.inspect(credential.token);
        const session = await dependencies.verifyMfa(
          credential.token,
          refreshCredential(request, config),
          factorId,
          challengeId,
          code,
        );
        const verified = await dependencies.inspect(session.accessToken);
        if (verified.aal !== 'aal2') throw new ApiError(401, 'unauthorized');
        const csrfToken = randomBase64Url();
        return appendSessionCookies(
          jsonResponse(meta, 200, {
            verified: true,
            aal: 'aal2',
            sessionId: verified.sessionId,
            memberships: verified.memberships,
            csrfToken,
          }),
          config,
          session,
          csrfToken,
        );
      }

      if (request.method === 'POST' && path === '/v2/auth/mfa/unenroll') {
        const body = asObject((await parseJson(request, config)).value);
        onlyKeys(body, ['factorId']);
        const factorId = uuid(body.factorId);
        const credential = accessCredential(request, config);
        verifyCsrf(request, config, credential.viaCookie);
        const current = await dependencies.inspect(credential.token);
        const now = Math.floor(Date.now() / 1000);
        if (current.aal !== 'aal2' || current.issuedAt < now - 300) {
          throw new ApiError(403, 'forbidden');
        }
        await dependencies.unenrollMfa(
          credential.token,
          refreshCredential(request, config),
          factorId,
        );
        return jsonResponse(meta, 200, { unenrolled: true, factorId });
      }

      if (request.method === 'POST' && path === '/v2/auth/sign-out') {
        await emptyJson(request, config);
        const credential = accessCredential(request, config);
        verifyCsrf(request, config, credential.viaCookie);
        await dependencies.revoke(credential.token);
        return clearSessionCookies(jsonResponse(meta, 200, { signedOut: true }), config);
      }

      if (request.method === 'POST' && path === '/v2/auth/account/delete') {
        // App Store 5.1.1(v): in-app account deletion. Authenticated exactly
        // like sign-out: web cookie sessions must present the CSRF pair,
        // native bearer sessions are exempt from CSRF.
        await emptyJson(request, config);
        const credential = accessCredential(request, config);
        verifyCsrf(request, config, credential.viaCookie);
        const identity = await dependencies.identify(credential.token);
        // Tombstone first: one database transaction quarantines the username,
        // anonymizes the profile, deactivates every membership, and removes
        // push registrations. Only then is the Auth principal soft-deleted
        // (auth.users.deleted_at), which every authorizer and the token
        // lifecycle hook fail closed on.
        await dependencies.deleteAccount(identity.userId, meta.requestId);
        await dependencies.softDeleteAuthUser(identity.userId);
        try {
          await dependencies.revoke(credential.token);
        } catch {
          // Best-effort, like the other terminal revocations: the tombstone
          // and the soft delete already close every token path, and a
          // revocation hiccup must not resurface a deleted account as a
          // retryable error.
        }
        return clearSessionCookies(jsonResponse(meta, 200, { status: 'deleted' }), config);
      }

      if (request.method === 'POST' && path === '/v2/auth/invitations/redeem') {
        const body = asObject((await parseJson(request, config)).value);
        onlyKeys(body, ['invitationToken', 'employeeCode']);
        const inviteToken = parseInviteToken(body.invitationToken);
        const employeeCode = optionalEmployeeCode(body.employeeCode);
        const credential = accessCredential(request, config);
        verifyCsrf(request, config, credential.viaCookie);
        const identity = await dependencies.identify(credential.token);
        try {
          const invite = await dependencies.redeemInvite(
            credential.token,
            identity.userId,
            inviteToken,
            employeeCode,
          );
          return jsonResponse(meta, 200, {
            activated: true,
            user: publicUser(identity.userId, identity),
            organization: { id: invite.organizationId, role: invite.role },
          });
        } catch {
          try {
            await dependencies.revoke(credential.token);
          } catch {
            // Organization access remains impossible because redemption failed.
          }
          return clearSessionCookies(
            errorResponse(meta, new ApiError(401, 'unauthorized')),
            config,
          );
        }
      }

      if (request.method === 'POST' && path === '/v2/auth/session') {
        await emptyJson(request, config);
        const credential = accessCredential(request, config);
        verifyCsrf(request, config, credential.viaCookie);
        const session = await dependencies.inspect(credential.token);
        return jsonResponse(meta, 200, {
          authenticated: true,
          user: publicUser(session.userId, session),
          memberships: session.memberships,
          sessionId: session.sessionId,
          aal: session.aal,
        });
      }

      if (request.method === 'POST' && path === '/v2/auth/realtime-token') {
        await emptyJson(request, config);
        const credential = accessCredential(request, config);
        verifyCsrf(request, config, credential.viaCookie);
        const session = await dependencies.inspect(credential.token);
        return jsonResponse(meta, 200, {
          accessToken: credential.token,
          expiresAt: session.expiresAt,
          memberships: session.memberships,
        });
      }

      throw new ApiError(404, 'not_found');
    } catch (error) {
      const safe = asApiError(error);
      if (safe.status >= 400) {
        // Operational failure telemetry: correlation id, route, and outcome
        // only. The cause line carries the internal error class/message for
        // unexpected (non-ApiError) failures; it never includes request
        // bodies, tokens, or credentials.
        console.error(JSON.stringify({
          event: 'newone_auth_failure',
          correlation_id: meta.requestId,
          path: authPath(request.url),
          status: safe.status,
          code: safe.code,
          cause: error instanceof ApiError
            ? undefined
            : String(error instanceof Error ? error.message : error).slice(0, 300),
        }));
      }
      return errorResponse(meta, error);
    }
  };
}
