# Newone acceptance and release test plan

This is the executable verification contract for the independent Expo/Supabase product. Passing a smaller unit suite never implies that an unrun device, provider, security, or owner-controlled gate passed.

Current status is an implementation checkpoint, not a release. The implementation line includes `d85cdac`, `0ebbf3f`, `799c611`, and the development-evidence reconciliation at `b67cfbe`. The former fictional-data browser workflow suite has been retired, and its historical pass count is withdrawn as acceptance evidence. No production release revision has been assigned. The linked Supabase project is Free development only. See [RELEASE_EVIDENCE.md](RELEASE_EVIDENCE.md) for the evidence ledger and its historical, explicitly superseded rows.

## 1. Fast local checks

```bash
npm ci
npm ci --prefix apps/newone
npm test
npm run backend:functions:check
npm run backend:functions:test
npm run edge-db:contract:check
npm audit --omit=dev
npm audit --omit=dev --prefix apps/newone
npm run ai:policy:check
npm run security:scan
npm run env:check
npm run docs:check
```

Run every Node/npm command with the pinned Node 22.13.0 toolchain. These checks must cover Expo dependency alignment, lint, TypeScript, static web export, iOS and Android source/bundle exports, production dependency vulnerabilities, tracked-secret invariants, Edge/SQL RPC drift, and the exact OpenRouter ZDR route policy.

The August 5 working-tree checkpoint observed the following results. They are useful regression baselines, but each must be reproduced from one clean checkout of the immutable candidate and retained with that revision before release:

| Area | Preliminary observation | Release meaning |
|---|---|---|
| Shared runtime/API | 272/272 tests passed; all 25 production `.mjs` modules measured 99.58% lines, 97.51% branches, and 100% functions | Global working-tree gate passed; machine-readable retention and candidate rerun open |
| Universal client | 49/49 suites and 617/617 tests passed; all 83 eligible production files measured 96.05% statements, 91.31% branches, 96.90% functions, and 97.27% lines | Global working-tree gate passed; per-file threshold and release acceptance are not claimed |
| Edge | Type-check and 257/257 tests passed; all 32 production TypeScript files and nine real entrypoints measured 92.84% lines, 91.36% branches, and 98.61% functions | Global working-tree gate passed; candidate rerun open |
| Database | 37 migrations; clean reset; 29 pgTAP files and 1,000/1,000 assertions; zero strict-lint findings | Candidate rerun open |
| Edge/RPC contract | Current name-and-shape drift check passed | Drift coverage only; candidate rerun open |
| Expo exports and fixture scan | Web, iOS, and Android export checks passed; 211 client, API, Edge, configuration, migration, and seed inputs plus 29 bundled text artifacts contained none of the forbidden runtime-fixture markers | Source/bundle proof only, not signed binaries or a repository-wide semantic proof |
| Playwright static surface | 6/6 unauthenticated sign-in rendering and client-side validation checks passed across desktop Chromium and Pixel 7 mobile Chromium on the current working tree | Static UI regression only; not hosted Auth, employee workflow, or acceptance proof |
| Hosted core-backend simulation | Artifact `newone-e2e-20260805t073237z-bbb833d0` passed 18 real hosted Auth/API/database/private-Realtime steps and completed guarded cleanup | Core development evidence only; deployed-web, provider, authenticated browser, and signed-device matrices remain open |
| Measured coverage | Shared runtime/API, universal-client, and Edge global reports exceeded 90% for every metric their tools measure; complete production-file inventory checks passed for the 83 client and 32 Edge files | Reports are gitignored working-tree evidence; retain them and rerun on the immutable candidate |
| AI | Paid synthetic evaluation passed 20/20 and production-adapter smoke passed; employee-data egress remained false | Human Korean-Spanish approval and candidate rerun open |
| Linked development | 37-migration parity; six active functions; hosted core artifact passed; fresh dry-run reported six active functions and zero existing organizations/users; hosted Auth hardening and Postgres SSL enabled | Development evidence only, not staging or production acceptance |

## 2. Database and authorization

```bash
supabase start
supabase db reset --local
supabase test db --local supabase/tests
supabase db lint --local --schema public,private --level warning --fail-on warning
npm run backend:types:check
npm run edge-db:contract:check
```

At the current preliminary checkpoint, local and linked development migration histories were in parity at 37. The clean local reset ran 29 pgTAP files and passed 1,000/1,000 assertions; strict lint returned zero findings. The earlier remote-development advisor observation reported zero security warnings and zero performance warnings. PostgreSQL SSL enforcement is enabled. Database network restrictions remain open until stable developer and CI egress addresses are selected. Repeat all local and remote checks after the candidate migration plan is frozen; none of these development observations is production acceptance.

