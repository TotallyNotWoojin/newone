import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const evidenceRoot = resolve(root, 'release-artifacts');
mkdirSync(evidenceRoot, { recursive: true });

const targets = [
  { name: 'release-tooling', cwd: root },
  { name: 'universal-client', cwd: resolve(root, 'apps/newone') },
];

for (const target of targets) {
  const raw = execFileSync(
    'npm',
    [
      'sbom',
      '--package-lock-only',
      '--omit=dev',
      '--sbom-format=cyclonedx',
      '--sbom-type=application',
    ],
    { cwd: target.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const sbom = JSON.parse(raw);
  if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components)) {
    throw new Error(`npm returned an invalid CycloneDX document for ${target.name}.`);
  }
  const output = resolve(evidenceRoot, `${target.name}.cdx.json`);
  writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`, { mode: 0o600 });
  console.log(`SBOM written to ${relative(root, output)} (${sbom.components.length} components).`);
}

function splitNpmSpecifier(specifier) {
  const separator = specifier.lastIndexOf('@');
  if (separator <= 0 || separator === specifier.length - 1) {
    throw new Error(`Invalid Deno npm lock entry ${specifier}`);
  }
  return { name: specifier.slice(0, separator), version: specifier.slice(separator + 1) };
}

function packageUrl(name, version) {
  const purlName = name.startsWith('@')
    ? `%40${name.slice(1).split('/').map(encodeURIComponent).join('/')}`
    : encodeURIComponent(name);
  return `pkg:npm/${purlName}@${encodeURIComponent(version)}`;
}

function licenseIndex() {
  const lock = JSON.parse(readFileSync(resolve(root, 'apps/newone/package-lock.json'), 'utf8'));
  const result = new Map();
  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    if (!packagePath || !entry?.version || typeof entry.license !== 'string') continue;
    const marker = 'node_modules/';
    const markerIndex = packagePath.lastIndexOf(marker);
    const name = entry.name ?? packagePath.slice(markerIndex + marker.length);
    result.set(`${name}@${entry.version}`, entry.license);
  }
  return result;
}

const denoLock = JSON.parse(readFileSync(resolve(root, 'supabase/functions/deno.lock'), 'utf8'));
const licenses = licenseIndex();
const referencesByName = new Map();
const edgeComponents = Object.entries(denoLock.npm ?? {}).map(([specifier, entry]) => {
  const { name, version } = splitNpmSpecifier(specifier);
  const reference = packageUrl(name, version);
  const existing = referencesByName.get(name) ?? [];
  existing.push(reference);
  referencesByName.set(name, existing);
  const [algorithm, encodedHash] = String(entry.integrity ?? '').split('-', 2);
  const license = licenses.get(`${name}@${version}`);
  const scoped = name.startsWith('@') ? name.split('/') : null;
  return {
    type: 'library',
    'bom-ref': reference,
    ...(scoped ? { group: scoped[0] } : {}),
    name: scoped ? scoped.slice(1).join('/') : name,
    version,
    purl: reference,
    ...(algorithm === 'sha512' && encodedHash
      ? { hashes: [{ alg: 'SHA-512', content: Buffer.from(encodedHash, 'base64').toString('hex') }] }
      : {}),
    ...(license ? { licenses: [{ license: { id: license } }] } : {}),
  };
});

const edgeApplicationRef = 'newone:edge-functions';
const edgeDependencies = Object.entries(denoLock.npm ?? {}).map(([specifier, entry]) => {
  const { name, version } = splitNpmSpecifier(specifier);
  return {
    ref: packageUrl(name, version),
    dependsOn: (entry.dependencies ?? [])
      .flatMap((dependency) => referencesByName.get(dependency) ?? [])
      .sort(),
  };
});
const directReferences = (denoLock.workspace?.dependencies ?? [])
  .filter((specifier) => typeof specifier === 'string' && specifier.startsWith('npm:'))
  .map((specifier) => {
    const { name, version } = splitNpmSpecifier(specifier.slice(4));
    return packageUrl(name, version);
  })
  .sort();
const edgeSbom = {
  '$schema': 'http://cyclonedx.org/schema/bom-1.6.schema.json',
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: 'application',
      'bom-ref': edgeApplicationRef,
      name: 'newone-edge-functions',
      version: '2.0.0',
    },
  },
  components: edgeComponents,
  dependencies: [
    { ref: edgeApplicationRef, dependsOn: directReferences },
    ...edgeDependencies,
  ],
};
const edgeOutput = resolve(evidenceRoot, 'edge-functions.cdx.json');
writeFileSync(edgeOutput, `${JSON.stringify(edgeSbom, null, 2)}\n`, { mode: 0o600 });
console.log(`SBOM written to ${relative(root, edgeOutput)} (${edgeComponents.length} components).`);
