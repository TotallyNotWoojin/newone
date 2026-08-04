# Newone platform architecture V2

Status: target architecture for implementation
Last updated: July 27, 2026
Companion requirements: [Full product requirements](FULL_PRODUCT_REQUIREMENTS.md)

## 1. Architecture decision

Newone V2 is a universal Expo application backed by Supabase and a Newone-controlled backend-for-frontend (BFF). It ships as native iOS and Android applications and a responsive web/PWA client. Supabase supplies company identity primitives, Postgres, member-authorized data access, private Realtime, and private object storage. The BFF owns command validation, abuse controls, privileged workflows, session-sensitive actions, and all AI-provider egress.

The current Vinext/Cloudflare D1 single-channel website is a **legacy prototype**. Newone V2 does not use its ChatGPT identity headers, ChatGPT Sites ingress, one-room schema, or UI. Git history can preserve the prototype for reference, but production traffic and live employee data must not straddle the old and new authorization systems.

The replacement is ChatGPT-independent:

- Newone accounts are Supabase Auth identities tied to organization memberships.
- The web application is hosted on a Newone/company domain, not a `chatgpt.site` domain.
- Native applications are signed and distributed through Newone/company Apple and Google accounts.
- OpenRouter is an optional server-side processor. No OpenRouter or ChatGPT account is exposed to employees.
- OpenRouter credentials, routing policy, prompts, and results stay behind Newone's BFF/worker boundary.

## 2. Goals and constraints

### Goals

- Fast, WhatsApp-familiar DMs and groups with correct multi-device synchronization.
- Strong organization and conversation isolation enforced in the database, not merely hidden in the UI.
- Native-quality iOS/Android behavior and a capable responsive web client from one product codebase.
- Original messaging remains available when translation or any AI provider is disabled or unhealthy.
- Explicit delivery, read, acknowledgement, handoff, and audit semantics.
- Immediate membership suspension and session revocation.
- Low-bandwidth operation, offline outbox, cursor reconciliation, and predictable failure states.
- Independent scale paths for messaging, files, search, notifications, and AI processing.
- Sufficient governance for employee communications without routine administrator access to private message bodies.

### Constraints

- Korean-Spanish server translation prevents a truthful end-to-end-encryption claim in the first architecture.
- OpenRouter's standard terms and data processing terms require company privacy/security/legal approval before live employment data is sent.
- Native store distribution requires external Apple/Google accounts, agreements, review, signing, and privacy disclosures.
- The employee pilot's 15-minute database RPO requires a paid production project with PITR or an approved equivalent continuous-backup service, plus a separate object-storage backup path.
- Supabase Auth, Data API, Realtime, Storage, and Edge behavior change over time; each release must check current changelog and documentation.
- New Supabase tables may not be exposed to the Data API automatically. Access requires explicit grants in addition to RLS.
- Realtime events are an acceleration mechanism; Postgres is the source of truth.

## 3. System context

```text
                    Newone-controlled clients
        +----------------+----------------+----------------+
        | iOS native     | Android native | Responsive web |
        | Expo Router    | Expo Router    | Expo Router/PWA|
        +--------+-------+--------+-------+--------+-------+
                 |                |                 |
                 +-------- HTTPS / WSS ------------+
                                  |
                      +-----------+-----------+
                      | Edge ingress / WAF    |
                      | TLS, bot protection,  |
                      | coarse IP limits      |
                      +------+----------+-----+
                             |          |
                 commands    |          | auth, reads,
                             |          | private realtime
                    +--------v----+  +--v-----------------------+
                    | Newone BFF  |  | Supabase                 |
                    | validation  |  | Auth                     |
                    | rate limits |  | Postgres + RLS           |
                    | policy      |  | Realtime Broadcast       |
                    | idempotency |  | private Storage          |
                    +-----+-------+  +---+----------+------------+
                          |              |          |
                          |       durable outbox    | private files
                          |              |          v
                          |       +------v------+ scanner / preview
                          |       | Async worker | service
                          |       | translation  |
                          |       | push, jobs   |
                          |       +------+-------+
                          |              |
                          +--------------v
                               OpenRouter
                       approved, pinned route only
```

The logical BFF and async worker may initially run as separate Supabase Edge Functions, backed by Postgres job/outbox tables and scheduled/queued invocation. They remain explicit application components so they can move to a dedicated Node 22 or edge runtime without changing client or database contracts. Edge Functions do not provide a generic automatic application rate limit, so rate limiting is an application requirement rather than an assumed platform feature.

## 4. Technology baseline

| Layer | Initial choice | Reason |
|---|---|---|
| Universal client | Expo Router, React Native, TypeScript | One route and domain model across iOS, Android, tablet, and web, with platform adapters where security/UX differ |
| Current implementation target | Expo SDK 57 and Node.js 22+ toolchain | Current supported baseline at the architecture date; versions remain pinned and lockfiles committed |
| Identity | Supabase Auth | OTP, password, social/enterprise providers, MFA, session primitives, and Postgres-integrated identity |
| Primary data | Supabase Postgres | Transactions, constraints, RLS, FTS, auditability, backup/restore, and a clear durable source of truth |
| Live updates | Supabase Realtime private Broadcast | Lower coupling and better scaling/security model than making every client consume raw Postgres Changes |
| Files | Supabase Storage, private buckets | Object storage integrated with Postgres/RLS; signed access and quarantine workflow |
| BFF/jobs | TypeScript Edge Functions initially | Close to Auth/Postgres, server-held secrets, deployable command surface; portable by contract |
| Abuse limiting | Edge/WAF plus a Redis-compatible distributed limiter and database quotas | Independent per-IP, session, member, organization, and operation limits across replicas |
| Push | Expo Push Service initially, with direct APNs/FCM fallback path | One cross-platform integration while preserving provider delivery receipts and migration path |
| AI translation/summaries | Provider adapter; OpenRouter candidate route | Keeps model/vendor out of product contracts and supports a direct approved provider later |
| Web hosting | Independent Newone/company domain through EAS Hosting or an approved CDN host | Static app shell and asset delivery without ChatGPT Sites dependency |
| Native delivery | EAS Build/Submit or equivalent signed CI | Repeatable iOS/Android builds with environment separation and over-the-air policy |

