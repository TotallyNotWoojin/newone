// Attach a processed build to the App Store version. Usage: node attach-build.mjs <buildNumber>
import { asc } from './asc.mjs';
const VERSION = 'f66f48a5-96d0-484f-aae5-8686f2f04bf3';
const [buildNumber] = process.argv.slice(2);
const started = Date.now();
while (Date.now() - started < 60 * 60 * 1000) {
  const r = await asc('GET', `/builds?filter[app]=6808028951&filter[version]=${buildNumber}&limit=1`);
  const build = r.json?.data?.[0];
  const state = build?.attributes?.processingState;
  console.log(new Date().toISOString().slice(11, 19), 'build', buildNumber, state ?? 'not visible yet');
  if (build && state === 'VALID') {
    const patch = await asc('PATCH', `/appStoreVersions/${VERSION}`, { data: { type: 'appStoreVersions', id: VERSION, relationships: { build: { data: { type: 'builds', id: build.id } } } } });
    console.log('attached to version', patch.status, patch.json?.errors?.[0]?.detail ?? 'ok');
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}
console.log('gave up waiting for build', buildNumber);
