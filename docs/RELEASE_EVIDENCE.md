# Newone release evidence

Status: working implementation and development-environment evidence ledger; no immutable release candidate, production deployment, or production acceptance is claimed

This file records only observed results. Every final entry must identify the immutable revision, environment, runner, date/time zone, command or procedure, result, and retained artifact. Preliminary results are useful during implementation but must be rerun from the exact release candidate. A linked Free Supabase development deployment exists; it is not staging or production evidence.

## Candidate identity

| Field | Current value |
|---|---|
| Evidence date | August 4, 2026, America/Denver |
| Implementation commits | `d85cdac` built the independent workplace messenger; `0ebbf3f` removed the duplicate shift-assignment index; `799c611` hardened hosted Edge transport, CORS, and maintenance integration; `b67cfbe` reconciled development-deployment evidence; the commit containing this record closes the remaining conditional browser-fixture gaps |
| Local verification target | The exact commit containing this evidence record; capture its hash with the final verification output. This is a local implementation checkpoint, not a production release revision |
| Immutable release revision | Not assigned |
| Local runner | macOS arm64 |
| Required Node baseline | 22.13.0, pinned in engines, `.nvmrc`, `.node-version`, and CI |
| Current local Node/npm | System default Node 22.11.0 / npm 11.6.2; exact Node 22.13.0 was selected for the recorded exact-baseline checks |
| Deno | 2.9.1 |
| Supabase CLI | 2.109.0 with telemetry disabled for sandbox-safe local execution |
| AI policy | `2026-08-04.2`; employee-data egress disabled |
| Linked Supabase project | Healthy Free development project with 34 local/remote migrations in parity, four active base Edge Functions, hosted Auth hardening, and Postgres SSL enforcement |
| Database network restrictions | Open pending stable developer and CI egress addresses; this remains a production security gate |
| Production environment | Not provisioned or claimed |

## Current preliminary automated and development results

These results were observed during implementation on August 4, 2026. They establish a strong implementation checkpoint, not a release. A clean `npm run verify:full` chain passed on exact commit `b67cfbe`; the commit containing this record adds skip-free handoff-acknowledgement and private-report fixtures and is the next exact local verification target. Retained release artifacts, the approved device/browser matrix, and owner-controlled production systems remain unavailable.

| Check | Observed result | Final disposition |
|---|---|---|
| Exact Node baseline availability | The selected temporary runtime reported `v22.13.0`; the shell default remained Node 22.11.0 / npm 11.6.2 | Select the exact runtime explicitly for every final Node/npm command |
| `node --test tests/*.test.mjs` | 245/245 Node contract tests passed, including the added production-shaped private-report fixture contract | Rerun from a clean checkout of the immutable candidate on Node 22.13.0 |
| `npm run backend:functions:check` and `npm run backend:functions:test` | Edge modules type-checked and 194/194 Deno tests passed | Rerun on the immutable candidate |
| Clean local reset, database contracts, and pgTAP | Clean reset succeeded through `20260804173600_remove_duplicate_shift_assignment_index.sql`; 976/976 assertions passed; strict database lint reported zero findings | Rerun the complete database chain on the immutable candidate and retain logs |
| `npm run edge-db:contract:check` | The Edge/database contract verified 156 called RPC names against 551 SQL function definitions | This is name/shape drift coverage, not proof that every SQL function is called or behaviorally accepted; rerun on the candidate |
| Universal-client deterministic exports | Web export plus iOS and Android Expo export/Hermes bundle checks completed successfully | These are source/bundle checks, not signed native binaries or physical-device evidence |
| iOS simulator demo runtime | Expo Go 57.0.6 bundled the app successfully on a booted iPhone 17 Pro simulator running iOS 26.5 and rendered Newone's branded secure-access screen. Only the expected `expo-notifications` Expo Go limitation warnings appeared; no runtime error was observed during this launch. | Simulator/demo runtime evidence only; it is not a signed development build, physical-device result, TestFlight build, or App Store acceptance |
| Browser/Playwright suite | 46/46 tests passed with zero skips across desktop Chromium and Pixel 7 mobile Chromium | Incoming-handoff acknowledgement and consent-gated private reporting now execute against authoritative synthetic eligibility/server-ID fixtures. This remains browser/demo evidence, not live-backend, native-device, or approved-matrix acceptance |
| Browser visual review | Desktop and Pixel 7 screenshots were reviewed | Tablet, WebKit/Firefox/Safari, native rendering, physical-device, and final accessibility evidence remain open |
| OpenRouter synthetic evaluation and adapter | Paid synthetic evaluation passed 20/20 and the production-adapter smoke passed using the server-only test credential; `employeeDataEgressEnabled` remained `false` | Rerun on the immutable candidate with synthetic content only; qualified Korean-Spanish human approval remains required |
| Remote development migrations and advisors | Local and linked development migration histories were in parity at 34; database advisors reported zero security warnings and zero performance warnings | Recheck after every migration; Free development evidence is not production evidence |
| Remote development Edge Functions and canaries | `newone-api`, `newone-read`, `newone-outbox-worker`, and `newone-maintenance-worker` were active. Live canaries observed health/authenticated readiness `200`, unauthenticated `401`, denied-origin `403`, all five withheld function slugs `404`, and allowed preflight `204` | Retain exact function versions/digests and rerun authenticated route/integration smokes from the immutable candidate |
| Remote development Auth and database transport | Hosted custom access-token hook and Auth hardening were enabled; public signup and anonymous signup were closed. Postgres SSL enforcement was enabled, and post-reboot health and database readiness returned `200` | Custom SMTP, Turnstile, recovery delivery, stable network restrictions, and production Auth review remain open |