No package is installed from an unpinned range in release branches. Dependency and lockfile review are part of CI.

## 5. Component responsibilities

### 5.1 Expo universal client

The client owns presentation and safe local interaction, not authorization truth.

Responsibilities:

- Platform-adaptive navigation, lists, conversation timeline, composer, Updates, People, Work, settings, and admin entry points.
- Optimistic UI with stable client-generated idempotency keys.
- Native encrypted outbox and bounded cache; tenant-controlled web offline storage.
- Cursor synchronization and deduplication after reconnect.
- Private Realtime subscription with short-lived user access token.
- Native push registration, notification routing, deep links, and device settings.
- Accessible Korean/Spanish product UI and message original/translation presentation.
- Upload preparation, compression, progress, cancellation, and retry.
- Local content redaction from crash reports, screenshots used for diagnostics, and analytics.

The client never contains the Supabase secret/service-role key, OpenRouter key, push provider server credentials, scanner key, or administrative signing secret. The Supabase publishable key is expected to be public and is safe only because every accessible resource is protected by grants and RLS.

### 5.2 Newone BFF

The BFF is a narrow command and policy boundary, not a second general database API.

Responsibilities:

- Validate request schema, content type, body size, authenticated identity, active membership, authorization scope, and current session.
- Enforce distributed rate limits, organization quotas, idempotency, and abuse/risk decisions.
- Perform sensitive commands such as invitations, group/membership changes, sends, update publication, acknowledgements, handoff signoff, session revocation, upload grants, exports, and AI enqueue.
- Run multi-row operations through safe transactions/RPCs while preserving user authorization.
- Mint short-lived upload/download grants and never accept caller-controlled tenant paths.
- Create durable outbox/job rows in the same database transaction as the authoritative state change.
- Normalize errors and retry hints without leaking account, membership, policy, or record existence.
- Attach correlation IDs and emit content-free operational telemetry.

Ordinary BFF commands use the caller's short-lived Supabase access token so RLS still applies. The secret/service-role key is confined to narrowly named internal adapters that cannot be called directly by clients. Any privileged adapter re-resolves active membership and scoped role in Postgres, validates session state for high-risk operations, and emits an audit event.

### 5.3 Supabase Auth

Supabase Auth establishes the person; organization membership establishes what that person may do.

- `auth.users` is not the application profile and never directly grants workspace access.
- A user needs an active `organization_membership` for every tenant operation.
- Authorization uses server-controlled membership/role tables. User-editable `user_metadata` is never used for authorization.
- Stable authorization may be mirrored in `app_metadata` for hints, but RLS rechecks Postgres records because JWT claims can be stale until refresh.
- Administrators and privileged publishers require MFA assurance and recent authentication.
- Sensitive operations can validate the JWT `session_id` against current sessions rather than assuming an unexpired JWT is sufficient.
- User deletion is never the offboarding mechanism; membership suspension and session revocation occur first.

### 5.4 Postgres and Data API

Postgres is authoritative for identities-to-organizations, conversation membership, message order, translations, receipts, updates, acknowledgements, handoffs, retention, audit, and jobs.

Rules:

- Every tenant row carries `organization_id` and uses organization-scoped foreign keys where feasible.
- Every table in an exposed schema has RLS enabled before grants.
- `anon` receives no employee-data table privileges.
- `authenticated` receives only explicit table/column/function grants needed by client reads or user-scoped writes.
- `TO authenticated` is always combined with an ownership/membership predicate; it is not authorization by itself.
- Update policies have a Select policy, `USING`, and `WITH CHECK`.
- Views exposed to users use `security_invoker = true`; otherwise they live in an unexposed schema with revoked access.
- `SECURITY DEFINER` is exceptional. If unavoidable, the function lives in a private schema, sets a safe `search_path`, performs an explicit auth/scope check, has `EXECUTE` revoked from `PUBLIC`, and is tested as anon/member/non-member/admin.
- Constraints enforce states and organization consistency even if application validation fails.
- Cursor, membership, uniqueness, foreign-key, search, and retention indexes are part of migrations.

### 5.5 Realtime

Newone uses private Broadcast topics such as:

```text
org:{organization_id}:conversation:{conversation_id}
org:{organization_id}:member:{membership_id}
org:{organization_id}:updates:{audience_id}
```

Requirements:

- Public channel access is disabled.
- RLS on `realtime.messages` authorizes the authenticated member for the exact topic.
- Topic identifiers are opaque UUIDs; knowing one never grants subscription.
- Persisted database state is committed before a notification is broadcast.
- Events contain identifiers, type, version/cursor, and minimal display data. Clients refetch authorized rows for sensitive detail.
- Presence is optional, approximate, privacy-controlled, and never a productivity record.
- Disconnect/reconnect always performs durable cursor reconciliation.

Raw Postgres Changes may be used only for tightly scoped internal tooling. It is not the default client fan-out mechanism.

### 5.6 Private file pipeline

The file lifecycle is:

```text
client requests upload grant
  -> BFF validates conversation membership, type, size, and quota
  -> BFF creates pending attachment metadata and restricted object key
  -> client uploads to private quarantine path
  -> scanner validates type, malware, and policy
  -> safe object is promoted/marked available; unsafe object is isolated
  -> Realtime event announces state
  -> authorized clients receive short-lived view/download grant
```

Object keys are server-generated and organization/conversation scoped. Storage RLS verifies active organization and conversation membership. Replacement/upsert is avoided for immutable message attachments; where upsert is used for an allowed object class, policies include Insert, Select, and Update. Signed URLs are short-lived, not logged, and never treated as an enduring authorization grant.

### 5.7 Async worker and durable job/outbox

Side effects never determine whether the original business transaction committed.

