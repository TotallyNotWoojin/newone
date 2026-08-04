# Newone acceptance and release test plan

This is the executable verification contract for the independent Expo/Supabase product. Passing a smaller unit suite never implies that an unrun device, provider, security, or owner-controlled gate passed.

## 1. Fast local checks

```bash
npm ci --prefix apps/newone
npm test
npm audit --omit=dev --prefix apps/newone
npm run ai:policy:check
```

These must cover Expo lint, TypeScript, static web export, production dependency vulnerabilities, tracked-secret invariants, and the exact OpenRouter ZDR route policy.

## 2. Database and authorization

```bash
supabase start
supabase db reset --local
supabase test db --local supabase/tests
supabase db lint --local --schema public,private --level warning --fail-on warning
```

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

## 4. Auth lifecycle

Run against isolated local and remote development users:

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

Without a key or approval, messaging succeeds and every AI command fails/queues safely without egress. With the dedicated test key and synthetic fixture only:

```bash
source .env.openrouter.local
npm run ai:eval
```

Coverage includes exact model/provider/ZDR routing, structured schema, server-side source-language detection, source/target language, IDs, numbers, units, negation, urgency, ambiguity, code-switching, prompt injection, malformed output, timeout, 429/5xx, circuit breaker, budget exhaustion, retry idempotency, source authorization, provenance, and kill switch.

Conversation/shift summary coverage includes manual and configured automatic enqueue, requester and worker-time authorization, immutable ordered source IDs/fingerprint, exact source window, primary topic/key topics/decisions/action items/ambiguities, per-claim source links, unsupported-claim rejection, strict JSON/schema validation, deduplication, correction/approval provenance, source edit/delete invalidation, retention, and the rule that approval cannot assign work or issue a handoff.

A qualified Korean-Spanish review remains mandatory. Blind reviewers score semantic accuracy, terminology, register, harmful reversal, ambiguity signaling, number/unit/ID preservation, latency, failure rate, and cost. Zero automated invariant failures and zero critical human-reviewed reversals are required for a release candidate.

## 9. Product, web, native, and accessibility

Automated browser tests cover enrollment/sign-in, Chats, People, Updates, Work, You, admin role gates, direct/group creation, sending/retry, search, connection/block/report, acknowledgement, handoff, settings, and session revocation at phone/tablet/desktop widths.

Manual and automated accessibility checks cover:

- keyboard-only navigation, visible focus, logical order, escape/back behavior, and no traps;
- screen-reader labels, names/roles/states, headings, status/live announcements, and error association;
- 44x44 touch targets, dynamic text/zoom/reflow, contrast, color-independent meaning, reduced motion, and RTL-safe layout primitives;
- complete English/Korean/Spanish product catalogs with no clipped or untranslated critical controls;
- current iOS and Android devices/emulators, slow network, offline, background/foreground, deep link, notification open, camera/photo/document permissions, and lost-session recovery.

## 10. Security, reliability, and operations

- SAST, dependency, secret, artifact/source-map, and client-bundle credential scans pass.
- Independent web/API/mobile security review has no unresolved Critical/High issue.
- Load/abuse tests cover shared NAT, login/OTP floods, DM/group spam, reconnect storms, large groups, shift changes, search, upload, notification fan-out, job backlog, and AI cost ceilings.
- Metrics/alerts contain no forbidden content and are triggered in staging for auth abuse, cross-tenant denial, privilege/export/hold, malware, AI drift, queue age, backup failure, and logging loss.
- Database recovery and separate Storage-object restore meet the recorded RPO/RTO; retention/deletion/hold results are verified after restore.
- Incident, revocation, provider kill-switch, status communication, and rollback runbooks complete a tabletop exercise.

## 11. Release evidence rule

Every result records date, environment, commit, runner/device/browser, relevant policy version, artifact/report link, owner, and reviewer. `Not run`, `blocked`, `requires credentials`, and `requires owner approval` are valid truthful states. They are never converted into `pass` because adjacent tests succeeded.
