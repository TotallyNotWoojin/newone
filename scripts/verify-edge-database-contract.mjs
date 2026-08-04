import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function filesUnder(directory, extension, excludedSegments = new Set()) {
  const result = [];
  for (const entry of readdirSync(directory)) {
    if (excludedSegments.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) result.push(...filesUnder(path, extension, excludedSegments));
    else if (extname(path) === extension) result.push(path);
  }
  return result;
}

function rpcLiterals(sources) {
  const names = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/['"](bff_[a-z0-9_]+)['"]/g)) names.add(match[1]);
  }
  return names;
}

function sqlFunctions(migrations) {
  const names = new Set();
  for (const migration of migrations) {
    for (const match of migration.matchAll(
      /create\s+(?:or\s+replace\s+)?function\s+(?:public|private)\.([a-z0-9_]+)/gi,
    )) names.add(match[1].toLowerCase());
  }
  return names;
}

function configuredFunctions(config) {
  const entries = new Map();
  for (const match of config.matchAll(
    /^\[functions\.([^\]]+)\]\s*\n(?:[^\[]*?\n)*?verify_jwt\s*=\s*(true|false)\s*$/gmi,
  )) entries.set(match[1], match[2] === 'true');
  return entries;
}

export function inspectContract({ edgeSources, migrations, config, functionNames }) {
  const used = rpcLiterals(edgeSources);
  const defined = sqlFunctions(migrations);
  const configured = configuredFunctions(config);
  const missingRpcs = [...used].filter((name) => !defined.has(name)).sort();
  const unconfiguredFunctions = functionNames.filter((name) => !configured.has(name)).sort();
  const staleFunctionConfig = [...configured.keys()]
    .filter((name) => !functionNames.includes(name))
    .sort();
  return {
    usedRpcCount: used.size,
    definedFunctionCount: defined.size,
    functionCount: functionNames.length,
    missingRpcs,
    unconfiguredFunctions,
    staleFunctionConfig,
  };
}

function run() {
  const root = resolve(import.meta.dirname, '..');
  const functionsRoot = resolve(root, 'supabase/functions');
  const migrationRoot = resolve(root, 'supabase/migrations');
  const edgePaths = filesUnder(functionsRoot, '.ts', new Set(['tests']));
  const migrationPaths = filesUnder(migrationRoot, '.sql');
  const functionNames = readdirSync(functionsRoot)
    .filter((name) => !name.startsWith('_') && name !== 'tests')
    .filter((name) => existsSync(join(functionsRoot, name, 'index.ts')))
    .sort();
  const report = inspectContract({
    edgeSources: edgePaths.map((path) => readFileSync(path, 'utf8')),
    migrations: migrationPaths.map((path) => readFileSync(path, 'utf8')),
    config: readFileSync(resolve(root, 'supabase/config.toml'), 'utf8'),
    functionNames,
  });
  const failures = [
    ...report.missingRpcs.map((name) => `Edge code calls missing database RPC ${name}`),
    ...report.unconfiguredFunctions.map((name) => `Edge Function ${name} has no explicit config.toml JWT policy`),
    ...report.staleFunctionConfig.map((name) => `config.toml contains missing Edge Function ${name}`),
  ];
  if (failures.length > 0) {
    throw new Error(`Edge/database contract verification failed:\n${failures.join('\n')}`);
  }
  console.log(
    `Edge/database contract verified (${report.functionCount} functions, ` +
    `${report.usedRpcCount} called RPCs, ${report.definedFunctionCount} SQL functions).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
