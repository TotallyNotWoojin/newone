import { isAuthRetryableFetchError, type Session } from '@supabase/supabase-js';
import { createContext, PropsWithChildren, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { publicRuntimeConfig, runtimeMode, type RuntimeMode } from '@/config/runtime';
// Metro selects the native or safe web client store.
// eslint-disable-next-line import/no-unresolved
import { clientStore } from '@/data/persistence/client-store';
import {
  offlineIdentityCacheKey,
  offlineIdentityExpiresAt,
  parseOfflineIdentity,
  retainSessionForMembershipFailure,
  serializeOfflineIdentity,
} from '@/data/persistence/offline-identity.mjs';
import { errorMessageKey } from '@/i18n/errors';
import { useI18n } from '@/i18n/provider';
import { usesCookieSession } from '@/lib/session-transport';
import {
  getSupabaseClient,
  getRealtimeClient,
  isNativeSupabaseConfigured,
} from '@/lib/supabase';
import {
  deleteNativeAccount,
  deleteWebAccount,
  getWebSession,
  getWebRealtimeToken,
  refreshWebSession,
  requestNativeOtp,
  requestNativeRecoveryOtp,
  requestNativeSignup,
  requestWebOtp,
  requestWebRecoveryOtp,
  requestWebSignup,
  setNativePassword,
  setWebPassword,
  signOutWebSession,
  verifyWebOtp,
  verifyWebPassword,
  verifyWebRecoveryOtp,
  verifyWebSignup,
  verifyNativeOtp,
  verifyNativePassword,
  verifyNativeRecoveryOtp,
  verifyNativeSignup,
  validateNativeMembership,
  WebAuthError,
  type SignupLanguage,
  type WebAuthUser,
} from '@/lib/web-auth';

interface AuthState {
  session: Session | null;
  user: WebAuthUser | null;
  authenticated: boolean;
  realtimeToken: string | null;
  sessionId: string | null;
  assuranceLevel: 'aal1' | 'aal2' | null;
  loading: boolean;
  mode: RuntimeMode;
  error: string | null;
  /** True once the account has a member-chosen password (server stamp, or set during this run). */
  hasPassword: boolean;
  /**
   * Raised right after a code sign-in for an account without a password so
   * the sign-in screen can offer to add one; cleared by setPassword,
   * dismissPasswordPrompt, or any sign-out.
   */
  passwordPromptPending: boolean;
  dismissPasswordPrompt: () => void;
  signInWithPassword: (input: {
    destinationType: 'email' | 'phone';
    destination: string;
    password: string;
  }) => Promise<void>;
  setPassword: (password: string) => Promise<void>;
  /** Forces a token refresh; resolves true while a session is still held afterwards. */
  refreshSession: () => Promise<boolean>;
  requestOtp: (input: {
    destinationType: 'email' | 'phone';
    destination: string;
    invitationToken?: string;
    employeeCode?: string;
    captchaToken?: string | null;
  }) => Promise<{ channelConfigured: boolean }>;
  verifyOtp: (input: {
    destinationType: 'email' | 'phone';
    destination: string;
    invitationToken?: string;
    employeeCode?: string;
    code: string;
  }) => Promise<{ hasPassword: boolean }>;
  requestSignup: (input: {
    destination: string;
    username: string;
    displayName: string;
    language: SignupLanguage;
    captchaToken?: string | null;
  }) => Promise<void>;
  verifySignup: (input: {
    destination: string;
    code: string;
  }) => Promise<{ hasPassword: boolean }>;
  requestRecoveryOtp: (input: {
    destinationType: 'email' | 'phone';
    destination: string;
    captchaToken?: string | null;
  }) => Promise<{ channelConfigured: boolean }>;
  verifyRecoveryOtp: (input: {
    destinationType: 'email' | 'phone';
    destination: string;
    code: string;
  }) => Promise<{ otherSessionsRevoked: number; hasPassword: boolean }>;
  refreshAssurance: () => Promise<'aal1' | 'aal2' | null>;
  signOut: () => Promise<void>;
  endAccess: () => Promise<void>;
  deleteAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

async function offlineWebIdentity() {
  if (!publicRuntimeConfig.offlineCacheEnabled) return null;
  await clientStore.initialize();
  return parseOfflineIdentity(await clientStore.getCache(offlineIdentityCacheKey));
}

async function rememberOfflineWebIdentity(userId: string) {
  if (!publicRuntimeConfig.offlineCacheEnabled) return;
  await clientStore.initialize();
  const previous = parseOfflineIdentity(await clientStore.getCache(offlineIdentityCacheKey));
  if (previous && previous !== userId) await clientStore.purgeUser(previous);
  const serialized = serializeOfflineIdentity(userId);
  if (!serialized) return;
  await clientStore.putCache(
    offlineIdentityCacheKey,
    serialized,
    offlineIdentityExpiresAt(),
  );
}

async function forgetOfflineWebIdentity(userId?: string | null) {
  await clientStore.initialize();
  const remembered = parseOfflineIdentity(await clientStore.getCache(offlineIdentityCacheKey));
  await clientStore.removeCache(offlineIdentityCacheKey);
  for (const id of new Set([remembered, userId].filter((value): value is string => Boolean(value)))) {
    await clientStore.purgeUser(id);
  }
}

function nativeClaims(accessToken?: string): {
  sessionId: string | null;
  assuranceLevel: 'aal1' | 'aal2' | null;
} {
  if (!accessToken) return { sessionId: null, assuranceLevel: null as 'aal1' | 'aal2' | null };
  try {
    const encoded = accessToken.split('.')[1];
    if (!encoded) return { sessionId: null, assuranceLevel: null as 'aal1' | 'aal2' | null };
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const claims = JSON.parse(atob(padded)) as { session_id?: unknown; aal?: unknown };
    const assuranceLevel: 'aal1' | 'aal2' | null =
      claims.aal === 'aal1' || claims.aal === 'aal2' ? claims.aal : null;
    return {
      sessionId: typeof claims.session_id === 'string' ? claims.session_id : null,
      assuranceLevel,
    };
  } catch {
    return { sessionId: null, assuranceLevel: null as 'aal1' | 'aal2' | null };
  }
}

function sessionHasPassword(session: Session | null): boolean {
  const metadata = session?.user?.app_metadata as Record<string, unknown> | undefined;
  return typeof metadata?.newone_password_set_at === 'string';
}

/** A refused token (401) rather than a membership or revocation verdict. */
function staleTokenFailure(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error
      && typeof (error as { code: unknown }).code === 'string'
      && (error as { code: string }).code.toLocaleLowerCase() === 'http_401',
  );
}

/** A refresh that failed for lack of network, not because the token was rejected. */
function retryableAuthFailure(error: unknown): boolean {
  return isAuthRetryableFetchError(error)
    || (error instanceof Error && error.name === 'AuthRetryableFetchError');
}

export function AuthProvider({ children }: PropsWithChildren) {
  const { t } = useI18n();
  // Cookie-gateway web keeps its own session state below; native and direct
  // (bearer) web hold the session in the Supabase client.
  const cookieSession = usesCookieSession();
  const [session, setSession] = useState<Session | null>(null);
  const [webUser, setWebUser] = useState<WebAuthUser | null>(null);
  const [webRealtimeToken, setWebRealtimeToken] = useState<string | null>(null);
  const [webSessionId, setWebSessionId] = useState<string | null>(null);
  const [webAal, setWebAal] = useState<'aal1' | 'aal2' | null>(null);
  const [loading, setLoading] = useState(isNativeSupabaseConfigured || runtimeMode === 'web');
  const [error, setError] = useState<string | null>(null);
  // Set-password receipt for the current run; the stored session only learns
  // about the app_metadata stamp on its next refresh.
  const [passwordSetFor, setPasswordSetFor] = useState<string | null>(null);
  const [passwordPromptPending, setPasswordPromptPending] = useState(false);
  const lastUserId = useRef<string | null>(null);
  const activationInFlight = useRef(false);

  useEffect(() => {
    if (cookieSession) {
      if (runtimeMode !== 'web') {
        return;
      }
      let active = true;
      const restoreWebSession = async () => {
        try {
          return await getWebSession();
        } catch (sessionError) {
          if (sessionError instanceof WebAuthError && sessionError.code === 'http_401') {
            return refreshWebSession();
          }
          throw sessionError;
        }
      };
      void restoreWebSession()
        .then((webSession) => {
          if (!active) return;
          setWebUser(webSession.user);
          setWebSessionId(webSession.sessionId ?? null);
          setWebAal(webSession.aal ?? null);
          setError(null);
          void rememberOfflineWebIdentity(webSession.user.id).catch(() => {});
        })
        .catch(async (sessionError) => {
          if (!active) return;
          if (
            sessionError instanceof WebAuthError
            && sessionError.code === 'network_unavailable'
          ) {
            const userId = await offlineWebIdentity().catch(() => null);
            if (!active) return;
            if (userId) {
              setWebUser({ id: userId });
              setWebSessionId(null);
              setWebAal(null);
              setError(null);
              return;
            }
          }
          setWebUser(null);
          setWebSessionId(null);
          setWebAal(null);
          if (
            sessionError instanceof WebAuthError
            && (sessionError.code === 'http_401' || sessionError.code === 'session_revoked')
          ) {
            await forgetOfflineWebIdentity().catch(() => {});
          }
          if (
            !(
              sessionError instanceof WebAuthError &&
              (sessionError.code === 'http_401' || sessionError.code === 'csrf_required')
            )
          ) {
            setError(t(errorMessageKey(sessionError)));
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
      const appStateSubscription = AppState.addEventListener('change', (state) => {
        if (state !== 'active') return;
        void refreshWebSession()
          .then((webSession) => {
            if (!active) return;
            setWebUser(webSession.user);
            setWebSessionId(webSession.sessionId ?? null);
            setWebAal(webSession.aal ?? null);
            setError(null);
            void rememberOfflineWebIdentity(webSession.user.id).catch(() => {});
          })
          .catch((refreshError) => {
            if (!active) return;
            if (refreshError instanceof WebAuthError && refreshError.code === 'http_401') {
              void forgetOfflineWebIdentity().catch(() => {});
              setWebUser(null);
              setWebRealtimeToken(null);
              setWebSessionId(null);
              setWebAal(null);
            }
          });
      });
      return () => {
        active = false;
        appStateSubscription.remove();
      };
    }

    const supabase = getSupabaseClient();
    if (!supabase) return;

    let active = true;
    let restoreTimer: ReturnType<typeof setTimeout> | null = null;
    let restoreAttempt = 0;
    let restoring = false;
    let restored = false;

    const commit = (next: Session) => {
      lastUserId.current = next.user.id;
      setSession(next);
      setError(null);
      setLoading(false);
      restored = true;
    };
    const drop = async (cause: unknown) => {
      await supabase.auth.signOut({ scope: 'local' });
      if (!active) return;
      lastUserId.current = null;
      setSession(null);
      setError(t(errorMessageKey(cause)));
      setLoading(false);
      restored = true;
    };
    const scheduleRestore = () => {
      if (restoreTimer !== null) return;
      // Offline at launch with an access token that already lapsed: the
      // session is still on disk, so keep the launch screen and try again
      // instead of showing "signed out" for a network blip.
      const delay = Math.min(30_000, 1_000 * 2 ** restoreAttempt);
      restoreAttempt += 1;
      restoreTimer = setTimeout(() => {
        restoreTimer = null;
        void restoreSession();
      }, delay);
    };
    const adopt = async (stored: Session) => {
      try {
        await validateNativeMembership({
          accessToken: stored.access_token,
          userId: stored.user.id,
        });
        if (!active) return;
        commit(stored);
      } catch (membershipError) {
        if (!active) return;
        if (retainSessionForMembershipFailure(membershipError)) {
          commit(stored);
          return;
        }
        if (!staleTokenFailure(membershipError)) {
          await drop(membershipError);
          return;
        }
        // The token was refused, not the membership: refresh once and check
        // again before anything signs the member out.
        const refreshed = await supabase.auth.refreshSession();
        if (!active) return;
        if (refreshed.error || !refreshed.data.session) {
          if (refreshed.error && retryableAuthFailure(refreshed.error)) {
            commit(stored);
            return;
          }
          await drop(membershipError);
          return;
        }
        const fresh = refreshed.data.session;
        try {
          await validateNativeMembership({
            accessToken: fresh.access_token,
            userId: fresh.user.id,
          });
          if (!active) return;
          commit(fresh);
        } catch (retryError) {
          if (!active) return;
          if (retainSessionForMembershipFailure(retryError)) {
            commit(fresh);
            return;
          }
          await drop(retryError);
        }
      }
    };
    const restoreSession = async () => {
      if (!active || restoring || restored) return;
      restoring = true;
      try {
        let stored: Session | null = null;
        let failure: unknown = null;
        try {
          const { data, error: sessionError } = await supabase.auth.getSession();
          stored = data.session;
          failure = sessionError;
        } catch (restoreError) {
          failure = restoreError;
        }
        if (!active) return;
        if (stored) {
          await adopt(stored);
          return;
        }
        if (failure && retryableAuthFailure(failure)) {
          scheduleRestore();
          return;
        }
        setSession(null);
        setError(failure ? t('errors.session') : null);
        setLoading(false);
        restored = true;
      } finally {
        restoring = false;
      }
    };
    void restoreSession();

    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;
      // The restore above owns the launch state; the client's own initial
      // notification (null while a refresh is still being retried) must not
      // flip the app to signed-out underneath it.
      if (event === 'INITIAL_SESSION' && !restored) return;
      if (activationInFlight.current && event === 'SIGNED_IN') return;
      if (nextSession && lastUserId.current !== nextSession.user.id) return;
      const previousUserId = lastUserId.current;
      lastUserId.current = nextSession?.user.id ?? null;
      setSession(nextSession);
      if (nextSession) setError(null);
      setLoading(false);
      if (event === 'SIGNED_OUT' && previousUserId) {
        void clientStore.purgeUser(previousUserId);
      }
    });

    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        // startAutoRefresh ticks immediately, refreshing any token within
        // 90 seconds of expiry; a launch still waiting on the network retries now.
        supabase.auth.startAutoRefresh();
        if (!restored) {
          if (restoreTimer !== null) {
            clearTimeout(restoreTimer);
            restoreTimer = null;
          }
          void restoreSession();
        }
      } else {
        supabase.auth.stopAutoRefresh();
      }
    });
    if (AppState.currentState === 'active') supabase.auth.startAutoRefresh();

    return () => {
      active = false;
      if (restoreTimer !== null) clearTimeout(restoreTimer);
      supabase.auth.stopAutoRefresh();
      data.subscription.unsubscribe();
      appStateSubscription.remove();
    };
  }, [cookieSession, t]);

  useEffect(() => {
    if (!cookieSession || !webUser) {
      return;
    }
    let active = true;
    const refreshRealtimeToken = async () => {
      try {
        const token = await getWebRealtimeToken();
        if (active) setWebRealtimeToken(token.accessToken);
      } catch {
        if (active) setWebRealtimeToken(null);
      }
    };
    void refreshRealtimeToken();
    const interval = setInterval(() => void refreshRealtimeToken(), 4 * 60 * 1000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [cookieSession, webUser]);

  const value = useMemo<AuthState>(
    () => {
      const claims = nativeClaims(session?.access_token);
      const currentUserId = cookieSession ? webUser?.id ?? null : session?.user.id ?? null;
      const hasPassword = (currentUserId !== null && passwordSetFor === currentUserId)
        || (cookieSession ? webUser?.hasPassword === true : sessionHasPassword(session));
      // Every code sign-in reports whether the account already has a password;
      // one without gets the inline offer to add one.
      const codeSignInOutcome = (accountHasPassword: boolean) => {
        setPasswordPromptPending(!accountHasPassword);
        return { hasPassword: accountHasPassword };
      };
      return ({
      session,
      user: cookieSession ? webUser : session?.user ?? null,
      authenticated: Boolean(cookieSession ? webUser : session),
      realtimeToken: cookieSession ? webRealtimeToken : session?.access_token ?? null,
      sessionId: cookieSession ? webSessionId : claims.sessionId,
      assuranceLevel: cookieSession ? webAal : claims.assuranceLevel,
      loading,
      mode: runtimeMode,
      error,
      hasPassword,
      passwordPromptPending,
      dismissPasswordPrompt: () => setPasswordPromptPending(false),
      signInWithPassword: async (input) => {
        if (cookieSession) {
          const webSession = await verifyWebPassword(input);
          setWebUser(webSession.user);
          setWebSessionId(webSession.sessionId ?? null);
          setWebAal(webSession.aal ?? null);
          setError(null);
          setPasswordPromptPending(false);
          return;
        }
        const nativeClient = getSupabaseClient();
        if (!nativeClient) throw new WebAuthError('Native identity is unavailable.', 'gateway_unconfigured');
        const gatewaySession = await verifyNativePassword(input);
        activationInFlight.current = true;
        try {
          const { data, error: setSessionError } = await nativeClient.auth.setSession({
            access_token: gatewaySession.session.accessToken,
            refresh_token: gatewaySession.session.refreshToken,
          });
          if (setSessionError || !data.session || data.session.user.id !== gatewaySession.user.id) {
            await nativeClient.auth.signOut({ scope: 'local' });
            throw new WebAuthError('The native identity gateway returned an invalid session.', 'invalid_response');
          }
          lastUserId.current = data.session.user.id;
          setSession(data.session);
          setError(null);
          setPasswordPromptPending(false);
        } finally {
          activationInFlight.current = false;
        }
      },
      setPassword: async (password) => {
        if (cookieSession) {
          await setWebPassword({ password });
          setWebUser((current) => (current ? { ...current, hasPassword: true } : current));
          setPasswordPromptPending(false);
          return;
        }
        const accessToken = session?.access_token;
        const userId = session?.user.id;
        if (!accessToken || !userId) {
          throw new WebAuthError('Setting a password requires an active session.', 'authentication_required');
        }
        await setNativePassword({ accessToken, password });
        setPasswordSetFor(userId);
        setPasswordPromptPending(false);
        // Pull the new app_metadata stamp into the stored session so the next
        // launch knows too; a failed refresh changes nothing about this one.
        const nativeClient = getSupabaseClient();
        if (!nativeClient) return;
        try {
          const { data } = await nativeClient.auth.refreshSession();
          if (data.session && data.session.user.id === userId) setSession(data.session);
        } catch {
          // The local receipt covers this run.
        }
      },
      refreshSession: async () => {
        if (cookieSession) {
          try {
            const webSession = await refreshWebSession();
            setWebUser(webSession.user);
            setWebSessionId(webSession.sessionId ?? null);
            setWebAal(webSession.aal ?? null);
            setError(null);
            return true;
          } catch {
            return false;
          }
        }
        const nativeClient = getSupabaseClient();
        if (!nativeClient) return false;
        const { data, error: refreshError } = await nativeClient.auth.refreshSession();
        if (refreshError || !data.session) {
          // No network is not a verdict on the session: it is still held.
          return session !== null && retryableAuthFailure(refreshError);
        }
        lastUserId.current = data.session.user.id;
        setSession(data.session);
        return true;
      },
      requestOtp: async (input) => {
        if (cookieSession) {
          const result = await requestWebOtp({
            destinationType: input.destinationType,
            destination: input.destination,
            invitationToken: input.invitationToken,
            employeeCode: input.employeeCode,
            captchaToken: input.captchaToken,
          });
          return { channelConfigured: result.channel.configured };
        }
        const result = await requestNativeOtp(input);
        return { channelConfigured: result.channel.configured };
      },
      verifyOtp: async (input) => {
        if (cookieSession) {
          const webSession = await verifyWebOtp({
            destinationType: input.destinationType,
            destination: input.destination,
            invitationToken: input.invitationToken,
            employeeCode: input.employeeCode,
            code: input.code,
          });
          setWebUser(webSession.user);
          setWebSessionId(webSession.sessionId ?? null);
          setWebAal(webSession.aal ?? null);
          setError(null);
          return codeSignInOutcome(webSession.user.hasPassword === true);
        }
        const nativeClient = getSupabaseClient();
        if (!nativeClient) throw new WebAuthError('Native identity is unavailable.', 'gateway_unconfigured');
        const gatewaySession = await verifyNativeOtp(input);
        activationInFlight.current = true;
        try {
          const { data, error: setSessionError } = await nativeClient.auth.setSession({
            access_token: gatewaySession.session.accessToken,
            refresh_token: gatewaySession.session.refreshToken,
          });
          if (setSessionError || !data.session || data.session.user.id !== gatewaySession.user.id) {
            await nativeClient.auth.signOut({ scope: 'local' });
            throw new WebAuthError('The native identity gateway returned an invalid session.', 'invalid_response');
          }
          lastUserId.current = data.session.user.id;
          setSession(data.session);
          setError(null);
          return codeSignInOutcome(gatewaySession.user.hasPassword === true);
        } finally {
          activationInFlight.current = false;
        }
      },
      requestSignup: async (input) => {
        if (cookieSession) {
          await requestWebSignup({
            destination: input.destination,
            username: input.username,
            displayName: input.displayName,
            language: input.language,
            captchaToken: input.captchaToken,
          });
          return;
        }
        await requestNativeSignup(input);
      },
      verifySignup: async (input) => {
        // A returned signup receipt (new account) and a silent sign-in for an
        // existing account commit the exact same session state.
        if (cookieSession) {
          const webSession = await verifyWebSignup({
            destination: input.destination,
            code: input.code,
          });
          setWebUser(webSession.user);
          setWebSessionId(webSession.sessionId ?? null);
          setWebAal(webSession.aal ?? null);
          setError(null);
          return codeSignInOutcome(webSession.user.hasPassword === true);
        }
        const nativeClient = getSupabaseClient();
        if (!nativeClient) throw new WebAuthError('Native identity is unavailable.', 'gateway_unconfigured');
        const gatewaySession = await verifyNativeSignup(input);
        activationInFlight.current = true;
        try {
          const { data, error: setSessionError } = await nativeClient.auth.setSession({
            access_token: gatewaySession.session.accessToken,
            refresh_token: gatewaySession.session.refreshToken,
          });
          if (setSessionError || !data.session || data.session.user.id !== gatewaySession.user.id) {
            await nativeClient.auth.signOut({ scope: 'local' });
            throw new WebAuthError('The native signup gateway returned an invalid session.', 'invalid_response');
          }
          lastUserId.current = data.session.user.id;
          setSession(data.session);
          setError(null);
          return codeSignInOutcome(gatewaySession.user.hasPassword === true);
        } finally {
          activationInFlight.current = false;
        }
      },
      requestRecoveryOtp: async (input) => {
        if (cookieSession) {
          const result = await requestWebRecoveryOtp({
            destinationType: input.destinationType,
            destination: input.destination,
            captchaToken: input.captchaToken,
          });
          return { channelConfigured: result.channel.configured };
        }
        const result = await requestNativeRecoveryOtp(input);
        return { channelConfigured: result.channel.configured };
      },
      verifyRecoveryOtp: async (input) => {
        if (cookieSession) {
          const recovered = await verifyWebRecoveryOtp({
            destinationType: input.destinationType,
            destination: input.destination,
            code: input.code,
          });
          setWebUser(recovered.user);
          setWebSessionId(recovered.sessionId ?? null);
          setWebAal(recovered.aal ?? null);
          setError(null);
          return {
            otherSessionsRevoked: recovered.recovery.otherSessionsRevoked,
            ...codeSignInOutcome(recovered.user.hasPassword === true),
          };
        }
        const nativeClient = getSupabaseClient();
        if (!nativeClient) {
          throw new WebAuthError('Native identity is unavailable.', 'gateway_unconfigured');
        }
        const recovered = await verifyNativeRecoveryOtp(input);
        activationInFlight.current = true;
        try {
          const { data, error: setSessionError } = await nativeClient.auth.setSession({
            access_token: recovered.session.accessToken,
            refresh_token: recovered.session.refreshToken,
          });
          if (setSessionError || !data.session || data.session.user.id !== recovered.user.id) {
            await nativeClient.auth.signOut({ scope: 'local' });
            throw new WebAuthError('The native recovery gateway returned an invalid session.', 'invalid_response');
          }
          lastUserId.current = data.session.user.id;
          setSession(data.session);
          setError(null);
          return {
            otherSessionsRevoked: recovered.recovery.otherSessionsRevoked,
            ...codeSignInOutcome(recovered.user.hasPassword === true),
          };
        } finally {
          activationInFlight.current = false;
        }
      },
      refreshAssurance: async () => {
        if (cookieSession) {
          const webSession = await getWebSession();
          setWebUser(webSession.user);
          setWebSessionId(webSession.sessionId ?? null);
          setWebAal(webSession.aal ?? null);
          return webSession.aal ?? null;
        }
        const nativeClient = getSupabaseClient();
        if (!nativeClient) return null;
        const { data, error: refreshError } = await nativeClient.auth.refreshSession();
        if (refreshError || !data.session) return null;
        setSession(data.session);
        return nativeClaims(data.session.access_token).assuranceLevel;
      },
      signOut: async () => {
        try {
          await getRealtimeClient()?.removeAllChannels();
        } catch {
          // Local credential and cache teardown must continue if the socket is unhealthy.
        }
        if (cookieSession) {
          try {
            if (webUser) await signOutWebSession();
          } catch {
            // A just-revoked current session can no longer authenticate sign-out.
          } finally {
            const userId = webUser?.id;
            lastUserId.current = null;
            setWebUser(null);
            setWebRealtimeToken(null);
            setWebSessionId(null);
            setWebAal(null);
            await forgetOfflineWebIdentity(userId).catch(() => {
              if (userId) return clientStore.purgeUser(userId);
            });
          }
          setError(null);
          return;
        }
        const supabase = getSupabaseClient();
        const userId = session?.user.id;
        try {
          if (supabase) await supabase.auth.signOut({ scope: 'local' });
        } catch {
          // The server revocation is authoritative; always finish local teardown.
        } finally {
          lastUserId.current = null;
          setSession(null);
          if (userId) await clientStore.purgeUser(userId);
        }
        setPasswordPromptPending(false);
        setError(null);
      },
      endAccess: async () => {
        try {
          await getRealtimeClient()?.removeAllChannels();
        } catch {
          // Continue revocation teardown even if the socket is already closed.
        }
        if (cookieSession) {
          try {
            if (webUser) await signOutWebSession();
          } catch {
            // Server-side revocation commonly invalidates sign-out itself.
          }
          await forgetOfflineWebIdentity(webUser?.id).catch(() => {
            if (webUser?.id) return clientStore.purgeUser(webUser.id);
          });
          setWebUser(null);
          setWebRealtimeToken(null);
          setWebSessionId(null);
          setWebAal(null);
        } else {
          const supabase = getSupabaseClient();
          const userId = session?.user.id;
          try {
            if (supabase) await supabase.auth.signOut({ scope: 'local' });
          } finally {
            if (userId) await clientStore.purgeUser(userId);
            setSession(null);
          }
        }
        setPasswordPromptPending(false);
        setError(t('errors.accessEnded'));
      },
      deleteAccount: async () => {
        // The authenticated deletion call must complete before any local
        // teardown; a rejected deletion leaves the session fully intact.
        if (cookieSession) {
          await deleteWebAccount();
          try {
            await getRealtimeClient()?.removeAllChannels();
          } catch {
            // Local teardown must continue after the server-side deletion.
          }
          const userId = webUser?.id;
          lastUserId.current = null;
          setWebUser(null);
          setWebRealtimeToken(null);
          setWebSessionId(null);
          setWebAal(null);
          await forgetOfflineWebIdentity(userId).catch(() => {
            if (userId) return clientStore.purgeUser(userId);
          });
          setError(null);
          return;
        }
        const accessToken = session?.access_token;
        if (!accessToken) {
          throw new WebAuthError('Account deletion requires an active session.', 'authentication_required');
        }
        await deleteNativeAccount({ accessToken });
        try {
          await getRealtimeClient()?.removeAllChannels();
        } catch {
          // Local teardown must continue after the server-side deletion.
        }
        const supabase = getSupabaseClient();
        const userId = session?.user.id;
        try {
          if (supabase) await supabase.auth.signOut({ scope: 'local' });
        } catch {
          // The account is already deleted server-side; finish local teardown.
        } finally {
          lastUserId.current = null;
          setSession(null);
          if (userId) await clientStore.purgeUser(userId);
        }
        setError(null);
      },
    });
    },
    [
      cookieSession,
      error,
      loading,
      passwordPromptPending,
      passwordSetFor,
      session,
      t,
      webAal,
      webRealtimeToken,
      webSessionId,
      webUser,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
