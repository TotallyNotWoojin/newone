# Newone release evidence

Status: working implementation and development-environment evidence ledger; no immutable release candidate, production deployment, or production acceptance is claimed

This file records only observed results. Every final entry must identify the immutable revision, environment, runner, date/time zone, command or procedure, result, and retained artifact. Preliminary results are useful during implementation but must be rerun from the exact release candidate. A linked Free Supabase development deployment exists; it is not staging or production evidence.

## Candidate identity

| Field | Current value |
|---|---|
| Evidence date | August 5, 2026, America/Denver |
| Implementation commits | `d85cdac` built the independent workplace messenger; `0ebbf3f` removed the duplicate shift-assignment index; `799c611` hardened hosted Edge transport, CORS, and maintenance integration; `b67cfbe` reconciled development-deployment evidence; the current uncommitted cleanup retires the fictional-data browser path and does not assign a release revision |
| Local verification target | The exact commit containing this evidence record; capture its hash with the final verification output. This is a local implementation checkpoint, not a production release revision |
| Immutable release revision | Not assigned |
| Local runner | macOS arm64 |
| Required Node baseline | 22.13.0, pinned in engines, `.nvmrc`, `.node-version`, and CI |
| Current local Node/npm | System default Node 22.11.0 / npm 11.6.2; exact Node 22.13.0 was selected for the recorded exact-baseline checks |
| Deno | 2.9.1 |
| Supabase CLI | 2.109.0 with telemetry disabled for sandbox-safe local execution |
| AI policy | `2026-08-04.2`; employee-data egress disabled |
| Linked Supabase project | Healthy Free development project with 37 local/remote migrations in parity, six active Edge Functions, hosted Auth hardening, and Postgres SSL enforcement |
| Database network restrictions | Open pending stable developer and CI egress addresses; this remains a production security gate |
| Production environment | Not provisioned or claimed |

## Consumer pivot slice 1 evidence (September 1, 2026)

The product pivoted to a general consumer messenger per [CONSUMER_PIVOT_PLAN.md](CONSUMER_PIVOT_PLAN.md); rows below are observed working-tree results for pivot slice 1 (open signup), not release evidence.

| Check | Observed result | Disposition |
|---|---|---|
| Dependency realignment | 16 drifted Expo packages realigned; regenerated client lockfile; `expo install --check` clean | Working-tree baseline restored after three weeks of ecosystem drift |
| Signup migrations | `20260901000000` (personal realm, usernames, reservations, signup RPCs) and `20260901010000` (lifecycle-hook reservation arm) applied locally and pushed to the linked Pro project; 38 migrations in local/remote parity | Rerun full chain on the eventual immutable candidate |
| Database suite | Full pgTAP including the new 27-assertion consumer signup suite passed; strict `public,private` lint clean; generated types in parity | Green on current working tree |
| Edge suite | Deno check clean; 268/268 tests; Edge/database drift contract verified (158 called RPCs) | Green on current working tree |
| Client suite | 49/49 Jest suites, 634/634 tests; coverage 96.09/91.40/96.92/97.29 all above the 91% gate; deterministic web/iOS/Android exports verified | Green on current working tree |
| Root contracts | 272/272 including the updated consumer media-permission contract | Green on current working tree |
| Real hosted signup smoke | `tests/hosted/signup-smoke.mjs` passed 7 steps against the deployed gateway, hosted GoTrue, and Postgres: request, pending user, admin-API OTP, verified session with signup receipt, durable state (username, ko language, private-directory personal-realm membership, request-first realm, consumed reservation), completion marker, returning-member acceptance. Secret-free artifact retained under `tests/hosted/.artifacts/` | Two real-integration defects were found by this smoke and fixed: the lifecycle hook refused pre-membership signup sessions, and the session parser rejected hosted GoTrue's 12-character refresh tokens. Mocked suites alone could not have caught either; rerun on the immutable candidate |
| Hosted deployment | `newone-auth` redeployed with signup routes and failure telemetry; synthetic e2e-prefixed smoke identities retained in the development-data project pending harness-style confirmed cleanup | Development evidence only; not production |

## Consumer pivot slice 2 evidence (September 1, 2026)

