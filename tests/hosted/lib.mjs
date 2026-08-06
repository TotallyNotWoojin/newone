import { createHmac, randomBytes } from 'node:crypto';

export const EXPECTED_PROJECT_REF = 'sfbkmnpduweusynopbig';
export const EXECUTION_CONFIRMATION = '1';
export const RUN_ID_PATTERN = /^newone-e2e-[a-z0-9](?:[a-z0-9-]{6,38}[a-z0-9])$/;
export const REQUIRED_EXECUTION_FUNCTIONS = Object.freeze([
  'newone-api',
  'newone-auth',
  'newone-bootstrap',
  'newone-read',
]);

export function validateHostedExecutionPrerequisites(
  activeFunctions,
  bootstrapToken,
  functionDeployments,
) {
  if (!(activeFunctions instanceof Set)) throw new Error('Active function inventory is invalid');
  const missing = REQUIRED_EXECUTION_FUNCTIONS.filter((name) => !activeFunctions.has(name));
  if (missing.length > 0) {
    throw new Error(`Required hosted execution functions are unavailable: ${missing.join(', ')}`);
  }
  if (!Array.isArray(functionDeployments)) {
    throw new Error('Hosted function deployment inventory is invalid');
  }
  for (const functionName of REQUIRED_EXECUTION_FUNCTIONS) {
    const deployment = functionDeployments.find((entry) => entry?.name === functionName);
    if (
      deployment?.verifyJwt !== false ||
      !Number.isSafeInteger(deployment?.version) || deployment.version < 1 ||
      typeof deployment?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(deployment.sha256)
    ) {
      throw new Error(
        `Hosted function ${functionName} must be active with verify_jwt=false and exact version provenance`,
      );
    }
  }
  if (typeof bootstrapToken !== 'string') {
    throw new Error('NEWONE_HOSTED_BOOTSTRAP_TOKEN is required for hosted execution');
  }
  const token = bootstrapToken.trim();
  if (token.length < 32 || token.length > 4096 || /\s/.test(token)) {
    throw new Error(
      'NEWONE_HOSTED_BOOTSTRAP_TOKEN must be a 32-4096 character non-whitespace secret',
    );
  }
  return token;
}

export function realtimeApplicationPayload(raw) {
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const outer = object(raw);
  const first = object(outer.payload ?? outer);
  return object(first.payload ?? first);
}

export function parseArguments(argv) {
  const options = {
    mode: 'dry-run',
    projectRef: EXPECTED_PROJECT_REF,
    runId: null,
    cleanup: false,
    cleanupArtifact: null,
    help: false,
  };
  let selectedMode = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--dry-run') {
      if (selectedMode && options.mode !== 'dry-run') throw new Error('Select one run mode');
      options.mode = 'dry-run';
      selectedMode = true;
    } else if (argument === '--execute') {
      if (selectedMode && options.mode !== 'execute') throw new Error('Select one run mode');
      options.mode = 'execute';
      selectedMode = true;
    } else if (argument === '--cleanup') {
      options.cleanup = true;
    } else if (argument === '--project-ref') {
      options.projectRef = requiredArgument(argv, ++index, '--project-ref');
    } else if (argument === '--run-id') {
      options.runId = requiredArgument(argv, ++index, '--run-id');
    } else if (argument === '--cleanup-artifact') {
      if (selectedMode && options.mode !== 'cleanup-artifact') throw new Error('Select one run mode');
      options.mode = 'cleanup-artifact';
      selectedMode = true;
      options.cleanupArtifact = requiredArgument(argv, ++index, '--cleanup-artifact');
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.cleanup && options.mode !== 'execute') {
    throw new Error('--cleanup is valid only with --execute');
  }
  if (options.mode === 'cleanup-artifact' && !options.cleanupArtifact) {
    throw new Error('--cleanup-artifact requires an artifact path');
  }
  if (options.runId !== null) assertRunId(options.runId);
  return options;
}

function requiredArgument(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function makeRunId(now = new Date(), entropy = randomBytes(4).toString('hex')) {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'z').toLowerCase();
  const runId = `newone-e2e-${timestamp}-${entropy.toLowerCase()}`;
  assertRunId(runId);
  return runId;
}

export function assertRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId) || runId.length > 50) {
    throw new Error('Run ID must be a 19-50 character newone-e2e-* lowercase slug');
  }
  return runId;
}

