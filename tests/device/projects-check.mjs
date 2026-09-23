#!/usr/bin/env node
// The Sep 23 2026 features on a real simulator or emulator, against the live
// backend: projects (made in the chat, filing what is sent, the summary saved
// under the AI's name and its date), 찾기, the summary that waits for enough
// conversation, and copying a photo then pasting it back. People and their
// chat are made through the public API first; the device signs in with the
// password like anyone would and does everything else through the app.
// Every step is screenshotted from the host (Maestro's takeScreenshot writes
// into its own debug directory) and checked against the server where it
// leaves something behind.
//
//   node tests/device/projects-check.mjs --platform ios [--device <udid>]
//   node tests/device/projects-check.mjs --platform android [--avd Gist_Flip]
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { makeRunId } from '../hosted/lib.mjs';
import { PERSONAL_REALM_ID, gatewayPost, loadAccessToken, projectKeys, signupUser } from '../hosted/smoke-lib.mjs';
import { sendAttachment } from '../e2e/support/live-media.mjs';
import { APP_PATH } from './lib/devices.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLOWS = join(HERE, 'suite', 'projects');
const APP_ID = 'com.totallynotwoojin.gist';
const MAESTRO = join(homedir(), '.maestro', 'bin', 'maestro');
const SDK = join(homedir(), 'Library', 'Android', 'sdk');
const ADB = join(SDK, 'platform-tools', 'adb');
const EMULATOR = join(SDK, 'emulator', 'emulator');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const PLATFORM = option('platform', 'ios');
const RUN = `projects-${PLATFORM}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const OUT = join(HERE, '.artifacts', RUN);
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const log = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

// ---------------------------------------------------------------- the device
function sh(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

let device = '';
async function prepareIos() {
  const wanted = option('device', '');
  const list = JSON.parse(sh('xcrun', ['simctl', 'list', 'devices', '-j'])).devices;
  const all = Object.values(list).flat();
  const target = wanted
    ? all.find((entry) => entry.udid === wanted)
    : all.find((entry) => entry.name === 'Newone Test 1');
  if (!target) throw new Error('no suite simulator ("Newone Test 1")');
  device = target.udid;
  if (target.state !== 'Booted') sh('xcrun', ['simctl', 'boot', device]);
  sh('xcrun', ['simctl', 'bootstatus', device, '-b'], { timeout: 300_000 });
  if (!existsSync(APP_PATH)) throw new Error(`no simulator build at ${APP_PATH}`);
  try { sh('xcrun', ['simctl', 'terminate', device, APP_ID]); } catch { /* not running */ }
  try { sh('xcrun', ['simctl', 'uninstall', device, APP_ID]); } catch { /* not installed */ }
  // A session kept in the keychain survives an uninstall on the simulator.
  sh('xcrun', ['simctl', 'keychain', device, 'reset']);
  sh('xcrun', ['simctl', 'install', device, APP_PATH], { timeout: 600_000 });
  sh('xcrun', ['simctl', 'pbcopy', device], { input: 'nothing copied yet' });
  sh('xcrun', ['simctl', 'launch', device, APP_ID]);
  log(`ios ${target.name} ${device}: installed ${APP_PATH.split('/').pop()}`);
}

function serialForAvd(avd) {
  const lines = sh(ADB, ['devices']).split('\n').filter((line) => line.startsWith('emulator-'));
  for (const line of lines) {
    const serial = line.split('\t')[0];
    try {
      if (sh(ADB, ['-s', serial, 'emu', 'avd', 'name']).split('\n')[0].trim() === avd) return serial;
    } catch { /* not answering */ }
  }
  return null;
}

async function prepareAndroid() {
  const avd = option('avd', 'Gist_Flip');
  const apk = option('apk', join(homedir(), '.cache', 'newone-release', 'gist-43.apk'));
  device = serialForAvd(avd) ?? '';
  if (!device) {
    const child = spawn(EMULATOR, ['-avd', avd, '-no-boot-anim', '-no-audio', '-no-window', '-netdelay', 'none', '-netspeed', 'full'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    for (let attempt = 0; attempt < 60 && !device; attempt += 1) {
      await sleep(4000);
      device = serialForAvd(avd) ?? '';
    }
    if (!device) throw new Error(`emulator ${avd} never appeared`);
  }
  // A booting emulator answers "device offline" for a while; that is waiting,
  // not failing.
  try { sh(ADB, ['-s', device, 'wait-for-device'], { timeout: 300_000 }); } catch { /* checked below */ }
  let booted = false;
  for (let attempt = 0; attempt < 90 && !booted; attempt += 1) {
    try {
      booted = sh(ADB, ['-s', device, 'shell', 'getprop', 'sys.boot_completed']).trim() === '1';
    } catch { /* still coming up */ }
    if (!booted) await sleep(4000);
  }
  if (!booted) throw new Error(`emulator ${avd} did not finish booting`);
  try { sh(ADB, ['-s', device, 'shell', 'cmd', 'overlay', 'enable', 'com.android.internal.systemui.navbar.threebutton']); } catch { /* older image */ }
  for (const key of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
    sh(ADB, ['-s', device, 'shell', 'settings', 'put', 'global', key, '0']);
  }
  log(sh(ADB, ['-s', device, 'install', '-r', apk], { timeout: 600_000 }).trim().split('\n').at(-1));
  sh(ADB, ['-s', device, 'shell', 'pm', 'clear', APP_ID]);
  sh(ADB, ['-s', device, 'shell', 'pm', 'grant', APP_ID, 'android.permission.POST_NOTIFICATIONS']);
  sh(ADB, ['-s', device, 'shell', 'monkey', '-p', APP_ID, '-c', 'android.intent.category.LAUNCHER', '1']);
  log(`android ${avd} ${device}: installed ${apk.split('/').pop()}`);
  await sleep(12_000);
}

function screenshot(name) {
  const path = join(OUT, `${name}.png`);
  try {
    if (PLATFORM === 'ios') sh('xcrun', ['simctl', 'io', device, 'screenshot', path]);
    else writeFileSync(path, execFileSync(ADB, ['-s', device, 'exec-out', 'screencap', '-p']));
  } catch (error) {
    log(`screenshot ${name} failed: ${error.message}`);
  }
  return path;
}

function maestro(flow, env) {
  const flags = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const logPath = join(OUT, `${flow.replace(/\.yaml$/, '')}.log`);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const output = execFileSync(MAESTRO, ['--device', device, 'test', ...flags, join(FLOWS, flow)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 600_000,
        env: { ...process.env, MAESTRO_DRIVER_STARTUP_TIMEOUT: '240000' },
      });
      writeFileSync(logPath, output);
      return { ok: true, log: logPath };
    } catch (error) {
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      writeFileSync(logPath, output);
      if (attempt === 1 && /did not start up in time/.test(output)) {
        if (PLATFORM === 'android') {
          try { sh(ADB, ['-s', device, 'shell', 'am', 'force-stop', 'dev.mobile.maestro']); } catch { /* gone */ }
        }
        continue;
      }
      const failed = output.split('\n').filter((line) => /FAILED|Assertion|not found|Element/.test(line)).slice(-4).join(' | ');
      return { ok: false, log: logPath, detail: failed.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 400) };
    }
  }
  return { ok: false, log: logPath, detail: 'driver never started' };
}

async function step(id, title, flow, env, truth) {
  log(`${id}: ${title}`);
  const ui = maestro(flow, env);
  const shot = screenshot(id);
  let server = null;
  if (ui.ok && truth) {
    try {
      server = await truth();
    } catch (error) {
      server = { ok: false, detail: error.message };
    }
  }
  const ok = ui.ok && (server ? server.ok : true);
  results.push({ id, title, flow, status: ok ? 'PASS' : 'FAIL', ui: ui.ok ? 'ok' : ui.detail, server, screenshot: shot });
  log(`${ok ? 'PASS' : 'FAIL'} ${id}${ui.ok ? '' : ` — ${ui.detail}`}${server && !server.ok ? ` — server: ${JSON.stringify(server.detail).slice(0, 300)}` : ''}`);
  return ok;
}

// ------------------------------------------------------------------- people
const keys = projectKeys(loadAccessToken());
const runId = makeRunId();
const password = `Dev-${randomUUID().slice(0, 10)}!`;
function post(user, fn, path, body) {
  return gatewayPost(fn, path, keys, {
    installationId: user.installationId,
    accessToken: user.accessToken,
    idempotencyKey: fn === 'newone-api' ? `device-${runId}-${randomUUID()}` : undefined,
    body: { organizationId: PERSONAL_REALM_ID, ...body },
  });
}
const data = (response) => response.payload?.data ?? response.payload;

log(`seeding ${runId}`);
const owner = await signupUser(keys, { runId, label: 'owner', language: 'en', password });
const friend = await signupUser(keys, { runId, label: 'friend', language: 'en', password });
const third = await signupUser(keys, { runId, label: 'third', language: 'en', password });
const request = data(await post(owner, 'newone-api', '/v2/contacts/message-requests', { targetUserId: friend.userId, body: 'Hi there' }));
const directId = String(request.conversationId);
await post(friend, 'newone-api', `/v2/contacts/connections/${owner.userId}/respond`, { decision: 'accepted' });
await post(owner, 'newone-api', '/v2/contacts/message-requests', { targetUserId: third.userId, body: 'Hello' });
await post(third, 'newone-api', `/v2/contacts/connections/${owner.userId}/respond`, { decision: 'accepted' });
const groupName = `Admin ${runId.slice(-4)}`;
const group = data(await post(owner, 'newone-api', '/v2/conversations/group', {
  name: groupName,
  kind: 'group',
  memberAssignments: [
    { membershipId: friend.userId, role: 'member' },
    { membershipId: third.userId, role: 'member' },
  ],
}));
const groupId = String(group.conversationId);
const say = (user, conversationId, body) => post(user, 'newone-api', `/v2/conversations/${conversationId}/messages`, {
  clientMessageId: randomUUID(),
  kind: 'text',
  body,
});
await say(friend, directId, 'ok');
await say(friend, groupId, 'The wood was only placed to size the surface; we will cut it and finish the edges so it looks presentable.');
await say(third, groupId, 'Please paint the whole base white and send the original PowerPoint file by email today.');
await say(friend, groupId, 'The acid delivery arrives at Otay on Friday; Francisco will confirm when it is in the warehouse.');
await sendAttachment(keys, friend, groupId, {
  label: 'device-photo',
  fileName: 'panel.jpg',
  mimeType: 'image/jpeg',
  bytes: readFileSync(join(HERE, '..', 'e2e', 'fixtures', 'copy-me.jpg')),
});
log(`seeded: owner ${owner.email}, group "${groupName}" ${groupId}`);

const projectsOf = async () => {
  const response = await post(owner, 'newone-read', `/v2/conversations/${groupId}/projects/query`, {});
  if (response.status !== 200) throw new Error(`projects read ${response.status}`);
  return data(response);
};

// -------------------------------------------------------------------- steps
if (PLATFORM === 'ios') await prepareIos();
else await prepareAndroid();
screenshot('00-launched');

const signedIn = await step('01-sign-in', 'Sign in with the password', 'sign-in.yaml', { EMAIL: owner.email, PASSWORD: password });
if (signedIn) {
  await step('02-not-enough', 'A thin chat is not summarized yet: the sheet says so and the button is off', 'not-enough.yaml', {
    PEER: 'Smoke friend',
  });
  const created = await step('03-create-project', 'Open Projects in the group, make HDG; it becomes the project being saved into', 'create-project.yaml', {
    GROUP: groupName,
  }, async () => {
    const projects = await projectsOf();
    const hdg = projects.projects.find((project) => project.name === 'HDG');
    return { ok: Boolean(hdg) && projects.selectedProjectId === hdg.projectId, detail: projects.projects };
  });
  if (created) {
    await step('04-send-link', 'A link typed and sent while HDG is selected', 'send-link.yaml', {
      BODY: 'Plans are at www.newoneinc.com today',
    }, async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const projects = await projectsOf();
        const link = projects.items.find((item) => item.kind === 'link' && item.url === 'https://www.newoneinc.com/');
        if (link) return { ok: true, detail: link };
        await sleep(1500);
      }
      return { ok: false, detail: 'the link never reached HDG' };
    });
    await step('05-drawers', 'The Projects sheet shows the link in HDG\'s Links drawer', 'check-drawers.yaml', {});
    await step('06-summary', 'A summary asked for here is saved into HDG under the AI\'s name and the date', 'summary.yaml', {}, async () => {
      const projects = await projectsOf();
      const summary = projects.items.find((item) => item.kind === 'summary');
      return { ok: summary?.summaryState === 'ready' && / #1$/.test(summary.title ?? ''), detail: summary };
    });
    maestro('close-sheet.yaml', {});
  }
  await step('07-copy-image', 'Copy the friend\'s photo from the message menu, then paste it back in the attachment sheet', 'copy-image.yaml', {});
  maestro('close-sheet.yaml', {});
  await step('08-find', '찾기 finds the chat a word came up in and opens it there', 'find.yaml', {
    GROUP: groupName,
    WORD: 'Otay',
    LINE: 'The acid delivery arrives at Otay',
  });
}

const failed = results.filter((row) => row.status === 'FAIL');
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ run: RUN, platform: PLATFORM, device, groupId, results }, null, 2));
writeFileSync(join(OUT, 'REPORT.md'), [
  `# ${RUN}`,
  '',
  `Platform ${PLATFORM}, device ${device}, group ${groupName} (${groupId}).`,
  '',
  '| Step | Result | What |',
  '|---|---|---|',
  ...results.map((row) => `| ${row.id} | ${row.status} | ${row.title}${row.status === 'FAIL' ? ` — ${row.ui === 'ok' ? `server: ${JSON.stringify(row.server?.detail).slice(0, 200)}` : row.ui}` : ''} |`),
  '',
].join('\n'));
log(`${results.length - failed.length}/${results.length} passed — ${OUT}`);
process.exit(failed.length ? 1 : 0);
