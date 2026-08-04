import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const tracked = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);

const forbiddenPaths = new Set([
  '.openai/hosting.json',
  'app/chatgpt-auth.ts',
]);
const ruleSourcePaths = new Set(['scripts/verify-repository-security.mjs']);

const findings = [];

for (const path of tracked) {
  // A dirty migration worktree can legitimately contain tracked files that
  // are already deleted but not committed yet. CI sees the post-commit index.
  if (!existsSync(path)) continue;
  if (forbiddenPaths.has(path)) {
    findings.push(`${path}: legacy hosted-runtime file is still tracked`);
    continue;
  }
  if (ruleSourcePaths.has(path)) continue;

  let source;
  try {
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    source = bytes.toString('utf8');
  } catch {
    findings.push(`${path}: tracked file could not be inspected`);
    continue;
  }

  const rules = [
    {
      expression: /sb_secret_[A-Za-z0-9_-]{20,}/g,
      message: 'Supabase server secret pattern',
    },
    {
      expression: /sk-or-v1-[A-Za-z0-9_-]{20,}/g,
      message: 'OpenRouter credential pattern',
    },
    {
      expression:
        /EXPO_PUBLIC_[A-Za-z0-9_]*(?:SERVICE_ROLE|SECRET|OPENROUTER|DATABASE_PASSWORD|APNS|FCM)/g,
      message: 'server-only credential class exposed through EXPO_PUBLIC_*',
    },
  ];

  if (!path.startsWith('docs/')) {
    rules.push({
      expression: /(?:chatgpt-auth|OAI-Sites-Authorization)/g,
      message: 'legacy ChatGPT Sites runtime binding',
    });
  }

  if (path.startsWith('apps/newone/src/data/')) {
    rules.push({
      expression: /\.from\s*\(\s*['"]/g,
      message: 'direct Supabase table access bypasses the bounded revocation-aware Edge contract',
    });
  }

  if (path.startsWith('.github/workflows/') && /\.ya?ml$/i.test(path)) {
    rules.push({
      expression:
        /uses:\s*[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@(?![0-9a-f]{40}(?:\s|#|$))[^\s#]+/g,
      message: 'third-party GitHub Action is not pinned to an immutable commit SHA',
    });
  }

  for (const rule of rules) {
    rule.expression.lastIndex = 0;
    const match = rule.expression.exec(source);
    if (!match) continue;
    const line = source.slice(0, match.index).split('\n').length;
    findings.push(`${path}:${line}: ${rule.message}`);
  }
}

if (findings.length > 0) {
  console.error('Repository security verification failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Repository security verification passed (${tracked.length} tracked files inspected).`);
