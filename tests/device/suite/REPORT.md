# Device suite report — September 3, 2026 (session 2)

Real-device (iOS simulator + Maestro, real hosted backend, real disposable inboxes) suite: `tests/device/run-suite.mjs` + `tests/device/areas/*.mjs` + `tests/device/suite/<area>/*.yaml` (107 flow files). This session could not complete the live sweep: the host was resource-starved (load average 260–388 on 16 GB, simulator installs timing out) and two gitignored secret files needed for a rebuild were iCloud-evicted (since regenerated). The findings below come from the earlier live runs on the 04:16 PDT binary plus this session's diagnosis.

## Ranked bug list

1. **HIGH — Cancel outgoing connect request has no effect (app, live-evidenced).** Tap "Cancel request" → button stays "Cancel request", server row stays `pending`. Evidence: `tests/device/.artifacts/dev-people-1/report.md`, action `people-03-cancel-request` (05:32 PDT, binary `jsBundleModified: Sep 3 04:16:27`); screenshot `tests/device/.artifacts/dev-people-1/people/001-people-03-cancel-request-FAIL.png`. Root cause found and fixed in the client round 1 commit (`workspace.removeConnection` returned early for people not in the loaded directory, which is always the case after a username search). **Not yet verified on a rebuilt binary.**
2. **HIGH — "Resend code" strands the signup (auth-07).** Resend shows the confirmation text, no second email arrives within 180 s, and the original code is then rejected with "Newone could not complete that action. (unauthorized · …)"; no profile row exists afterwards. Evidence: `tests/device/.artifacts/dev-auth-1/report.md`. Reproduction outside the UI: `NEWONE_HOSTED_E2E=1 node tests/hosted/resend-smoke.mjs` (real inbox, code #1 → resend → code #2 → verify). Disposition tracked in `docs/RELEASE_EVIDENCE.md`.
3. **MEDIUM — `people-04-message-request` fails** because "Send message request" is not offered while a connect request is already pending; cascades from bug 1. `tests/device/areas/people.mjs` already handles this ordering.
4. **Harness (fixed in source)** — the resend-code selector now asserts the disabled Pressable state (`tests/device/suite/auth/resend-code.yaml`).
5. **Harness (open)** — Maestro's XCUITest driver can crash under host load (Kotlin/JVM stack trace, simulator kicked to the Home Screen) and is recorded as a plain FAIL. `dev-auth-2` shows this. Recommended: `tests/device/lib/harness.mjs::step()` should detect the Home-Screen/Kotlin signature and tag it as `environment`, not `fail`.
6. **Environment (fixed)** — 11 of 107 flow files were iCloud-evicted (dataless) and were rewritten from their `expected:`/`env:` contracts and sibling flows, with catalog strings verified against `apps/newone/src/i18n/catalog.ts`: `chat/see-text`, `chat/unpin`, `chat/pin`, `chat/open-actions`, `common/signup-request-es`, `profile/language-to-en`, `people/block`, `people/cancel-request`, `people/friends-shows-after-relaunch`, `people/accept-request`, `people/send-expect-error`.

## Coverage

| Feature | Status | Notes |
|---|---|---|
| Signup happy path, wrong-code rejection | PASS (live, 04:16 binary) | dev-auth-1 |
| Resend code UI (cooldown) | PASS | selector fix in source |
| Resend code (delivery + code validity) | FAIL (live) | bug 2 |
| Username search, Connect (send) | PASS (live) | dev-people-1 |
| Connect (cancel) | FAIL (live, old binary) | bug 1, fixed in source |
| Message request send | blocked by bug 1 in that data point | bug 3 |
| Sign-out/relaunch, account deletion, accept/decline live update, block/unblock, DM chat (reply/react/edit/delete/forward/search/unread/typing), media (photo/voice/document), translation latency, briefing/summary, groups (creation/roles/removal/mentions/avatar), profile edit, language switch, notification settings, sessions (multi-device/revoke), negative (validation/caps/stale code) | BLOCKED this session | fully scripted in `chat.mjs`, `groups.mjs`, `translation.mjs`, `sessions.mjs`, `negative.mjs`, `auth.mjs`; media and profile run inline inside `chat.mjs` (media-01..05b) and `auth.mjs` (profile-01..04b) |
| AI conversation summary | server policy fixed in round 2 (`summary` approved for the personal realm) | re-verify on device |
| Friends-only groups / role hardening | server rules deployed in round 2, client gating in round 2 | `negative.mjs` (neg-06), `groups.mjs` (groups-05..20) verify live |

## How to rerun

```
uptime && vm_stat | head -4          # load must be sane before booting simulators
stat -f "%z %b" apps/newone/.env.local apps/newone/credentials.json   # both non-zero
cd apps/newone && npx expo run:ios --device <a "Newone Test N" udid> --configuration Release --no-bundler
node tests/device/run-suite.mjs --pool 3                        # full sweep
node tests/device/run-suite.mjs --pool 3 --areas auth,people    # confirm bugs 1 and 2 first
node tests/device/run-suite.mjs --pool 1 --areas auth           # smallest footprint
```

Results land in `tests/device/.artifacts/<run-id>/report.md` with screenshots and Maestro debug output. `OWNER_DEVICES` in `tests/device/lib/devices.mjs` refuses the owner's simulators (`084E6094-…`, `74D8B645-…`).
