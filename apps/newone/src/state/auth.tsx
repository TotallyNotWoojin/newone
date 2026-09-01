import type { Session } from '@supabase/supabase-js';
import { createContext, PropsWithChildren, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

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
  signOutWebSession,
  verifyWebOtp,
  verifyWebRecoveryOtp,
  verifyWebSignup,
  verifyNativeOtp,
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
  requestOtp: (input: {
    destinationType: 'email' | 'phone';
    destination: string;
    invitationToken?: string;
    employeeCode?: string;
    captchaToken: string;
  }) => Promise<{ channelConfigured: boolean }>;
  verifyOtp: (input: {
    destinationType: 'email' | 'phone';
    destination: string;
    invitationToken?: string;
    employeeCode?: string;
    code: string;
  }) => Promise<void>;
  requestSignup: (input: {
    destination: string;
    username: string;
    displayName: string;
    language: SignupLanguage;
    captchaToken: string;
  }) => Promise<void>;
  verifySignup: (input: {
    destination: string;
    code: string;
  }) => Promise<void>;
  requestRecoveryOtp: (input: {
    destinationType: 'email' | 'phone';
    destination: string;
    captchaToken: string;
  }) => Promise<{ channelConfigured: boolean }>;
  verifyRecoveryOtp: (input: {
    destinationType: 'email' | 'phone';
    destination: string;
    code: string;
  }) => Promise<{ otherSessionsRevoked: number }>;
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

export function AuthProvider({ children }: PropsWithChildren) {
  const { t } = useI18n();
  const [session, setSession] = useState<Session | null>(null);
  const [webUser, setWebUser] = useState<WebAuthUser | null>(null);
  const [webRealtimeToken, setWebRealtimeToken] = useState<string | null>(null);
  const [webSessionId, setWebSessionId] = useState<string | null>(null);
  const [webAal, setWebAal] = useState<'aal1' | 'aal2' | null>(null);
  const [loading, setLoading] = useState(isNativeSupabaseConfigured || runtimeMode === 'web');
  const [error, setError] = useState<string | null>(null);
  const lastUserId = useRef<string | null>(null);
  const activationInFlight = useRef(false);

  useEffect(() => {
    if (Platform.OS === 'web') {
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
    void supabase.auth
      .getSession()
      .then(async ({ data, error: sessionError }) => {
        if (!active) return;
        if (sessionError || !data.session) {
          setSession(null);
          setError(sessionError ? t('errors.session') : null);
          setLoading(false);
          return;
        }
        try {
          await validateNativeMembership({
            accessToken: data.session.access_token,
            userId: data.session.user.id,
          });
          if (!active) return;
          lastUserId.current = data.session.user.id;
          setSession(data.session);
          setError(null);
        } catch (membershipError) {
          if (retainSessionForMembershipFailure(membershipError)) {
            if (!active) return;
            lastUserId.current = data.session.user.id;
            setSession(data.session);
            setError(null);
          } else {
            await supabase.auth.signOut({ scope: 'local' });
            if (!active) return;
            lastUserId.current = null;
            setSession(null);
            setError(t(errorMessageKey(membershipError)));
          }
        }
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setError(t('errors.session'));
        setLoading(false);
      });

    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;
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
        supabase.auth.startAutoRefresh();
      } else {
        supabase.auth.stopAutoRefresh();
      }
    });
    if (AppState.currentState === 'active') supabase.auth.startAutoRefresh();

    return () => {
      active = false;
      supabase.auth.stopAutoRefresh();
      data.subscription.unsubscribe();
      appStateSubscription.remove();
    };
  }, [t]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !webUser) {
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
  }, [webUser]);

  const value = useMemo<AuthState>(
    () => {
      const claims = nativeClaims(session?.access_token);
      return ({
      session,
      user: Platform.OS === 'web' ? webUser : session?.user ?? null,
      authenticated: Boolean(Platform.OS === 'web' ? webUser : session),
      realtimeToken: Platform.OS === 'web' ? webRealtimeToken : session?.access_token ?? null,
      sessionId: Platform.OS === 'web' ? webSessionId : claims.sessionId,
      assuranceLevel: Platform.OS === 'web' ? webAal : claims.assuranceLevel,
      loading,
      mode: runtimeMode,
      error,
      requestOtp: async (input) => {
        if (Platform.OS === 'web') {
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
        if (Platform.OS === 'web') {
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
          return;
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
        } finally {
          activationInFlight.current = false;
        }
      },
      requestSignup: async (input) => {
        if (Platform.OS === 'web') {
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
        if (Platform.OS === 'web') {
          const webSession = await verifyWebSignup({
            destination: input.destination,
            code: input.code,
          });
          setWebUser(webSession.user);
          setWebSessionId(webSession.sessionId ?? null);
          setWebAal(webSession.aal ?? null);
          setError(null);
          return;
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
        } finally {
          activationInFlight.current = false;
        }
      },
      requestRecoveryOtp: async (input) => {
        if (Platform.OS === 'web') {
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
        if (Platform.OS === 'web') {
          const recovered = await verifyWebRecoveryOtp({
            destinationType: input.destinationType,
            destination: input.destination,
            code: input.code,
          });
          setWebUser(recovered.user);
          setWebSessionId(recovered.sessionId ?? null);
          setWebAal(recovered.aal ?? null);
          setError(null);
          return { otherSessionsRevoked: recovered.recovery.otherSessionsRevoked };
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
          return { otherSessionsRevoked: recovered.recovery.otherSessionsRevoked };
        } finally {
          activationInFlight.current = false;
        }
      },
      refreshAssurance: async () => {
        if (Platform.OS === 'web') {
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
        if (Platform.OS === 'web') {
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
        setError(null);
      },
      endAccess: async () => {
        try {
          await getRealtimeClient()?.removeAllChannels();
        } catch {
          // Continue revocation teardown even if the socket is already closed.
        }
        if (Platform.OS === 'web') {
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
        setError(t('errors.accessEnded'));
      },
      deleteAccount: async () => {
        // The authenticated deletion call must complete before any local
        // teardown; a rejected deletion leaves the session fully intact.
        if (Platform.OS === 'web') {
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
    [error, loading, session, t, webAal, webRealtimeToken, webSessionId, webUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
