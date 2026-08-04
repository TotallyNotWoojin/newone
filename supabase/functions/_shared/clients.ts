import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { ApiError } from './errors.ts';

export interface JwtClaims {
  sub: string;
  sessionId: string;
  aal: 'aal1' | 'aal2';
  issuedAt: number;
  expiresAt: number;
}

export interface AuthenticatedActor {
  user: User;
  token: string;
  claims: JwtClaims;
  userClient: SupabaseClient;
  adminClient: SupabaseClient;
}

export interface ClientEnvironment {
  url: string;
  publishableKey: string;
  secretKey: string;
}

function firstConfiguredKey(
  env: Pick<typeof Deno.env, 'get'>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = env.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function keyFromSet(env: Pick<typeof Deno.env, 'get'>, name: string): string | undefined {
  const raw = env.get(name);
  if (!raw) return undefined;
  try {
    const values = JSON.parse(raw) as Record<string, unknown>;
    const value = values.default;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    throw new Error(`${name} must be a JSON object with a default key`);
  }
}

export function loadClientEnvironment(
  env: Pick<typeof Deno.env, 'get'> = Deno.env,
): ClientEnvironment {
  const url = env.get('SUPABASE_URL')?.trim();
  const publishableKey = firstConfiguredKey(env, [
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_ANON_KEY',
  ]) ?? keyFromSet(env, 'SUPABASE_PUBLISHABLE_KEYS');
  const secretKey = firstConfiguredKey(env, [
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]) ?? keyFromSet(env, 'SUPABASE_SECRET_KEYS');

  if (!url || !publishableKey || !secretKey) {
    throw new Error('Supabase URL, publishable key, and server secret key are required');
  }
  return { url, publishableKey, secretKey };
}

export function createUserClient(
  environment: ClientEnvironment,
  token: string,
  fetcher: typeof fetch = fetch,
): SupabaseClient {
  return createClient(environment.url, environment.publishableKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: {
      fetch: fetcher,
      headers: {
        apikey: environment.publishableKey,
        Authorization: `Bearer ${token}`,
      },
    },
  });
}

export function createPublicClient(
  environment: ClientEnvironment,
  fetcher: typeof fetch = fetch,
): SupabaseClient {
  const publicFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    if (headers.get('authorization') === `Bearer ${environment.publishableKey}`) {
      headers.delete('authorization');
    }
    return fetcher(input, { ...init, headers });
  };
  return createClient(environment.url, environment.publishableKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { apikey: environment.publishableKey }, fetch: publicFetch },
  });
}

export function createAdminClient(
  environment: ClientEnvironment,
  headers: Readonly<Record<string, string>> = {},
  fetcher: typeof fetch = fetch,
): SupabaseClient {
  const serverFetch: typeof fetch = (input, init) => {
    const outboundHeaders = new Headers(init?.headers);
    if (outboundHeaders.get('authorization') === `Bearer ${environment.secretKey}`) {
      outboundHeaders.delete('authorization');
    }
    return fetcher(input, { ...init, headers: outboundHeaders });
  };
  return createClient(environment.url, environment.secretKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: {
      fetch: serverFetch,
      headers: { apikey: environment.secretKey, 'X-Newone-Server': 'edge-function', ...headers },
    },
  });
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const segments = token.split('.');
  if (segments.length !== 3 || !segments[1]) throw new ApiError(401, 'unauthorized');
  try {
    const normalized = segments[1].replaceAll('-', '+').replaceAll('_', '/');
    const padding = '='.repeat((4 - normalized.length % 4) % 4);
    const binary = atob(normalized + padding);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(401, 'unauthorized');
  }
}

function validatedClaims(payload: Record<string, unknown>, userId: string): JwtClaims {
  const sub = payload.sub;
  const sessionId = payload.session_id;
  const aal = payload.aal;
  const issuedAt = payload.iat;
  const expiresAt = payload.exp;
  if (
    typeof sub !== 'string' || sub !== userId || typeof sessionId !== 'string' ||
    (aal !== 'aal1' && aal !== 'aal2') || typeof issuedAt !== 'number' ||
    typeof expiresAt !== 'number'
  ) {
    throw new ApiError(401, 'unauthorized');
  }
  if (expiresAt <= Math.floor(Date.now() / 1000)) throw new ApiError(401, 'unauthorized');
  return { sub, sessionId, aal, issuedAt, expiresAt };
}

export async function authenticate(
  environment: ClientEnvironment,
  token: string,
): Promise<AuthenticatedActor> {
  const userClient = createUserClient(environment, token);
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data.user) throw new ApiError(401, 'unauthorized');
  const claims = validatedClaims(decodeJwtPayload(token), data.user.id);
  return {
    user: data.user,
    token,
    claims,
    userClient,
    adminClient: createAdminClient(environment),
  };
}
