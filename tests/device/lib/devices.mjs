// Simulator pool for the real-device suite. Only simulators the suite owns
// are ever booted or shut down; the owner's hand-driven iPhone 17 Pro and
// 17 Pro Max are hard-excluded so a run can never touch them.
import { execFileSync } from 'node:child_process';

export const APP_ID = 'com.totallynotwoojin.newone';
export const APP_PATH = process.env.NEWONE_APP_PATH
  ?? '/Users/woojin/Library/Developer/Xcode/DerivedData/Newone-bncixaxagctigcezdsldwgsoxvsz/Build/Products/Release-iphonesimulator/Newone.app';
export const OWNER_DEVICES = new Set([
  '084E6094-8685-40DA-AB64-9DF887F48842', // iPhone 17 Pro — owner uses by hand
  '74D8B645-02E0-4D3F-AEF2-1E8BB7813D7B', // iPhone 17 Pro Max — owner uses by hand
]);
const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
const DEVICE_TYPE = 'iPhone 17';

function simctl(args, options = {}) {
  return execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

export function listDevices() {
  const parsed = JSON.parse(simctl(['list', 'devices', '-j']));
  const devices = [];
  for (const [runtime, list] of Object.entries(parsed.devices)) {
    for (const device of list) devices.push({ ...device, runtime });
  }
  return devices;
}

// Returns udids for `count` suite-owned simulators named "Newone Test N",
// creating any that are missing. Never returns an owner device.
export function ensurePool(count) {
  const udids = [];
  for (let n = 1; n <= count; n += 1) {
    const name = `Newone Test ${n}`;
    let device = listDevices().find((entry) => entry.name === name && entry.isAvailable !== false);
    if (!device) {
      const udid = simctl(['create', name, DEVICE_TYPE, RUNTIME]).trim();
      device = { udid, name };
    }
    if (OWNER_DEVICES.has(device.udid)) throw new Error(`refusing to use owner device ${device.udid}`);
    udids.push(device.udid);
  }
  return udids;
}

export function bootAndInstall(udid, log = console.log) {
  if (OWNER_DEVICES.has(udid)) throw new Error(`refusing to boot owner device ${udid}`);
  // CoreSimulator answers "Invalid argument" (NSPOSIXErrorDomain 22) or
  // "Unable to boot" while a device is still shutting down or its previous
  // launchd is being torn down; wait it out instead of failing the run.
  let bootError = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const state = listDevices().find((entry) => entry.udid === udid)?.state;
    if (state === 'Booted') { bootError = null; break; }
    try {
      simctl(['boot', udid], { timeout: 120_000 });
      log(`booted ${udid}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      bootError = null;
      break;
    } catch (error) {
      bootError = error;
      log(`boot attempt ${attempt} on ${udid} (state ${state ?? 'unknown'}) failed: ${String(error?.stderr ?? error?.message ?? error).trim().split('\n')[0]}`);
      execFileSync('sleep', ['15']);
    }
  }
  if (bootError) throw bootError;
  // A freshly created or upgraded simulator runs "Data Migration" plugins on
  // its first boot; on a loaded host that phase alone exceeded ten minutes
  // and the bootstatus wait died with ETIMEDOUT, killing the whole run.
  // Wait in bounded rounds and reboot the simulator between rounds instead
  // of failing the suite on the first timeout.
  let statusError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      simctl(['bootstatus', udid, '-b'], { timeout: 600_000 });
      statusError = null;
      break;
    } catch (error) {
      statusError = error;
      const tail = String(error?.stdout ?? '').trim().split('\n').filter(Boolean).slice(-3).join(' / ');
      log(`bootstatus attempt ${attempt} on ${udid} ${error?.code ?? 'failed'}: ${tail.slice(0, 200)}`);
      if (attempt < 3) {
        try { simctl(['shutdown', udid], { timeout: 120_000 }); } catch { /* already down */ }
        execFileSync('sleep', ['20']);
        try { simctl(['boot', udid], { timeout: 120_000 }); } catch { /* bootstatus will report */ }
      }
    }
  }
  if (statusError) throw statusError;
  // CoreSimulator gets very slow when several simulators boot on a loaded
  // host (an install that normally takes a second timed out at 180s and
  // killed a whole run). Give it time and retry rather than abort the suite.
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      simctl(['install', udid, APP_PATH], { timeout: 600_000 });
      log(`installed ${APP_PATH.split('/').pop()} on ${udid}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return;
    } catch (error) {
      lastError = error;
      log(`install attempt ${attempt} on ${udid} failed: ${error?.code ?? error?.message ?? error}`);
      try { simctl(['terminate', udid, APP_ID]); } catch { /* not running */ }
    }
  }
  throw lastError;
}

export function shutdown(udid) {
  if (OWNER_DEVICES.has(udid)) return;
  try { simctl(['shutdown', udid]); } catch { /* already shut down */ }
}

export function screenshot(udid, path) {
  try {
    simctl(['io', udid, 'screenshot', path], { timeout: 30_000 });
    return path;
  } catch {
    return null;
  }
}

export function terminateApp(udid) {
  try { simctl(['terminate', udid, APP_ID]); } catch { /* not running */ }
}

export function launchApp(udid) {
  try { simctl(['launch', udid, APP_ID]); } catch { /* ignore */ }
}

// Foreground another app to background Newone without killing it (the
// simulator has no hardware Home button we can drive from the CLI).
export function backgroundApp(udid) {
  simctl(['launch', udid, 'com.apple.Preferences']);
}

export function openUrl(udid, url) {
  simctl(['openurl', udid, url]);
}

export function appBuildInfo() {
  try {
    const plist = execFileSync('plutil', ['-convert', 'json', '-o', '-', `${APP_PATH}/Info.plist`], { encoding: 'utf8' });
    const info = JSON.parse(plist);
    const stat = execFileSync('stat', ['-f', '%Sm', `${APP_PATH}/main.jsbundle`], { encoding: 'utf8' }).trim();
    return { bundleId: info.CFBundleIdentifier, version: info.CFBundleShortVersionString, build: info.CFBundleVersion, jsBundleModified: stat };
  } catch {
    return { bundleId: APP_ID };
  }
}
