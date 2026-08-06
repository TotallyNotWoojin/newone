#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXECUTION_CONFIRMATION,
  EXPECTED_PROJECT_REF,
  makeRunId,
} from './lib.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bootstrapSecretName = 'NEWONE_BOOTSTRAP_TOKEN';

function supabase(args, options = {}) {
  return execFileSync('supabase', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

if (process.env.NEWONE_HOSTED_E2E !== EXECUTION_CONFIRMATION) {
  throw new Error('Set NEWONE_HOSTED_E2E=1 to permit the real hosted development simulation.');
}

const inventory = JSON.parse(supabase([
  'secrets',
  'list',
  '--project-ref',
  EXPECTED_PROJECT_REF,
  '--output',
  'json',
]));
if (inventory.some((entry) => entry?.name === bootstrapSecretName)) {
  throw new Error(
    `${bootstrapSecretName} already exists; refusing to overwrite an owner-controlled secret.`,
  );
}

const startedAt = new Date();
const runId = makeRunId(startedAt, randomBytes(4).toString('hex'));
const bootstrapToken = randomBytes(48).toString('base64url');
let secretInstalled = false;
let runStatus = 1;

try {
  supabase([
    'secrets',
    'set',
    `${bootstrapSecretName}=${bootstrapToken}`,
    '--project-ref',
    EXPECTED_PROJECT_REF,
  ]);
  secretInstalled = true;
  console.log(`Installed an ephemeral Bootstrap secret for hosted run ${runId}.`);

  const result = spawnSync(
    process.execPath,
    [
      'tests/hosted/run.mjs',
      '--execute',
      '--cleanup',
      '--run-id',
      runId,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NEWONE_HOSTED_BOOTSTRAP_TOKEN: bootstrapToken,
        NEWONE_HOSTED_E2E_CLEANUP_CONFIRM: runId,
      },
      stdio: 'inherit',
    },
  );
  runStatus = result.status ?? 1;
} finally {
  if (secretInstalled) {
    try {
      supabase([
        'secrets',
        'unset',
        bootstrapSecretName,
        '--project-ref',
        EXPECTED_PROJECT_REF,
        '--yes',
      ]);
      console.log('Removed the ephemeral Bootstrap secret.');
    } catch {
      console.error(
        `Failed to remove ${bootstrapSecretName}; remove it immediately with the Supabase CLI.`,
      );
      runStatus = 1;
    }
  }
}

process.exitCode = runStatus;