| Check | Observed result | Disposition |
|---|---|---|
| Discovery/requests migration | `20260901020000` (username prefix search RPC with expression index, message-request pending arm in the DM policy predicate, realm-only anti-enumeration relaxation, connections-plus-conversations realm directory) applied locally and pushed; 41 migrations in parity | Rerun on the eventual immutable candidate |
| Database suite | Full pgTAP 31 files / 1,062 assertions passed including the new 35-assertion discovery suite; strict lint clean; types in parity | Green on current working tree |
| Edge suite | 282/282 Deno tests; drift contract verified (160 called RPCs) | Green on current working tree |
| Client suite | 50/50 Jest suites, 650/650 tests; coverage 96.11/91.42/96.93/97.32 above the 91% gate; deterministic exports verified | Green on current working tree |
| Root contracts | 272/272 | Green on current working tree |
| Real hosted discovery smoke | `tests/hosted/discovery-smoke.mjs` passed 7 steps first-run against the deployed gateways: two gateway signups (en/es), username search surfacing a stranger, message request creating connection+conversation+first message atomically, correct pending direction on both sides, acceptance, recipient reply, and database evidence (accepted connection, exactly 2 messages, 2 members). Secret-free artifact retained | Rerun on the immutable candidate; authenticated browser/device workflows remain open |

## Real-device and full-journey evidence (September 3, 2026)

Owner-directed shift after first TestFlight use exposed three production-breaking defects that every mocked suite had passed: simulations now run the real binary with no shortcuts.

