// Per-area harness: runs one Maestro flow per user action on an explicit
// device, captures the exact on-screen text and a screenshot on failure,
// evaluates server truth for every durable effect, and records everything
// in the shared report. Areas never work around app bugs; they record them.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFlow, screenTexts, findErrorTexts, screenshotsIn } from './maestro.mjs';
import { screenshot as simShot } from './devices.mjs';
import { createMailbox, waitForCode } from './mailbox.mjs';
import * as server from './server.mjs';

export const SUITE_DIR = new URL('../suite/', import.meta.url).pathname;

export function createAreaContext({ area, devices, report, runDir }) {
  const areaDir = join(runDir, area);
  mkdirSync(areaDir, { recursive: true });
  const log = (message) => report.log(area, message);
  let sequence = 0;

  async function shot(device, name) {
    sequence += 1;
    const path = join(areaDir, `${String(sequence).padStart(3, '0')}-${name}.png`);
    return simShot(device, path);
  }

  // Runs one flow as one reported action. `serverTruth` (optional) is an
  // async function returning { ok, detail }; it is always evaluated so the
  // report shows server state even when the UI failed.
  async function step({ id, title, device, flow, env = {}, expected, screen, steps, serverTruth, timeoutMs = 300_000, optional = false, latencyFrom }) {
    const flowPath = join(SUITE_DIR, flow);
    const shotPrefix = `${id}`;
    const started = Date.now();
    log(`start ${id} (${title}) on ${device}`);
    // Maestro's iOS driver itself can crash on a loaded host (Kotlin stack
    // trace, "hierarchy unavailable"); that says nothing about the app, so
    // run the flow once more before recording a failure.
    // A flow that hangs until the harness limit (e.g. inputText never
    // returning while the keyboard is up) is the driver stalling, too.
    const driverCrash = (r) => !r.ok && (r.timedOut === true || /kotlinx\.coroutines|hierarchy unavailable|XCUITest|Connection refused|Unable to launch the driver|MaestroDriver|driver not ready in time|IOSDriverTimeoutException/i.test(`${r.failure ?? ''}\n${r.stderr ?? ''}`));
    let result = await runFlow({
      device,
      flow: flowPath,
      env: { SHOT: shotPrefix, ...env },
      cwd: areaDir,
      timeoutMs,
      debugDir: join(areaDir, 'maestro-debug', id),
    });
    if (driverCrash(result)) {
      log(`driver crash during ${id} on ${device}; retrying once`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      result = await runFlow({
        device,
        flow: flowPath,
        env: { SHOT: shotPrefix, ...env },
        cwd: areaDir,
        timeoutMs,
        debugDir: join(areaDir, 'maestro-debug', `${id}-retry`),
      });
      if (driverCrash(result)) result = { ...result, failure: `ENVIRONMENT (Maestro driver crashed twice): ${result.failure ?? ''}` };
    }
    writeFileSync(join(areaDir, `${id}.maestro.txt`), `${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}`);
    const screenshots = screenshotsIn(areaDir, shotPrefix);
    let observed = '';
    let visibleTexts = [];
    if (!result.ok) {
      const failShot = await shot(device, `${id}-FAIL`);
      if (failShot) screenshots.push(failShot);
      const texts = await screenTexts(device);
      visibleTexts = texts.texts;
      const errors = findErrorTexts(visibleTexts);
      observed = [result.failure, errors.length ? `on-screen: ${errors.join(' | ')}` : '', texts.raw ?? ''].filter(Boolean).join('\n');
      // A failed step can leave a sheet, a dialog, or the keyboard open; the
      // next step's long-press or tap would land on it and fail for that
      // reason alone. Close whatever is open (best effort, never recorded).
      try {
        await runFlow({ device, flow: join(SUITE_DIR, 'common/recover.yaml'), env: { SHOT: `${id}-recover` }, cwd: areaDir, timeoutMs: 90_000, debugDir: join(areaDir, 'maestro-debug', `${id}-recover`) });
      } catch {
        // recovery is opportunistic
      }
    } else {
      observed = env.OBSERVE ? `verified on screen: ${env.OBSERVE}` : 'as expected';
    }
    let serverResult = null;
    if (serverTruth) {
      try {
        serverResult = await serverTruth();
      } catch (error) {
        serverResult = { ok: false, detail: `server query failed: ${String(error.message)}` };
      }
    }
    const uiOk = result.ok;
    const serverOk = serverResult ? serverResult.ok !== false : true;
    const status = uiOk && serverOk ? 'PASS' : optional && !uiOk ? 'UNREACHABLE' : 'FAIL';
    if (uiOk && !serverOk) observed = `UI reported success but server truth mismatched: ${typeof serverResult.detail === 'string' ? serverResult.detail : JSON.stringify(serverResult.detail)}`;
    const entry = report.record({
      area, id, title, device, flow, expected, screen, steps,
      status, observed, visibleTexts, screenshots, server: serverResult,
      durationMs: Date.now() - started, maestro: result.ok ? '' : result.failure,
      latencyMs: latencyFrom ? Date.now() - latencyFrom : undefined,
    });
    return { ok: status === 'PASS', uiOk, serverResult, entry, durationMs: result.durationMs, stdout: result.stdout };
  }

  function note({ id, title, status = 'INFO', observed = '', expected = '', screen = '', server = null, screenshots = [] }) {
    return report.record({ area, id, title, status, observed, expected, screen, server, screenshots });
  }

  // Capture what is on screen right now as a reported observation.
  async function observe(device, { id, title, expected = '', screen = '' }) {
    const path = await shot(device, id);
    const texts = await screenTexts(device);
    return report.record({ area, id, title, status: 'INFO', observed: texts.texts.slice(0, 80).join(' | '), expected, screen, screenshots: path ? [path] : [], visibleTexts: texts.texts });
  }

  // Signs a brand-new human up through the real app UI on `device` with a
  // real disposable inbox. Reported as setup actions so a broken signup is
  // visible in the area that depended on it.
  async function signup(device, { label, displayName, language = 'en' }) {
    const mailbox = await createMailbox();
    const username = `sim_${label}_${randomBytes(3).toString('hex')}`.toLowerCase();
    const account = { label, email: mailbox.email, username, displayName, language, mailbox, userId: null, device };
    log(`signup ${label}: ${mailbox.email} @${username} (${language}) on ${device}`);
    const form = await step({
      id: `setup-${label}-signup-form`,
      title: `Setup: sign up ${displayName} (${language}) — form`,
      device,
      flow: language === 'en' ? 'common/signup-request.yaml' : `common/signup-request-${language}.yaml`,
      env: { EMAIL: mailbox.email, USERNAME: username, DISPLAY_NAME: displayName },
      expected: 'Sign-up form accepts email/username/display name and shows the one-time code screen',
      screen: 'sign-in (Create account)',
    });
    if (!form.uiOk) return account;
    const requestedAt = Date.now();
    const code = await waitForCode(mailbox);
    if (!code) {
      note({ id: `setup-${label}-signup-email`, title: `Setup: signup email for ${displayName}`, status: 'FAIL', expected: 'verification email arrives in the real inbox within 150s', observed: 'no email with a six-digit code arrived' });
      return account;
    }
    note({ id: `setup-${label}-signup-email`, title: `Setup: signup email for ${displayName}`, status: 'PASS', expected: 'verification email arrives in the real inbox', observed: `code arrived after ${Math.round((Date.now() - requestedAt) / 1000)}s (subject: ${code.subject})` });
    account.code = code.code;
    const verify = await step({
      id: `setup-${label}-signup-verify`,
      title: `Setup: verify code for ${displayName}`,
      device,
      flow: language === 'en' ? 'common/signup-verify.yaml' : `common/signup-verify-${language}.yaml`,
      env: { CODE: code.code },
      expected: 'Code accepted; app lands on Chats',
      screen: 'sign-in (One-time code)',
      serverTruth: async () => {
        const row = await server.profileByUsername(username);
        if (!row) return { ok: false, detail: 'no profile row for the new username' };
        account.userId = row.user_id;
        return { ok: row.preferred_language === language && row.display_name === displayName, detail: row };
      },
    });
    if (!account.userId) {
      const row = await server.profileByUsername(username).catch(() => null);
      account.userId = row?.user_id ?? null;
    }
    account.signedIn = verify.uiOk;
    if (language !== 'en' && verify.uiOk) {
      await step({
        id: `setup-${label}-ui-english`,
        title: `Setup: switch ${displayName}'s display language back to English (server language stays es)`,
        device,
        flow: `common/ui-language-${language}-to-en.yaml`,
        expected: `Settings chrome returns to English; profile.preferred_language stays ${language}`,
        screen: 'settings',
        serverTruth: async () => {
          const row = await server.profileByUsername(username);
          return { ok: row?.preferred_language === language, detail: row };
        },
      });
    }
    return account;
  }

  return { area, devices, areaDir, log, shot, step, note, observe, signup, server, waitForCode, report };
}
