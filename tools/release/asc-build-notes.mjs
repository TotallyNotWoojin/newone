// Set TestFlight "What to test" for a build (waits for processing). Usage: node asc-build-notes.mjs <buildNumber> <copy.en.json> [copy.es.json ...]
import { readFileSync } from 'node:fs';
import { asc } from './asc.mjs';
const [buildNumber, ...files] = process.argv.slice(2);
const notes = files.map((f) => { const c = JSON.parse(readFileSync(f, 'utf8')); return { locale: c.locale.asc, whatsNew: c.whatsNew.slice(0, 4000) }; });
let build = null;
for (let i = 0; i < 60 && !build; i++) {
  const r = await asc('GET', `/builds?filter[app]=6808028951&filter[version]=${buildNumber}&limit=1`);
  const b = r.json?.data?.[0]; if (b && b.attributes.processingState === 'VALID') build = b; else await new Promise((res) => setTimeout(res, 60_000));
}
if (!build) { console.log('build not processed'); process.exit(1); }
const existing = await asc('GET', `/builds/${build.id}/betaBuildLocalizations?limit=20`);
for (const note of notes) {
  const found = existing.json?.data?.find((l) => l.attributes.locale === note.locale);
  const r = found
    ? await asc('PATCH', `/betaBuildLocalizations/${found.id}`, { data: { type: 'betaBuildLocalizations', id: found.id, attributes: { whatsNew: note.whatsNew } } })
    : await asc('POST', '/betaBuildLocalizations', { data: { type: 'betaBuildLocalizations', attributes: { locale: note.locale, whatsNew: note.whatsNew }, relationships: { build: { data: { type: 'builds', id: build.id } } } } });
  console.log(note.locale, r.status, r.json?.errors?.[0]?.detail ?? 'ok');
}