| Check | Observed result | Disposition |
|---|---|---|
| Defects found only by real use | (1) client route table lacked signup/deletion paths (unit tests mocked routing); (2) GoTrue refused OTP email to unconfirmed users under disabled public signup and the gateway masked it as success (smokes fetched codes via admin link); (3) native session validator required bootstrap fields the server never sends, silently signing every new user out (fixtures encoded the wrong shape); plus magic-link sign-in emails pointing at localhost (Site URL default) and a Settings keyboard/scroll UX that automation had to learn | All fixed with regression nets that use real components: route sweep (`tests/client-route-coverage.test.mjs`), real-inbox smoke, captured-payload parser test, device lifecycle |
| Real-device lifecycle | `tests/device/run-signup.mjs` (Maestro driving the Release build on iPhone 17 Pro / iOS 26.5): sign-up with real taps, code read from a real disposable inbox, Chats reached, force-quit/relaunch keeps the session, sign out via Settings, returning sign-in with a second real code — **PASS** | Rerun on each candidate build |
| Real-inbox smoke | `tests/hosted/real-user-smoke.mjs` PASS after the gateway took ownership of code email delivery via Resend (en/es/ko copy); delivery failures now surface as 503 `code_delivery_failed` by owner direction | Live on hosted |
| Three-user journey | `tests/hosted/journey-smoke.mjs` **15/15, gaps: none** (88s): signups en/es/ko, bootstrap, friends, reply/reaction/edit/receipt, real PNG and M4A through the signature gate and download, group with Korean→en/es translation, private realtime typing, profile edit (new `PATCH /v2/profile`), preference toggle, block fail-closed/unblock, search, device registration | Live on hosted; artifact retained |
| Suites | pgTAP 35 files / 1,122; Deno 331; Jest 52 suites / 705; root 273 | Green |
| Owner hands-on findings (Sep 3) | Requester never learned of acceptance (no counterpart invalidation on request/accept/decline) and was told it could not post (V7 bootstrap evaluated the pending arm with a null actor); translations completed server-side within ~25s but no invalidation reached open apps; AI worker polled every 10s across two stages; consumer copy leaks; groups allowed non-friends; summaries not approved for the realm; keyboard covered search; simulator push toggle showed a generic error | Round 1 deployed (`20260903020000`): both-party invalidations, actor-context can_post (V11 wrapper), AI wake-on-enqueue via pg_net + Vault (measured on hosted after deploy: detection 10s→2s, translation 15s→7s, ~9s end to end). Round 2 in progress: server-wide desync audit with per-path invalidation tests, friends-only groups, role hardening, consumer summaries, preflight caching |
| Store | iOS builds 11 (routing fix), 12 (resend/error ids) uploaded to TestFlight; build 13 (session validator fix — the one that makes sign-in work) building for automatic submission | Owner verification on device next |
| Server round 1 (deployed Sep 3) | Migration `20260903020000_request_sync_and_ai_wake`: both-party invalidations on request create/accept/decline (outbox worker forwards contact-connection control events), bootstrap `can_post` for direct threads evaluated under the actor, and a wake-on-enqueue trigger for the AI worker. Hosted latency after deploy: language detection avg 2s, translation avg 7s (was 25–40s); translation smoke PASS | Live on hosted |
| Client round 1 (commit, Sep 3) | Requests section in Chats with inline accept/decline; Cancel request now issues the DELETE for username-search targets not yet in the directory (it had been a silent no-op); direct threads never show "administrators only"; an outgoing pending request keeps the composer open with the server enforcing the cap; People/Search inputs stay above the keyboard; simulator push registration reports `push_needs_device`; manual "Request translation" hidden in the personal realm. Jest 739; root contracts updated for the explicit direct-pending exception | Committed |
| Server round 2 (deployed Sep 3, 47 migrations) | Migration `20260903030000_desync_audit_and_consumer_rules`: an invalidation for every affected user on every write path (reactions, pins, hide-for-me, attachment upload/scan, translation completion/failure, summaries, blocks, conversation metadata/preferences, profile changes, contact decline/cancel/block/unblock/remove, deletion tombstone — `desync_audit_test.sql`, 32); friends-only group creation/add in the personal realm (12); role hardening (15) that also caught admins editing other admins and a sole owner leaving via a raw update; personal-realm AI policy approves `summary`; OpenRouter preflight cached 5 min and never on failure. pgTAP 39 files / 1,211; Deno 336; root 273; db lint clean; fresh reset clean. Hosted after deploy: journey **15/15, gaps: none** (91s), discovery 7/7, translation 5/5 | Live on hosted |
| Client round 2 (Sep 3) | Realtime channels rebuilt on foreground with the current token; 30s±5s reconcile poll while active (10s while realtime is degraded; skipped when a refresh is in flight or a realtime event arrived <15s ago; stopped in background); channel error/close or 60s without heartbeat → degraded + resubscribe with 1→30s backoff and a "Reconnecting…" banner after 10s; one server reconcile of the open thread after each send; personal-realm group creation offers only "Private group", no role chips, friends-only candidates; "Create action item" hidden; per-role member-management affordances proven by tests (nobody can touch their own role). Jest 756; root 273 | Committed with this ledger |
| Environment incident (Sep 3) | Disk at 98% caused macOS/iCloud to evict repo files (empty reads, evicted git packs and 71 loose objects). Recovery: freed 106 GB (Docker images/build cache, other projects' DerivedData, npm cache), restored 35 tracked files from the pack-resident commit and 7 from the session transcripts (verified byte-identical against the index), consolidated the five commits whose objects never returned into `50df70c`, reinstalled dependencies. Owner disabled Optimize Mac Storage and marked the folder Keep Downloaded | Repository whole; history hashes changed |
| Device suite (Sep 3) and resend check | `tests/device/run-suite.mjs` + 107 flows across auth/people/chat/groups/media/profile/sessions/negative; the live sweep was blocked by host load (load average 260–388) and evicted secret files, so only auth/people evidence from the 04:16 binary exists (`tests/device/suite/REPORT.md`): cancel-request no-op (fixed in client round 1, awaiting a rebuilt binary) and a resend-code lockout. The resend path was then reproduced against the real inbox with `tests/hosted/resend-smoke.mjs`: code #1 in 11s, resend accepted, code #2 in 11s, old code rejected 401 by design, new code signs in — **PASS**, so the device failure was transient delivery, not a gateway defect | Suite rerun on the rebuilt binary next |
| TestFlight build 18 (Sep 3) | EAS iOS production build (7 min) from commit `8fdd207` — server rounds 1–2 and client rounds 1–2 — uploaded directly with `xcrun altool --upload-app`, VALID, available to the Team (internal) and Public Testers groups; public link still gated on the beta review of build 6 | On the owner's phone via TestFlight |
| Device suite live run 1 (Sep 3, build from 8fdd207) | `run-2026-09-03T19-37-50`: **26 PASS / 13 FAIL** across auth + people on two suite simulators. Owner-reported defects now PASS on device: cancel request (server row removed), recipient sees the request under People → Requests, requester learns of acceptance without relaunch, block/unblock/remove. All 13 failures were harness, not app: iOS 26 exposes multiline placeholders merged with their labels ("First message Introduce yourself") so exact-text taps missed (flows now use `.*…*` regexes); the Spanish switch worked but the flow asserted the sign-out button without scrolling and then used an English chip label on a Spanish screen (fixed); two Maestro driver crashes under host load (harness retries once). Keyboard check on a third simulator: People search input bottom y=234 vs keyboard top y=590 — not covered | Rerun + remaining areas next |
| Device suite run 2 (Sep 3 evening, build from 8fdd207) | `run-2026-09-04T01-24-27` translation setup **8 PASS / 2 FAIL** (the Spanish signup that failed in run 1 now passes; both failures were selectors, since iOS 26 exposes chat rows and message bubbles as one merged accessibility node) and `run-2026-09-04T01-35-11` chat + negative (partial). **App defect A, fixed:** on iOS 26 the conversation composer sat about 60pt underneath the keyboard's predictive bar (React Native's KeyboardAvoidingView pads relative to its parent, and AppScaffold starts below the safe-area top), so every tap on "Send message" landed on the keyboard and no message could be sent from a conversation. `KeyboardAvoidingScreen` (self-measuring offset) now wraps the conversation pane, People and Search; on the rebuilt binary the send button sits at y 476–516 with the keyboard top at ≈575. **App defect B, fixed:** with the composer reachable, a send rendered its bubble with the clock icon but the app never issued the request: no server row, an empty `outbox_commands` table on the device, and no message POST in the Supabase edge log for the window. Cause: every queued command is AES-GCM sealed with expo-crypto before it is written; the store saved the parts as base64 strings and rebuilt the sealed box with `AESSealedData.fromParts(iv, ciphertext, tag)` using those strings, but the native module takes the tag only as bytes (or a length) and honours `outputFormat`, not the `encoding` its typings advertise, so every decrypt threw, `listOutbox` classed the row as corrupt and deleted it, and the message stayed pending forever with nothing on the wire. The encrypted workspace cache failed the same round trip. The composer also fired `onSend` without awaiting it. Fix: only Uint8Arrays cross the native boundary (base64 encode/decode in the store), the unit-test mock now rejects a string tag the way the device does, enqueue is raced against 4s with a direct online send and a visible reason in Settings as the fallback, and the composer's send promise is caught. TestFlight build 18 carries the broken store: on that build no message sent from a conversation can leave the phone | Rerun on the fixed binary; ship a new TestFlight build before anyone tests messaging |
| Environment (Sep 3 evening) | The reboot re-enabled iCloud Drive; its file provider ran at 100–130% CPU and the load average sat between 400 and 900 with CPU 45–60% idle, which starved Maestro's driver start-up. Owner turned iCloud Drive off ("Remove from Mac"). The `.nosync` symlink workaround from the afternoon broke Jest (duplicate haste packages), `tsc`, and Expo's manifest build step: a binary built through the symlinks shipped without `EXConstants.bundle/app.config` and crashed at launch. Real directory names restored; Jest 756/756 | Keep the repository outside iCloud; never rename `node_modules` |
| Translation latency (Sep 3 evening, owner requirement: quick every time, never the polling path) | Baseline from server rows: message created → translation completed 10–14s on recent messages, 21s p50 / 112s max over 48h, while a direct call to the same model (`qwen/qwen3-235b-a22b-2507` on Google Vertex) answers in 0.7s. Causes and fixes, all deployed to hosted: (1) the AI worker claimed one batch per invocation, so the translation job that a detection completion enqueues waited for the next wake or the 10s cron — the worker now drains its queue within one pass (6s budget, repeat-id guard); (2) the per-topic 2s wake debounce made the second message of a burst wait for the cron — migration `20260904040000` wakes the worker for every AI job; (3) the OpenRouter control-plane proofs (4 management calls) were cached only in isolate memory and the isolate recycles constantly — migration `20260904050000` persists the proof for the same 5-minute window (`private.ai_control_plane_proofs`). Stage timings are now logged (`newone_ai_job_timing`). After: 3–7s end to end; RPC stages 30–100ms; the provider stage (1.6–3s detection, 2.5–4.8s translation) is the whole remainder: ~0.7s synthetic route probe before every completion plus ~1.5s of output tokens because the translation schema echoes source/target language and a 64-hex hash. (4) the structured replies now echo a 16-hex fingerprint instead of source/target language plus the 64-hex hash (commit f4af80a): translation provider stage 1.8–2.6s (was 2.5–4.8s). Steady state after all four: Spanish→English ≈3s end to end, English→Spanish ≈6s, the gap being language detection (Spanish is recognized deterministically in 1ms; English goes to the model, ~2s plus the probe). Deno 339/339; pgTAP assertions updated (Docker off, not run here) | Owner decisions pending: keep/cache/drop the per-completion route probe (0.7s per model call); let the deterministic detector recognise English (saves ~2s on English messages); then fold detection and translation into one call (target ≈1.5s) |

