// Shared plumbing for the real hosted smoke scripts. No mocks: credentials
// come from the logged-in Supabase CLI, SQL evidence flows through the
// Management API, and OTP codes come from the admin generate-link API so no
// mailbox is required. Secrets are never printed or written to artifacts.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_PROJECT_REF, selectProjectKeys } from './lib.mjs';

const HOSTED_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HOSTED_DIRECTORY, '..', '..');
export const PROJECT_URL = `https://${EXPECTED_PROJECT_REF}.supabase.co`;
export const PERSONAL_REALM_ID = '11111111-1111-4111-8111-111111111111';

export function fail(message, extra = undefined) {
  console.error(`FAIL: ${message}`);
  if (extra !== undefined) console.error(extra);
  process.exit(1);
}

export function loadAccessToken() {
  const configured = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (configured) return configured;
  if (process.platform !== 'darwin') fail('SUPABASE_ACCESS_TOKEN is required outside macOS');
  const token = execFileSync(
    'security',
    ['find-generic-password', '-s', 'Supabase CLI', '-a', 'supabase', '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
  if (!token) fail('Supabase CLI access token is unavailable');
  return token;
}

export function projectKeys(accessToken) {
  const output = execFileSync(
    'supabase',
    [
      'projects', 'api-keys', '--reveal',
      '--project-ref', EXPECTED_PROJECT_REF, '--output', 'json',
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken },
    },
  );
  const records = JSON.parse(output);
  const selected = selectProjectKeys(records);
  // GoTrue admin endpoints accept the legacy service_role JWT; new-format
  // sb_secret keys serve PostgREST/Edge.
  const legacyServiceRole = records.find(
    (record) => record?.name === 'service_role' && record?.type === 'legacy',
  );
  const adminKey = legacyServiceRole?.api_key ?? legacyServiceRole?.apiKey ?? selected.secretKey;
  return { ...selected, adminKey };
}

export async function managementSql(accessToken, query) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${EXPECTED_PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) fail(`Management SQL failed (${response.status})`, body?.message);
  return body;
}

// Any-method gateway call (the command gateway also serves PATCH/PUT/DELETE
// routes). Returns the raw status plus parsed JSON; callers decide what is
// an acceptable outcome so expected denials can be asserted explicitly.
export async function gatewayRequest(functionSlug, method, path, keys, options) {
  const { installationId, accessToken, idempotencyKey, body } = options;
  const headers = {
    'Content-Type': 'application/json',
    apikey: keys.publishableKey,
    'x-newone-installation-id': installationId,
    'x-newone-client-platform': 'ios',
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(`${PROJECT_URL}/functions/v1/${functionSlug}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

export async function gatewayPost(functionSlug, path, keys, options) {
  return await gatewayRequest(functionSlug, 'POST', path, keys, options);
}

export async function adminRequest(adminKey, path, init = {}) {
  const response = await fetch(`${PROJECT_URL}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: adminKey,
      Authorization: `Bearer ${adminKey}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    fail(
      `Admin auth request failed for ${path} (${response.status})`,
      payload?.msg ?? payload?.message,
    );
  }
  return payload;
}

// Full gateway signup for one synthetic identity: request, admin-API OTP,
// verify. Returns the verified native session and identity facts. A password
// (the v3 signup form always sends one) is stored at request time.
export async function signupUser(keys, { runId, label, language, password = null }) {
  const entropy = randomBytes(3).toString('hex');
  const email = `${runId}-${label}@example.test`;
  const username = `e2e_${label}_${entropy}`.slice(0, 30);
  const installationId = randomUUID();

  const request = await gatewayPost('newone-auth', '/v2/auth/native/signup/request', keys, {
    installationId,
    body: {
      destination: email,
      username,
      displayName: `Smoke ${label}`,
      language,
      installationId,
      captchaToken: 'hosted-smoke-captcha-placeholder',
      ...(password ? { password } : {}),
    },
  });
  const requestStatus = request.payload?.data?.status ?? request.payload?.status;
  if (request.status !== 202 || requestStatus !== 'code_sent') {
    fail(`signup request for ${label} was not accepted (${request.status})`, request.payload);
  }

  const link = await adminRequest(keys.adminKey, '/admin/generate_link', {
    method: 'POST',
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const otp = String(link?.email_otp ?? link?.properties?.email_otp ?? '');
  if (!/^[0-9]{6,10}$/.test(otp)) fail(`no OTP for ${label}`);

  const verify = await gatewayPost('newone-auth', '/v2/auth/native/signup/verify', keys, {
    installationId,
    body: { destination: email, code: otp, installationId },
  });
  if (verify.status !== 200) fail(`signup verify for ${label} failed (${verify.status})`, verify.payload);
  const data = verify.payload?.data ?? verify.payload ?? {};
  const session = data.session ?? {};
  if (typeof session.accessToken !== 'string' || session.accessToken.length < 20) {
    fail(`no session for ${label}`, Object.keys(session));
  }
  const userId = data.user?.id;
  if (typeof userId !== 'string') fail(`no user id for ${label}`);
  return { email, username, userId, installationId, accessToken: session.accessToken };
}
