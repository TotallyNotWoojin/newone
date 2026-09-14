// Attach a processed build to the app's editable App Store version.
// Usage: node attach-build.mjs <buildNumber>
//
// The app id comes from ~/.config/newone/asc.json and the version is looked
// up, not hardcoded: both used to be literals for the retired
// com.totallynotwoojin.newone record, so this attached builds to the dead app.
import { asc, ascConfig } from './asc.mjs';
const APP_ID = ascConfig().appId;
const [buildNumber] = process.argv.slice(2);
if (!buildNumber) { console.error('usage: attach-build.mjs <buildNumber>'); process.exit(2); }

// A version can take a build unless it is already live or in review.
const FROZEN = new Set(['READY_FOR_SALE', 'IN_REVIEW', 'WAITING_FOR_REVIEW', 'PENDING_DEVELOPER_RELEASE', 'PROCESSING_FOR_APP_STORE']);
const versions = await asc('GET', `/apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&limit=10`);
const version = (versions.json?.data ?? []).find((v) => !FROZEN.has(v.attributes?.appStoreState));
if (!version) { console.error('no editable App Store version on app', APP_ID); process.exit(1); }
console.log('version', version.attributes.versionString, version.attributes.appStoreState, version.id);

const started = Date.now();
while (Date.now() - started < 60 * 60 * 1000) {
  const r = await asc('GET', `/builds?filter[app]=${APP_ID}&filter[version]=${buildNumber}&limit=1`);
  const build = r.json?.data?.[0];
  const state = build?.attributes?.processingState;
  console.log(new Date().toISOString().slice(11, 19), 'build', buildNumber, state ?? 'not visible yet');
  if (build && state === 'VALID') {
    const patch = await asc('PATCH', `/appStoreVersions/${version.id}`, { data: { type: 'appStoreVersions', id: version.id, relationships: { build: { data: { type: 'builds', id: build.id } } } } });
    console.log('attached to version', patch.status, patch.json?.errors?.[0]?.detail ?? 'ok');
    process.exit(patch.status < 300 ? 0 : 1);
  }
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}
console.log('gave up waiting for build', buildNumber);
process.exit(1);
