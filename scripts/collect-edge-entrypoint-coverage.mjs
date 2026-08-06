import { spawn, spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const coverageDirectory = path.resolve(process.argv[2] ?? 'coverage/edge/raw');
const entrypoints = [
  'newone-api',
  'newone-auth',
  'newone-bootstrap',
  'newone-read',
  'newone-ai-worker',
  'newone-attachment-scan-worker',
  'newone-outbox-worker',
  'newone-push-receipt-worker',
  'newone-maintenance-worker',
];

function localSupabaseStatus() {
  const result = spawnSync('supabase', ['status', '--output', 'json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error('The real local Supabase stack must be running before Edge coverage is collected.');
  }
  const start = result.stdout.indexOf('{');
  if (start < 0) throw new Error('Supabase CLI did not return its local service contract.');
  return JSON.parse(result.stdout.slice(start));
}

async function coveragePolicy() {
  const policy = JSON.parse(await readFile('config/ai-route-policy.json', 'utf8'));
  policy.employeeDataEgressEnabled = true;
  return JSON.stringify(policy);
}

function boundedOutput(chunks) {
  return chunks.join('').replace(/[A-Za-z0-9_-]{80,}/g, '[redacted]').slice(-4000);
}

async function waitForServer(child, stderr, name) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Edge entrypoint exited before listening:\n${boundedOutput(stderr)}`);
    }
    try {
      const bootstrap = name === 'newone-bootstrap';
      const response = await fetch('http://127.0.0.1:8000/v2/health', {
        method: bootstrap ? 'GET' : 'OPTIONS',
        headers: bootstrap ? undefined : {
          Origin: 'http://127.0.0.1:4173',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'content-type,x-correlation-id',
        },
        signal: AbortSignal.timeout(500),
      });
      return response;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for Edge entrypoint:\n${boundedOutput(stderr)}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000, 'timeout'));
  if (await Promise.race([exited, timeout]) === 'timeout' && child.exitCode === null) {
    child.kill('SIGINT');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

const status = localSupabaseStatus();
const policy = await coveragePolicy();
const testSecret = 'coverage-entrypoint-test-input-00000000000000000000000000000000';
const environment = {
  ...process.env,
  SUPABASE_URL: status.API_URL,
  SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY: status.SECRET_KEY,
  NEWONE_ALLOW_HTTP_LOCAL: 'true',
  NEWONE_ALLOWED_WEB_ORIGINS: 'http://127.0.0.1:4173',
  NEWONE_NETWORK_HASH_KEY: testSecret,
  NEWONE_CURSOR_SIGNING_KEY: testSecret,
  NEWONE_WEB_GATEWAY_SHARED_SECRET: testSecret,
  NEWONE_WORKER_TOKEN: testSecret,
  NEWONE_RECOVERY_EVIDENCE_HASH_KEY: testSecret,
  NEWONE_AUTH_CAPTCHA_REQUIRED: 'false',
  NEWONE_AUTH_PHONE_OTP_ENABLED: 'false',
  NEWONE_BOOTSTRAP_TOKEN: testSecret,
  NEWONE_OUTBOX_TOPICS: 'realtime_control',
  NEWONE_ATTACHMENT_SCANNER_URL: 'https://scanner.invalid/v1/scan',
  NEWONE_ATTACHMENT_SCANNER_TOKEN: testSecret,
  NEWONE_EXPO_ACCESS_TOKEN: testSecret,
  NEWONE_AI_DATA_EGRESS_APPROVED: 'true',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? testSecret,
  OPENROUTER_MANAGEMENT_API_KEY: testSecret,
  NEWONE_OPENROUTER_API_KEY_HASH: '0'.repeat(64),
  NEWONE_OPENROUTER_WORKSPACE_ID: '00000000-0000-4000-8000-000000000001',
  NEWONE_OPENROUTER_POLICY_JSON: policy,
  NEWONE_PUBLIC_APP_URL: 'https://newone.invalid',
  NEWONE_OPENROUTER_APP_NAME: 'Newone coverage entrypoint',
};

for (const name of entrypoints) {
  const stderr = [];
  const child = spawn(
    'deno',
    [
      'run',
      '--config=supabase/functions/deno.json',
      `--coverage=${coverageDirectory}`,
      '--allow-env',
      '--allow-read=supabase/functions',
      '--allow-net=0.0.0.0:8000,127.0.0.1:55321,localhost:55321',
      'tests/edge-entrypoint-runner.ts',
    ],
    {
      cwd: process.cwd(),
      env: { ...environment, NEWONE_COVERAGE_ENTRYPOINT: name },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  try {
    const response = await waitForServer(child, stderr, name);
    const expectedStatus = name === 'newone-bootstrap'
      ? 401
      : name.endsWith('-worker')
      ? 405
      : 204;
    if (response.status !== expectedStatus) {
      throw new Error(`${name} returned ${response.status}; expected ${expectedStatus}.`);
    }
  } finally {
    await stop(child);
  }
}

const profiles = (await readdir(coverageDirectory)).filter((name) => name.endsWith('.json'));
if (profiles.length < entrypoints.length) {
  throw new Error(`Expected at least ${entrypoints.length} V8 profiles, found ${profiles.length}.`);
}

console.log(`Exercised all ${entrypoints.length} real Edge entrypoints and recorded V8 profiles.`);
