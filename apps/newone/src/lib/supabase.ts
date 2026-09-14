import 'react-native-url-polyfill/auto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

import {
  isDirectEdgeConfigured,
  isNativeSupabaseConfigured,
  isApiConfigured,
  isSupabaseConfigured,
  publicRuntimeConfig,
} from '@/config/runtime';
import type { Database } from '@/data/database.types';
// Metro selects the native or web suffix; ESLint's Node resolver cannot model it.
// eslint-disable-next-line import/no-unresolved
import { authStorage } from '@/lib/secure-storage';

export { isDirectEdgeConfigured, isNativeSupabaseConfigured, isSupabaseConfigured };
export const isWebAuthBlocked = Platform.OS === 'web' && !isApiConfigured;

let client: SupabaseClient<Database> | null = null;
let webRealtimeClient: SupabaseClient<Database> | null = null;
let realtimeAccessToken: string | null = null;

/**
 * The token the browser's realtime socket presents when it re-authenticates
 * on its own. supabase-js always hands realtime-js a token callback, and
 * realtime-js calls that callback -- not the token set by hand -- after every
 * channel join and on every reconnect. For this session-less client the
 * default callback answered with the publishable key, so seconds after
 * joining, every private channel was downgraded to anonymous and refused
 * ("Unauthorized: You do not have permissions to read from this Channel
 * topic"; Sep 14 2026, typing never reached the phone from the web). The
 * signed-in native client's callback answers with its session, so only the
 * web socket needs feeding; the auth provider does it as the token changes.
 */
export function setRealtimeAccessToken(token: string | null) {
  realtimeAccessToken = token;
}

export function getSupabaseClient() {
  // Native sessions come only from Gist's bounded OTP gateway and are kept
  // in OS-protected storage. Web auth terminates at the Gist BFF so refresh
  // tokens never enter browser JavaScript, unless the build opted into direct
  // bearer auth (isDirectEdgeConfigured), where the web storage adapter keeps
  // the session in the encrypted IndexedDB client store.
  if (isDirectEdgeConfigured !== true || !publicRuntimeConfig.supabase) return null;
  if (client) return client;

  client = createClient<Database>(
    publicRuntimeConfig.supabase.url,
    publicRuntimeConfig.supabase.publishableKey,
    {
    auth: {
      storage: authStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
    global: {
      headers: {
        'x-client-info': `newone-expo/${Platform.OS}`,
      },
    },
    },
  );
  return client;
}

export function getRealtimeClient() {
  if (Platform.OS !== 'web') return getSupabaseClient();
  if (!publicRuntimeConfig.supabase) return null;
  if (webRealtimeClient) return webRealtimeClient;
  webRealtimeClient = createClient<Database>(
    publicRuntimeConfig.supabase.url,
    publicRuntimeConfig.supabase.publishableKey,
    {
      accessToken: async () => realtimeAccessToken,
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: { headers: { 'x-client-info': 'newone-expo/web-realtime-only' } },
    },
  );
  return webRealtimeClient;
}
