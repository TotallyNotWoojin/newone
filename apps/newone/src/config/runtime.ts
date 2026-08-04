import { Platform } from 'react-native';
import { z } from 'zod';

import {
  directEdgeRequestHeaders,
  resolveApiUrl,
  supabaseProjectOrigin,
} from '@/config/api-routing.mjs';

const supabaseSchema = z.object({
  url: z.string().trim().refine(
    (value) => Boolean(supabaseProjectOrigin(value)),
    'Use a hosted Supabase project origin.',
  ),
  publishableKey: z.string().trim().min(20).max(2048).regex(/^[A-Za-z0-9._-]+$/).refine(
    (value) => !/^sb_secret_/i.test(value),
    'Use a Supabase publishable key, never a secret key.',
  ),
});

const apiSchema = z.string().trim().refine((value) => {
  if (value.startsWith('/')) {
    return !value.startsWith('//') && !value.includes('\\') && !/[\r\n]/.test(value);
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, 'Use a same-origin path or an HTTPS URL.');

const supabaseResult = supabaseSchema.safeParse({
  url: process.env.EXPO_PUBLIC_SUPABASE_URL,
  publishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
});
const apiResult = apiSchema.safeParse(process.env.EXPO_PUBLIC_API_URL);
const turnstileResult = z.string().trim().min(10).max(256).safeParse(
  process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY,
);
const turnstileOriginResult = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/';
}).safeParse(process.env.EXPO_PUBLIC_TURNSTILE_CHALLENGE_ORIGIN);
const supportLabelResult = z.string().trim().min(2).max(160).refine(
  (value) => !/[\r\n]/.test(value),
).safeParse(process.env.EXPO_PUBLIC_SUPPORT_CONTACT_LABEL);
const supportUrlResult = z.string().trim().max(500).refine((value) => {
  if (/^mailto:[^\s]+$/i.test(value) || /^tel:\+?[0-9(). -]+$/i.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}).safeParse(process.env.EXPO_PUBLIC_SUPPORT_CONTACT_URL);
const easProjectIdResult = z.string().uuid().safeParse(process.env.EXPO_PUBLIC_EAS_PROJECT_ID);
const pushEnvironmentResult = z.enum(['development', 'preview', 'production']).safeParse(
  process.env.EXPO_PUBLIC_PUSH_ENVIRONMENT,
);
const offlineCacheEnabled = process.env.EXPO_PUBLIC_OFFLINE_CACHE_ENABLED === 'true';

/** Demo data is never inferred from missing credentials. It requires an exact opt-in. */
export const isDemoMode = process.env.EXPO_PUBLIC_DEMO_MODE === 'true';
export const isSupabaseConfigured = supabaseResult.success;
const normalizedApiUrl = apiResult.success
  ? apiResult.data.replace(/\/$/, '') || '/'
  : null;
export const isApiConfigured = Boolean(resolveApiUrl({
  path: '/v2/health',
  platform: Platform.OS,
  apiBase: normalizedApiUrl,
  supabaseUrl: supabaseResult.success ? supabaseResult.data.url : null,
}));
export const isNativeSupabaseConfigured = isSupabaseConfigured
  && isApiConfigured
  && Platform.OS !== 'web';

export type RuntimeMode = 'demo' | 'native' | 'web' | 'web_locked' | 'unconfigured';

export const runtimeMode: RuntimeMode = isDemoMode
  ? 'demo'
  : Platform.OS === 'web'
    ? isApiConfigured
      ? 'web'
      : 'web_locked'
    : isSupabaseConfigured && isApiConfigured
      ? 'native'
      : 'unconfigured';

export const publicRuntimeConfig = {
  apiUrl: normalizedApiUrl,
  supabase: supabaseResult.success ? supabaseResult.data : null,
  turnstileSiteKey: turnstileResult.success ? turnstileResult.data : null,
  turnstileChallengeOrigin: turnstileOriginResult.success
    ? turnstileOriginResult.data.replace(/\/$/, '')
    : null,
  supportContact: supportLabelResult.success
    ? {
        label: supportLabelResult.data,
        url: supportUrlResult.success ? supportUrlResult.data : null,
      }
    : null,
  easProjectId: easProjectIdResult.success ? easProjectIdResult.data : null,
  pushEnvironment: pushEnvironmentResult.success ? pushEnvironmentResult.data : null,
  offlineCacheEnabled,
} as const;

export function apiUrlFor(path: `/${string}`) {
  return resolveApiUrl({
    path,
    platform: Platform.OS,
    apiBase: publicRuntimeConfig.apiUrl,
    supabaseUrl: publicRuntimeConfig.supabase?.url ?? null,
  });
}

/** Public `apikey` and user bearer JWT are intentionally separate headers. */
export function nativeEdgeRequestHeaders(accessToken?: string) {
  return directEdgeRequestHeaders({
    platform: Platform.OS,
    publishableKey: publicRuntimeConfig.supabase?.publishableKey ?? null,
    accessToken,
  });
}