The database transaction writes both the authoritative row and an outbox job. Workers claim jobs with bounded leases, retry only classified transient failures, and place terminal failures into an inspectable dead-letter state. Job identity and unique constraints make execution idempotent.

Worker classes:

- Realtime event publication.
- Translation and message-language processing.
- Summary/handoff drafting.
- Push and permitted SMS fallback.
- File scan/preview status reconciliation.
- Retention, deletion, and legal-hold exclusion.
- Audit export and organization export.
- Delivery/acknowledgement reminder and escalation.

No worker logs raw employee content by default. Diagnostic content capture requires a scoped support case, explicit authorization, redaction, expiry, and audit.

### 5.8 OpenRouter/provider adapter

The product calls an internal interface, not OpenRouter-specific methods:

```ts
interface LanguageProcessor {
  translate(request: TranslationRequest): Promise<TranslationResult>;
  draftHandoff(request: HandoffDraftRequest): Promise<HandoffDraftResult>;
}
```

The adapter owns model identifier, provider route, region, timeout, retry classification, strict schema validation, provenance, cost metering, and data-processing policy. This allows a later direct Vertex AI, Bedrock, or customer-approved endpoint without changing message records or UI.

The initial Qwen baseline (`qwen/qwen3-235b-a22b-2507`) and the current lower-cost challengers documented in [MODEL_EVALUATION.md](MODEL_EVALUATION.md) are evaluation candidates, not automatic production approvals. When OpenRouter is enabled, the server request policy must include the winning versioned model plus the approved exact provider/region and controls equivalent to:

```json
{
  "provider": {
    "only": ["google-vertex/us-south1"],
    "zdr": true,
    "data_collection": "deny",
    "require_parameters": true,
    "allow_fallbacks": false
  }
}
```

The adapter also disables response caching, sends no browser/search/tool plugins, keeps prompts minimal, validates structured output, and stores processor/model/provider-region provenance. Account-level logging and ZDR settings must match request controls.

`NEWONE_AI_DATA_EGRESS_APPROVED` or an equivalent production policy record remains false by default. A model key alone cannot enable live employee-data egress. If approval is withdrawn or a route fails a policy/health check, the queue pauses and original messaging continues.

## 6. Conceptual data model

The physical schema is delivered through reviewed migrations. This model defines ownership and invariants.

### 6.1 Organization and identity

| Entity | Purpose and invariant |
|---|---|
| `organizations` | Tenant root; immutable ID, status, locale, region, policy version |
| `sites` | Organization-scoped location; no cross-organization parent |
| `organization_units` | Department/team/line hierarchy with cycle prevention |
| `shifts` | Scheduled work context and notification window, not payroll truth by default |
| `profiles` | Person-level display data linked to Auth user; no authorization role in editable fields |
| `organization_memberships` | User-to-organization identity, authoritative employee ID, active/suspended state |
| `membership_assignments` | Site/unit/role/shift assignments with effective intervals and source |
| `role_bindings` | Scoped, server-controlled authorization grants |
| `invitations` | Hashed single-use token, intended membership, channel, expiry, attempts, issuer |
| `devices` / `device_sessions` | Device identity, push endpoint, session, revocation, security state |
| `connections` / `connection_requests` / `blocks` | DM policy and per-person relationship controls |

### 6.2 Conversations and messages

| Entity | Purpose and invariant |
|---|---|
| `conversations` | Direct, group DM, team, or incident type; organization and lifecycle state |
| `direct_conversation_keys` | One normalized membership pair per organization, unique under concurrency |
| `conversation_members` | Membership, role, history boundary, join/leave, notification state, last-read cursor |
| `dynamic_group_rules` | Versioned policy expression and preview/publish state |
| `messages` | Immutable original payload reference, sender, server sequence, client idempotency key, status |
| `message_versions` | Policy-governed edit/delete events; prior values protected |
| `message_relations` | Reply, forward, or source relation with authorization-safe behavior |
| `translations` | Message, target language, status, content, glossary/model policy, provenance, review |
| `reactions` | One reaction per member/message/emoji identity under configured policy |
| `delivery_receipts` / `read_cursors` | Monotonic recipient/device delivery and member read position |
| `attachments` | Private object identity, scan state, media metadata, retention and source message |
| `reports` / `moderation_cases` | Scoped evidence, reason, status, assignment, access approvals |

The message ordering key is a database-assigned, conversation-scoped monotonically increasing sequence or a globally sortable server identifier with a stable tie breaker. Client timestamps never determine canonical order.

### 6.3 Official communication and work

| Entity | Purpose and invariant |
|---|---|
| `updates` / `update_versions` | Official content, author, state, severity, schedule, correction chain |
| `audience_snapshots` / `audience_members` | Immutable publish-time target and reason for inclusion |
| `update_deliveries` | Per-recipient delivery/read state |
| `acknowledgements` | Deliberate member action bound to exact notice version |
| `handoffs` / `handoff_versions` | Shift window, outgoing/incoming roles, draft/issued/superseded states |
| `handoff_items` / `handoff_sources` | Structured status/action and authorized source evidence |
| `handoff_signatures` | Outgoing signoff or incoming acknowledgement bound to version |
| `actions` / `action_events` | Human-confirmed owner/due/status and append-only changes |
| `glossaries` / `glossary_entries` | Versioned, scoped translation terminology and review status |

### 6.4 Governance and platform

| Entity | Purpose and invariant |
|---|---|
| `organization_policies` | Versioned auth, directory, DM, history, notification, AI, storage, and retention policy |
| `retention_rules` / `legal_holds` | Record-class lifecycle and narrowly approved preservation scope |
| `audit_events` | Append-only security/admin/investigator event without routine message body |
| `idempotency_keys` | Actor, route, request digest, response/result, and expiry |
| `outbox_jobs` | Durable side effects, attempts, lease, schedule, terminal error class |
| `rate_limit_decisions` | Short-lived abuse decisions or references; raw sensitive inputs excluded |
| `processor_runs` | Translation/summary job policy, provider provenance, token/cost/status, no redundant raw prompt |

