import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const OPERATORS = new Set(['AND', 'OR', 'WITH']);

function atoms(expression) {
  return (expression.match(/[A-Za-z0-9.+-]+/g) ?? [])
    .filter((value) => !OPERATORS.has(value));
}

export function classifyLicense(expression, policy) {
  if (typeof expression !== 'string' || !expression.trim()) {
    return { state: 'denied', reason: 'missing-license' };
  }
  const normalized = expression.trim();
  if (policy.approvedExpressions.includes(normalized)) {
    return { state: 'allowed', reason: 'approved-expression' };
  }
  if (policy.deniedFragments.some((fragment) => normalized.includes(fragment))) {
    return { state: 'denied', reason: 'denied-license-fragment' };
  }

  const identifiers = atoms(normalized);
  const permissive = new Set(policy.permissiveLicenseIds);
  const review = new Set(policy.reviewLicenseIds);
  const denied = new Set(policy.deniedLicenseIds);

  if (identifiers.some((identifier) => denied.has(identifier))) {
    return { state: 'denied', reason: 'denied-license' };
  }
  if (identifiers.some((identifier) => review.has(identifier))) {
    return { state: 'review', reason: 'notice-or-copyleft-review' };
  }
  if (identifiers.length > 0 && identifiers.every((identifier) => permissive.has(identifier))) {
    return { state: 'allowed', reason: 'permissive-license' };
  }
  return { state: 'review', reason: 'unclassified-expression' };
}

export function buildLicenseReport(inventory, policy) {
  const entries = [];
  for (const graph of inventory.lockfiles ?? []) {
    for (const dependency of graph.dependencies ?? []) {
      if (!dependency.production) continue;
      const classification = classifyLicense(dependency.license, policy);
      entries.push({
        application: graph.application,
        name: dependency.name,
        version: dependency.version,
        license: dependency.license,
        ...classification,
      });
    }
  }
  entries.sort((left, right) =>
    `${left.state}:${left.application}:${left.name}@${left.version}`.localeCompare(
      `${right.state}:${right.application}:${right.name}@${right.version}`,
      'en-US',
    ));
  const count = (state) => entries.filter((entry) => entry.state === state).length;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRevision: inventory.sourceRevision ?? 'unknown',
    summary: {
      productionEntries: entries.length,
      allowed: count('allowed'),
      review: count('review'),
      denied: count('denied'),
    },
    reviewRequired: entries.filter((entry) => entry.state === 'review'),
    denied: entries.filter((entry) => entry.state === 'denied'),
    entries,
  };
}

function run() {
  const root = resolve(import.meta.dirname, '..');
  const inventoryPath = resolve(root, 'release-artifacts/dependency-inventory.json');
  const policyPath = resolve(root, 'config/dependency-license-policy.json');
  const output = resolve(root, 'release-artifacts/license-policy-report.json');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const report = buildLicenseReport(inventory, policy);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

  if (report.denied.length > 0) {
    const details = report.denied
      .map((entry) => `${entry.application}:${entry.name}@${entry.version} (${entry.license})`)
      .join('\n');
    throw new Error(`Denied production dependency licenses:\n${details}`);
  }
  if (process.argv.includes('--strict-review') && report.reviewRequired.length > 0) {
    const details = report.reviewRequired
      .map((entry) => `${entry.application}:${entry.name}@${entry.version} (${entry.license})`)
      .join('\n');
    throw new Error(`Production dependency licenses still require approval:\n${details}`);
  }
  console.log(
    `License policy report written to ${relative(root, output)} ` +
    `(${report.summary.allowed} allowed, ${report.summary.review} review, 0 denied).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