## Historical implementation checkpoints

The rows below are preserved to show evidence progression. They are superseded observations from the earlier dirty-worktree checkpoint and must not be combined with current counts or represented as release evidence.

| Historical check | Earlier observed result | Current interpretation |
|---|---|---|
| Node contracts | 119/119 passed | Superseded by the current 245/245 implementation checkpoint |
| Edge Functions | Type-check and 135/135 Deno tests passed | Superseded by the current 194/194 implementation checkpoint |
| Database chain | Reset through `20260804155917_complete_search_filters.sql`; 413/413 pgTAP passed; lint was clean; types matched; Edge/database contract found 122 called RPCs and 370 SQL functions | Superseded by the current 34-migration, 976/976, strict-zero-lint, 156/551 checkpoint |
| SEARCH-01 focused contracts | Exact Node 22.13.0 ran 5/5 client/DTO tests; focused Edge read passed 10/10; focused search pgTAP passed 39/39; client lint/typecheck passed | Useful feature-level history only; the current full chain and browser evidence control release status |
| Universal-client exports | Web, iOS, and Android exports completed | Reconfirmed in the current checkpoint; these were never signed-build evidence |
| Repository security, environment, and documentation | Security and environment contracts passed; documentation check passed over 16 delivery files | Historical run only; rerun after final source and evidence freeze |
| Browser suite state | No pass was recorded while E2E was being repaired | Superseded first by 42 passes with 4 explicit conditional skips, then by the current skip-free 46/46 implementation checkpoint |
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
| Universal client | Expo dependency alignment, lint, TypeScript, deterministic web export, iOS export, Android export, and approved native runtime/device matrix | Preliminary web/iOS/Android source/bundle exports green; one Expo Go 57.0.6 iPhone 17 Pro/iOS 26.5 simulator demo launch rendered without runtime error; signed builds, physical devices, TestFlight/App Store, and immutable-candidate chain remain open |
| Root contracts | BFF, auth-routing, invitation, environment, documentation, web-export, AI-policy, and repository-security suites | Preliminary 245/245 Node contracts green; immutable-candidate chain open |
| Edge Functions | Deno check and full Deno test suite | Preliminary type-check and 194/194 tests green; immutable-candidate chain open |
| Database | Fresh local stack, clean migration/seed rebuild, full pgTAP authorization suite, strict database lint, generated-type drift check, and Edge/RPC contract | Preliminary 976/976 pgTAP, zero strict-lint findings, and 156-called-RPC/551-SQL-function contract green; immutable-candidate chain open |
| Browser | Supported browser/viewport journeys, axe checks, keyboard/focus, skip-free critical workflows, and visual screenshot review | Preliminary desktop Chromium and Pixel 7 mobile Chromium: 46/46 passed, zero skipped. Approved Firefox/WebKit/Safari/tablet coverage, native renderers, and final visual/accessibility acceptance remain open |
| Supply chain | Production audits, registry signatures, three SBOMs, combined license/integrity inventory | Historical artifacts exist; 14 license classifications require review and immutable-candidate regeneration is open |
| AI adapter | Paid synthetic evaluation plus one synthetic-only production-adapter smoke using a server-only test key | Preliminary 20/20 and adapter smoke green with employee egress false; candidate rerun and human bilingual approval open |
| Integrated local | Synthetic Auth users through BFF/native contracts, RLS/RPC, Realtime, Storage quarantine/scan, revocation, offline reconciliation, and AI-disabled path | Not run as one retained candidate chain |
| Remote development | Migration parity, active function versions/digests, environment/config verification, synthetic route smoke, Auth settings, and database/security/performance advisors | Preliminary 34-migration parity, four active functions, canary status contract, hardened Auth, SSL, and zero advisor warnings observed in linked Free development; candidate rerun open |
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

The linked Free Supabase project is a development environment only. The following observation documents development state without secret values or a production claim. Exact remote function versions/digests, immutable logs, rollback evidence, and a frozen source revision were not retained, so this is not a releasable deployment record.

| Field | Observed development state |
|---|---|
| Date/time zone | August 4, 2026, America/Denver; exact final-run timestamp not assigned |
| Source checkpoints | `d85cdac`, `0ebbf3f`, and `799c611`; immutable release revision not assigned |
| Environment | Linked Free Supabase development project; no staging or production mapping claimed |
| Database | 34 local/remote migrations in parity; zero security advisor warnings; zero performance advisor warnings; Postgres SSL enforcement enabled |
| Edge Functions | Four active base functions: `newone-api`, `newone-read`, `newone-outbox-worker`, `newone-maintenance-worker` |
| Live canaries | Health and authenticated readiness `200`; unauthenticated `401`; denied origin `403`; all five withheld function slugs `404`; allowed preflight `204`; post-SSL-reboot health and database readiness `200` |
| Auth | Custom access-token hook and hardening enabled; public and anonymous signup closed |
| Open development limitation | Database network restrictions await stable developer/CI egress; production SMTP, Turnstile, recovery delivery, scanner, push, and AI management controls are absent or unaccepted |
| Rollback and retained artifacts | Rollback not run; immutable deployment logs, function digests, and reviewer sign-off not yet retained |

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