### 6.5 Tenant-isolation invariants

- Child rows reference parent organization using composite keys where practical, preventing a conversation in organization A from referencing a membership in organization B.
- A direct conversation pair is normalized and unique within one organization.
- A message sender must be an active member of its conversation at the accepted time.
- Receipt, reaction, translation, and attachment parentage cannot cross the message's organization.
- An acknowledgement binds one audience member to one immutable update version.
- An issued handoff version and its signatures are immutable; corrections supersede.
- Audit actor and target organizations are consistent or explicitly marked as platform-level.

## 7. Authorization model

Authorization is resolved from four questions:

1. Is the Auth user and session currently valid?
2. Does the user have an active membership in this organization?
3. Does the user have the required record relationship, such as conversation membership or audience membership?
4. For privileged action, does the user have the required scoped role, current MFA assurance, recent authentication, and policy permission?

### 7.1 Representative access rules

| Resource/action | Required relationship |
|---|---|
| List/open conversation | Active organization membership and active/retained `conversation_members` access |
| Read message/translation | Authorized conversation access at that message/history boundary |
| Send message | Active member, conversation writable, not blocked/policy-restricted, send quota available |
| Read attachment | Current authorized message access and attachment safe/available state |
| Start DM | Active memberships, same organization, DM/connection policy permits, no block |
| Manage group member | Group owner/admin plus organization delegation and target-role ceiling |
| Read update | Member included in publish-time audience snapshot or scoped publisher/admin report role |
| Acknowledge notice | Exact active audience member and current notice version |
| Draft/sign handoff | Assigned supervisor/work role for the site/team/shift window |
| Publish update | Scoped communications role and current MFA/re-auth policy |
| Suspend member | Scoped people/security role; cannot exceed delegation; current MFA/re-auth |
| Review report | Explicit case assignment/approval and case-scoped content access |

An administrator's ability to manage a conversation does not imply permission to read its message bodies. Membership metadata, policy administration, abuse case access, and private-content access are separate permissions.

### 7.2 Revocation

Suspension commits an authoritative membership state change and a revocation generation. New database, API/BFF, and Storage authorization rejects the membership immediately after commit, and queued offline commands are re-authorized and rejected when submitted. Realtime subscriptions are disconnected through a member control topic and must terminate within 60 seconds. Refresh sessions and push destinations are disabled server-side as part of suspension; local cache purge and device cleanup occur on the next device contact. Previously issued signed file URLs expire within their short grant lifetime and no new grant is issued.

Each tier of that revocation contract must be demonstrated independently; it must not be inferred from ordinary access-token expiry.

## 8. Authentication and session architecture

### 8.1 Enrollment

1. Administrator or HRIS creates an inactive/pre-provisioned membership.
2. BFF issues a hashed, single-use invitation bound to employee identity, organization, delivery channel, and expiry.
3. User proves control of email/phone or follows the approved employee-ID plus separately delivered code path.
4. CAPTCHA/risk controls and invitation attempt limits run before verification.
5. Auth identity is linked transactionally to the intended membership; duplicate authoritative identity is rejected.
6. User accepts current terms/privacy/acceptable-use notices and enrolls required MFA if privileged.
7. Device/session record is created and the membership becomes active.

### 8.2 Native session storage

- OAuth/OTP uses PKCE and an application-owned deep-link/universal-link callback.
- Refresh credentials live in `expo-secure-store`/Keychain/Android Keystore, never AsyncStorage.
- Access tokens remain in memory where practical and are refreshed through a serialized session adapter.
- Lock screen, biometric re-entry, root/jailbreak risk, and managed-device policy are organization-configurable; device signals inform risk but are not sole proof.

### 8.3 Web session storage

- The BFF performs the authorization-code/PKCE exchange and stores the refresh credential in a Secure, HttpOnly, SameSite cookie scoped to the Newone domain.
- The browser receives a short-lived access token in memory for authorized Data/Realtimes. Refresh occurs through a CSRF-protected BFF endpoint.
- Content Security Policy, Trusted Types where supported, dependency pinning, output encoding, and no inline third-party scripts reduce token theft risk.
- Service workers never cache tokens, authenticated HTML responses, message JSON, or signed file URLs.

### 8.4 Session policy

- Short access-token lifetime balanced against mobile reliability; never below the provider's practical minimum without tests.
- Configurable absolute lifetime, inactivity timeout, and concurrent-session policy.
- Privileged roles use shorter inactivity and recent-auth windows.
- Password/phone/email/MFA change, recovery, risk event, or offboarding can revoke all sessions.
- Auth error responses are generic and rate-limited to resist account discovery.

### 8.5 Account recovery

- Web and native recovery OTP requests are CAPTCHA-gated, never create an unknown Auth user, and return one enumeration-safe accepted response. Request and verification have independent atomic destination, network, and installation budgets.
- After OTP verification, the server binds the exact new session to the installation before inspecting membership. Completion preserves only that session and revokes every other Auth session, installation binding, device registration, and push destination.
- Lost-TOTP recovery is a privileged case workflow, not an administrator shortcut. The target requests the case for an exact currently verified TOTP factor; an independent AAL2/recent-auth recovery manager records only a keyed digest of the external human-verification reference; separate approvers authorize it; and privileged targets require two approvers.
- Auth factor deletion and Postgres cleanup use a versioned retryable saga because they cannot be one transaction. The case is locked in `executing` before the exact factor is deleted. Finalization atomically revokes all target sessions/devices/push state and appends audit/security evidence. Ambiguous provider results remain retryable and do not claim success.
- Human identity proofing and out-of-band notice delivery are external controls. The current backend records a durable `pending_external_delivery` notice, which is not a provider delivery receipt.

## 9. Key data flows

### 9.1 Start a direct conversation

