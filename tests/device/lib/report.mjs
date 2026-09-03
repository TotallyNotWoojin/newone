// Run report: JSON for machines, Markdown for people. Every action records
// the on-screen outcome, the exact observed text, screenshot paths, and the
// server-truth row consulted at that moment.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export class Report {
  constructor({ runId, runDir, root }) {
    this.runId = runId;
    this.runDir = runDir;
    this.root = root;
    this.startedAt = new Date().toISOString();
    this.actions = [];
    this.areaLogs = {};
    this.meta = {};
    this.sections = [];
    mkdirSync(runDir, { recursive: true });
  }

  log(area, message) {
    const line = `[${new Date().toISOString()}] [${area}] ${message}`;
    (this.areaLogs[area] ??= []).push(line);
    console.log(line);
  }

  record(action) {
    const entry = {
      status: 'FAIL',
      observed: '',
      expected: '',
      screenshots: [],
      server: null,
      durationMs: 0,
      recordedAt: new Date().toISOString(),
      ...action,
    };
    this.actions.push(entry);
    const short = entry.observed ? ` — ${String(entry.observed).split('\n')[0].slice(0, 160)}` : '';
    this.log(entry.area, `${entry.status} ${entry.id}: ${entry.title}${short}`);
    this.flush();
    return entry;
  }

  addSection(markdown) {
    this.sections.push(markdown);
    this.flush();
  }

  rel(path) {
    return path ? relative(this.root, path) : '';
  }

  flush() {
    const json = {
      runId: this.runId,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      meta: this.meta,
      summary: this.summary(),
      actions: this.actions,
      logs: this.areaLogs,
    };
    writeFileSync(join(this.runDir, 'report.json'), `${JSON.stringify(json, null, 2)}\n`);
    writeFileSync(join(this.runDir, 'report.md'), this.markdown());
  }

  summary() {
    const counts = { PASS: 0, FAIL: 0, UNREACHABLE: 0, SKIPPED: 0, INFO: 0 };
    for (const action of this.actions) counts[action.status] = (counts[action.status] ?? 0) + 1;
    return counts;
  }

  markdown() {
    const esc = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
    const lines = [];
    lines.push(`# Newone real-device suite — run ${this.runId}`, '');
    lines.push(`Started ${this.startedAt}; updated ${new Date().toISOString()}.`, '');
    for (const [key, value] of Object.entries(this.meta)) {
      lines.push(`- **${key}**: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
    const counts = this.summary();
    lines.push('', `**Totals:** ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`, '');
    lines.push('## Results', '');
    lines.push('| # | Area | Action | Status | Screenshot | Observed (exact on-screen text / error) | Server truth |');
    lines.push('|---|---|---|---|---|---|---|');
    this.actions.forEach((action, index) => {
      const shot = action.screenshots?.length
        ? action.screenshots.map((path) => `[${path.split('/').pop()}](${this.rel(path)})`).join('<br>')
        : '';
      let server = 'n/a';
      if (action.server) {
        const detail = typeof action.server.detail === 'string' ? action.server.detail : JSON.stringify(action.server.detail ?? action.server);
        server = action.server.ok === false ? `MISMATCH: ${esc(detail)}` : esc(detail);
      }
      lines.push(`| ${index + 1} | ${action.area} | ${esc(action.title)} (${action.id}) | **${action.status}** | ${shot} | ${esc(action.observed)} | ${server} |`);
    });
    const failures = this.actions.filter((action) => action.status === 'FAIL');
    if (failures.length) {
      lines.push('', '## Failure details', '');
      for (const action of failures) {
        lines.push(`### ${action.area} / ${action.id} — ${action.title}`, '');
        lines.push(`- **Screen:** ${action.screen ?? ''}`);
        lines.push(`- **Steps:** ${action.steps ?? action.flow ?? ''}`);
        lines.push(`- **Expected:** ${action.expected}`);
        lines.push(`- **Observed:** ${esc(action.observed)}`);
        if (action.visibleTexts?.length) lines.push(`- **Visible text at failure:** ${esc(action.visibleTexts.slice(0, 60).join(' | '))}`);
        lines.push(`- **Screenshot(s):** ${(action.screenshots ?? []).map((path) => this.rel(path)).join(', ') || 'none'}`);
        lines.push(`- **Server state at that moment:** ${esc(JSON.stringify(action.server?.detail ?? action.server ?? null))}`);
        if (action.maestro) lines.push(`- **Maestro:** ${esc(action.maestro)}`);
        lines.push('');
      }
    }
    for (const section of this.sections) lines.push('', section);
    lines.push('', '## Area logs', '');
    for (const [area, log] of Object.entries(this.areaLogs)) {
      lines.push(`<details><summary>${area} (${log.length} lines)</summary>`, '', '```', ...log, '```', '</details>', '');
    }
    return `${lines.join('\n')}\n`;
  }
}
