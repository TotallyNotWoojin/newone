#!/usr/bin/env node
// Two real humans on two real phones (simulators), through the real app:
// A finds B by username, sends a message request with a first message; B
// sees it, accepts, replies; A sees the reply. No API shortcuts.
//
// Usage: USERNAME_B=<b's username> DEVICE_A=<udid> DEVICE_B=<udid> node tests/device/run-messaging.mjs
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FLOWS = join(dirname(fileURLToPath(import.meta.url)), 'flows');
const MAESTRO = `${process.env.HOME}/.maestro/bin/maestro`;
const DEVICE_A = process.env.DEVICE_A ?? '084E6094-8685-40DA-AB64-9DF887F48842';
const DEVICE_B = process.env.DEVICE_B ?? '74D8B645-02E0-4D3F-AEF2-1E8BB7813D7B';
const USERNAME_B = process.env.USERNAME_B;
if (!USERNAME_B) { console.error('USERNAME_B is required'); process.exit(1); }

function maestro(device, flow, env = {}) {
  const args = ['--device', device, 'test'];
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  args.push(join(FLOWS, flow));
  try {
    execFileSync(MAESTRO, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
    return true;
  } catch (error) {
    console.error(String(error.stdout ?? '').split('\n').filter((l) => /COMPLETED|FAILED|Assertion|not found/.test(l)).slice(-12).join('\n'));
    return false;
  }
}

if (!maestro(DEVICE_A, 'a-send-request.yaml', { USERNAME_B })) { console.error('FAIL: A could not find B / send the request'); process.exit(1); }
console.log('A sent a message request to B and is in the conversation');
if (!maestro(DEVICE_B, 'b-accept-and-reply.yaml')) { console.error('FAIL: B could not see/accept/reply'); process.exit(1); }
console.log('B accepted and replied');
if (!maestro(DEVICE_A, 'a-sees-reply.yaml')) { console.error('FAIL: A did not see B\'s reply'); process.exit(1); }
console.log('PASS: two real people messaged each other through the real app');
