// Wait for a build to finish processing, add it to the beta groups, and
// submit it for Beta App Review when an external group is among them.
// Usage: wait-build.mjs <buildNumber>
//
// Adding a build to an external group is not enough: external testers only
// receive it once it has a Beta App Review submission. Builds 47-52 sat at
// READY_FOR_BETA_SUBMISSION in "Public Testers" with nobody the wiser
// (found Sep 15 2026 when the owner asked "still no upload?").
import { asc, ascConfig } from './asc.mjs';

const [buildNumber] = process.argv.slice(2);
const { appId } = ascConfig();
// The app's own groups, asked for each run. Two ids used to be written here
// and both belonged to the retired Newone app after the rename: build 49 got a
// 409 "Group and build are from different apps" and a DONE line anyway
// (Sep 14 2026), while builds 47 and 48 had been added by hand.
const groups = (await asc('GET', `/apps/${appId}/betaGroups?fields[betaGroups]=name,isInternalGroup`)).json?.data ?? [];
if (!groups.length) {
  console.error('no beta groups found for app', appId);
  process.exit(1);
}
const started = Date.now();
while (Date.now() - started < 60 * 60 * 1000) {
  const r = await asc('GET', `/builds?filter[app]=${appId}&filter[version]=${buildNumber}&limit=1`);
  const build = r.json?.data?.[0];
  const state = build?.attributes?.processingState;
  console.log(new Date().toISOString().slice(11, 19), 'build', buildNumber, state ?? 'not visible yet');
  if (build && state === 'VALID') {
    let failed = false;
    for (const group of groups) {
      const add = await asc('POST', `/betaGroups/${group.id}/relationships/builds`, {
        data: [{ type: 'builds', id: build.id }],
      });
      // An internal group already has every build and refuses to be assigned
      // one, which is a 422 saying exactly that — not a failure.
      const detail = add.json?.errors?.[0]?.detail ?? '';
      const internal = add.status === 422 && detail.includes('internal group');
      const ok = internal || (add.status >= 200 && add.status < 300);
      if (!ok) failed = true;
      console.log('add to group', group.attributes.name, add.status,
        internal ? '(internal group: has it already)' : detail || 'ok');
    }
    // Say DONE only after the API lists the build in every group.
    for (const group of groups) {
      const rel = await asc('GET', `/betaGroups/${group.id}/relationships/builds?limit=200`);
      const has = (rel.json?.data ?? []).some((item) => item.id === build.id);
      console.log('group', group.attributes.name, has ? 'has' : 'MISSING', buildNumber);
      if (!has) failed = true;
    }
    // External testers need a Beta App Review submission; internal groups do not.
    if (groups.some((group) => group.attributes.isInternalGroup === false)) {
      const before = (await asc('GET', `/builds/${build.id}/buildBetaDetail`)).json?.data?.attributes?.externalBuildState;
      console.log('external state', before);
      if (before === 'READY_FOR_BETA_SUBMISSION') {
        const submit = await asc('POST', '/betaAppReviewSubmissions', {
          data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: build.id } } } },
        });
        const review = submit.json?.data?.attributes?.betaReviewState ?? submit.json?.errors?.[0]?.detail;
        console.log('beta review submission', submit.status, review ?? '');
        if (submit.status < 200 || submit.status >= 300) failed = true;
      }
      const after = (await asc('GET', `/builds/${build.id}/buildBetaDetail`)).json?.data?.attributes?.externalBuildState;
      console.log('external state now', after);
      if (!['IN_BETA_TESTING', 'READY_FOR_BETA_TESTING', 'WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW'].includes(after ?? '')) failed = true;
    }
    console.log(failed ? `FAILED build ${buildNumber} is not in every group or not submitted for external testing` : `DONE build ${buildNumber} in ${groups.length} groups, external review submitted or already testing`);
    process.exit(failed ? 1 : 0);
  }
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}
console.error(`build ${buildNumber} never became VALID`);
process.exit(1);
