import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('apps/newone/dist');
const deploymentConfigPath = path.resolve('vercel.json');
const allowedInlineScriptHashes = new Set([
  'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8=',
]);
const forbiddenCredentialPatterns = [
  /sk-or-v1-[A-Za-z0-9_-]{20,}/,
  /sb_secret_[A-Za-z0-9_-]{20,}/,
  /SUPABASE_SERVICE_ROLE_KEY\s*=/,
  /OPENROUTER_API_KEY\s*=/,
];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(target)));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (match) => match[1],
  );
}

function scriptHash(body) {
  return `sha256-${createHash('sha256').update(body).digest('base64')}`;
}

const info = await stat(root).catch(() => null);
if (!info?.isDirectory()) throw new Error('Web export is missing. Run the Expo web build first.');

const deploymentConfig = JSON.parse(await readFile(deploymentConfigPath, 'utf8'));
const globalHeaders = deploymentConfig.headers?.find((entry) => entry.source === '/(.*)')?.headers ?? [];
const csp = globalHeaders.find((entry) => entry.key?.toLowerCase() === 'content-security-policy')?.value;
if (typeof csp !== 'string') throw new Error('The production web CSP is missing.');
for (const directive of [
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  'https://challenges.cloudflare.com',
]) {
  if (!csp.includes(directive)) throw new Error(`The production web CSP is missing ${directive}.`);
}
if (csp.includes("'unsafe-eval'")) throw new Error('The production web CSP permits unsafe-eval.');
for (const hash of allowedInlineScriptHashes) {
  if (!csp.includes(`'${hash}'`)) {
    throw new Error(`The production web CSP does not authorize ${hash}.`);
  }
}

const files = await filesBelow(root);
const htmlFiles = files.filter((file) => file.endsWith('.html'));
if (htmlFiles.length < 8) throw new Error(`Expected the routed web export, found ${htmlFiles.length} HTML files.`);

for (const required of [
  'manifest.json',
  'service-worker.js',
  'register-service-worker.js',
  'offline.html',
  'newone-icon-192.png',
  'newone-icon-512.png',
]) {
  const found = files.some((file) => path.relative(root, file) === required);
  if (!found) throw new Error(`Installed-web asset ${required} is missing.`);
}

const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
for (const size of ['192x192', '512x512']) {
  if (!manifest.icons?.some((icon) => icon.type === 'image/png' && icon.sizes === size)) {
    throw new Error(`The web manifest is missing a real ${size} PNG icon.`);
  }
}

const serviceWorker = await readFile(path.join(root, 'service-worker.js'), 'utf8');
for (const required of ["cache: 'no-store'", "url.pathname.startsWith('/api/')", 'APPROVED_SHELL_ASSETS']) {
  if (!serviceWorker.includes(required)) {
    throw new Error(`The conservative service worker is missing ${required}.`);
  }
}
for (const forbidden of ["'/api'", "'/_expo'", 'supabase.co', 'Authorization', 'message']) {
  if (serviceWorker.match(/APPROVED_SHELL_ASSETS[\s\S]*?\]\);/)?.[0]?.includes(forbidden)) {
    throw new Error(`The service-worker shell allowlist contains forbidden entry ${forbidden}.`);
  }
}

for (const file of files) {
  const content = await readFile(file);
  const text = content.toString('utf8');
  for (const pattern of forbiddenCredentialPatterns) {
    if (pattern.test(text)) throw new Error(`Server credential material found in ${path.relative(root, file)}.`);
  }
  if (!file.endsWith('.html')) continue;
  if (!/<meta[^>]+name=["']viewport["']/i.test(text)) {
    throw new Error(`Viewport metadata is missing from ${path.relative(root, file)}.`);
  }
  if (!/<title(?:\s|>)/i.test(text)) {
    throw new Error(`A document title is missing from ${path.relative(root, file)}.`);
  }
  if (
    path.basename(file) !== 'offline.html'
    && !/<script[^>]+src=["']\/register-service-worker\.js["']/i.test(text)
  ) {
    throw new Error(`Service-worker registration is missing from ${path.relative(root, file)}.`);
  }
  for (const body of inlineScripts(text)) {
    const hash = scriptHash(body);
    if (!allowedInlineScriptHashes.has(hash)) {
      throw new Error(
        `CSP does not authorize inline script ${hash} in ${path.relative(root, file)}.`,
      );
    }
  }
}

console.log(`Verified ${htmlFiles.length} routed HTML files and ${files.length} exported files.`);