```text
Client -> BFF: POST /v2/conversations/direct {targetMembershipId, idempotencyKey}
BFF: authenticate + active membership + DM policy + block + rate limit
BFF -> Postgres with caller JWT: create-or-return normalized direct pair
Postgres: unique organization/pair constraint resolves concurrency
BFF -> Client: existing or new conversation
Client: subscribe to private topic and navigate
```

No client can submit arbitrary member lists to bypass connection or organization policy.

### 9.2 Send an original text message

```text
Client creates clientMessageId and encrypted local outbox item
  -> BFF validates token/session, active membership, conversation write access,
     schema/size, block/policy state, idempotency, and send quotas
  -> Postgres transaction inserts original message and outbox jobs
  -> BFF returns durable server ID/sequence
  -> client reconciles optimistic item
  -> worker broadcasts committed identifier/version
  -> recipients fetch/render authorized original
  -> translation job proceeds independently if approved
```

A retry with the same actor/client ID and identical request returns the same result. A different digest returns a conflict. Push or translation failure never rolls back the original message.

### 9.3 Translate a message

```text
Outbox worker claims unique message/target-language/policy-version job
  -> verifies current organization AI policy and content category
  -> loads only authorized original, target language, and scoped glossary
  -> calls provider adapter with pinned route and strict response schema
  -> validates language, structure, source identity, length, and preserved tokens
  -> writes translation + provenance or classified failure
  -> broadcasts state change
  -> client displays translation with original reveal and warning/review state
```

The worker does not send unrelated conversation history by default. A summary/handoff job includes only the explicitly authorized time window and returns source IDs that are validated against the supplied set.

### 9.4 Offline send and reconnect

1. Client stores an encrypted pending command with membership/conversation ID, client ID, content, and creation order.
2. Reconnect refreshes authentication and pulls durable changes from the last cursor.
3. Each queued command is submitted in order and re-authorized against current membership/policy.
4. Success reconciles; retryable network/service failure remains queued with next attempt; policy/auth failure becomes visible terminal failure.
5. Duplicate realtime events and send responses collapse by durable ID/client ID.

### 9.5 Publish and acknowledge a critical notice

1. Publisher creates a draft and targeting rule.
2. BFF resolves a preview count and policy exclusions without publishing.
3. Recent MFA/re-auth, role scope, severity, deadline, translations/review, and override reason are validated.
4. Transaction creates immutable update version, audience snapshot/members, deliveries, audit, and outbox jobs.
5. Push/Realtime are delivery attempts; database audience state remains authoritative.
6. Recipient deliberately acknowledges the exact version through an idempotent command.
7. Reminder/escalation worker acts on overdue/unreachable states; authorized dashboard separates delivered, read, acknowledged, and overdue.

### 9.6 Issue a shift handoff

1. Outgoing supervisor selects site/team/shift/time window and starts a draft.
2. Authorized messages/tasks/files are attached manually or sent to the approved processor for a source-cited draft.
3. Server rejects any model citation outside the supplied authorized source set.
4. Supervisor edits and signs a version; transaction marks it issued and immutable.
5. Incoming supervisor acknowledges that exact version or records a discrepancy.
6. Corrections create a superseding version; no issued version is overwritten.

### 9.7 Upload an attachment

1. Client sends metadata and content hash/size to BFF.
2. BFF validates membership, quota, media policy, and creates pending attachment plus restricted upload grant.
3. Client uploads to private quarantine storage.
4. Scanner verifies actual type, malware, and policy; preview worker strips/configures metadata.
5. Available state is committed and broadcast. Unsafe/quarantined state is visible to sender and support without exposing content in logs.
6. Every view/download obtains a fresh member-authorized grant.

### 9.8 Suspend a member

1. Privileged operator re-authenticates with MFA and supplies a reason.
2. Transaction marks membership suspended, increments revocation generation, removes future dynamic access, transfers/flags owned groups, disables push devices, and writes audit/outbox rows.
3. Auth refresh sessions are revoked; current clients receive a control event and are disconnected.
4. API, Realtime, and Storage verify suspension independently; offline queued commands fail on reauthorization.
5. Historical records follow retention/ownership policy.

## 10. API shape

The public command API is versioned under `/v2`. Representative routes:

```text
POST   /v2/auth/invitations/verify
POST   /v2/auth/session/refresh
POST   /v2/auth/sessions/:id/revoke
POST   /v2/auth/recovery/otp/request
POST   /v2/auth/recovery/otp/verify
POST   /v2/auth/native/recovery/otp/request
POST   /v2/auth/native/recovery/otp/verify
POST   /v2/auth/recovery/cases
POST   /v2/auth/recovery/cases/query
POST   /v2/auth/recovery/cases/:id/verify
POST   /v2/auth/recovery/cases/:id/approve
POST   /v2/auth/recovery/cases/:id/reject
POST   /v2/auth/recovery/cases/:id/execute
POST   /v2/conversations/direct
POST   /v2/conversations/group
PATCH  /v2/conversations/:id
POST   /v2/conversations/:id/members
DELETE /v2/conversations/:id/members/:membershipId
POST   /v2/conversations/:id/messages
PATCH  /v2/messages/:id
POST   /v2/messages/:id/reactions
POST   /v2/messages/:id/report
POST   /v2/attachments/grants
POST   /v2/updates
POST   /v2/updates/:id/publish
POST   /v2/updates/:versionId/acknowledgements
POST   /v2/handoffs
POST   /v2/handoffs/:versionId/sign
POST   /v2/handoffs/:versionId/acknowledge
POST   /v2/admin/members/:id/suspend
POST   /v2/admin/exports
```

API rules:

- JSON schemas are shared with the client, but the server validates independently.
- Mutation requests carry `Idempotency-Key`; the actor, organization, route, and request digest define uniqueness.
- Cursor pagination uses opaque signed cursors, never caller-controlled offsets for message history.
- Error bodies contain stable machine codes, localized-safe messages, correlation ID, and optional retry time.
- Responses with employee data are `private, no-store`; sensitive state never appears in URL query strings.
- CORS is an allowlist of Newone web origins. Native clients are authenticated, not trusted by origin.
- Body/file sizes and decompression ratios are enforced before parsing or processing.