Required denial/concurrency cases include:

- anon and cross-tenant access to every exposed table, view, RPC, Storage object, and Realtime topic;
- nonmember and former-member access to conversations/messages/history/files/search;
- admin-to-owner escalation, forged join actor/role, last-owner demotion races, and delegated-scope escape;
- direct-message policy, block, request-first, duplicate-pair, and raw-write bypasses;
- server-owned delivery/read/acknowledgement/handoff timestamps;
- AAL1 versus AAL2 and active versus suspended/deactivated membership;
- invite hashing, verified identity binding, expiry, revocation, single use, concurrent redemption, and enumeration resistance;
- idempotent message/update/handoff/action commands and mismatched replay conflict;
- edit/delete scrubbing of translations/search/cache/file visibility and content-free Realtime events;
- clean-only attachment visibility, guessed paths, expired grants, and deleted parent messages;
- rate-limit/quota behavior under sequential and concurrent requests;
- service-role internal calls versus caller-identity reauthorization;
- retention and legal-hold exclusion with idempotent retries.

All exposed tables use forced RLS and explicit grants. All privileged functions require reviewed owner, grants, safe search path, explicit actor/scope checks, and negative tests.

### ADM-02 privileged audit access and export

- Query and export require an active membership, `audit.read`, AAL2, authentication no older than 15 minutes, and one approved purpose code; curiosity/free-text purpose is rejected.
- Query ranges are at most 90 days, export ranges at most 31 days, event filters are unique and bounded, page size is 1–100, export rows are at most 5,000, and decoded export content is at most 2 MB.
- Query cursors are snapshot-, filter-, actor-, and organization-bound; tampering, filter replay, actor/tenant replay, expiry, malformed input, and concurrent inserts must not leak, skip, or duplicate rows.
- Every successful query page and export creates an immutable forced-RLS private receipt. The query receipt reconstructs the normalized filter, input boundary, returned boundaries, snapshot, row count, and next-cursor digest. The export receipt records format, range, normalized filter digest, row/byte counts, payload digest, actor, session, and request.
- Authorized-tenant permission/AAL/recent-auth denials append a content-free `audit.access.denied` event. Cross-tenant, suspended, and inactive actors cannot cause an event in the target tenant. Successful query/export appends a self-audit event linked to its receipt.
- Neither query, export, receipt, API error, Realtime event, nor application log may contain message bodies, attachment names/bytes, translation text, summary text, contact details, IP addresses, user-agent strings, or arbitrary audit metadata.
- JSON and CSV exports are deterministically ordered. CSV always quotes cells, doubles quotes, and neutralizes formula prefixes hidden behind whitespace/control characters. Edge and client independently verify decoded byte count and SHA-256 before download/share.
- Direct `authenticated` table access is denied, receipt mutation is impossible, database/Edge rate limits fail closed, and audit data is absent from ambient bootstrap.
- Browser and physical iOS/Android acceptance must prove recent-verification prompts, filter/date/purpose controls, pagination, loading/error/empty states, EN/KO/ES copy, web download, native share, receipt/digest display, keyboard/screen-reader operation, and no implicit clipboard copy.

## 3. Command API and BFF

Automated unit/contract/integration coverage must exercise every `/v2` route for:

- content type, body size, malformed JSON, unknown fields, schema boundaries, and decompression limits;
- bearer/native and HttpOnly-cookie/web authentication;
- active membership, current session, MFA/recent-auth, scoped role, CORS, CSRF, and no-store behavior;
- correlation IDs and stable enumeration-safe error bodies;
- operation-specific IP/device/session/member/target/organization rate limits;
- idempotency success, conflicting replay, concurrent replay, and expired claims;
- transaction rollback and durable outbox creation;
- unavailable/missing RPC or secret failing closed;
- request/response/log captures containing no credentials or employee content.

Core commands include enrollment/invites, sessions, direct/groups/membership, messages/reactions/reports/forward/delete-for-me/pins, contacts/connections/blocks, updates/acknowledgements, summaries/review, handoffs/signoff, actions, upload/download grants, member suspension, role assignment, retention/export, and AI enqueue.

### Hosted Edge transport and development canaries

Gateway JWT verification is intentionally disabled for the versioned functions because Newone performs route-specific bearer, cookie, worker-token, session, membership, MFA, and recent-auth checks inside the handlers. Acceptance must therefore prove each route fails closed on its own; a deployed function or gateway response is not authentication evidence by itself.

