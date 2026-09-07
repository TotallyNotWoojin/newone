// A third person for a group, without a third simulator.
//
// v3.3 (backlog 36) refuses a group of two, so an area with only two devices
// still needs somebody to be the third member. The picker finds anyone by name
// or @username, so that person does not have to hold a phone: this creates a
// real account through the same public signup route the app uses (request →
// one-time code → verify), and nothing ever signs in on a device with it.
//
// Nothing here ever exits the process — a suite area records a failure, it does
// not kill the run — which is why the hosted smoke helper (tests/hosted, whose
// fail() calls process.exit) is not reused directly.
import { randomBytes, randomUUID } from 'node:crypto';

import { gatewayPost, loadAccessToken, projectKeys, PROJECT_URL } from '../../hosted/smoke-lib.mjs';

let keysPromise = null;

/** Project keys are read once per run; the reveal shells out to the CLI. */
function projectKeysOnce() {
  keysPromise ??= (async () => projectKeys(loadAccessToken()))();
  return keysPromise;
}

async function adminPost(adminKey, path, body) {
  const response = await fetch(`${PROJECT_URL}/auth/v1${path}`, {
    method: 'POST',
    headers: {
      apikey: adminKey,
      Authorization: `Bearer ${adminKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

/**
 * Signs a new account up through the gateway and returns it, or an object
 * carrying `error` when any leg refused. The shape matches the accounts
 * `ctx.signup` returns so an area can pass either into a flow's env:
 * `{ label, email, username, displayName, userId, signedIn }`.
 *
 * `signedIn` is always false: nobody is holding this account on a device.
 */
export async function createHeadlessAccount({ label, displayName, language = 'en' }) {
  const account = {
    label,
    displayName,
    language,
    username: null,
    email: null,
    userId: null,
    signedIn: false,
    headless: true,
    error: null,
  };
  try {
    const keys = await projectKeysOnce();
    const entropy = randomBytes(3).toString('hex');
    const username = `sim_${label}_${entropy}`.toLowerCase().slice(0, 30);
    const email = `sim-${label}-${entropy}@example.test`;
    const installationId = randomUUID();
    account.username = username;
    account.email = email;

    const request = await gatewayPost('newone-auth', '/v2/auth/native/signup/request', keys, {
      installationId,
      body: {
        destination: email,
        username,
        displayName,
        language,
        installationId,
        captchaToken: 'hosted-smoke-captcha-placeholder',
        password: 'Newone-test-2026',
      },
    });
    const requestStatus = request.payload?.data?.status ?? request.payload?.status;
    if (request.status !== 202 || requestStatus !== 'code_sent') {
      account.error = `signup request refused (${request.status}): ${JSON.stringify(request.payload).slice(0, 300)}`;
      return account;
    }

    const link = await adminPost(keys.adminKey, '/admin/generate_link', { type: 'magiclink', email });
    const otp = String(link.payload?.email_otp ?? link.payload?.properties?.email_otp ?? '');
    if (!/^[0-9]{6,10}$/.test(otp)) {
      account.error = `no one-time code for ${email} (${link.status})`;
      return account;
    }

    const verify = await gatewayPost('newone-auth', '/v2/auth/native/signup/verify', keys, {
      installationId,
      body: { destination: email, code: otp, installationId },
    });
    if (verify.status !== 200) {
      account.error = `signup verify refused (${verify.status}): ${JSON.stringify(verify.payload).slice(0, 300)}`;
      return account;
    }
    const userId = (verify.payload?.data ?? verify.payload ?? {}).user?.id;
    if (typeof userId !== 'string') {
      account.error = 'signup verify returned no user id';
      return account;
    }
    account.userId = userId;
    return account;
  } catch (error) {
    account.error = String(error?.message ?? error);
    return account;
  }
}

/**
 * Creates the third person an area needs and records the outcome as a setup
 * action, so a group that cannot be created says why. Returns the account
 * (with `error` set when it could not be made).
 */
export async function setupThirdPerson(ctx, { label, displayName }) {
  const account = await createHeadlessAccount({ label, displayName });
  ctx.note({
    id: `setup-${label}-headless-account`,
    title: `Setup: third group member ${displayName} (account only, no device)`,
    status: account.userId ? 'PASS' : 'FAIL',
    expected: 'A real account exists to be the third person in a group (v3.3 refuses a group of two)',
    observed: account.userId
      ? `@${account.username} (${account.userId}) created through /v2/auth/native/signup — never signed in on a simulator`
      : `could not create the account: ${account.error}`,
  });
  return account;
}
