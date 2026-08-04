import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const defaultOutput = resolve(root, 'release-artifacts/dependency-inventory.json');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? resolve(root, process.argv[outputIndex + 1] ?? '') : defaultOutput;
const evidenceRoot = resolve(root, 'release-artifacts');

if (output !== evidenceRoot && !output.startsWith(`${evidenceRoot}${sep}`)) {
  throw new Error('Dependency evidence must be written under release-artifacts/.');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function dependencyName(packagePath, entry) {
  if (entry.name) return entry.name;
  const marker = 'node_modules/';
  const markerIndex = packagePath.lastIndexOf(marker);
  return markerIndex >= 0 ? packagePath.slice(markerIndex + marker.length) : packagePath;
}

function inspectLock(relativePath, application) {
  const absolutePath = resolve(root, relativePath);
  const bytes = readFileSync(absolutePath);
  const lock = JSON.parse(bytes.toString('utf8'));
  const dependencies = [];
  const missingProductionLicenses = [];

  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    if (!packagePath || !entry || typeof entry !== 'object') continue;
    const name = dependencyName(packagePath, entry);
    const production = entry.dev !== true;
    const license = typeof entry.license === 'string' ? entry.license : null;
    const item = {
      name,
      version: entry.version ?? null,
      license,
      production,
      optional: entry.optional === true,
      peer: entry.peer === true,
      integrity: entry.integrity ?? null,
    };
    dependencies.push(item);
    if (production && !license) missingProductionLicenses.push(`${name}@${entry.version ?? 'unknown'}`);
  }

  dependencies.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en-US'),
  );

  return {
    application,
    lockfile: relativePath,
    lockfileVersion: lock.lockfileVersion ?? null,
    sha256: sha256(bytes),
    dependencyCount: dependencies.length,
    productionDependencyCount: dependencies.filter((entry) => entry.production).length,
    missingProductionLicenses,
    dependencies,
  };
}

function splitNpmSpecifier(specifier) {
  const separator = specifier.lastIndexOf('@');
  if (separator <= 0 || separator === specifier.length - 1) {
    throw new Error(`Invalid Deno npm lock entry ${specifier}`);
  }
  return { name: specifier.slice(0, separator), version: specifier.slice(separator + 1) };
}

function inspectDenoLock(relativePath, licenseGraph) {
  const absolutePath = resolve(root, relativePath);
  const bytes = readFileSync(absolutePath);
  const lock = JSON.parse(bytes.toString('utf8'));
  const licenseByPackage = new Map(
    licenseGraph.dependencies.map((entry) => [`${entry.name}@${entry.version}`, entry.license]),
  );
  const dependencies = Object.entries(lock.npm ?? {}).map(([specifier, entry]) => {
    const { name, version } = splitNpmSpecifier(specifier);
    return {
      name,
      version,
      license: licenseByPackage.get(`${name}@${version}`) ?? null,
      production: true,
      optional: false,
      peer: false,
      integrity: entry.integrity ?? null,
      dependencies: Array.isArray(entry.dependencies) ? [...entry.dependencies].sort() : [],
    };
  });
  dependencies.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en-US'),
  );
  return {
    application: 'edge-functions',
    lockfile: relativePath,
    lockfileVersion: lock.version ?? null,
    sha256: sha256(bytes),
    dependencyCount: dependencies.length,
    productionDependencyCount: dependencies.length,
    missingProductionLicenses: dependencies
      .filter((entry) => !entry.license)
      .map((entry) => `${entry.name}@${entry.version}`),
    dependencies,
  };
}

const releaseToolingGraph = inspectLock('package-lock.json', 'release-tooling');
const universalClientGraph = inspectLock('apps/newone/package-lock.json', 'universal-client');
const graphs = [
  releaseToolingGraph,
  universalClientGraph,
  inspectDenoLock('supabase/functions/deno.lock', universalClientGraph),
];

const missingLicenses = graphs.flatMap((graph) =>
  graph.missingProductionLicenses.map((dependency) => `${graph.application}:${dependency}`),
);
if (missingLicenses.length > 0) {
  throw new Error(`Production dependencies without declared licenses:\n${missingLicenses.join('\n')}`);
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceRevision: process.env.GITHUB_SHA ?? process.env.NEWONE_RELEASE_REVISION ?? 'local-uncommitted',
  nodeVersion: process.version,
  npmUserAgent: process.env.npm_config_user_agent ?? null,
  lockfiles: graphs,
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(
  `Dependency inventory written to ${relative(root, output)} (${graphs.reduce((sum, graph) => sum + graph.dependencyCount, 0)} resolved entries).`,
);