The transport contract must reject ordinary insecure HTTP and spoofed forwarding headers. An internal Supabase `http:` hop may be treated as secure only when `x-forwarded-proto` is exactly `https` and the request host exactly matches the canonical host injected through `SUPABASE_URL`. CORS must allow only an exact configured web origin and the required `GET, POST, PUT, PATCH, DELETE, OPTIONS` methods. Worker functions must reject browser origins and cookie authentication.

The linked Free development project currently has six active functions: `newone-api`, `newone-auth`, `newone-bootstrap`, `newone-read`, `newone-outbox-worker`, and `newone-maintenance-worker`. The observed live canary contract was:

| Probe class | Required status |
|---|---|
| API health and correctly service-authenticated readiness | `200` |
| Missing or invalid required authentication | `401` |
| Denied browser origin | `403` |
| Readiness route when the required readiness secret is absent | `404` |
| Preflight from the exact allowed origin | `204` |

Post-SSL-reboot health and database readiness also returned `200`. The August 5 hosted core artifact additionally exercised exact deployed `newone-api`, `newone-auth`, `newone-bootstrap`, and `newone-read` versions through 18 real Auth/API/database/private-Realtime steps and guarded cleanup. A fresh dry-run then reported six active functions and zero existing organizations/users. For a release candidate, repeat the matrix against the exact deployed versions and retain redacted request/response metadata. The hosted core run does not prove provider-backed AI, attachment scanning, or push receipts; those three source workers remain withheld.

## 4. Auth lifecycle

Run against isolated local and remote development users:

The current hosted development observation is limited but positive: the custom access-token hook and session hardening are enabled, and public plus anonymous signup are closed. `newone-auth` is deployed and the hosted core artifact passed real password sessions, installation binding, AAL1 privileged denial, TOTP/AAL2, one-time invitation redemption, replay denial, and rate-limit exhaustion. A real domain and redirect set, production Turnstile site/secret and hostname proof, custom SMTP or approved Auth email delivery, synthetic recovery delivery, and final production rate-limit review remain external release gates.

1. Unknown users cannot create or join a workspace.
2. An issued invitation is bound, verified, expiring, revocable, and one-time.
3. OTP, recovery request, recovery verification, invite, and MFA attempts have independent throttles and generic responses. Recovery exhausts destination, network, and installation buckets independently and cannot create an unknown Auth account.
4. Privileged actions fail at AAL1 and after the recent-auth window.
5. Native PKCE credentials persist only through OS secure storage.
6. Web refresh credentials never enter browser JavaScript or public caches.
7. Device/session listing and self-revocation work.
8. Suspension atomically disables membership, sessions, refresh, push destinations, future group access, queued offline sends, REST/RPC/Storage, and live Realtime within the target.
9. Successful self-service recovery binds the new session before returning membership data, preserves only it, revokes every other Auth session/device/push destination, and appends immutable security/audit evidence.
10. Lost-TOTP recovery creates one expiring case under concurrent/idempotent replay; stores only a keyed digest of the external-verification reference; enforces target/verifier/approver separation; and requires two distinct approvers for owners/admins.
11. Recovery execution snapshots target sessions, deletes only the approved verified factor, rejects stale execution versions, and revokes every session/device/push destination on finalization. A definite pre-delete mismatch cancels; an ambiguous Auth response remains retryable without falsely claiming success.
12. Recovery/factor/email/password changes queue the required security notice. Production acceptance separately proves provider delivery/receipt and never treats `pending_external_delivery` as notification evidence.

## 5. Messaging, offline, and Realtime

- Korean, Spanish, and English originals commit exactly once before derived processing.
- Source language is detected server-side; forged client/profile language does not override the detector, while short/mixed/ambiguous text resolves visibly to unknown/mixed instead of a confident route.
- Offline sends survive approved native restart, preserve order, retry with backoff, and deduplicate after ambiguous responses.
- Installed-web sends survive browser restart in the approved encrypted IndexedDB outbox; the service-worker cache contains only the shell/approved assets and never credentials or message payloads.
- Logout, account switch, suspension contact, and organization change purge/decrypt-invalidate the correct local cache/outbox.
- Private Realtime rejects public/nonmember topics and live-removes an offboarded member.
- Disconnect/reconnect performs cursor backfill with no loss or duplication.
- Edit/delete/reaction/read/translation/file-state events refetch durable authorized state.
- Large-group and reconnect-storm tests meet the latency/error/connection targets.

## 6. Files and media

Test image/document capture, compression, cancellation, retry, quota, and progress on supported devices. The server suite includes EICAR, MIME mismatch, extension spoofing, polyglot/active content, oversized input, archive/decompression bomb, scanner timeout/failure, quarantine denial, clean promotion, signed-link expiry, membership removal, deletion, and Storage-object backup/restore.

