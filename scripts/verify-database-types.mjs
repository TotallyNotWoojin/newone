import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(
  new URL('../apps/newone/src/data/database.types.ts', import.meta.url),
);
const generated = spawnSync(
  'supabase',
  ['gen', 'types', 'typescript', '--local', '--schema', 'public'],
  {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  },
);

if (generated.status !== 0) {
  process.stderr.write(generated.stderr || generated.stdout);
  process.exit(generated.status ?? 1);
}

const normalized = `${generated.stdout.replaceAll('\r\n', '\n').trimEnd()}\n`;

if (process.argv.includes('--write')) {
  writeFileSync(target, normalized);
  process.stdout.write(`Generated ${target}\n`);
  process.exit(0);
}

const checkedIn = readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
if (checkedIn !== normalized) {
  process.stderr.write(
    'Supabase database types are stale. Run `npm run backend:types:generate` after a local database reset.\n',
  );
  process.exit(1);
}

process.stdout.write('Supabase database types match the local public schema.\n');
