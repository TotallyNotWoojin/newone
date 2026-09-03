// Maestro runner. Every flow is executed on an explicit --device udid with
// its env passed via -e; on failure the on-screen text is captured through
// `maestro hierarchy` so the report can quote the exact error the user saw.
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const MAESTRO = `${process.env.HOME}/.maestro/bin/maestro`;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function tail(text, lines) {
  return String(text ?? '').split('\n').filter(Boolean).slice(-lines).join('\n');
}

export function summarizeMaestroOutput(stdout) {
  const lines = String(stdout ?? '').replace(ANSI, '').split('\n');
  const failed = lines.filter((line) => /FAILED|Assertion|not found|Element not found|Unable to|Error|Exception/i.test(line) && !/COMPLETED\s*$/.test(line));
  return failed.slice(-8).map((line) => line.trim()).join('\n');
}

export async function runFlow({ device, flow, env = {}, cwd, timeoutMs = 300_000, debugDir }) {
  const args = ['--device', device, 'test'];
  if (debugDir) {
    mkdirSync(debugDir, { recursive: true });
    args.push('--debug-output', debugDir);
  }
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  args.push(flow);
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(MAESTRO, args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, MAESTRO_CLI_NO_ANALYTICS: '1' },
    });
    return { ok: true, durationMs: Date.now() - started, stdout, stderr, failure: '' };
  } catch (error) {
    const stdout = String(error.stdout ?? '');
    const stderr = String(error.stderr ?? '');
    const timedOut = error.killed === true || /ETIMEDOUT/.test(String(error.code ?? ''));
    const failure = (timedOut ? `maestro timed out after ${Math.round(timeoutMs / 1000)}s (harness limit)\n` : '')
      + (summarizeMaestroOutput(stdout) || tail(stderr, 6) || String(error.message).slice(0, 400));
    return { ok: false, durationMs: Date.now() - started, stdout, stderr, failure, timedOut };
  }
}

function collectTexts(node, out) {
  if (!node || typeof node !== 'object') return;
  const attributes = node.attributes ?? node;
  for (const key of ['text', 'accessibilityText', 'title', 'value', 'hintText', 'label']) {
    const value = attributes?.[key];
    if (typeof value === 'string' && value.trim()) out.push(value.trim());
  }
  for (const child of node.children ?? []) collectTexts(child, out);
}

// Visible text on the device right now (deduplicated, document order).
export async function screenTexts(device, timeoutMs = 90_000) {
  try {
    const { stdout } = await execFileAsync(MAESTRO, ['--device', device, 'hierarchy'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    const jsonStart = stdout.indexOf('{');
    if (jsonStart < 0) return { texts: [], raw: stdout.slice(0, 2000) };
    const parsed = JSON.parse(stdout.slice(jsonStart));
    const texts = [];
    collectTexts(parsed, texts);
    return { texts: [...new Set(texts)], raw: null };
  } catch (error) {
    return { texts: [], raw: `hierarchy unavailable: ${String(error.message).slice(0, 200)}` };
  }
}

const ERROR_PATTERNS = [
  /could not/i, /cannot/i, /unavailable/i, /failed/i, /invalid/i, /expired/i, /not sent/i, /try again/i,
  /too many/i, /does not allow/i, /not allowed/i, /forbidden/i, /\([a-z_]+(?: · [0-9a-f]{4,8})?\)/i, /error/i, /denied/i,
];

export function findErrorTexts(texts) {
  return texts.filter((text) => ERROR_PATTERNS.some((pattern) => pattern.test(text)) && text.length < 400);
}

export function screenshotsIn(dir, prefix) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.png'))
    .sort()
    .map((name) => join(dir, name));
}