No client directly chooses an organization/conversation object path. No pending/quarantined/failed/blocked object is downloadable, including by its uploader.

## 7. Push and critical communication

- Register, rotate, revoke, and invalidate Expo/APNs/FCM tokens per device/environment.
- Capture locked-screen payloads and verify confidential text is absent by default.
- Verify quiet hours, mute, mention, severity, collapse, provider receipt, retry, invalid token, and offboarding behavior.
- Publish standard/important/critical updates to synthetic audiences and verify immutable audience snapshot/version/correction semantics.
- Preview and publish company/channel plus site, department, team, arbitrary-unit, job-title/configured-role, access-role, language, and authoritative-current-shift audiences. A parent unit must include active descendant-unit members; a unit-scoped publisher must be denied outside the delegated hierarchy.
- Schedule a current-shift update, then move one person, suspend another, and add a replacement before promotion. Only the reevaluated publish-time audience may receive immutable recipient rows; the scheduler must never fall back to all channel members.
- Reject unknown, malformed, inactive, wrong-kind, empty-base, non-authoritative-shift, unauthorized-unit, zero-recipient, null-time, and infinite-time audience inputs without publishing or revealing unrelated activity.
- Keep delivered, read, and deliberate acknowledgement distinct.
- Test reminder/escalation and approved SMS fallback without treating transport receipts as comprehension.

## 8. AI and bilingual evaluation

Without a key or approval, messaging succeeds and every AI command fails/queues safely without egress. With the dedicated test key and approved synthetic evaluation dataset only:

```bash
source .env.openrouter.local
npm run ai:eval
npm run ai:adapter:smoke
```

Coverage includes exact model/provider/ZDR routing, structured schema, server-side source-language detection, source/target language, IDs, numbers, units, negation, urgency, ambiguity, code-switching, prompt injection, malformed output, timeout, 429/5xx, circuit breaker, budget exhaustion, retry idempotency, source authorization, provenance, and kill switch.

At the August 4 implementation checkpoint, the paid synthetic evaluation passed 20/20 and the production-adapter smoke passed. The route policy was `2026-08-04.2`, and employee-data egress remained disabled. This proves only the synthetic adapter path. It does not authorize employee content, establish production account controls, or replace the candidate rerun. Before employee use, a company owner must provision separate server-only completion and management credentials and verify least-privilege rotation/revocation, the exact completion-key hash and dedicated workspace identity, the global egress approval, an enabled exact organization policy, organization authorization, the pinned model/provider route, uncached ZDR/data-denial and no-BYOK/content-mutating-guardrail controls, billing caps and monitoring, the management-control-plane and synthetic-route preflights, and a tested kill switch.

Conversation/shift summary coverage includes manual and configured automatic enqueue, requester and worker-time authorization, immutable ordered source IDs/fingerprint, exact source window, primary topic/key topics/decisions/action items/ambiguities, per-claim source links, unsupported-claim rejection, strict JSON/schema validation, deduplication, correction/approval provenance, source edit/delete invalidation, retention, and the rule that approval cannot assign work or issue a handoff.

A qualified Korean-Spanish review remains mandatory. Blind reviewers score semantic accuracy, terminology, register, harmful reversal, ambiguity signaling, number/unit/ID preservation, latency, failure rate, and cost. Zero automated invariant failures and zero critical human-reviewed reversals are required for a release candidate.

## 9. Product, web, native, and accessibility

The retained Playwright checks cover only the exported, unauthenticated sign-in surface in desktop Chromium and the Pixel 7 Chromium profile. They verify visible modes and fail-closed client validation without signing in or exercising a hosted API. They are useful static UI regressions, but they do not prove Auth delivery, authorization, employee workflows, accessibility of authenticated screens, persistence, Realtime, or backend integration.

The formerly recorded 46-pass browser result depended on an in-client fictional data repository and is withdrawn as acceptance evidence. No current authenticated browser workflow pass is claimed. The real hosted core-backend artifact exercised invitation, contact, direct/group messaging, multilingual persistence, private Realtime, idempotency, rate limiting, and denial cases through actual hosted services, but it did not drive the Expo UI. Authenticated real-hosted simulations must still exercise dynamic groups, primary navigation, search, updates, handoffs, settings, attachment gating, offline entitlement, source navigation, denial cases, and accessibility across the approved browser/device matrix.

