// Report sections derived from the recorded actions: the full-surface
// inventory table (every screen/control/catalog action key with a status) and
// the ranked bug list. Mapping rules live in suite/coverage-map.json.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const COVERAGE_MAP = join(new URL('../suite/', import.meta.url).pathname, 'coverage-map.json');

function statusFor(actions, actionIds) {
  const matched = actions.filter((action) => actionIds.includes(action.id));
  if (!matched.length) return null;
  if (matched.some((action) => action.status === 'FAIL')) return 'FAIL';
  if (matched.some((action) => action.status === 'PASS')) return 'PASS';
  if (matched.some((action) => action.status === 'UNREACHABLE')) return 'UNREACHABLE';
  return matched[0].status;
}

export function buildInventorySection(inventory, actions) {
  const map = existsSync(COVERAGE_MAP) ? JSON.parse(readFileSync(COVERAGE_MAP, 'utf8')) : { controls: {}, keys: {} };
  const lines = ['## App surface inventory', '', `Generated from the static inventory (${inventory.screens?.length ?? 0} screens). Status: PASS/FAIL come from the actions listed; UNREACHABLE means the control is not rendered for a consumer (personal-realm) account on iOS, with the gating condition from the source; UNTESTED means reachable but not exercised by this run.`, ''];
  lines.push('| Screen | Control | Catalog key | Consumer iOS | Status | Evidence / where looked |');
  lines.push('|---|---|---|---|---|---|');
  const esc = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const counts = { PASS: 0, FAIL: 0, UNREACHABLE: 0, UNTESTED: 0 };
  for (const screen of inventory.screens ?? []) {
    for (const control of screen.controls ?? []) {
      const mapped = map.controls?.[control.id] ?? map.keys?.[control.catalogKey ?? ''] ?? null;
      let status;
      let evidence = '';
      if (control.consumerIosReachable === false) {
        status = 'UNREACHABLE';
        evidence = `not rendered for consumer: ${control.gating}`;
      } else if (mapped) {
        const ids = Array.isArray(mapped) ? mapped : mapped.actions ?? [];
        const derived = statusFor(actions, ids);
        status = derived ?? (mapped.status ?? 'UNTESTED');
        evidence = derived ? ids.join(', ') : (mapped.note ?? '');
        if (!derived && mapped.status === 'UNREACHABLE') evidence = mapped.note ?? evidence;
      } else {
        status = 'UNTESTED';
        evidence = control.note ?? '';
      }
      counts[status] = (counts[status] ?? 0) + 1;
      lines.push(`| ${esc(screen.id)} | ${esc(control.label)} | ${esc(control.catalogKey ?? '')} | ${esc(control.consumerIosReachable)} | ${status} | ${esc(evidence).slice(0, 220)} |`);
    }
  }
  lines.unshift(`**Inventory totals:** ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`, '');
  const keys = inventory.catalogActionKeys ?? [];
  if (keys.length) {
    lines.push('', '### Catalog action keys', '', '| Key | English | Consumer iOS | Status | Evidence |', '|---|---|---|---|---|');
    for (const key of keys) {
      const mapped = map.keys?.[key.key] ?? null;
      let status;
      let evidence = '';
      if (key.consumerIosReachable === false) {
        status = 'UNREACHABLE';
        evidence = key.gating ?? '';
      } else if (mapped) {
        const ids = Array.isArray(mapped) ? mapped : mapped.actions ?? [];
        const derived = statusFor(actions, ids);
        status = derived ?? (mapped.status ?? 'UNTESTED');
        evidence = derived ? ids.join(', ') : (mapped.note ?? '');
      } else {
        status = 'UNTESTED';
        evidence = (key.usedIn ?? []).join(', ');
      }
      lines.push(`| ${esc(key.key)} | ${esc(key.en)} | ${esc(key.consumerIosReachable)} | ${status} | ${esc(evidence).slice(0, 160)} |`);
    }
  }
  return lines.join('\n');
}

// Impact ranking: auth/data-loss > messaging core > social graph > groups > media > settings > cosmetic.
const AREA_WEIGHT = { auth: 100, sessions: 90, chat: 80, translation: 70, people: 60, groups: 55, media: 50, negative: 45, summary: 30, profile: 25 };

export function buildBugList(actions) {
  const failures = actions.filter((action) => action.status === 'FAIL' && !action.id.startsWith('setup-'));
  const setupFailures = actions.filter((action) => action.status === 'FAIL' && action.id.startsWith('setup-'));
  const ranked = [...failures].sort((a, b) => (AREA_WEIGHT[b.area] ?? 10) - (AREA_WEIGHT[a.area] ?? 10));
  const lines = ['## Bug list (ranked by user impact)', ''];
  if (!ranked.length && !setupFailures.length) {
    lines.push('No failures recorded.');
    return lines.join('\n');
  }
  ranked.forEach((action, index) => {
    lines.push(`${index + 1}. **[${action.area}] ${action.title}** (\`${action.id}\`)`);
    lines.push(`   - Expected: ${action.expected}`);
    lines.push(`   - Observed: ${String(action.observed).split('\n').slice(0, 3).join(' / ').slice(0, 400)}`);
    if (action.server) lines.push(`   - Server: ${JSON.stringify(action.server.detail ?? action.server).slice(0, 300)}`);
    if (action.screenshots?.length) lines.push(`   - Screenshot: ${action.screenshots[action.screenshots.length - 1]}`);
  });
  if (setupFailures.length) {
    lines.push('', 'Setup failures (account creation through the real app; they block the area that needed the account):');
    for (const action of setupFailures) lines.push(`- [${action.area}] ${action.title}: ${String(action.observed).split('\n')[0].slice(0, 200)}`);
  }
  return lines.join('\n');
}
