import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const COVERAGE_FLOOR = 91;
const testRoot = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(testRoot, '..');
const sourceRoot = resolve(appRoot, 'src');
const coverageFinalPath = resolve(appRoot, '.expo', 'coverage', 'coverage-final.json');
const coverageSummaryPath = resolve(appRoot, '.expo', 'coverage', 'coverage-summary.json');
const forbiddenCoverageDirectives = [
  /istanbul\s+ignore/i,
  /c8\s+ignore/i,
  /v8\s+ignore/i,
  /node:coverage\s+(?:ignore|disable)/i,
];

function walk(directory) {
  return readdirSync(directory)
    .flatMap((name) => {
      const absolutePath = resolve(directory, name);
      return statSync(absolutePath).isDirectory() ? walk(absolutePath) : [absolutePath];
    });
}

function toPortableRelative(absolutePath) {
  return relative(appRoot, absolutePath).split(sep).join('/');
}

function eligible(absolutePath) {
  const relativePath = toPortableRelative(absolutePath);
  const extension = extname(absolutePath);
  return (extension === '.ts' || extension === '.tsx')
    && !relativePath.endsWith('.d.ts')
    && !relativePath.endsWith('.d.tsx')
    && relativePath !== 'src/data/database.types.ts';
}

const expectedFiles = walk(sourceRoot).filter(eligible).sort();
const directiveViolations = expectedFiles.flatMap((absolutePath) => {
  const source = readFileSync(absolutePath, 'utf8');
  return forbiddenCoverageDirectives.some((pattern) => pattern.test(source))
    ? [toPortableRelative(absolutePath)]
    : [];
});

const failures = [];
if (directiveViolations.length > 0) {
  failures.push(`Coverage-ignore directives are forbidden:\n${directiveViolations.join('\n')}`);
}

if (!existsSync(coverageFinalPath) || !existsSync(coverageSummaryPath)) {
  failures.push('Coverage artifacts are missing. Run npm run test:coverage so every owned source file is instrumented.');
} else {
  const coverage = JSON.parse(readFileSync(coverageFinalPath, 'utf8'));
  const coveredFiles = new Set(Object.keys(coverage).map((file) => resolve(file)));
  const missingFiles = expectedFiles.filter((file) => !coveredFiles.has(resolve(file)));
  const unexpectedFiles = [...coveredFiles]
    .filter((file) => file.startsWith(`${sourceRoot}${sep}`) && !expectedFiles.includes(file));

  if (missingFiles.length > 0) {
    failures.push(`Eligible source files missing from coverage:\n${missingFiles.map(toPortableRelative).join('\n')}`);
  }
  if (unexpectedFiles.length > 0) {
    failures.push(`Coverage contains excluded source files:\n${unexpectedFiles.map(toPortableRelative).join('\n')}`);
  }

  const summary = JSON.parse(readFileSync(coverageSummaryPath, 'utf8')).total;
  const measured = ['statements', 'branches', 'functions', 'lines']
    .map((metric) => `${metric}=${summary[metric].pct}%`)
    .join(', ');
  console.log(`Coverage inventory: ${expectedFiles.length} eligible files; ${coveredFiles.size} instrumented.`);
  console.log(`Measured coverage: ${measured}. Required: >=${COVERAGE_FLOOR}% for every metric.`);

  for (const metric of ['statements', 'branches', 'functions', 'lines']) {
    if (summary[metric].pct < COVERAGE_FLOOR) {
      failures.push(`${metric} coverage ${summary[metric].pct}% is below ${COVERAGE_FLOOR}%.`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n\n'));
  process.exitCode = 1;
} else {
  console.log('Coverage gate passed with a complete source inventory and no ignore directives.');
}
