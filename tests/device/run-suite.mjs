#!/usr/bin/env node
// Orchestrates the real-device suite: suite-owned simulators only, areas run
// concurrently inside waves (bounded by the simulator pool), every action is
// reported with on-screen evidence and server truth.
//
// Usage:
//   node tests/device/run-suite.mjs                 # everything, 3-sim pool, waves
//   node tests/device/run-suite.mjs --areas auth     # one or more areas (comma list)
//   node tests/device/run-suite.mjs --pool 2         # smaller pool (waves adapt)
//   node tests/device/run-suite.mjs --devices <udid,udid,udid>   # explicit sims
//   node tests/device/run-suite.mjs --keep           # leave sims booted afterwards
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensurePool, bootAndInstall, shutdown, appBuildInfo, OWNER_DEVICES, APP_ID } from './lib/devices.mjs';
import { warmDriver } from './lib/maestro.mjs';
import { Report } from './lib/report.mjs';
import { createAreaContext } from './lib/harness.mjs';
import { buildInventorySection, buildBugList } from './lib/summary.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const AREA_FILTER = option('areas', '')?.split(',').filter(Boolean) ?? [];
const POOL_SIZE = Number(option('pool', '3'));
const EXPLICIT_DEVICES = option('devices', '')?.split(',').filter(Boolean) ?? [];
const KEEP = flag('keep');
const RUN_ID = option('run', `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);

// Waves keep at most POOL_SIZE simulators busy; each area declares how many
// devices it needs. Order matters: independent areas share a wave.
const WAVES = [
  ['auth', 'people'],
  // v3 consumer features (two devices) run before profile, which grants the
  // notification permission the v3 first-launch card depends on.
  ['v3'],
  ['chat', 'negative'],
  ['groups'],
  ['translation', 'sessions'],
  ['translation-ko'],
  // Media (two devices) and profile pictures (one device) share a wave.
  ['media', 'profile'],
];
// An area requested by id that no wave lists (e.g. `media`, a quick proof
// carved out of chat) runs in its own wave at the end; before this, such a
// request booted the simulators and ran nothing (run-2026-09-04T10-41-13).
const EXTRA_WAVE = AREA_FILTER.filter((id) => !WAVES.some((wave) => wave.includes(id)));
const RUN_WAVES = EXTRA_WAVE.length ? [...WAVES, EXTRA_WAVE] : WAVES;

async function loadArea(id) {
  const path = join(HERE, 'areas', `${id}.mjs`);
  if (!existsSync(path)) throw new Error(`unknown area ${id}`);
  return await import(pathToFileURL(path).href);
}

const runDir = join(HERE, '.artifacts', RUN_ID);
mkdirSync(runDir, { recursive: true });
const report = new Report({ runId: RUN_ID, runDir, root: ROOT });
report.meta.app = appBuildInfo();
report.meta.pool = POOL_SIZE;

for (const udid of EXPLICIT_DEVICES) {
  if (OWNER_DEVICES.has(udid)) {
    console.error(`refusing owner device ${udid}`);
    process.exit(2);
  }
}
const pool = EXPLICIT_DEVICES.length ? EXPLICIT_DEVICES : ensurePool(POOL_SIZE);
report.meta.devices = pool;
report.log('suite', `run ${RUN_ID}; devices ${pool.join(', ')}`);
for (const udid of pool) bootAndInstall(udid, (message) => report.log('suite', message));
// Bring Maestro's iOS driver up on each device one at a time before the
// waves start; concurrent driver installs on a loaded host end in
// "iOS driver not ready in time" for every flow.
for (const udid of pool) {
  const ready = await warmDriver(udid, { appId: APP_ID, cwd: runDir, log: (message) => report.log('suite', message) });
  if (!ready) report.log('suite', `WARNING: driver never became ready on ${udid}; flows there will likely fail`);
}

const areaModules = {};
for (const wave of RUN_WAVES) {
  for (const id of wave) {
    if (AREA_FILTER.length && !AREA_FILTER.includes(id)) continue;
    areaModules[id] = await loadArea(id);
  }
}

// Split a wave into batches that fit the pool (an area needing more devices
// than the pool is skipped with a note).
function batches(wave) {
  const result = [];
  let current = [];
  let used = 0;
  for (const id of wave) {
    const need = areaModules[id]?.meta.devices ?? 0;
    if (!areaModules[id]) continue;
    if (need > pool.length) {
      report.record({ area: id, id: `${id}-skipped`, title: `${id} needs ${need} simulators; pool has ${pool.length}`, status: 'SKIPPED', observed: 'reduce --pool or run this area alone with enough simulators' });
      continue;
    }
    if (used + need > pool.length) {
      result.push(current);
      current = [];
      used = 0;
    }
    current.push(id);
    used += need;
  }
  if (current.length) result.push(current);
  return result;
}

const suiteStarted = Date.now();
for (const [waveIndex, wave] of RUN_WAVES.entries()) {
  for (const batch of batches(wave)) {
    if (!batch.length) continue;
    let cursor = 0;
    report.log('suite', `wave ${waveIndex + 1}: ${batch.join(' + ')} in parallel`);
    const runs = batch.map((id) => {
      const module = areaModules[id];
      const devices = pool.slice(cursor, cursor + module.meta.devices);
      cursor += module.meta.devices;
      const ctx = createAreaContext({ area: id, devices, report, runDir });
      const started = Date.now();
      report.log(id, `starting on ${devices.join(', ')}`);
      return module.run(ctx)
        .then(() => report.log(id, `finished in ${Math.round((Date.now() - started) / 1000)}s`))
        .catch((error) => {
          report.record({ area: id, id: `${id}-crash`, title: `${id} runner crashed`, status: 'FAIL', observed: String(error?.stack ?? error).slice(0, 1200), expected: 'area completes' });
        });
    });
    await Promise.allSettled(runs);
  }
}

report.meta.totalSeconds = Math.round((Date.now() - suiteStarted) / 1000);
try {
  const inventoryPath = join(HERE, 'suite', 'inventory.json');
  if (existsSync(inventoryPath)) {
    const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
    report.addSection(buildInventorySection(inventory, report.actions));
  }
} catch (error) {
  report.log('suite', `inventory section failed: ${error.message}`);
}
report.addSection(buildBugList(report.actions));
report.flush();

if (!KEEP) for (const udid of pool) shutdown(udid);
const counts = report.summary();
console.log(`\n${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}\nreport: ${join(runDir, 'report.md')}`);
process.exit(counts.FAIL > 0 ? 1 : 0);