export function selectProjectKeys(records) {
  if (!Array.isArray(records)) throw new Error('Supabase CLI returned an invalid key inventory');
  const readKey = (entry) => typeof entry?.api_key === 'string'
    ? entry.api_key
    : typeof entry?.key === 'string'
    ? entry.key
    : null;
  const publishableRecord = records.find((entry) =>
    entry?.name === 'default' && entry?.type === 'publishable' && readKey(entry)
  ) ?? records.find((entry) => entry?.name === 'anon' && readKey(entry));
  const secretRecord = records.find((entry) =>
    entry?.name === 'default' && entry?.type === 'secret' && readKey(entry)
  ) ?? records.find((entry) => entry?.name === 'service_role' && readKey(entry));
  const publishableKey = readKey(publishableRecord);
  const secretKey = readKey(secretRecord);
  if (!publishableKey || !secretKey || publishableKey === secretKey) {
    throw new Error('A distinct publishable key and server secret key are required');
  }
  return { publishableKey, secretKey };
}

export function decodeJwtPayload(token) {
  if (typeof token !== 'string') throw new Error('JWT is missing');
  const segments = token.split('.');
  if (segments.length !== 3 || !segments[1]) throw new Error('JWT is malformed');
  const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('JWT payload is malformed');
  }
  return payload;
}

export function decodeBase32(value) {
  if (typeof value !== 'string') throw new Error('TOTP secret is missing');
  const normalized = value.toUpperCase().replaceAll('=', '').replaceAll(' ', '');
  if (!/^[A-Z2-7]+$/.test(normalized)) throw new Error('TOTP secret is not valid base32');
  let bits = '';
  for (const character of normalized) {
    const numeric = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character);
    bits += numeric.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotp(secret, options = {}) {
  const period = options.period ?? 30;
  const digits = options.digits ?? 6;
  const timestampSeconds = options.timestampSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(period) || period < 1 || !Number.isInteger(digits) || digits < 6 || digits > 10) {
    throw new Error('Invalid TOTP options');
  }
  const counter = BigInt(Math.floor(timestampSeconds / period));
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', decodeBase32(secret)).update(counterBytes).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) >>> 0;
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

export function sqlLiteral(value) {
  if (typeof value !== 'string') throw new Error('SQL literal must be a string');
  if (value.includes('\0')) throw new Error('SQL literal contains a null byte');
  return `'${value.replaceAll("'", "''")}'`;
}

export function isUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function validateCleanupManifest(manifest, expectedProjectRef = EXPECTED_PROJECT_REF) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Cleanup manifest is invalid');
  }
  const runId = assertRunId(manifest.runId);
  if (manifest.projectRef !== expectedProjectRef) throw new Error('Cleanup project reference mismatch');
  if (!Number.isFinite(Date.parse(manifest.startedAt))) throw new Error('Cleanup start time is invalid');
  if (!Array.isArray(manifest.users) || !Array.isArray(manifest.organizations)) {
    throw new Error('Cleanup targets are invalid');
  }
  if (manifest.users.length > 3 || manifest.organizations.length > 2) {
    throw new Error('Cleanup target count exceeds the bounded hosted scenario');
  }

  const allowedEmails = new Set([
    `${runId}-owner-a@example.invalid`,
    `${runId}-owner-b@example.invalid`,
    `${runId}-member-a@example.invalid`,
  ]);
  const allowedSlugs = new Set([`${runId}-org-a`, `${runId}-org-b`]);

  const users = manifest.users.map((user) => {
    if (!user || !isUuid(user.id) || typeof user.email !== 'string') {
      throw new Error('Cleanup user target is invalid');
    }
    const email = user.email.toLowerCase();
    if (!allowedEmails.has(email)) {
      throw new Error('Cleanup user email is outside the run prefix');
    }
    return { id: user.id.toLowerCase(), email };
  });
  const organizations = manifest.organizations.map((organization) => {
    if (!organization || !isUuid(organization.id) || typeof organization.slug !== 'string') {
      throw new Error('Cleanup organization target is invalid');
    }
    if (!allowedSlugs.has(organization.slug)) {
      throw new Error('Cleanup organization slug is outside the run prefix');
    }
    return { id: organization.id.toLowerCase(), slug: organization.slug };
  });
  if (new Set(users.map((user) => user.id)).size !== users.length) {
    throw new Error('Cleanup user targets contain duplicates');
  }
  if (new Set(organizations.map((organization) => organization.id)).size !== organizations.length) {
    throw new Error('Cleanup organization targets contain duplicates');
  }
  return { runId, users, organizations, startedAt: manifest.startedAt };
}

export function sanitizeText(value, secrets = []) {
  let result = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) result = result.replaceAll(secret, '[REDACTED]');
  }
  return result.replace(/\b(?:sb_(?:secret|publishable)_[A-Za-z0-9_-]+|sk-or-v1-[A-Fa-f0-9]+)\b/g, '[REDACTED]');
}
