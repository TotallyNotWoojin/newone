// Wait for a build to finish processing, then add it to the beta groups.
// Usage: wait-build.mjs <buildNumber>
import { asc, ascConfig } from './asc.mjs';

const groups = ['a2355488-1483-426b-b73d-b4ce719e5698', 'bf610c48-6161-464b-9181-70179c31605c'];
const [buildNumber] = process.argv.slice(2);
const { appId } = ascConfig();
const started = Date.now();
while (Date.now() - started < 60 * 60 * 1000) {
  const r = await asc('GET', `/builds?filter[app]=${appId}&filter[version]=${buildNumber}&limit=1`);
  const build = r.json?.data?.[0];
  const state = build?.attributes?.processingState;
  console.log(new Date().toISOString().slice(11, 19), 'build', buildNumber, state ?? 'not visible yet');
  if (build && state === 'VALID') {
    for (const group of groups) {
      const add = await asc('POST', `/betaGroups/${group}/relationships/builds`, {
        data: [{ type: 'builds', id: build.id }],
      });
      console.log('add to group', group.slice(0, 8), add.status);
    }
    console.log(`DONE build ${buildNumber} in both groups`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}
console.error(`build ${buildNumber} never became VALID`);
process.exit(1);
