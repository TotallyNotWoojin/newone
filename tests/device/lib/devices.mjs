// Simulator pool for the real-device suite. Only simulators the suite owns
// are ever booted or shut down; the owner's hand-driven iPhone 17 Pro and
// 17 Pro Max are hard-excluded so a run can never touch them.
import { execFileSync } from 'node:child_process';

export const APP_ID = 'com.totallynotwoojin.newone';
export const APP_PATH = process.env.NEWONE_APP_PATH
  ?? '/Users/woojin/Library/Developer/Xcode/DerivedData/Newone-bowskecbalbwwcfmvmkdfargugzh/Build/Products/Release-iphonesimulator/Newone.app';
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
  const state = listDevices().find((entry) => entry.udid === udid)?.state;
  if (state !== 'Booted') {
    simctl(['boot', udid]);
    log(`booted ${udid}`);
  }
  simctl(['bootstatus', udid, '-b'], { timeout: 180_000 });
  simctl(['install', udid, APP_PATH], { timeout: 180_000 });
  log(`installed ${APP_PATH.split('/').pop()} on ${udid}`);
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