## 11. Search architecture

Pilot search uses Postgres full-text and exact/fuzzy supporting indexes, with a security-filtered search document keyed to organization and source record.

- Original and approved translation text are indexed separately so the UI can label why a result matched.
- Equipment IDs, quoted text, and names have exact/normalized indexes; Korean and Spanish analyzers are tested against a bilingual corpus.
- Query first constrains the user's permitted conversations/audiences, then ranks results. The result is re-authorized at open time.
- Snippets are generated only from authorized text and never include hidden adjacent content.
- Retention/deletion removes search documents in the same governed workflow.
- Search query content is sensitive telemetry and is not written to routine logs.

If measured scale exceeds Postgres search targets, an external search service can be added through a security-trimmed change stream. It must store tenant/conversation ACL generations and recheck authorization in Postgres before open; search-engine filtering alone is insufficient.

## 12. Rate limiting and abuse defense

Controls are layered:

1. **Edge/WAF:** TLS, request size, bot/risk challenge, coarse IP/network limits, known attack signatures.
2. **Auth provider:** OTP/email/SMS/recovery/MFA limits and CAPTCHA.
3. **BFF distributed limiter:** operation-specific token buckets by IP, device, session, member, target, and organization.
4. **Database constraints/quotas:** invitations, groups, memberships, message/files per policy period, AI spend, and idempotency.
5. **Behavioral response:** backoff, challenge, temporary block, target shielding, and human review for reports/anomalies.

