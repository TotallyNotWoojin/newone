import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function filesUnder(directory, extensions) {
  const result = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) result.push(...filesUnder(path, extensions));
    else if (extensions.has(extname(path))) result.push(path);
  }
  return result;
}

function declaredNames(examplePath) {
  const names = new Set();
  for (const line of readFileSync(examplePath, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

function referencedNames(paths, prefix) {
  const names = new Set();
  const patterns = [
    /(?:Deno\.)?env\.get\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
    /(?:requiredSecret|requiredEnv|optionalEnv)\(['"]([A-Z][A-Z0-9_]*)['"]/g,
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
  ];
  for (const path of paths) {
    const body = readFileSync(path, 'utf8');
    for (const pattern of patterns) {
      for (const match of body.matchAll(pattern)) {
        if (!prefix || match[1].startsWith(prefix)) names.add(match[1]);
      }
    }
  }
  return names;
}

const serverFiles = [
  ...filesUnder(resolve(root, 'supabase/functions'), new Set(['.ts'])),
  ...filesUnder(resolve(root, 'api'), new Set(['.mjs'])),
];
const serverDeclared = declaredNames(resolve(root, '.env.example'));
const serverReferenced = referencedNames(serverFiles);

// Supabase may inject one of the modern or legacy key aliases. The canonical
// names below still have to be documented; fallback aliases are platform
// compatibility inputs and need not all appear in the example.
const injectedAliases = new Set([
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_PUBLISHABLE_KEYS',
  'SUPABASE_SECRET_KEYS',
]);

const appFiles = filesUnder(resolve(root, 'apps/newone/src'), new Set(['.ts', '.tsx']));
const appDeclared = declaredNames(resolve(root, 'apps/newone/.env.example'));
const appReferenced = referencedNames(appFiles, 'EXPO_PUBLIC_');

const failures = [];
for (const name of serverReferenced) {
  if (!serverDeclared.has(name) && !injectedAliases.has(name)) {
    failures.push(`.env.example does not document server variable ${name}`);
  }
}
for (const name of appReferenced) {
  if (!appDeclared.has(name)) {
    failures.push(`apps/newone/.env.example does not document public variable ${name}`);
  }
}

for (const required of [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'NEWONE_ALLOWED_WEB_ORIGINS',
  'NEWONE_NETWORK_HASH_KEY',
  'NEWONE_RECOVERY_EVIDENCE_HASH_KEY',
  'NEWONE_WEB_GATEWAY_SHARED_SECRET',
  'NEWONE_WORKER_TOKEN',
  'NEWONE_CURSOR_SIGNING_KEY',
  'NEWONE_PUSH_TOKEN_KEY_V1',
  'OPENROUTER_MANAGEMENT_API_KEY',
  'NEWONE_OPENROUTER_API_KEY_HASH',
  'NEWONE_OPENROUTER_WORKSPACE_ID',
]) {
  if (!serverDeclared.has(required)) failures.push(`.env.example is missing required ${required}`);
}

for (const forbidden of serverDeclared) {
  if (forbidden.startsWith('EXPO_PUBLIC_')) {
    failures.push(`server example exposes ${forbidden} through the public namespace`);
  }
}
for (const forbidden of appDeclared) {
  if (/(?:SECRET|SERVICE_ROLE|OPENROUTER|DATABASE_PASSWORD|APNS|FCM)/.test(forbidden)) {
    failures.push(`public app example contains server credential class ${forbidden}`);
  }
}

if (failures.length > 0) {
  console.error('Environment contract verification failed:\n' + failures.map((entry) => `- ${entry}`).join('\n'));
  process.exit(1);
}

console.log(
  `Environment contract verified (${serverReferenced.size} server and ${appReferenced.size} public references).`,
);
