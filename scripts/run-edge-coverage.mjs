import { mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const coverageRoot = path.resolve('coverage/edge');
const rawDirectory = path.join(coverageRoot, 'raw');
const lcovPath = path.join(coverageRoot, 'lcov.info');
const include = '^file:.*/supabase/functions/(?:_shared|newone-[^/]+)/.*\\.ts$';
const exclude = '/(?:tests|integration-tests)/';

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (path.basename(coverageRoot) !== 'edge' || path.basename(path.dirname(coverageRoot)) !== 'coverage') {
  throw new Error('Refusing to clean an unexpected coverage directory.');
}
await rm(coverageRoot, { recursive: true, force: true });
await mkdir(rawDirectory, { recursive: true });

run('deno', [
  'test',
  '--config=supabase/functions/deno.json',
  '--allow-env',
  `--coverage=${rawDirectory}`,
  '--clean',
  'supabase/functions/tests',
]);

run(process.execPath, ['scripts/collect-edge-entrypoint-coverage.mjs', rawDirectory]);

run('deno', [
  'coverage',
  `--include=${include}`,
  `--exclude=${exclude}`,
  '--lcov',
  `--output=${lcovPath}`,
  rawDirectory,
]);

run(process.execPath, ['scripts/verify-edge-coverage-universe.mjs', lcovPath]);

run('deno', [
  'coverage',
  '--threshold=91',
  `--include=${include}`,
  `--exclude=${exclude}`,
  rawDirectory,
]);