## Consumer 1.0 feature-complete evidence (September 1–2, 2026)

| Check | Observed result | Disposition |
|---|---|---|
| Feature waves | Account deletion (tombstone + auth soft delete), consumer branding/nav gating, typing-indicator realtime authorization, voice notes, video attachments (all six enforcement layers), and realm translation policy landed across migrations `20260901030000`/`20260901040000` | Working-tree green; immutable-candidate rerun open |
| Suites | pgTAP 34 files / 1,105 assertions; Deno 290; Jest 52 suites / 688 tests; root contracts 272; coverage 96.14/91.43/96.99/97.37 | All green on current tree |
| Real hosted deletion smoke | `tests/hosted/deletion-smoke.mjs` passed 4 steps: signup, gateway deletion, tombstone evidence (anonymized profile, quarantined username, deactivated memberships, purged devices, auth soft delete), quarantined-handle reuse refusal. Found and fixed a native-only guard bug (origin-less bearer deletion 403'd) | Rerun on candidate; browser/device matrix open |
| Hosted worker scheduling | pg_cron + pg_net + Vault configured on the linked project per DEPLOYMENT.md: outbox worker every 5s and maintenance worker every minute, verified returning 200 with clean claims; worker token rotated into Vault; two integration findings recorded (pg_net duplicate Content-Type header causes gateway 400; worker batch limit caps at 10) | Environment state documented; not a migration |
| Attachment scan worker | Deployed but unscheduled: requires an external scanner service (`NEWONE_ATTACHMENT_SCANNER_URL`/`TOKEN`), an open owner gate; attachments remain fail-closed pending scan | Owner decision required before media flows in production |
| AI worker | Not deployed; `OPENROUTER_API_KEY`, key hash, policy JSON `2026-09-01.1`, and egress approval staged as secrets; blocked on owner-provided OpenRouter management key + workspace id | Owner gate |
| iOS release pipeline | Headless signing chain via ASC API (bundle `com.totallynotwoojin.newone`, push capability, distribution certificate, App Store profile); first production build FINISHED; feature-complete candidate build launched | TestFlight blocked only on the UI-only ASC app-record creation (owner) |
| Legal | Privacy policy and terms live at totallynotwoojin.github.io/newone-legal | App Store metadata prerequisite met |

## Current preliminary automated and development results

These results were observed on the current uncommitted implementation worktree on August 5, 2026. They establish a verified working-tree checkpoint, not a release. Coverage reports and a real hosted core-backend simulation now exist, but their artifacts are gitignored and are not tied to an immutable revision. A clean immutable-candidate rerun, authenticated browser/device workflows, provider integrations, signed binaries, and owner-controlled production systems remain unavailable.

| Check | Observed result | Final disposition |
|---|---|---|
| Exact Node baseline availability | The selected temporary runtime reported `v22.13.0`; the shell default remained Node 22.11.0 / npm 11.6.2 | Select the exact runtime explicitly for every final Node/npm command |
| Shared runtime and API coverage | 272/272 Node tests passed across all 25 production `.mjs` modules; measured coverage was 99.58% lines, 97.51% branches, and 100% functions | Global working-tree coverage gate passed; retain a machine-readable report and rerun on the immutable candidate |
| Universal-client tests and coverage | 49/49 Jest suites and 617/617 tests passed; all 83 eligible production files were instrumented at 96.05% statements, 91.31% branches, 96.90% functions, and 97.27% lines | Global working-tree coverage gate passed; generated database types and declarations are non-executable exclusions; per-file coverage is not claimed |
| Edge Functions tests and coverage | Edge modules type-checked; 257/257 Deno tests passed; all 32 production TypeScript files and all nine real entrypoints were exercised at 92.84% lines, 91.36% branches, and 98.61% functions | Global working-tree coverage gate passed; rerun and retain reports on the immutable candidate |
| Clean local reset, database contracts, and pgTAP | All 37 migrations reset cleanly; 29 pgTAP files produced 1,000/1,000 passing assertions; strict `public,private` database lint reported zero findings | Rerun the complete database chain on the immutable candidate and retain logs |
| `npm run edge-db:contract:check` | The current Edge/database name-and-shape drift contract passed | This is drift coverage, not proof that every SQL function is called or behaviorally accepted; rerun on the candidate |
| Universal-client deterministic exports | Web export plus iOS and Android Expo export/Hermes bundle checks completed successfully | These are source/bundle checks, not signed native binaries or physical-device evidence |
| iOS simulator launch | Expo Go 57.0.6 bundled the app successfully on a booted iPhone 17 Pro simulator running iOS 26.5 and rendered Newone's branded secure-access screen. Only the expected `expo-notifications` Expo Go limitation warnings appeared; no runtime error was observed during this launch. | Launch observation only; it is not a signed development build, physical-device result, TestFlight build, App Store acceptance, or workflow evidence |
| Retired Browser/Playwright workflow suite | A former run recorded 46/46 passes across desktop Chromium and Pixel 7 mobile Chromium | Withdrawn as acceptance evidence because the workflows used an in-client fictional data repository; no current browser workflow pass is claimed |
| Static Playwright sign-in checks | 6/6 passed across desktop Chromium and Pixel 7 mobile Chromium on the current uncommitted cleanup worktree | Static unauthenticated UI regression only; not hosted Auth, employee workflow, or acceptance evidence; rerun on the immutable candidate |
| Browser visual review | Desktop and Pixel 7 screenshots from the retired fictional-data path were reviewed | Historical design reference only; real hosted browser/device visual and accessibility review remains open |
| Real hosted core-backend simulation | Artifact `newone-e2e-20260805t073237z-bbb833d0` passed 18 real hosted steps against development Supabase Auth, Postgres/RLS, deployed Edge Functions, and private Realtime, then completed guarded cleanup | Core backend evidence only; the artifact is gitignored and authenticated browser/device, SMTP/CAPTCHA, scanner, AI worker/approved egress, push receipts, and deployed same-origin web testing remain open |
| Measured coverage | Shared runtime/API, universal client, and Edge reports all exceeded 90% for every metric their respective tools measure; complete production-file inventory checks passed for the 83 client and 32 Edge files | Global working-tree coverage is established, but ignored artifacts must be retained and the exact immutable candidate rerun before release |
| OpenRouter synthetic evaluation and adapter | Paid synthetic evaluation passed 20/20 and the production-adapter smoke passed using the server-only test credential; `employeeDataEgressEnabled` remained `false` | Rerun on the immutable candidate with synthetic content only; qualified Korean-Spanish human approval remains required |
| Remote development migrations and advisors | Local and linked development migration histories were in parity at 37; the current local strict lint was clean, while the earlier remote advisor observation reported zero security and zero performance warnings | Recheck remote advisors after every migration; Free development evidence is not production evidence |
| Remote development Edge Functions and canaries | Six functions were active: `newone-api`, `newone-auth`, `newone-bootstrap`, `newone-read`, `newone-outbox-worker`, and `newone-maintenance-worker`. A fresh dry-run passed with six active functions and zero existing organizations/users | The core artifact records exact versions/digests for its four exercised gateway functions; retain a frozen full inventory and rerun candidate smokes |
| Remote development Auth and database transport | Hosted custom access-token hook and Auth hardening were enabled; real password sessions, installation binding, TOTP/AAL2, one-time invitation redemption, and denial paths passed in the hosted core run. Postgres SSL enforcement remained enabled | Custom SMTP, Turnstile, recovery delivery, stable network restrictions, and production Auth review remain open |

## Historical implementation checkpoints

The rows below are preserved to show evidence progression. They are superseded observations from the earlier dirty-worktree checkpoint and must not be combined with current counts or represented as release evidence.

| Historical check | Earlier observed result | Current interpretation |
|---|---|---|
| Node contracts | 119/119 passed | Superseded by the current 272/272 shared runtime/API checkpoint |
| Edge Functions | Type-check and 135/135 Deno tests passed | Superseded by the current 257/257, 32-file, nine-entrypoint checkpoint |
| Database chain | Reset through `20260804155917_complete_search_filters.sql`; 413/413 pgTAP passed; lint was clean; types matched; Edge/database contract found 122 called RPCs and 370 SQL functions | Superseded by the current 37-migration, 29-file/1,000-assertion, strict-zero-lint checkpoint |
| SEARCH-01 focused contracts | Exact Node 22.13.0 ran 5/5 client/DTO tests; focused Edge read passed 10/10; focused search pgTAP passed 39/39; client lint/typecheck passed | Useful feature-level history only; the current full chain and browser evidence control release status |
| Universal-client exports | Web, iOS, and Android exports completed | Reconfirmed in the current checkpoint; these were never signed-build evidence |
| Repository security, environment, and documentation | Security and environment contracts passed; documentation check passed over 16 delivery files | Historical run only; rerun after final source and evidence freeze |
| Retired browser suite state | The fictional-data suite progressed from no recorded pass, to 42 passes with 4 conditional skips, to a recorded 46/46 run | The entire sequence is withdrawn as workflow and acceptance evidence; it does not supersede the real hosted core artifact or the still-pending authenticated browser/device matrix |
| OpenRouter policy | Policy `2026-08-03.1` public ZDR route check passed with employee-data egress disabled | Superseded by policy `2026-08-04.2`, 20/20 synthetic evaluation, and adapter smoke |
| Production dependency audits | Root/release-tooling and universal-client production graphs reported zero known vulnerabilities | Historical lockfile evidence; rerun from immutable clean installs |
| npm registry signatures | 6 root/release-tooling and 838 universal-client packages had verified registry signatures; 5 and 198 respectively also had attestations | Historical lockfile evidence; signatures do not replace vulnerability, provenance, or license review |
| Supply-chain evidence | Inventory covered 892 entries; license report classified 625 allowed, 14 review, 0 denied; CycloneDX production component counts were 0 root/release-tooling, 527 universal client, and 9 Edge | Historical artifacts; resolve or accept the 14 review classifications and regenerate from immutable lockfiles |
| Documentation diff check | `git diff --check -- docs/CONTRACT_TRACEABILITY.md docs/RELEASE_EVIDENCE.md` passed | Historical documentation-only check; rerun repository-wide before source freeze |

## Final automated chain

All rows below remain open until executed from a clean checkout of the immutable candidate with the pinned toolchain. Preliminary successes are recorded so the remaining work is clear, but none is promoted to a final pass.

| Area | Required command/evidence | Status |
|---|---|---|
| Clean installs | `npm ci` and `npm ci --prefix apps/newone`, with no lock drift | Not run on candidate |
| Universal client | Expo dependency alignment, lint, TypeScript, deterministic web export, iOS export, Android export, and approved native runtime/device matrix | Preliminary web/iOS/Android source/bundle exports green; one Expo Go 57.0.6 iPhone 17 Pro/iOS 26.5 simulator launch rendered without runtime error; signed builds, physical devices, TestFlight/App Store, and immutable-candidate chain remain open |
| Root contracts | BFF, auth-routing, invitation, environment, documentation, web-export, AI-policy, and repository-security suites | Current shared runtime/API run passed 272/272; immutable-candidate chain remains open |
| Edge Functions | Deno check and full Deno test suite | Current type-check and 257/257 tests green; all 32 production TypeScript files and nine entrypoints covered; immutable-candidate chain open |
| Database | Fresh local stack, clean migration/seed rebuild, full pgTAP authorization suite, strict database lint, generated-type drift check, and Edge/RPC contract | Current 37-migration reset, 29 files/1,000 assertions, and strict-zero-lint result green; immutable-candidate chain open |
| Static browser surface | Exported unauthenticated sign-in rendering and fail-closed validation in configured Playwright browser profiles | 6/6 passed on the current uncommitted cleanup worktree; not hosted Auth, workflow, accessibility-matrix, or acceptance evidence; immutable-candidate rerun remains open |
| Hosted core plus browser/device simulations | Real hosted Auth, BFF, database, Realtime, Storage, worker, and supported-client journeys with approved synthetic accounts | Core Auth/API/database/private-Realtime artifact passed 18 steps and cleaned up; provider-backed Storage/AI/push, same-origin deployed web, authenticated browser workflows, and signed-device matrix remain open |
| Coverage | Coverage-instrumented report for the agreed application/backend scope | Global working-tree gates passed for shared runtime/API, all 83 eligible client files, and all 32 Edge files; retain reports and rerun on immutable candidate |
| Supply chain | Production audits, registry signatures, three SBOMs, combined license/integrity inventory | Historical artifacts exist; 14 license classifications require review and immutable-candidate regeneration is open |
| AI adapter | Paid synthetic evaluation plus one synthetic-only production-adapter smoke using a server-only test key | Preliminary 20/20 and adapter smoke green with employee egress false; candidate rerun and human bilingual approval open |
| Integrated local | Synthetic Auth users through BFF/native contracts, RLS/RPC, Realtime, Storage quarantine/scan, revocation, offline reconciliation, and AI-disabled path | Not run as one retained candidate chain |
| Remote development | Migration parity, active function versions/digests, environment/config verification, synthetic route smoke, Auth settings, and database/security/performance advisors | Current 37-migration parity and six active functions; hosted core run and clean six-function/zero-data dry-run passed; candidate rerun, fresh advisors, and retained full inventory remain open |
| Production | Dedicated production environment, owner-controlled providers, deployment IDs, signed binaries, restore/rollback, monitoring, security review, and human acceptance | Not provisioned or run |

## Manual and external gates

| Gate | Status / owner action |
|---|---|
| Qualified Korean-Spanish blind evaluation | Required; 20/20 automated synthetic evidence is not human language approval |
| Web domain, Vercel project, and TLS | Company account, domain, and credential required |
| Separate paid production Supabase with target RPO, PITR/equivalent, independent Storage-object backup, and stable database network restrictions | Company plan/account and restore exercise required; SSL is enabled in Free development, but that project is not production evidence |
| Custom SMTP or approved Auth email hook, DKIM/DMARC, and deliverability | Company provider/domain credentials required |
| Turnstile production site/secret and hostname checks | Company Cloudflare account required |
| Account-recovery human verification and notification | Company security owner must approve the external verification procedure and trained recovery-manager roster; a trusted out-of-band provider plus synthetic delivery receipt is required because the implementation currently records `pending_external_delivery` only |
| Production malware/content scanner | Company-selected provider or isolated scanner plus credentials/signatures/SLA required |
| Expo/APNs/FCM push and optional SMS fallback | Company Apple/Google/Expo/SMS accounts, credentials, consent, and device evidence required |
| Signed Expo/EAS iOS and Android builds, deep/app links, store listings, and review | Company owner accounts and physical devices required; successful Expo exports are not this evidence |
| OpenRouter production management controls | Company-owned completion and management credentials; exact completion-key hash and dedicated workspace identity; global plus organization egress authorization; enabled exact organization policy; pinned model/provider route; uncached ZDR/data-denial and no-BYOK/content-mutating-guardrail controls; management and synthetic preflights; least-privilege rotation/revocation; billing cap, monitoring, and tested kill switch required |
| Retention, investigation, legal hold/export, DM, device, critical-notice, AI, privacy/labor, and employee-notice decisions | Company policy/legal/security owners required |
| Independent security review, load/abuse test, monitoring alerts, incident/rollback/provider-kill-switch, and restore tabletop | Not yet performed |
| Two-hour training and acceptance certificate | Human delivery/review action; never self-certified by software |

## Development deployment ledger

The linked Free Supabase project is a development environment only. The following observation documents development state without secret values or a production claim. The hosted core artifact records the exact four gateway versions/digests it exercised, but that artifact and the coverage reports are gitignored, and immutable logs, rollback evidence, a full six-function frozen inventory, and a frozen source revision were not retained. This is not a releasable deployment record.

| Field | Observed development state |
|---|---|
| Date/time zone | August 5, 2026, America/Denver; hosted run `2026-08-05T07:32:42.237Z` through cleanup at `2026-08-05T07:33:25.123Z` |
| Source checkpoints | Current uncommitted worktree plus deployed function digests in the hosted artifact; immutable release revision not assigned |
| Environment | Linked Free Supabase development project; no staging or production mapping claimed |
| Database | 37 local/remote migrations in parity; local reset passed 29 files/1,000 assertions with clean strict lint; earlier remote advisors reported zero security and zero performance warnings; Postgres SSL enforcement enabled |
| Edge Functions | Six active functions: `newone-api`, `newone-auth`, `newone-bootstrap`, `newone-read`, `newone-outbox-worker`, and `newone-maintenance-worker`; AI, attachment-scan, and push-receipt workers remain withheld |
| Hosted core simulation | Secret-free artifact `tests/hosted/.artifacts/newone-e2e-20260805t073237z-bbb833d0.json` passed 18 real steps, recorded four exercised gateway versions/digests, and completed guarded data/Auth cleanup |
| Fresh dry-run | Six active functions; zero existing organizations; zero existing users; no hosted data changed; the ephemeral Bootstrap secret was absent after execution |
| Auth | Custom access-token hook and hardening enabled; real password, bound-session, TOTP/AAL2, invitation redemption/replay-denial, and cross-tenant denial paths passed |
| Open development limitation | No deployed public same-origin web host, production SMTP/Turnstile delivery, provider scanner, approved AI-worker egress, push receipts, signed native builds, or physical-device matrix; database network restrictions await stable developer/CI egress |
| Rollback and retained artifacts | Guarded test-data cleanup passed; deployment rollback was not run; hosted and coverage artifacts remain ignored and lack immutable-revision/reviewer attachment |

For the next deployment, complete every field below rather than copying the preliminary entry.

```text
Date/time and timezone:
Actor/runner:
Immutable source revision:
Environment and project reference:
Database migration versions:
Edge Function names/versions/digests:
Web deployment ID/origin:
Native build IDs:
Configuration and secret-name inventory (never secret values):
Synthetic smoke users/data set:
Commands and results:
Advisors/findings:
Rollback result:
Artifacts and reviewer:
```

See [ACCEPTANCE_TESTS.md](ACCEPTANCE_TESTS.md) for the complete verification contract and [DELIVERY_AND_ACCEPTANCE_CHECKLIST.md](DELIVERY_AND_ACCEPTANCE_CHECKLIST.md) for the human delivery record.
