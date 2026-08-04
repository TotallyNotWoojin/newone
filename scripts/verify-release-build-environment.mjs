import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PUBLIC_SECRET_CLASS = /(?:SERVICE_ROLE|SECRET|OPENROUTER|DATABASE_PASSWORD|APNS|FCM)/;

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for a hosted release build.`);
  return value;
}

function requiredSecret(environment, name) {
  const value = required(environment, name);
  if (
    value !== environment[name] || value.length < 32 || value.length > 4096 ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error(`${name} must contain an independent 32-character-or-longer secret.`);
  }
  return value;
}

function canonicalHttps(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }
  if (
    url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
  ) {
    throw new Error(`${name} must be a credential-free HTTPS URL.`);
  }
  return url;
}

function reservedDocumentationHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
    hostname === 'example.com' || hostname.endsWith('.example.com') ||
    hostname.endsWith('.example') || hostname.endsWith('.test') || hostname.endsWith('.invalid');
}

export function verifyReleaseBuildEnvironment(environment = process.env, deploymentConfig = null) {
  const releaseBuild = environment.NEWONE_RELEASE_BUILD === 'true' || environment.VERCEL === '1';
  if (!releaseBuild) return { releaseBuild: false };

  if (environment.EXPO_PUBLIC_DEMO_MODE !== 'false') {
    throw new Error('EXPO_PUBLIC_DEMO_MODE must be explicitly false for a hosted release build.');
  }
  if (required(environment, 'EXPO_PUBLIC_API_URL') !== '/api') {
    throw new Error('Hosted web releases must use the same-origin /api gateway.');
  }
  if (!['true', 'false'].includes(required(environment, 'EXPO_PUBLIC_OFFLINE_CACHE_ENABLED'))) {
    throw new Error('EXPO_PUBLIC_OFFLINE_CACHE_ENABLED must explicitly record the tenant policy.');
  }

  for (const name of Object.keys(environment)) {
    if (name.startsWith('EXPO_PUBLIC_') && PUBLIC_SECRET_CLASS.test(name)) {
      throw new Error(`${name} is a server credential class and cannot be public.`);
    }
  }

  const supabase = canonicalHttps(
    required(environment, 'EXPO_PUBLIC_SUPABASE_URL'),
    'EXPO_PUBLIC_SUPABASE_URL',
  );
  if (
    supabase.pathname !== '/'
    || supabase.port
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.supabase\.co$/.test(supabase.hostname)
  ) {
    throw new Error('EXPO_PUBLIC_SUPABASE_URL must be a hosted Supabase project origin.');
  }

  const publicKey = required(environment, 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  if (
    publicKey.length < 20 || publicKey.length > 2048 ||
    !/^[A-Za-z0-9._-]+$/.test(publicKey) || /^sb_secret_/i.test(publicKey) ||
    /replace_me|replace-with/i.test(publicKey)
  ) {
    throw new Error('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not a valid public project key.');
  }
  if (required(environment, 'SUPABASE_PUBLISHABLE_KEY') !== publicKey) {
    throw new Error('The BFF and universal client must use the same Supabase publishable key.');
  }
  requiredSecret(environment, 'NEWONE_WEB_GATEWAY_SHARED_SECRET');

  const functionsOrigin = canonicalHttps(
    required(environment, 'NEWONE_SUPABASE_FUNCTIONS_ORIGIN'),
    'NEWONE_SUPABASE_FUNCTIONS_ORIGIN',
  );
  if (
    functionsOrigin.origin !== supabase.origin ||
    functionsOrigin.pathname.replace(/\/+$/, '') !== '/functions/v1'
  ) {
    throw new Error('NEWONE_SUPABASE_FUNCTIONS_ORIGIN must target the configured Supabase project.');
  }

  if (deploymentConfig) {
    const globalHeaders = deploymentConfig.headers
      ?.find((entry) => entry.source === '/(.*)')?.headers ?? [];
    const csp = globalHeaders
      .find((entry) => entry.key?.toLowerCase() === 'content-security-policy')?.value;
    const realtimeOrigin = `wss://${supabase.host}`;
    if (typeof csp !== 'string' || !csp.includes(supabase.origin) || !csp.includes(realtimeOrigin)) {
      throw new Error('The web CSP does not authorize the configured Supabase HTTPS and Realtime origins.');
    }
  }

  const turnstileKey = required(environment, 'EXPO_PUBLIC_TURNSTILE_SITE_KEY');
  if (turnstileKey.length < 10 || turnstileKey.length > 256 || /replace/i.test(turnstileKey)) {
    throw new Error('EXPO_PUBLIC_TURNSTILE_SITE_KEY is not configured.');
  }
  const challengeOrigin = canonicalHttps(
    required(environment, 'EXPO_PUBLIC_TURNSTILE_CHALLENGE_ORIGIN'),
    'EXPO_PUBLIC_TURNSTILE_CHALLENGE_ORIGIN',
  );
  if (challengeOrigin.pathname !== '/') {
    throw new Error('EXPO_PUBLIC_TURNSTILE_CHALLENGE_ORIGIN must be an origin without a path.');
  }
  if (reservedDocumentationHost(challengeOrigin.hostname)) {
    throw new Error('EXPO_PUBLIC_TURNSTILE_CHALLENGE_ORIGIN still uses a reserved example host.');
  }

  const supportLabel = required(environment, 'EXPO_PUBLIC_SUPPORT_CONTACT_LABEL');
  if (/^your organization support desk$/i.test(supportLabel)) {
    throw new Error('EXPO_PUBLIC_SUPPORT_CONTACT_LABEL still uses the example value.');
  }
  const supportUrl = canonicalHttps(
    required(environment, 'EXPO_PUBLIC_SUPPORT_CONTACT_URL'),
    'EXPO_PUBLIC_SUPPORT_CONTACT_URL',
  );
  if (reservedDocumentationHost(supportUrl.hostname)) {
    throw new Error('EXPO_PUBLIC_SUPPORT_CONTACT_URL still uses a reserved example host.');
  }

  return {
    releaseBuild: true,
    supabaseOrigin: supabase.origin,
    challengeOrigin: challengeOrigin.origin,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deploymentConfig = JSON.parse(
    readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
  );
  const result = verifyReleaseBuildEnvironment(process.env, deploymentConfig);
  console.log(result.releaseBuild
    ? `Hosted release environment verified for ${result.supabaseOrigin}.`
    : 'Release environment check skipped for a non-hosted local build.');
}
