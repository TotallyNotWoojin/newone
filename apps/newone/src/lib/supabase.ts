import 'react-native-url-polyfill/auto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

import {
  isNativeSupabaseConfigured,
  isApiConfigured,
  isSupabaseConfigured,
  publicRuntimeConfig,
} from '@/config/runtime';
import type { Database } from '@/data/database.types';
// Metro selects the native or web suffix; ESLint's Node resolver cannot model it.
// eslint-disable-next-line import/no-unresolved
import { authStorage } from '@/lib/secure-storage';

export { isNativeSupabaseConfigured, isSupabaseConfigured };
export const isWebAuthBlocked = Platform.OS === 'web' && !isApiConfigured;

let client: SupabaseClient<Database> | null = null;
let webRealtimeClient: SupabaseClient<Database> | null = null;

export function getSupabaseClient() {
  // Native sessions come only from Newone's bounded OTP gateway and are kept
  // in OS-protected storage. Web auth terminates at the Newone BFF so refresh
  // tokens never enter browser JavaScript.
  if (!isNativeSupabaseConfigured || !publicRuntimeConfig.supabase || Platform.OS === 'web') return null;
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
