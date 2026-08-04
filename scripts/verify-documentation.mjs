import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const requiredDocuments = [
  'README.md',
  'docs/ACCEPTANCE_TESTS.md',
  'docs/ARCHITECTURE.md',
  'docs/CONTRACT_TRACEABILITY.md',
  'docs/DELIVERY_AND_ACCEPTANCE_CHECKLIST.md',
  'docs/DEPLOYMENT.md',
  'docs/FULL_PRODUCT_REQUIREMENTS.md',
  'docs/MODEL_EVALUATION.md',
  'docs/PLATFORM_ARCHITECTURE_V2.md',
  'docs/PRIVACY_AND_SAFETY.md',
  'docs/RESEARCH_WHATSAPP_AND_WORKPLACE.md',
  'docs/RELEASE_EVIDENCE.md',
  'docs/SECURITY_ARCHITECTURE_V2.md',
  'docs/THIRD_PARTY_COMPONENTS.md',
  'docs/TRAINING_GUIDE.md',
  'docs/USER_GUIDE.md',
];

const failures = [];

for (const relativePath of requiredDocuments) {
  const absolutePath = resolve(root, relativePath);
  if (!existsSync(absolutePath)) {
    failures.push(`${relativePath}: required delivery document is missing`);
    continue;
  }
  const body = readFileSync(absolutePath, 'utf8');
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of body.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (!target || target.startsWith('#') || /^(?:https?:|mailto:|tel:)/i.test(target)) continue;
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split('#', 1)[0].split('?', 1)[0];
    if (!target) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      failures.push(`${relativePath}: malformed encoded link ${match[1]}`);
      continue;
    }
    const linkedPath = resolve(dirname(absolutePath), target);
    if (!existsSync(linkedPath)) failures.push(`${relativePath}: broken local link ${match[1]}`);
  }
}

const requirements = readFileSync(resolve(root, 'docs/FULL_PRODUCT_REQUIREMENTS.md'), 'utf8');
for (const marker of [
  'automatic language detection',
  'SUM-01',
  'SUM-02',
  'primary topic',
  'source fingerprint',
]) {
  if (!requirements.toLocaleLowerCase('en-US').includes(marker.toLocaleLowerCase('en-US'))) {
    failures.push(`docs/FULL_PRODUCT_REQUIREMENTS.md: missing contract marker ${marker}`);
  }
}

const traceability = readFileSync(resolve(root, 'docs/CONTRACT_TRACEABILITY.md'), 'utf8');
const requirementIds = [
  ...requirements.matchAll(/^####\s+([A-Z]+-[0-9]+)\s+/gm),
].map((match) => match[1]);
if (requirementIds.length < 40) {
  failures.push(
    `docs/FULL_PRODUCT_REQUIREMENTS.md: parsed only ${requirementIds.length} requirement identifiers`,
  );
}
for (const requirementId of requirementIds) {
  const escapedId = requirementId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^\\|\\s*${escapedId}\\s*\\|`, 'm').test(traceability)) {
    failures.push(`docs/CONTRACT_TRACEABILITY.md: missing requirement row ${requirementId}`);
  }
}

for (const staleClaim of [
  '4.5-second visible polling',
  'D1 history',
  'Native apps are not required',
  'Explicitly outside this MVP',
]) {
  if (traceability.includes(staleClaim)) {
    failures.push(`docs/CONTRACT_TRACEABILITY.md: contains stale legacy claim ${staleClaim}`);
  }
}

for (const marker of [
  'Korean to Spanish',
  'Spanish to Korean',
  'automatic conversation and shift summaries',
  'primary topic and action items',
  'One training session up to two hours',
  'not a claim of acceptance',
]) {
  if (!traceability.toLocaleLowerCase('en-US').includes(marker.toLocaleLowerCase('en-US'))) {
    failures.push(`docs/CONTRACT_TRACEABILITY.md: missing agreement marker ${marker}`);
  }
}

const training = readFileSync(resolve(root, 'docs/TRAINING_GUIDE.md'), 'utf8');
if (!/two-hour agenda/i.test(training) || !/0:00.{0,10}0:10/s.test(training)) {
  failures.push('docs/TRAINING_GUIDE.md: missing bounded two-hour delivery agenda');
}

const dependencies = readFileSync(resolve(root, 'docs/THIRD_PARTY_COMPONENTS.md'), 'utf8');
for (const marker of ['Supabase', 'OpenRouter', 'Cloudflare Turnstile', 'package-lock.json']) {
  if (!dependencies.includes(marker)) {
    failures.push(`docs/THIRD_PARTY_COMPONENTS.md: missing material component ${marker}`);
  }
}

if (failures.length > 0) {
  console.error('Documentation verification failed:\n' + failures.map((entry) => `- ${entry}`).join('\n'));
  process.exit(1);
}

console.log(`Documentation verification passed (${requiredDocuments.length} delivery files).`);