Post-cleanup coverage reports now exist for the agreed working-tree scope. Shared runtime/API measured 99.58% lines, 97.51% branches, and 100% functions; all 83 eligible client files measured 96.05% statements, 91.31% branches, 96.90% functions, and 97.27% lines; all 32 Edge TypeScript files plus nine real entrypoints measured 92.84% lines, 91.36% branches, and 98.61% functions. These are global thresholds, not a claim that every individual file exceeds 90%. The reports are gitignored and must be retained with the immutable revision and environment after the candidate rerun.

Deterministic Expo web, iOS, and Android exports passed at the August 5 working-tree checkpoint, and the production-fixture scanner found no forbidden runtime-fixture markers in 211 client, API, Edge, configuration, migration, and seed inputs plus 29 inspectable bundled text artifacts. The iOS and Android results are source/Hermes bundle evidence only. They do not replace EAS-signed binaries, install/launch checks, deep/app-link verification, notification-open behavior, store review, or tests on physical iOS and Android devices.

One additional simulator launch observation was recorded on August 4, 2026: Expo Go 57.0.6 bundled the app successfully on a booted iPhone 17 Pro simulator running iOS 26.5, rendered Newone's branded secure-access screen, emitted only the expected `expo-notifications` Expo Go limitation warnings, and showed no runtime error during that launch. This is not a signed development build, physical-device result, TestFlight build, App Store acceptance, or workflow evidence, and it does not satisfy the native workflow matrix below.

Manual and automated accessibility checks cover:

- keyboard-only navigation, visible focus, logical order, escape/back behavior, and no traps;
- screen-reader labels, names/roles/states, headings, status/live announcements, and error association;
- 44x44 touch targets, dynamic text/zoom/reflow, contrast, color-independent meaning, reduced motion, and RTL-safe layout primitives;
- complete English/Korean/Spanish product catalogs with no clipped or untranslated critical controls;
- current iOS and Android devices/emulators, slow network, offline, background/foreground, deep link, notification open, camera/photo/document permissions, and lost-session recovery.

## 10. Security, reliability, and operations

The following owner-controlled dependencies remain release gates and cannot be satisfied by the local or linked Free-development test results:

- a real company domain, Vercel project, TLS, same-origin web BFF, redirect proof, and production deployment evidence;
- production Turnstile configuration and hostname tests plus custom SMTP or an approved Auth email hook with delivery receipts;
- a separate production Supabase topology with target RPO/RTO, PITR/equivalent, independent Storage backup/restore, and stable database network restrictions;
- a production malware/content scanner, Expo/APNs/FCM push credentials and receipts, and any approved SMS fallback;
- EAS signing, signed iOS/Android builds, app/deep links, store accounts/review, and physical-device evidence;
- OpenRouter production account/key management, billing/budget limits, provider/ZDR controls, monitoring, revocation, and kill-switch proof;
- qualified Korean-Spanish human evaluation plus company security, privacy/labor/legal, retention, critical-notice, AI, incident, and operating approvals.

Zero development database advisor warnings does not replace the independent security, abuse/load, recovery, monitoring, or provider-control work below.

- SAST, dependency, secret, artifact/source-map, and client-bundle credential scans pass.
- Independent web/API/mobile security review has no unresolved Critical/High issue.
- Load/abuse tests cover shared NAT, login/OTP floods, DM/group spam, reconnect storms, large groups, shift changes, search, upload, notification fan-out, job backlog, and AI cost ceilings.
- Metrics/alerts contain no forbidden content and are triggered in staging for auth abuse, cross-tenant denial, privilege/export/hold, malware, AI drift, queue age, backup failure, and logging loss.
- Database recovery and separate Storage-object restore meet the recorded RPO/RTO; retention/deletion/hold results are verified after restore.
- Incident, revocation, provider kill-switch, status communication, and rollback runbooks complete a tabletop exercise.

## 11. Release evidence rule

Every result records date, environment, commit, runner/device/browser, relevant policy version, artifact/report link, owner, and reviewer. `Not run`, `blocked`, `requires credentials`, and `requires owner approval` are valid truthful states. They are never converted into `pass` because adjacent tests succeeded.

Development observations must also record the project/environment classification, migration parity, function names plus versions/digests, Auth configuration state, database transport/network settings, advisor results, and redacted canary metadata. The present 37-migration/six-function Free-project snapshot and hosted core artifact may be cited only as August 5 development evidence. Global working-tree coverage greater than 90% and a real hosted core-backend simulation are established, but neither is retained against an immutable release revision. A final release still requires a single clean immutable-candidate rerun, retained artifacts, deployed same-origin web and authenticated browser journeys, provider and signed-device simulations, exact web/native deployment identifiers, rollback/restore proof, and named human approvals. No production release or acceptance is claimed.
