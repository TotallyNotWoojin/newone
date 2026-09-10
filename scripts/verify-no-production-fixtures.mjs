import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const productionInputs = [
  'api',
  'apps/newone/src',
  'apps/newone/app.json',
  'apps/newone/eas.json',
  'apps/newone/.env.example',
  'apps/newone/package.json',
  'config',
  'supabase/functions/_shared',
  'supabase/functions/newone-ai-worker',
  'supabase/functions/newone-api',
  'supabase/functions/newone-attachment-scan-worker',
  'supabase/functions/newone-auth',
  'supabase/functions/newone-bootstrap',
  'supabase/functions/newone-outbox-worker',
  'supabase/functions/newone-push-receipt-worker',
  'supabase/functions/newone-read',
  'supabase/migrations',
  'supabase/seed.sql',
];

const bundleTargets = {
  web: 'apps/newone/dist',
  ios: 'apps/newone/.expo/verify-ios',
  android: 'apps/newone/.expo/verify-android',
};

const forbiddenMarkers = [
  ['legacy demo environment switch', /EXPO_PUBLIC_DEMO_MODE/],
  ['demo repository class', /\bDemoRepository\b/],
  ['demo repository module', /(?:data\/demo|demo-repository)/],
  ['demo authorization branch', /\bdemoMode\b/],
  ['fictional product runtime', /fictional local product demo/i],
  ['fixture organization identity', /\bdemo-organization\b/],
  ['fixture user identity', /\bdemo-user\b/],
  ['fixture message identity', /\bmsg-p-reportable\b/],
  ['synthetic moderation runtime', /synthetic demo evidence/i],
];

const textBundleExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.txt',
]);

function requiredBundleNames() {
  const argument = process.argv.find((value) => value.startsWith('--require='));
  if (!argument) return [];
  const names = argument.slice('--require='.length).split(',').filter(Boolean);
  for (const name of names) {
    if (!(name in bundleTargets)) throw new Error(`Unknown bundle target: ${name}`);
  }
  return names;
}

async function filesBelow(target) {
  const info = await stat(target).catch(() => null);
  if (!info) return [];
  if (info.isFile()) return [target];
  if (!info.isDirectory()) return [];

  const entries = await readdir(target, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function scanFile(file) {
  const content = await readFile(file, 'utf8');
  for (const [description, pattern] of forbiddenMarkers) {
    if (pattern.test(content)) {
      throw new Error(`${description} found in production artifact ${path.relative(process.cwd(), file)}`);
    }
  }
}

const required = requiredBundleNames();
const sourceFiles = (await Promise.all(productionInputs.map(filesBelow))).flat();
if (sourceFiles.length === 0) throw new Error('No production runtime inputs were found.');

for (const file of sourceFiles) await scanFile(file);

let bundleFileCount = 0;
for (const name of required) {
  const target = bundleTargets[name];
  const info = await stat(target).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`Required ${name} bundle is missing at ${target}.`);
  }
  const files = (await filesBelow(target)).filter((file) => textBundleExtensions.has(path.extname(file)));
  if (files.length === 0) throw new Error(`Required ${name} bundle contains no inspectable files.`);
  bundleFileCount += files.length;
  for (const file of files) await scanFile(file);
}

console.log(
  `Verified ${sourceFiles.length} production inputs and ${bundleFileCount} bundled text artifacts contain no runtime fixtures.`,
);
