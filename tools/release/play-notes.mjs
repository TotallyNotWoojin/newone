// Attach localized release notes to a Play track release.
// Usage: node play-notes.mjs <track> <versionCode> <copy.en.json> [copy.es.json ...]
import { readFileSync } from 'node:fs';
import { playEdit } from './play-edit.mjs';
const [track, versionCode, ...files] = process.argv.slice(2);
const notes = files.map((f) => { const c = JSON.parse(readFileSync(f, 'utf8')); const raw = c.whatsNewPlay ?? c.whatsNew; const text = raw.length <= 500 ? raw : raw.slice(0, raw.lastIndexOf('\n', 500)); return { language: c.locale.play, text }; });
const { base, auth, edit, commit } = await playEdit();
const current = await (await fetch(`${base}/edits/${edit.id}/tracks/${track}`, { headers: auth })).json();
const releases = (current.releases ?? []).map((r) => (r.versionCodes ?? []).includes(String(versionCode)) ? { ...r, releaseNotes: notes } : r);
if (!releases.some((r) => (r.versionCodes ?? []).includes(String(versionCode)))) { console.log(`no release with version code ${versionCode} on ${track}; releases:`, JSON.stringify(current.releases ?? []).slice(0, 300)); process.exit(1); }
const put = await fetch(`${base}/edits/${edit.id}/tracks/${track}`, { method: 'PUT', headers: auth, body: JSON.stringify({ track, releases }) });
console.log('track notes', put.status, put.ok ? notes.map((n) => n.language).join(',') : (await put.text()).slice(0, 200));
const committed = await commit(); console.log('commit', committed.status);