The authoritative initial numeric limits are defined in the [security architecture](SECURITY_ARCHITECTURE_V2.md#starting-rate-limits-and-abuse-controls) and loaded from versioned policy rather than hardcoded into clients. Other documents specify behavior and link to that table instead of copying values. Security-relevant bypasses require a named role, reason, expiry, and audit. A service outage or critical incident does not justify globally removing limits.

## 13. Notification architecture

- Each active device has a revocable push registration scoped to membership and environment.
- Database state change produces a push outbox job; workers collapse routine bursts by conversation/member.
- Payloads default to an opaque event ID, organization label, and privacy-safe category. Message-body previews require both tenant and user/device permission.
- A push never grants content access; open performs normal authentication and authorization.
- Delivery provider receipt is an attempt/transport signal, not proof the person read or acknowledged.
- Off-shift, quiet-hours, mute, mention, and severity rules are resolved server-side so a stale client cannot route unauthorized urgent alerts.
- Critical SMS fallback uses a separately approved provider and minimized content, with opt-in/required-employment policy, attempt state, cost limits, and audit.

## 14. Security and privacy architecture

### 14.1 Primary threat classes

- Cross-tenant or cross-conversation object access (BOLA/IDOR).
- Stolen device, refresh token, invitation, or administrator session.
- Client-side secret exposure or forged identity/role metadata.
- Unauthorized Realtime subscription or copied Storage URL.
- Spam, request flooding, OTP abuse, group/invitation abuse, and AI cost exhaustion.
- Malicious file, polyglot file, decompression bomb, or unsafe preview.
- Prompt injection, invalid structured model output, harmful translation, or provider-policy drift.
- Insider misuse of admin, export, investigator, or retention capabilities.
- Sensitive content leakage through logs, analytics, push, crash reports, URL, cache, or screenshots.
- Supply-chain compromise in JavaScript/native dependencies or build/signing pipeline.

### 14.2 Controls

- TLS everywhere, managed encryption at rest, private buckets, short grants, and scoped credentials.
- Database RLS plus application checks plus relational constraints; denial tests for every tenant resource.
- MFA/recent-auth/session checks and dual control for highest-risk exports/holds where required.
- Least-privilege runtime identities and separate publishable, server, scanner, worker, and CI credentials.
- Secrets managed per environment with rotation and no production value in source, build artifacts, client manifests, or logs.
- CSP, output encoding, dependency pinning, lockfiles, SAST/dependency/secret scans, protected release signing, and review.
- Immutable security/admin audit with alerting on privilege, export, hold, egress, and revocation events.
- Content-free observability and short-lived, audited diagnostic capture only when necessary.
- Provider route allowlist, ZDR/data denial/cache denial, strict schemas, source validation, budget/backpressure, and kill switch.
- Formal incident response, vulnerability handling, backup/restore tests, access review, and offboarding tests.

Newone describes DMs as member-private within a company-governed service. It does not claim that servers technically cannot access content. Legal hold or designated investigation access must use a scoped, approved, audited workflow; an ordinary admin console never offers browse-all messages.

## 15. Retention, deletion, and legal hold

- Record classes include DMs, groups, incidents, updates, acknowledgements, handoffs, actions, files, audit, auth/security events, and processor provenance.
- Policies specify active retention, deletion grace, backup expiry, legal basis, user-visible behavior, and legal-hold eligibility.
- A periodic job identifies candidates; a separately controlled worker deletes content and search/file derivatives idempotently.
- Legal hold prevents destructive processing for the exact case scope but does not restore broad user visibility.
- "Delete for me," "delete for everyone," organization retention, Auth user deletion, and legal deletion are distinct operations.
- Deletion completes across primary rows, object storage, search documents, derived translation/summary, caches, and eventually backup expiry, with a verifiable report.

## 16. Observability and operations

### 16.1 Telemetry

Safe metrics include:

- Request count/latency/error by route and safe error class.
- Message commit and Realtime propagation latency.
- Reconnect gap and reconciliation volume.
- Push attempt/provider result without body text.
- Job queue age, attempts, terminal failure, and worker saturation.
- Translation latency, model/provider policy ID, token/cost, schema/quality failure, and kill-switch state without raw prompt.
- File scan time/result category and storage quota.
- Auth, MFA, CAPTCHA, invitation, revocation, and rate-limit events.
- Backup freshness, restore test result, and retention backlog.

Forbidden in routine telemetry: original messages, translations, attachments, search text, OTPs, invite tokens, credentials, signed URLs, full phone/email values, or sensitive notification bodies.

### 16.2 Service objectives and alerting

The product requirements define pilot SLOs. Alerts cover:

- Elevated original-message commit failure or latency.
- Realtime propagation/reconciliation gap.
- Auth or token refresh failure spike.
- Session revocation propagation outside target.
- Cross-tenant denial-test or authorization anomaly.
- Queue backlog, dead-letter growth, push degradation, scanner outage, or retention backlog.
- AI provider policy drift, spend threshold, schema failure, quality incident, or unapproved egress attempt.
- Backup failure or stale recovery point.

Translation latency is not included in the original-message availability SLO.

### 16.3 Required runbooks

- Account takeover, lost device, administrator compromise, and mass session revocation.
- Cross-tenant/authorization incident and emergency global access disablement.
- Message commit, Realtime, push, and offline reconciliation degradation.
- Storage/scanner outage or malicious-file incident.
- OpenRouter/model outage, policy drift, budget exhaustion, bad translation, and egress kill switch.
- Critical-notice delivery escalation and manual communication fallback.
- Backup restoration, regional outage, retention failure, and audit export.
- Key/secret rotation and app-signing compromise.

## 17. Deployment topology and environments

### 17.1 Environment separation

Development, staging, and production have separate:

- Supabase projects/databases/Auth tenants/Storage buckets/Realtime configuration.
- BFF/worker deployments, custom domains, WAF policies, distributed limit stores, secrets, and AI approval flags.
- Expo/EAS projects, bundle identifiers/application IDs, universal links, push credentials, signing, and update channels.
- OpenRouter/provider keys, cost caps, processor allowlists, audit sinks, and test data.

Production employee data is never copied into development. Staging uses synthetic or approved deidentified fixtures.

### 17.2 Domains

Illustrative independent layout:

```text
app.newone.company       web/PWA application
api.newone.company       BFF commands and web session endpoints
data.newone.company      optional custom Supabase API/Auth domain
status.newone.company    service status and support instructions
```

The exact company domain is a deployment decision. No production URL or auth trust depends on `chatgpt.site` or ChatGPT headers.

### 17.3 CI/CD gates

1. Formatting, typecheck, lint, unit, schema contract, and dependency/secret/license scans.
2. Ephemeral/local Supabase migration apply and rollback/forward-recovery test.
3. RLS and Storage policy denial matrix for anon, same-tenant member/non-member, cross-tenant member, scoped admin, and suspended user.
4. BFF integration, idempotency, rate limit, malformed body, and authorization tests.
5. Realtime reconnect/duplication/order and offline outbox tests.
6. iOS/Android/web builds, accessibility automation, and core device/browser smoke tests.
7. Database/security/performance advisors and migration review.
8. Staging canary, synthetic message/acknowledgement/handoff, restore freshness, and safe observability verification.
9. Human approval for database migration, auth/policy change, AI egress, push entitlement, and store release as applicable.

Production migrations are forward-safe and expand/contract where clients may run mixed versions. Destructive cleanup waits until compatibility telemetry confirms old versions are outside support.

## 18. Verification strategy

### 18.1 Authorization matrix

Every resource is tested as:

- unauthenticated/anon;
- authenticated without organization membership;
- same-organization non-member;
- authorized conversation/audience member;
- cross-organization member;
- scoped group/site/organization administrator;
- suspended user with an otherwise unexpired access token;
- revoked session;
- privileged service adapter.

Tests cover Select, Insert, Update, Delete, RPC, Realtime subscribe/send, Storage upload/read/replace/delete, search, export, and signed-grant creation.

### 18.2 Reliability and concurrency

- Concurrent DM creation produces one conversation.
- Duplicate message/update/acknowledgement/handoff commands produce one business result.
- Messages converge under duplicated, delayed, dropped, and out-of-order Realtime events.
- Membership removal races with send/upload/subscribe and fails closed after revocation commit.
- Job leases recover after worker termination without duplicate provider charge or notification.
- Cursor pagination remains stable during active writes.
- Restore reconciles message sequence, acknowledgement, handoff signatures, audit, and files.

### 18.3 Translation safety

- Bilingual golden set includes numbers, units, negation, urgency, names, equipment IDs, mixed language, abbreviations, slang, register, and safety terms.
- Quality gates are measured separately for Korean-to-Spanish and Spanish-to-Korean.
- Strict-output, wrong-source, wrong-language, prompt-injection, policy refusal, timeout, 429, and malformed-result tests.
- Every AI claim in a handoff/summary must cite a supplied authorized source.
- Human reviewers define stop-ship severity and processor rollback criteria.

### 18.4 Platform/device matrix

- Current and agreed prior iOS/Android versions on low-, medium-, and high-capability devices.
- Supported Safari, Chrome, Edge, and installed PWA behavior.
- Narrow phone, large text, tablet split view, desktop resizes, offline/reconnect, background/foreground, push/deep link, and low bandwidth. Shared-device tests enter this matrix only after the pilot, before that mode is enabled.
- VoiceOver, TalkBack, keyboard-only, reduced motion, high contrast, and 200% text size core journeys.

## 19. Rollout plan

### Phase 0 — Foundation and decisions

- Approve product requirements, identity source, workspace hierarchy, roles, DM policy, retention baseline, device policy, and support ownership.
- Create isolated Supabase/Expo/BFF environments and Newone domains.
- Establish threat model, RLS conventions, audit events, release pipeline, a paid production PITR or equivalent continuous-backup path meeting the 15-minute RPO, a separate object-storage backup, recovery tests, and synthetic fixtures.
- Keep AI egress disabled.

Exit evidence: architecture/security review, environment isolation proof, migration/RLS test harness, restore result, and clean synthetic build.

### Phase 1 — Internal synthetic alpha

- Implement Auth/enrollment, directory, contacts, DMs, groups, timeline, original-first send, offline outbox, Realtime reconciliation, private files, search, notifications, settings, device/session controls, and admin basics.
- Validate on native iOS/Android and responsive web with synthetic identities only.
- Exercise abuse limits, suspension, lost device, attachment isolation, and outage paths.

Exit evidence: core cross-platform acceptance journeys, authorization matrix, no critical security/accessibility defects, and SLO instrumentation.

### Phase 2 — Translation and operational alpha

- Add provider adapter, translation states, glossary/correction/review, Updates, critical acknowledgement, policy-controlled SMS fallback for unreachable recipients, handoffs, and actions.
- Evaluate Qwen and approved alternatives on a deidentified bilingual golden set.
- Complete processor DPA/security/privacy/labor review and record route/region/subprocessors/cost limits.

Exit evidence: company approval, quality threshold, kill switch, provenance verification, and successful provider-disabled degraded-mode test.

### Phase 3 — Controlled employee pilot

- Pilot with a small cross-section of Korean/Spanish workers, supervisors, shifts, sites, device types, and technical comfort levels.
- Use real data only after release gates pass; start with low-consequence operational groups.
- Prohibit shared kiosks, pooled tablets, and shift phones during the employee pilot.
- Provide in-language onboarding, staffed support, rapid revocation, daily defect review, and a clearly communicated fallback channel.
- Do not claim replacement of emergency systems or high-impact translation review.

Exit evidence: acceptance journeys, adoption/quality/reliability measures, no open critical security/safety issue, tested backup/restore, and employee feedback disposition.

### Phase 4 — Broad rollout readiness

- Add SSO/SCIM/HRIS, conditionally enable shared-device/MDM only after its security tests pass, and add advanced retention/legal hold/export, DLP, analytics privacy thresholds, regional strategy, formal on-call, and contracted SLAs as required.
- Run load, abuse, disaster-recovery, penetration, privacy, accessibility, and bilingual safety testing.

Exit evidence: production readiness review and signed owner acceptance for security, privacy, legal/labor, operations, language quality, support, and cost.

### Phase 5 — Expansion

- Introduce voice notes, push-to-talk, calling, forms, scheduling, and enterprise integrations through separate architecture/security reviews.

## 20. Legacy migration and retirement

1. Freeze the legacy single-channel prototype as non-authoritative and clearly label any remaining preview.
2. Do not copy fictional/demo content into production.
3. If any legitimate records exist, inventory and classify them, obtain owner approval, map identities/conversations, and import through a one-time audited tool into isolated staging first.
4. Run Newone V2 in parallel only for an explicitly bounded pilot window; never allow identity or authorization fallback between systems.
5. After acceptance, disable legacy writes, export approved records, revoke legacy secrets, remove ChatGPT identity trust and production routing, and retain/delete data according to policy.
6. Verify that old origins, signed URLs, API keys, worker routes, and sessions no longer provide access.

External deployment deletion is a deliberate owner-approved operation. Source history can remain as an engineering record without remaining a live service.

## 21. Architectural non-goals

- Reusing the legacy one-channel D1 schema as the V2 conversation model.
- Treating ChatGPT identity headers, ChatGPT Pro, or OpenRouter credits as employee identity or authorization.
- Building the primary client as an embedded website or WebView-only native shell.
- Admin-readable-by-default private messages.
- End-to-end encryption claims while server processing remains enabled.
- A model call in the synchronous transaction that commits an original message.
- Raw Postgres Changes as an unrestricted global event bus.
- Public Storage buckets or long-lived attachment URLs.
- Client-held service keys, model keys, provider routing, or authorization roles.
- Automatic AI employment, disciplinary, safety, payroll, medical, or legal decisions.
- Public social/status/channel discovery, customer marketing automation, payroll, or ERP as part of the core messenger.

## 22. Architecture decisions and tradeoffs

| Decision | Benefit | Cost / consequence |
|---|---|---|
| Universal Expo app | Shared product behavior and faster parity across native/web | Requires platform-specific auth, storage, navigation, performance, and accessibility adapters |
| Supabase Postgres + RLS | Transactional source of truth and row-level tenant/member enforcement | RLS must be designed/tested rigorously; service-role use becomes a high-risk boundary |
| BFF for commands | Central validation, idempotency, rate limiting, audit, and provider isolation | Additional service and latency; contracts must avoid duplicating general Data API behavior |
| Private Broadcast + cursor sync | Fast updates without trusting ephemeral delivery | Requires durable cursor/reconciliation design and private-topic policy tests |
| Original-first async AI | Messaging survives model failure and provenance is clear | Translation may arrive later and UI must represent pending/failure honestly |
| Server-side search/translation | Cross-device search and consistent Korean-Spanish support | No truthful E2EE claim; requires processor, retention, and access governance |
| Separate Updates object | True targeting, acknowledgement, correction, and analytics semantics | More product/data complexity than posting an "important" chat message |
| Dynamic groups | Correct site/team/shift routing and lifecycle automation | Needs authoritative attributes, previews, versioning, and careful history boundaries |

## 23. Current-document verification notes

This design was checked against the July 2026 Supabase changelog and current guidance available at the architecture date. Important implementation checks include:

- [Supabase Realtime authorization](https://supabase.com/docs/guides/realtime/authorization)
- [Subscribing to database changes and Broadcast guidance](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes)
- [Supabase Auth sessions](https://supabase.com/docs/guides/auth/sessions)
- [Auth CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha)
- [Production checklist](https://supabase.com/docs/guides/deployment/going-into-prod)
- [Edge Function rate-limiting example](https://supabase.com/docs/guides/functions/examples/rate-limiting)
- [Securing the Data API](https://supabase.com/docs/guides/api/securing-your-api)
- [Expo Router introduction](https://docs.expo.dev/router/introduction/)
- [Expo and Supabase](https://docs.expo.dev/guides/using-supabase/)
- [Expo authentication](https://docs.expo.dev/guides/authentication/)

Before schema or production implementation, recheck these sources and the latest changelog. Platform defaults are not security controls unless they are explicitly configured and verified in the target environment.
