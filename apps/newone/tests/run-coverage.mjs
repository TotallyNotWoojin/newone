import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testRoot = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(testRoot, '..');
const require = createRequire(import.meta.url);
const jestBin = require.resolve('jest/bin/jest');
const verifier = resolve(testRoot, 'verify-coverage-report.mjs');

const jestResult = spawnSync(
  process.execPath,
  [jestBin, '--config', resolve(appRoot, 'jest.config.cjs'), '--runInBand', '--coverage'],
  { cwd: appRoot, stdio: 'inherit' },
);
const verifyResult = spawnSync(process.execPath, [verifier], {
  cwd: appRoot,
  stdio: 'inherit',
});

if (jestResult.error) throw jestResult.error;
if (verifyResult.error) throw verifyResult.error;

process.exitCode = jestResult.status === 0 && verifyResult.status === 0 ? 0 : 1;
