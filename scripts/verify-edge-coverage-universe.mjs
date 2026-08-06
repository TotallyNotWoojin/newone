import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const functionsRoot = path.resolve('supabase/functions');
const lcovPath = path.resolve(process.argv[2] ?? 'coverage/edge/lcov.info');
const ignoreCommentPattern = /(?:c8|istanbul|deno(?:-coverage)?)\s+ignore/i;

async function productionFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tests' || entry.name === 'integration-tests') continue;
      files.push(...await productionFiles(target));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path.resolve(target));
    }
  }
  return files;
}

function coveredFiles(lcov) {
  const files = new Set();
  for (const line of lcov.split(/\r?\n/)) {
    if (!line.startsWith('SF:')) continue;
    const raw = line.slice(3);
    const resolved = raw.startsWith('file:')
      ? fileURLToPath(raw)
      : path.resolve(raw);
    files.add(path.normalize(resolved));
  }
  return files;
}

const expected = await productionFiles(functionsRoot);
const lcov = await readFile(lcovPath, 'utf8').catch(() => {
  throw new Error(`Edge LCOV report is missing at ${lcovPath}.`);
});
const covered = coveredFiles(lcov);

const ignored = [];
for (const file of expected) {
  if (ignoreCommentPattern.test(await readFile(file, 'utf8'))) ignored.push(file);
}
if (ignored.length > 0) {
  throw new Error(
    `Coverage-ignore comments are forbidden in production Edge code:\n${ignored.map((file) => `- ${path.relative(process.cwd(), file)}`).join('\n')}`,
  );
}

const missing = expected.filter((file) => !covered.has(path.normalize(file)));
if (missing.length > 0) {
  throw new Error(
    `Edge coverage omitted ${missing.length} production source files:\n${missing.map((file) => `- ${path.relative(process.cwd(), file)}`).join('\n')}`,
  );
}

console.log(`Verified Edge coverage includes all ${expected.length} production TypeScript files.`);
