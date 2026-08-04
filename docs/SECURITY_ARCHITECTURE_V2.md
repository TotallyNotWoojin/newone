# Newone security architecture v2

Status: target architecture and release gate, not a claim that every control is implemented
Research cut-off: July 28, 2026
Applies to: independent Newone iOS, Android, and web clients; Supabase backend; optional OpenRouter processing

## Executive decision

Newone is a company-owned communications system. It must not depend on ChatGPT identity, ChatGPT Sites, caller-supplied identity headers, or any consumer messaging account. The production trust root is Newone's own company enrollment and Supabase Auth session. The replacement runs under a Newone-controlled domain and native app identifiers.

The first production architecture uses:

- TLS in transit, managed encryption at rest, strict tenant and conversation authorization, private storage, short-lived sessions, and auditable server-side processing;
- Supabase Auth, Postgres, Realtime, and Storage, with a narrow server/API layer for privileged mutations, rate limits, file processing, notifications, and AI egress;
- an Expo/React Native client for iOS and Android and a responsive web client, with platform-specific session storage and hardening;
- OpenRouter only behind an explicit organizational release gate, with an exact provider allowlist and no client-visible key.

This version is **not end-to-end encrypted**. Server-side Korean-Spanish translation, organization-wide search, summaries, malware scanning, moderation, retention, and legal export all require authorized services to process plaintext. WhatsApp defines E2EE as a design in which only the sender and recipient have the keys and not even WhatsApp can read the messages. Newone must not use that label while its servers or model providers can process message content. See [WhatsApp's official privacy explanation](https://www.whatsapp.com/privacy).

This architecture treats database RLS as the final authorization boundary, not as a substitute for API, client, monitoring, or organizational controls. Supabase's own [shared-responsibility model](https://supabase.com/docs/guides/deployment/shared-responsibility-model) and [production checklist](https://supabase.com/docs/guides/deployment/going-into-prod) make those application responsibilities explicit.

## Security objectives

The release must provide all of the following:

1. **Tenant isolation:** a user in one organization cannot discover or access another organization's people, conversations, messages, files, notifications, search results, audit events, or AI jobs.
2. **Conversation privacy:** a valid organization account still sees only conversations to which it has active membership. Ordinary organization and site administrators do not automatically receive access to private DMs.
3. **Employer-controlled lifecycle:** enrollment is invite-only; role and site assignment are server-controlled; suspension blocks new access immediately at the database/API boundary; sessions and live sockets are revoked as a separate operation.
4. **Least privilege:** public clients contain only a Supabase publishable key. Secret/service keys stay in server-side secret storage. Administrative functions have narrow scopes and require stronger authentication.
5. **Message integrity:** retries cannot duplicate a message, clients cannot forge delivery/read/acknowledgement state for another user, edits preserve history, and generated translations or summaries never overwrite the original.
6. **Safe file handling:** files remain quarantined until type, size, and malware checks pass. File access is re-authorized at download time.
7. **Controlled external processing:** AI and notification vendors receive the minimum necessary data, only after approval, with independently testable kill switches.
8. **Detectability and recovery:** security-relevant actions produce tamper-resistant audit events; alerts have owners; backups cover both database and file objects; restores are exercised.
9. **Honest user claims:** delivered, read, acknowledged, translated, and human-reviewed are distinct states. None implies comprehension. Newone never claims E2EE for a server-readable conversation.

Availability matters, but emergency communications must have an approved fallback such as phone, radio, SMS, or an onsite procedure. Push delivery and AI availability are not safety guarantees.

## Data classification

Every stored field and outbound integration must be assigned one of these classes:

| Class | Examples | Default handling |
|---|---|---|
| Public | Public support URL, published app version | May be served publicly; integrity still protected |
| Internal | Department names, non-sensitive group names, product telemetry | Authenticated organization access; no public indexing |
| Confidential | DMs, group messages, translations, directory data, read state, shift handoffs, attachments | Conversation-scoped access, encrypted transport/storage, no content logs, retention policy required |
| Restricted | Auth tokens, recovery artifacts, identity documents, HR/disciplinary/medical/union/immigration/payroll data, legal exports, service credentials | Do not place in ordinary chat or send to AI by default; step-up access, explicit policy, separate retention and audit |

Message text is Confidential even if it appears operationally mundane. Authentication credentials and secret keys are Restricted. A file or message inherits the highest classification of its contents.

## Assets and trust boundaries

### High-value assets

- account identities, organization memberships, roles, site/department/shift assignments;
- access tokens, refresh tokens, enrollment tokens, MFA factors, recovery records, and push tokens;
- original messages, edits, reactions, receipts, acknowledgements, translations, summaries, and search indexes;
- attachments, thumbnails, transcripts, and malware-scan results;
- audit events, exports, retention/legal-hold records, and incident evidence;
- Supabase secrets, OpenRouter credentials, push credentials, signing keys, OTA-update keys, and CI/CD credentials.

### Trust boundaries

```text
Untrusted device / browser
        |
        | TLS; Newone Auth JWT or same-origin web session
        v
Newone edge/API boundary --------> WAF + distributed rate limiter
        |                                  |
        | scoped user JWT                  | counters, abuse signals
        v                                  v
Supabase Auth + Postgres + Realtime + private Storage
        |             |                  |
        | queued job  | generic event    | quarantine object
        v             v                  v
AI worker         Push worker       Malware/file worker
        |             |                  |
        v             v                  v
OpenRouter       Expo/APNs/FCM       scanner/CDR service

Privileged admin console -> step-up auth -> narrow admin API -> audited mutations
```

The client, network, IDs supplied by the client, attachment metadata, Realtime topics, AI output, and third-party callbacks are untrusted. A valid JWT proves a session was issued; it does not prove authorization to a supplied organization, conversation, message, file, or admin function.

## Threat model

### Threat actors

- an unauthenticated attacker automating enrollment, recovery, scraping, spam, or denial of service;
- a valid employee attempting horizontal access to another conversation, site, or tenant;
- a manager or administrator exceeding their delegated scope;
- a former employee with an unexpired token, live WebSocket, signed URL, push token, or offline cache;
- an attacker with a stolen, shared, rooted, jailbroken, or unattended device;
- a compromised administrator, CI account, dependency, OTA signing key, service secret, or vendor account;
- a malicious file sender, model prompt, webhook, or third-party response;
- an internal operator accidentally logging, exporting, or routing sensitive content.

### Priority abuse cases and required defenses

| Threat | Impact | Required controls | Verification |
|---|---|---|---|
| Change `organization_id`, `conversation_id`, `message_id`, or storage path | Cross-tenant or cross-conversation disclosure/modification | RLS and object-level checks on every operation; non-sequential IDs only as defense in depth | Negative tests for every role and operation; OWASP calls this [BOLA](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/) |
| Call an admin endpoint as a member | Role escalation, export, offboarding, policy changes | Default-deny function authorization, AAL2, fresh-session check, narrow admin API | Member/admin/site-admin matrix; alternate HTTP methods and direct calls |
| Redeem or alter an invitation | Unauthorized account or admin role | Hashed one-time token, server-bound org/role/site, verified destination, expiry, attempt limit | Reuse, race, role-tampering, expired-token, wrong-destination tests |
| Reuse a token after suspension | Former-worker access | Active membership checked from database; revoke sessions; kill sockets; short signed URLs; purge device | Suspension test across REST, Realtime, Storage, web, and native within stated SLA |
| Join or retain a Realtime topic | Live message leakage | Private channels, `realtime.messages` RLS, short JWT, explicit disconnect/re-auth | Nonmember join denied; removal while connected; expired JWT behavior |
| Upload polyglot, executable, oversized, or infected file | Malware, stored XSS, resource exhaustion | Quarantine, allowlist, signature validation, scanner/CDR, immutable names, download isolation | EICAR, MIME mismatch, extension confusion, decompression-bomb, SVG/HTML tests |
| Steal refresh token or offline cache | Account and history compromise | native secure storage, encrypted local DB, web BFF, session/device inventory, remote revoke | device extraction review; logout/reinstall/biometric-change tests |
| Read message from lock-screen push | Confidentiality leak | no message body or attachment URL in push; user privacy controls | capture APNs/FCM/Expo payloads and locked-device screenshots |
| Inject instructions into a message sent to an LLM | Data exfiltration or unsafe output | no tools, no arbitrary retrieval, server-scoped input, output schema validation, source links, human review | prompt-injection corpus and cross-conversation retrieval tests |
| Exhaust model, SMS, email, upload, search, or Realtime resources | Cost or availability loss | layered quotas, organization budgets, backpressure, idempotency, alerting | burst and sustained load tests; shared-NAT tests |
| Read data through logs, analytics, crash reports, or backups | Silent secondary disclosure | content-free structured logs, scrubbed errors, controlled telemetry, encrypted backups, access audit | log sampling, secret scan, restore access review |
| Malicious or mistaken admin export | Mass disclosure | dedicated compliance role, AAL2, recent re-auth, reason, dual approval, encrypted expiring export | role tests, notification, audit immutability, expiry test |

OWASP's [API Security Top 10](https://owasp.org/www-project-api-security/) also requires explicit protection against resource consumption, broken function authorization, sensitive business-flow automation, misconfiguration, and unsafe consumption of third-party APIs. UUIDs do not replace authorization.

## Identity, enrollment, and account lifecycle

### No open registration

- Anonymous sign-in and open self-signup are disabled.
- An organization administrator or approved HRIS/SCIM connector creates a pending membership. The server fixes the organization, initial role, sites, departments, and invitation destination; the client cannot submit authoritative values for these fields.
- Invitation tokens contain at least 128 bits of randomness, are stored only as hashes, are one-time, expire within 24 hours, and become invalid when the destination or pending membership changes.
- Redemption requires control of the invited email or phone through a short-lived OTP or an enterprise IdP assertion. A visible employee ID or date of birth is not an authenticator.
- A Supabase custom-access-token hook rechecks canonical current membership or
  an exact live invitation before every initial token, MFA-upgraded token, and
  refresh token is issued. Direct calls to the public Auth API therefore do not
  bypass Newone lifecycle authorization. The hook is versioned in SQL, granted
  only to `supabase_auth_admin`, and must be independently enabled and tested in
  each hosted project. This control is available on Supabase Free and Pro; see
  [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks) and the
  [custom access token hook](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook).
- Enrollment, sign-in, and recovery use CAPTCHA/Turnstile after risk or abuse signals. Supabase supports these controls for signup, sign-in, and recovery; see [Auth CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha).
- Responses are enumeration-resistant. They do not reveal whether an address, employee, invitation, organization, or factor exists.
- Role assignment, admin promotion, invitation issuance, identity change, and recovery are audited.

For broad rollout, SSO/OIDC or SAML and an HRIS/SCIM lifecycle feed become the source for joiner/mover/leaver state. A temporary outage in the identity feed must fail closed for new privilege grants but must not silently re-enable a suspended membership.

### Authenticators

Preferred order:

1. enterprise SSO with phishing-resistant MFA;
2. passkey/WebAuthn when the selected provider implementation is production-stable;
3. password plus TOTP or another approved second factor;
4. verified email OTP for a bounded pilot and recovery, with stricter abuse controls.

SMS OTP is not the preferred admin factor. NIST notes that manually entered OTPs are not phishing-resistant; see [NIST SP 800-63B-4 phishing resistance](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/#phish-resist). Supabase passkeys were still Beta in the May 2026 changelog, so a passkey-only launch needs a fresh readiness review rather than relying on the Beta label.

If passwords are enabled, use a minimum of 15 characters for single-factor use, allow at least 64 characters, permit password managers and paste, compare against compromised/common-password blocklists, and do not impose composition rules or scheduled rotation without evidence of compromise. Follow [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html).

### MFA and step-up

- Organization owners, platform operators, compliance export users, and support personnel require AAL2 for every privileged session.
- A fresh authentication within five minutes is required for role changes, factor reset, bulk invite, export, legal hold, retention change, organization deletion, AI-egress enablement, and secret rotation.
- High-impact RLS/API paths verify `aal2` and confirm `session_id` still exists rather than trusting a stale role claim. Supabase documents both the AAL claim and session record in [MFA](https://supabase.com/docs/guides/auth/auth-mfa) and [user sessions](https://supabase.com/docs/guides/auth/sessions).
- Recovery must be at least as strong as enrollment. Self-service OTP recovery uses a non-creating, enumeration-safe request; independently limits request and verification by destination, network, and installation; binds the newly verified session before membership access; and revokes all other sessions, device bindings, and push destinations.
- Lost-TOTP help-desk recovery requires an expiring immutable case. A separate AAL2/recent-auth recovery manager records only a keyed digest of an approved external-verification reference, never identity documents or the raw reference. The target cannot verify or approve, the verifier cannot approve, and privileged targets require two distinct approvers.
- Exact-factor deletion at Supabase Auth and database cleanup cannot share one transaction. Newone therefore uses a target-locked, versioned, fail-closed saga: snapshot sessions and mark `executing`, delete the exact verified TOTP factor through the Auth admin API, then atomically revoke every session/device/push destination and finalize. An ambiguous provider response remains `executing` for safe retry; only a definite first-attempt factor mismatch cancels the case.
- Security questions are prohibited. Completion appends immutable security/audit evidence and a `pending_external_delivery` notice. That queue record is not proof that the user was notified; approved human verification and a delivery provider with retained receipts remain production gates.

### Session policy

Supabase sessions last indefinitely and allow unlimited devices unless configured otherwise. Session controls therefore are a launch requirement, not a default assumption. Supabase also notes that timeout and single-session changes take effect on token refresh and recommends JWT lifetimes no shorter than five minutes. See [Supabase user sessions](https://supabase.com/docs/guides/auth/sessions).

Starting policy:

| Context | Access JWT | Maximum session | Inactivity | Re-authentication |
|---|---:|---:|---:|---|
| Standard user, assigned personal device | 15 minutes | 7 days | 24 hours | on risk, credential change, or protected action |
| Standard user, unmanaged web/device | 15 minutes | 24 hours | 1 hour | at each maximum lifetime |
| Shared device | 10 minutes | 12 hours or end of shift | 15 minutes | every shift/user change |
| Admin/compliance/support | 10 minutes | 8 hours | 15 minutes | AAL2; five-minute freshness for destructive/export actions |

Do not enable a single-session limit globally: a legitimate employee may use phone and web. Maintain a Newone device/session inventory, default to five active devices for a standard user and two for privileged users, notify on new-device enrollment, and let users/admins revoke individual devices.

Native refresh tokens live only in platform-protected storage. Web refresh tokens live behind a same-origin session gateway in `Secure`, `HttpOnly`, `SameSite` cookies with CSRF protection; browser JavaScript receives only an ephemeral access token. If the web build instead persists refresh tokens in `localStorage`, production web launch is blocked pending an explicit threat review.

### Suspension and offboarding

One audited operation must:

1. set the organization membership to suspended in a transaction;
2. prevent all future RLS/API/Storage authorization through a database lookup of active membership;
3. revoke every Auth session and Newone device registration;
4. terminate or force re-authorization of active Realtime connections;
5. invalidate notification destinations and future signed-URL creation;
6. transfer owned groups/workflows and preserve existing records under retention policy;
7. enqueue a purge of local caches at the next device contact.

Deleting the identity is not the first step and does not replace suspension. An already-issued JWT can remain valid until expiration, and Realtime caches access for a connection. Sensitive operations therefore validate `session_id`, ordinary RLS checks active membership from the database, and the socket service must actively disconnect the user. The pilot acceptance target is denial of new database/API/storage access immediately after commit and termination of online sockets within 60 seconds. Offline data already present on a lost device cannot be remotely guaranteed deleted; device encryption, session expiry, MDM, and minimal cache retention reduce that residual risk.

## Authorization and database isolation

### Authorization model

Roles are scoped, not global:

- `member`: directory and conversations allowed by membership;
- `group_admin`: membership and settings for named groups only;
- `site_admin`: people and policy for assigned sites, without automatic DM access;
- `org_admin`: organization configuration and lifecycle, without automatic DM access;
- `org_owner`: bounded ownership actions;
- `compliance_exporter`: policy-approved export/legal hold only;
- `platform_operator`: infrastructure operation, with no ordinary message-content access.

Conversation membership and active organization membership are always checked. A role never grants blanket message access unless a documented compliance operation explicitly does so. Break-glass content access requires a configured legal basis, a case ID, AAL2, recent re-authentication, dual approval, time-limited scope, user/organization notice where permitted, and immutable audit.

### RLS rules

Supabase requires RLS on every table in an exposed schema. Its [RLS guide](https://supabase.com/docs/guides/database/postgres/row-level-security) also warns that views bypass RLS by default, user metadata is user-editable, JWT claims can be stale, and service keys bypass RLS.

Newone requirements:

- Enable RLS on every `public` table, every application-accessible view, `storage.objects`, and applicable `realtime.messages` operations. Use RLS in private schemas as defense in depth.
- Grant Data API privileges explicitly and minimally. A 2026 Supabase change means new tables are no longer automatically exposed; explicit grants and RLS are separate controls. See the [Data API exposure changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) and [Securing your API](https://supabase.com/docs/guides/api/securing-your-api).
- Give `anon` no application-table privileges. Disable anonymous accounts. A Supabase publishable key is safe in the client only because every accessible row and operation is constrained by grants plus RLS.
- Start every user policy with `TO authenticated` and an actual authorization predicate. `TO authenticated` alone is authentication, not tenant or object authorization.
- Check `(select auth.uid())` against an active membership row and the requested resource. Do not authorize from an organization ID, user ID, sender ID, role, or storage path supplied by the client.
- Store dynamic authorization in normalized membership tables. Never use `raw_user_meta_data` or `user_metadata`. `app_metadata` may carry non-authoritative hints but cannot be the only check because it remains stale until JWT refresh.
- Every `UPDATE` has a corresponding `SELECT` policy plus `USING` and `WITH CHECK`. Clients cannot change ownership, organization, author, conversation, role, or immutable audit fields.
- Views exposed to clients use `security_invoker = true`. Materialized views and search indexes need equivalent tenant/conversation filters and separate policies.
- Prefer `SECURITY INVOKER` functions. A genuinely necessary `SECURITY DEFINER` function lives in a non-exposed schema, fixes its `search_path`, checks `auth.uid()` and authorization itself, has `EXECUTE` revoked from `PUBLIC`, and is granted only to the intended role.
- A secret/service key is never bundled in web/native code, logs, analytics, build artifacts, OTA updates, or public CI output. Server code using it must reconstruct the caller and reapply authorization rather than treating possession of the key as user authority.
- Index every column used by RLS joins, particularly `(organization_id, user_id, status)`, `(conversation_id, user_id, status)`, and attachment/message foreign keys. Security that times out under load is not reliable security.

### Required negative-test matrix

Every data object is tested as:

- unauthenticated;
- authenticated but uninvited;
- active member of another organization;
- active same-organization nonmember of the conversation;
- suspended same-organization member;
- conversation member;
- group admin for another group;
- site admin for another site;
- organization admin attempting a DM read;
- compliance user without and with an approved case;
- expired or revoked session.

Run `SELECT`, `INSERT`, `UPDATE`, and `DELETE` tests, including forged immutable fields and bulk operations. Repeat equivalent tests for REST, RPC, Realtime, Storage, search, exports, and every Edge Function. Run Supabase Security Advisor and the RLS tester before each release.

## API and server-side boundaries

Direct client-to-Supabase access is limited to simple, RLS-scoped reads and low-risk writes. The following go through a Newone API/Edge Function:

- enrollment, recovery coordination, session/device management, and offboarding;
- group creation and membership changes;
- message creation when idempotency, attachment state, mention fan-out, or quotas are involved;
- critical notices, acknowledgements, exports, legal holds, and retention changes;
- signed upload/download issuance and malware state transitions;
- translation, summary, notification, search-index, and background jobs;
- all operations that require a secret key, elevated database role, vendor credential, or cross-row transaction.

Every endpoint must:

1. accept only HTTPS and an allowlisted origin where browser CORS applies;
2. verify the JWT signature, issuer, audience, expiration, and subject using the current key set;
3. fetch active membership and object authorization; sensitive actions also validate `session_id` and AAL;
4. validate a bounded request schema, reject unknown privileged fields, and normalize Unicode/length before storage;
5. enforce per-action rate and cost limits;
6. use an idempotency key for retryable mutations and bind it to actor, operation, and request-body hash;
7. perform the database mutation before emitting Realtime/push/AI work;
8. return a stable error code and request ID without stack traces, SQL, tokens, or cross-tenant existence clues;
9. write a structured audit event when the action changes security, membership, retention, export, or external processing state.

Do not accept arbitrary callback URLs, model names, provider slugs, bucket names, table names, SQL fragments, or Realtime topics from public clients. Outbound HTTP destinations are allowlisted to prevent SSRF. Third-party JSON and AI output pass the same schema and length checks as hostile user input.

The web session gateway adds CSRF tokens and exact-origin checks to state-changing cookie-authenticated requests. Web responses carrying organization data use `Cache-Control: private, no-store`; the service worker must not cache API bodies, authenticated HTML, message attachments, or session responses. Apply HSTS, a restrictive CSP, `frame-ancestors 'none'`, MIME sniffing protection, a narrow Permissions Policy, and no wildcard CORS.

## Realtime security and delivery semantics

Supabase can authorize Broadcast and Presence through RLS on `realtime.messages`. Production channels must be private and public access must be disabled. Supabase states that policy results are cached for the connection and refresh when a new JWT is sent; see [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization).

Requirements:

- Use opaque topics such as `org:<uuid>:conversation:<uuid>`. Never place names, emails, phone numbers, employee IDs, message text, or secrets in topics.
- Create each channel with `private: true`; disable Realtime public access at the project level.
- Authorize both active organization membership and active conversation membership in `realtime.messages` policies. Distinguish `broadcast` from `presence` in the policy.
- Persist a message transactionally before publishing an event. Broadcast is a wake-up/low-latency signal, not the durable record. On reconnect, clients backfill from Postgres with a cursor.
- Ordinary clients do not broadcast authoritative message, receipt, acknowledgement, membership, or admin events. Database triggers or a trusted server emit those after commit. Clients may send bounded typing/presence signals only if a policy and rate limit allow them.
- Presence contains only an opaque user/device identifier and coarse availability. No current document, GPS, phone, or message text.
- Refresh the Realtime JWT before expiry. Membership changes and suspension trigger explicit channel teardown; do not wait only for the cached authorization to expire.
- Cap sockets and channel joins per device/user, add jittered reconnect backoff, and test shared-site NAT behavior before applying IP caps.
- Prevent unread-count or notification fan-out from revealing a hidden conversation through error timing, badges, or topic names.

The maximum ordering guarantee is the database's committed order, not client clock time or push arrival. Use server timestamps and a deterministic cursor. Sent, persisted, delivered-to-client, read, and acknowledged are separate state transitions. A push receipt is not message delivery, and a read event is not acknowledgement.

## Attachment and media boundary

Supabase Storage denies uploads until RLS policies permit them, and upsert requires `INSERT`, `SELECT`, and `UPDATE`; see [Storage access control](https://supabase.com/docs/guides/storage/security/access-control). Newone should avoid upsert for conversation files and treat objects as immutable.

### Upload flow

1. An authorized conversation member requests an upload slot with declared name, size, type, and message draft ID.
2. The API checks membership, quota, file allowlist, and message state, creates an `upload_pending` row, and returns a short-lived single-object signed upload for a private quarantine bucket.
3. The client uploads under a server-generated random object key. The original filename is metadata only and is sanitized for display.
4. A worker verifies actual byte length, magic signature, extension/type consistency, archive expansion limits, and image/document parsability; scans for malware; and performs content disarm/reconstruction where supported.
5. Clean content is copied or promoted to an immutable private object, with hash, scan engine/version, result, and derived thumbnails recorded. Quarantine has no client `SELECT` policy.
6. Only then may a message reference the attachment. Failed, timed-out, or suspicious files remain unavailable and are deleted under the quarantine policy.
7. Download goes through a membership check and a signed URL no longer than 60 seconds. The URL is not logged or placed in push, AI prompts, analytics, or long-lived client state.

Starting limits are 25 MB per object and 250 MB per user per hour. Images, safe audio formats, and PDF are the initial allowlist. HTML, SVG, scripts, executables, disk images, macros, password-protected archives, and nested archives are denied until a reviewed use case exists. Preserve neither GPS EXIF nor unnecessary document metadata by default. Follow the [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).

Serve downloads with safe `Content-Disposition`, a validated MIME type, `X-Content-Type-Options: nosniff`, and an attachment/isolated origin for active document types. Previewers run sandboxed and do not inherit the application's authenticated origin.

## Push notification boundary

Expo Push Service relays payloads to FCM and APNs, and Expo notes that a successful push receipt means the platform service accepted it, not that the device received it. See [Expo push delivery](https://docs.expo.dev/push-notifications/sending-notifications/). Push is therefore an external, best-effort hint.

Requirements:

- Default payload: generic title/body such as “New activity in Newone” plus opaque event and conversation IDs. No message text, translation, attachment name/URL, employee ID, safety detail, or auth token.
- The app authenticates and fetches current content after the user opens the notification. Access can be denied if membership changed.
- Each push token is bound to a Newone user, device record, platform, app environment, and last-seen time. Encrypt tokens at rest, never use them as identity, and remove them after `DeviceNotRegistered` or revocation.
- Enable Expo Push access-token protection if Expo Push Service is used. For higher-assurance deployments, send directly to APNs/FCM to remove Expo from the processor chain; that does not remove Apple/Google from it.
- Staging and production credentials, bundle IDs, projects, and tokens are isolated.
- Quiet hours and shift policy apply before enqueueing. An urgent override is a privileged, rate-limited, audited workflow.
- Web push is a separate design and consent surface; Expo Notifications does not provide web notifications. Do not silently substitute browser marketing infrastructure for operational messages.
- Critical notices show server-side non-receipt and non-acknowledgement. They use approved fallback channels and never assume push completion.

## OpenRouter and model-processing boundary

### Default state

`NEWONE_AI_DATA_EGRESS_APPROVED` is false by default. No API key, model selection, or UI toggle alone may enable employee-data egress. The organization, legal/privacy owner, exact use case, allowed conversation classes, model, provider endpoint, region, and effective dates must be recorded in a server-side policy.

OpenRouter explains that requests pass through OpenRouter and a model provider, stores request metadata, and can route by endpoint data policy. Review current [data collection](https://openrouter.ai/docs/guides/privacy/data-collection), [ZDR](https://openrouter.ai/docs/guides/features/zdr), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [DPA](https://openrouter.ai/data-processing-agreement), and [terms](https://openrouter.ai/terms) before every production approval. Endpoint policies can change, so release and scheduled checks must query the current [ZDR endpoint list](https://openrouter.ai/api/v1/endpoints/zdr).

### Required request controls

- Calls originate only from the AI worker. The OpenRouter key never reaches a web/native bundle, Supabase public environment, message log, error tracker, or OTA update.
- Use an immutable application allowlist for model ID and exact provider endpoint/region. A client cannot choose model or provider.
- Enforce `zdr: true`, `data_collection: "deny"`, `allow_fallbacks: false`, and `require_parameters: true`; disable OpenRouter response caching separately. Account/guardrail privacy settings must also enforce ZDR and leave prompt/output logging and data-discount opt-ins off.
- Fail closed when the exact allowed endpoint is unavailable or no longer reports the approved policy. Do not silently fall back to another provider, region, or model.
- Send only the minimum source messages needed for one translation or approved summary. Do not include the whole directory, unrelated thread history, push tokens, hidden system fields, or raw attachments.
- Block Restricted categories and organization-configured patterns before egress. Redaction can reduce exposure but is not proof that a prompt is anonymous.
- The model receives no tools, database credentials, URLs to fetch, plugins, web search, or ability to select more context. Text inside a message is data, never an instruction that expands access.
- Validate structured output, length, language, source IDs, and provenance. A cited source must be in the server-authorized input set. Reject the whole generated artifact on an unauthorized citation or malformed schema.
- Original text remains canonical and immutable. Translations and summaries store model/version, approved endpoint, policy version, timestamps, source links, status, and human correction without overwriting source evidence.
- Enforce per-user, per-organization, per-thread, and budget quotas. A cost spike trips a circuit breaker without blocking original message delivery.
- Raw prompts and responses are not written to application logs. Quality review uses explicit, access-controlled samples under a documented retention policy.

Safety, disciplinary, medical, legal, payroll, immigration, union, identity-document, credential, and emergency content requires a separate approved processor path or qualified human. AI is never the sole authority for an employment decision, safety instruction, or emergency response. Treat every model response as untrusted and potentially wrong.

## End-to-end encryption trade-off

### What Newone can claim in this version

- encrypted in transit between clients and services;
- encrypted at rest through managed platform/storage controls;
- access-controlled by organization and conversation membership;
- external AI processing disabled by default and policy-gated when enabled.

It cannot claim that “only participants can read messages” because authorized Newone services must process plaintext for translation, search, summaries, malware scanning, governance, and recovery. A provider's ZDR promise reduces retention; it does not turn server-side processing into E2EE.

### Future sealed-conversation mode

A later conversation class may use audited, independently reviewed E2EE with per-device keys. That mode must visibly disable or redesign:

- server-side translation, summaries, semantic/full-text search, and content moderation;
- server malware inspection of encrypted attachments;
- server-readable push previews;
- server-side legal export, retention inspection, and account-recovery access;
- effortless multi-device history and administrator recovery.

On-device Korean-Spanish translation could restore translation without server plaintext, but it needs a supported model, device-performance testing, glossary behavior, battery/storage analysis, and an independent quality evaluation. Key backup, device linking, member removal, group rekeying, reporting, and metadata leakage would each require a separate cryptographic design and external review. “Encrypted database” or “client-side AES” is not sufficient to claim E2EE.

## Expo, native, and web client security

OWASP MASVS treats secure storage, authentication, network communication, platform interaction, code, resilience, and privacy as separate mobile controls; use the [OWASP MASVS](https://mas.owasp.org/MASVS/) verification checklist for both native platforms.

### Native token and cache storage

- Store refresh tokens and local-database keys in `expo-secure-store`, backed by Android Keystore and iOS Keychain. Do not put tokens or message content in AsyncStorage, plaintext SQLite, Redux persistence, crash breadcrumbs, clipboard history, URL parameters, or logs.
- SecureStore is not a database or backup. Expo documents that iOS Keychain values may survive reinstall, Android values do not, Android backup must exclude SecureStore, and biometric changes can invalidate protected values; see [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/). Detect a new app-instance identifier and clear/rebind an orphaned session after reinstall.
- Encrypted offline workspace caching is release-disabled by default and requires an explicit build-time opt-in. When enabled, it is employee/contractor-only: guests are never cached or hydrated, expired memberships fail closed, and a contractor cache expires no later than the canonical membership `access_expires_at`. Guests are online-only for sends, receipts, and update acknowledgements; their message bodies, reply previews, cursors, and queued commands are never written to the durable user store. Contractor queued commands are purged at access expiry. Bound cache age and size by conversation policy. On logout, definitive revocation response, suspension contact, ineligible online bootstrap, or user switch, delete message/attachment caches, drafts, search indexes, thumbnails, notification state, and queued commands.
- Offline encryption protects data at rest; it is not remote revocation. A persisted employee envelope is bounded to 24 hours and cannot be hydrated after expiry, but content already decrypted into a running app can remain visible while that device stays disconnected until the app process ends or revalidates. Newone also cannot remotely wipe ciphertext from a disconnected unmanaged device. Treat this already-offline employee window as an explicit risk acceptance. Keep offline caching disabled for deployments requiring immediate cutoff, or require managed-device controls and remote wipe before enabling it.
- Shared kiosks, pooled tablets, and shift phones are prohibited during the employee pilot. Any later shared-device rollout uses a dedicated mode with short idle timeout, no cross-user cache, no notification preview, and a visible “end shift/sign out” action. MDM is required for high-sensitivity shared deployments.
- Blur the app-switcher snapshot and use Android secure-window controls on Restricted screens. Detect iOS screen capture and warn/blank where practical. These controls reduce accidental disclosure but cannot guarantee that another camera or compromised OS cannot copy the screen.
- Disable clipboard actions for credentials and Restricted records; clear any app-written sensitive clipboard value promptly.

### Authentication and deep links

- Use authorization code + PKCE, `state`, and `nonce` where applicable. Accept callbacks only from exact universal/app links and redirect paths owned by Newone.
- Do not trust a custom URL scheme alone when an associated/universal link is available. Validate host, path, state, pending transaction, and one-time code before establishing a session.
- Magic links are single-use and can be consumed by enterprise email scanners. Prefer an intermediate Newone-controlled page with an explicit user action or use OTP, consistent with the [Supabase production checklist](https://supabase.com/docs/guides/deployment/going-into-prod#email-link-validity).
- Expo Go is not a production security environment. Test authentication, deep links, secure storage, push, biometrics, screenshots, and native configuration in signed development/preview builds and final store builds. See [Expo authentication guidance](https://docs.expo.dev/develop/authentication/).

### Build, update, and dependency integrity

- Production and staging use separate Supabase projects, app IDs, deep-link domains, push credentials, update channels, and secrets.
- Lock dependency versions and commit lockfiles. Generate an SBOM, run dependency/license/secret scans, and review native config plugins because JavaScript bundles and mobile binaries are inspectable.
- Put no secret in `EXPO_PUBLIC_*`, the JavaScript bundle, source maps, `app.json`, `google-services.json` beyond intended public configuration, or client-readable web environment variables.
- Sign native releases through controlled Apple/Google accounts with hardware-backed MFA and least-privilege CI service accounts.
- Sign EAS OTA updates, pin runtime versions, separate channels, require review, preserve rollback, and protect the offline private signing key. Expo documents its [EAS Update code-signing mechanism](https://docs.expo.dev/eas-update/code-signing/).
- Upload source maps privately to the approved error service and prevent public distribution. Error telemetry strips message text, tokens, email/phone, file names, and URL query strings.
- Do not add certificate pinning casually; a broken rotation can take every app offline. If a managed deployment requires it, use backup pins, expiry monitoring, and a tested emergency update path.

### Web-specific controls

- Use the same-origin session gateway described above so the browser does not persist a refresh token in script-readable storage.
- Render messages as text. Do not render user/AI HTML. Sanitize any future rich-text AST with a maintained allowlist and test stored XSS in original, translated, quoted, search-highlighted, and notification text.
- Use a strict CSP with nonces/hashes, no unsafe inline script, Trusted Types where supported, SRI for any unavoidable third-party static asset, and no third-party advertising/behavioral analytics on authenticated pages.
- The PWA/service worker uses a network-only policy for authenticated APIs and a versioned allowlist for public static assets. Logout clears Cache Storage, IndexedDB, local/session storage, in-memory state, and active Realtime connections.

## Cryptography, network, and secrets

- Require TLS 1.2 or newer everywhere; enforce HSTS on the web domain and SSL for database connections. Restrict direct database networks and use pooled least-privilege connections. Supabase lists SSL enforcement, network restrictions, RLS, and MFA in its [production checklist](https://supabase.com/docs/guides/deployment/going-into-prod).
- Use platform-managed encryption at rest plus application envelope encryption for especially sensitive exports or fields where the threat model requires it. Keep data-encryption keys separate from encrypted data and rotate key-encryption keys under a documented procedure.
- Store server secrets only in the deployment/Supabase secret manager. Separate secrets by environment and purpose. Prefer independent OpenRouter, push, SMTP, scanning, and monitoring credentials so one leak can be revoked narrowly.
- Rotate secrets on staff departure, suspected exposure, provider incident, and scheduled policy. Record owner, creation, last rotation, allowed services, and emergency revocation steps without logging the value.
- Production database console and vendor dashboards require individual accounts, MFA, least privilege, and quarterly access review. Shared administrator credentials are prohibited.
- Egress is allowlisted. Server functions cannot call arbitrary user-provided URLs. DNS and redirect behavior are validated for any approved fetcher.

## Starting rate limits and abuse controls

This section is the authoritative source for Newone's numeric launch limits. Other product and architecture documents link here rather than duplicating values. These are conservative starting values, not vendor defaults or permanent capacity claims. They must be load-tested and tuned from observed worker behavior through versioned server policy. Apply atomic distributed counters at the edge/API layer. Supabase's Auth limits are configurable, while its Edge Function example uses Redis for application limiting; see [production Auth limits](https://supabase.com/docs/guides/deployment/going-into-prod#auth-rate-limits) and [Edge Function rate limiting](https://supabase.com/docs/guides/functions/examples/rate-limiting).

Use several keys together: IP/subnet, destination/account, invitation, user, device, organization, conversation, and action. Do not use IP as the only key because many frontline workers may share a site NAT. Return `429` with `Retry-After`; clients use jittered backoff. Avoid permanent account lockout that an attacker can weaponize.

| Operation | Starting limit | Additional control |
|---|---:|---|
| Start/inspect enrollment | 5 per IP per 15 min; 3 per invitation per 15 min | CAPTCHA after risk; uniform response |
| Send sign-in/enrollment OTP | 3 per destination per hour; 10 per IP per hour; at least 60 sec apart | destination and org budget; custom SMTP/SMS alerting |
| Verify OTP/invitation | 10 per invitation/account per 15 min; 30 per IP per hour | progressive delay after five failures; revoke after repeated abuse |
| Password reset start, if passwords are enabled | 3 per account per hour; 10 per IP per hour | uniform response; notify account; no security questions |
| Recovery OTP request | 3 per destination per hour; 10 per IP per hour; 5 per installation per hour | independent atomic buckets; uniform response; `shouldCreateUser=false`; CAPTCHA |
| Recovery OTP verification | 10 per destination per 15 min; 30 per IP per 15 min; 15 per installation per 15 min | independent from request budget; progressive client backoff; generic failure |
| General authenticated API | 300 requests per user per minute; 3,000 per org per minute | route-specific limit still applies |
| Create message | burst 10 per 10 sec; 60 per minute; 1,000 per user per hour | idempotency; 32 KB text maximum; conversation flood limit |
| Reactions/read receipts | 120 per user per minute | batch/coalesce receipts; actor may write only own state |
| Create DM/group | 10 new DMs per user per hour; 5 groups per user per day | block/report and recipient-abuse signals |
| Directory/search | 60 queries per user per minute | cursor pagination; result cap; no cross-tenant counts |
| Start file upload | 10 per user per minute; 250 MB per hour; 2 GB per day | 25 MB object cap; scanner queue backpressure |
| Translation | 30 jobs per user per minute; 200,000 source characters per user per day | deduplicate by source/language/model; org spend ceiling |
| Summary/handoff draft | 5 per conversation per hour; 20 per manager per day | source fingerprint; one active job per conversation |
| Issue invitations | 20 per admin per hour; 100 per org per day | AAL2; bulk import is reviewed async job |
| Critical notice | 5 per admin per hour; 20 per org per day | AAL2, target preview, audit; urgent override 3 per org per hour |
| Export | 1 active export per org; 3 per org per day | AAL2, recent auth, dual approval, encrypted expiring result |
| Realtime | 5 sockets per device; 10 per user; 50 joins per user per minute | IP cap is soft/alert-only at shared sites; reconnect backoff |
| Presence/typing | 30 updates per user per minute per conversation | coalesce; no durable write for each keystroke |

Also enforce monthly vendor budgets and hard circuit breakers for OpenRouter, email/SMS, push, storage, egress bandwidth, and scanning. Rate-limit failed and successful sensitive actions; otherwise a stolen valid account can bypass protections intended only for unauthenticated abuse.

## Logging, monitoring, and privacy

Use structured security events following the principles in the [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).

### Log these events

- enrollment created/redeemed/revoked; sign-in success/failure; MFA and recovery changes;
- new device, token reuse detection, sign-out, session/device revocation, suspension/offboarding;
- organization/site/group membership and role changes;
- group ownership transfer, block/report/moderation action;
- critical notice creation/targeting/acknowledgement escalation;
- export, legal hold, retention change, break-glass access, and organization deletion request;
- RLS/API authorization denial anomalies, rate-limit trips, enumeration signals, and WAF actions;
- malware/quarantine outcomes and blocked file types;
- AI policy decisions, endpoint/model/policy identifiers, character/token/cost counts, and failures, but not raw prompt/response;
- secret/config/deployment/OTA change, backup/restore, and incident-response actions.

Each event contains an event ID, UTC server timestamp, actor and effective role, organization, session/device, action, object type and opaque ID, result/reason code, request/trace ID, policy version, source network information under the approved privacy policy, and service version. Sanitize CR/LF and bounded fields to prevent log injection.

### Never log

- access/refresh tokens, session cookies, OTPs, invitation secrets, MFA seeds, passwords, service keys, signed URLs, or authorization headers;
- raw message/translation/summary text, attachment bytes, complete filenames, identity documents, or unrestricted search queries;
- full vendor prompts/responses in application, proxy, crash, analytics, or APM logs.

Security logs are append-only to the application role, exported to a separate restricted account/store, time-synchronized, integrity-protected, and monitored for deletion or ingestion failure. Organization administrators see only tenant-scoped administrative audit data; platform operators do not gain content access through the logging system.

Starting retention: 180 days searchable for authentication and security telemetry, one year for immutable administrative/security audit, and 30 days for ordinary performance logs. Exact IP/user-agent retention and longer legal requirements need privacy/legal approval. Alert on cross-tenant denials, admin promotion, recovery/factor reset, mass membership change, export, break-glass access, service-key use, unusual file or model volume, repeated malware, AI policy drift, logging gaps, and backup failure.

## Message retention, deletion, and legal hold

Retention is explicit per conversation class and organization. It is not an accidental forever default.

- Original messages, edits, translations, summaries, search documents, attachments, thumbnails, receipts, and derived tasks share a deletion graph. Derived AI data cannot outlive its source unless a documented record policy requires it.
- A deleted message becomes unavailable to ordinary users immediately; physical deletion follows the configured grace period unless a legal hold applies. The UI distinguishes user redaction from policy retention.
- Legal hold is a separate immutable record with scope, authority, case, approvers, start/end, and audit. It overrides ordinary deletion only for matching records.
- Account deactivation does not erase company records. Identity display is preserved or pseudonymized according to policy without reassigning authorship.
- Search, caches, exports, notification queues, scanner copies, AI job payloads, and storage objects must receive the same deletion event. A database row deletion alone is incomplete.
- Employees receive a clear notice explaining company ownership, DM privacy boundaries, administrators' capabilities, monitoring, retention, AI processing, and lawful access. A company DM is not presented as a personal WhatsApp conversation.
- Pilot default: 90-day message/attachment retention and no legal hold unless Company counsel approves a different schedule. Production schedules by operational, safety, HR, and direct-message class require written records/privacy/labor review before rollout.

Backups expire on their own documented schedule. A deletion is removed from active systems promptly and ages out of backups; restoring an older backup must replay deletion/hold changes before reopening user access.

## Backups and disaster recovery

Supabase provides daily database backups on paid plans and optional PITR, but explicitly states that database backups contain only Storage metadata, not Storage objects. See [Supabase Database Backups](https://supabase.com/docs/guides/platform/backups). Newone therefore needs two coordinated backup systems.

Requirements:

- Before any live employee pilot data, use a paid production Supabase project with PITR or an approved equivalent continuous database-backup path. Daily backups alone do not meet the pilot's 15-minute RPO.
- Replicate/export private Storage objects and their hashes to a separate encrypted, versioned, access-controlled backup location. Preserve attachment-to-message consistency and quarantine/clean status.
- Keep infrastructure configuration, migrations, RLS policies, function source, notification templates, and secret inventory recoverable without copying live secrets into source control.
- Encrypt backups, restrict restore/download to dedicated operators with MFA, audit every access, and prevent production backups from entering developer laptops or lower environments.
- Define and contractually validate vendor-region and retention behavior for database, object, log, and AI metadata backups.
- Pilot target: database RPO at most 15 minutes and service RTO at most 4 hours, with a separately verified object-backup design supporting the same business recovery requirement. Broad rollout may tighten these objectives after risk, load, regional, and contractual review; it may not silently weaken the pilot baseline.
- Perform a full staging restore before pilot, quarterly thereafter, and after material backup changes. Test database + files + Auth/config + Realtime recovery, attachment hash verification, deletion/legal-hold replay, and credential rotation.
- Maintain a read-only degraded mode and an approved non-Newone emergency communication path. Do not send messages that appear successful while the durable database is unavailable.

## Incident response

Use a named incident commander, security lead, engineering lead, communications/legal/privacy contacts, vendor contacts, and alternates. NIST SP 800-61 Rev. 3 integrates preparation, detection, response, and recovery with CSF 2.0; see [NIST Incident Response](https://csrc.nist.gov/projects/incident-response).

### Severity examples

- **SEV-0:** confirmed or credible cross-tenant access, mass message/file disclosure, service-key/OTA-signing compromise, destructive database event, or active provider leakage.
- **SEV-1:** privileged account takeover, former employee retaining access, malicious file delivered to users, material AI routing-policy failure, or widespread auth bypass.
- **SEV-2:** contained single-account compromise, blocked malware, limited metadata exposure, or sustained abuse without confirmed data access.

### Response sequence

1. **Declare and contain:** assign severity/commander; preserve event IDs and clocks; activate narrow kill switches for invites, AI egress, file upload/download, exports, push, Realtime, or an organization; revoke affected sessions and credentials.
2. **Scope:** determine tenants, identities, conversations, files, vendors, time range, and data classes; verify whether it was possible and whether evidence shows it occurred.
3. **Preserve evidence:** snapshot relevant audit/config/version records with provenance and restricted access. Do not broadly duplicate message content unless necessary and authorized.
4. **Eradicate:** patch the policy/code/configuration, rotate secrets and signing keys as needed, remove malicious artifacts, and invalidate caches/signed URLs/tokens.
5. **Recover:** restore from verified data, run tenant-isolation and integrity tests, monitor heightened signals, and reopen features in stages.
6. **Communicate:** follow contractual, legal, regulatory, labor, customer, and individual notice requirements; coordinate with Supabase/OpenRouter/Expo/Apple/Google or other processors as applicable.
7. **Learn:** complete root cause and corrective actions, add regression tests, update threat model/runbooks, and track every action to closure.

Maintain exercised runbooks for lost/stolen device, account takeover, compromised admin, bad offboarding, cross-tenant/RLS exposure, malicious attachment, credential leak, OTA supply-chain event, harmful translation, OpenRouter policy drift/provider incident, push credential leak, database corruption, and object-loss restore. Run a tabletop before pilot and twice yearly.

## Secure development and operations

- All schema changes are migrations reviewed with their RLS/grants. A table, view, function, bucket, Realtime topic, or index is not complete until its negative authorization tests exist.
- CI runs type/lint/unit/integration tests, RLS tests, secret scan, dependency audit, SBOM generation, SAST, migration lint, and build verification for web/iOS/Android. Release artifacts are reproducible enough to map to a reviewed commit.
- Staging uses synthetic data. Production data is not copied to preview branches, local Docker, screenshots, model-evaluation tools, or developer machines.
- Branch protection requires review for auth, RLS, cryptography, retention, logging, file parsing, AI routing, and CI/CD changes. Production changes use least-privilege deploy identities and an audited rollback plan.
- Run DAST/API authorization testing and OWASP MASVS checks. Commission an independent penetration test before broad rollout and after material identity/tenant/encryption redesign.
- Review Supabase's current changelog and product security guidance before upgrades. Current reference: [Supabase security configuration](https://supabase.com/docs/guides/security/product-security).
- Monitor dependency and platform security advisories; define patch SLAs by severity. Keep Node, Expo SDK, Supabase clients/CLI, native dependencies, and lockfiles supported and pinned.
- Separate platform support from company administration. Support tooling uses impersonation only if explicitly designed with approval, visible banners, time limits, and audit; hidden permanent impersonation is prohibited.

## Launch gates

No gate may be waived merely because the UI works. Each gate needs stored evidence, an owner, date, environment, and reviewer.

### Gate A: architecture and independence

- [ ] Production domain, mobile bundle IDs, auth, hosting, analytics, and support are Newone-controlled and have no ChatGPT identity/header/Sites dependency.
- [ ] Data-flow diagram, processor inventory, data classification, threat model, and this document are reviewed by engineering and Company security/privacy owners.
- [ ] Production, staging, and development accounts/projects/keys/data are isolated.
- [ ] Ordinary managers/admins cannot read private DMs by role alone; compliance access behavior is documented and tested.

### Gate B: identity and lifecycle

- [ ] Open/anonymous signup is disabled; invite redemption is bound, hashed, expiring, one-time, verified, and rate-limited.
- [ ] Email/phone confirmation, custom trusted-domain SMTP, CAPTCHA/risk controls, enumeration resistance, and recovery notifications are verified.
- [ ] MFA/AAL2 and five-minute step-up protect every privileged/export/destructive action.
- [ ] Session lifetimes, inactivity, device inventory, secure token storage, logout, password/factor change, and refresh-token reuse behavior are tested.
- [ ] Offboarding blocks new REST/RPC/Storage authorization immediately and active Realtime within 60 seconds; refresh sessions and push destinations are disabled server-side during suspension, while native/web cache and device cleanup occurs on next online contact. Evidence records the bounded residual risk for an employee device that was already offline and therefore cannot receive a remote purge.

### Gate C: tenant, conversation, and API authorization

- [ ] RLS is enabled on every exposed table and applicable Storage/Realtime path; `anon` has no application data grants.
- [ ] All views are `security_invoker` or unexposed; all privileged functions have reviewed owner, grants, `search_path`, and explicit authorization.
- [ ] The complete negative-role matrix passes for REST, RPC, Edge Functions, Realtime, Storage, search, exports, and bulk operations.
- [ ] Supabase Security Advisor/RLS tester has no unresolved security finding; query plans and indexes meet load targets.
- [ ] Service/secret keys are absent from clients, git history, logs, artifacts, source maps, and OTA bundles.
- [ ] API schemas, idempotency, CSRF/CORS/CSP, error redaction, SSRF allowlists, and layered rate limits pass automated tests.

### Gate D: Realtime, offline, files, and push

- [ ] Every Realtime channel is private; public access is disabled; nonmember join and live-removal tests pass; reconnect backfill proves no loss/duplication.
- [ ] Offline queues preserve original messages without cross-user leakage; release builds default workspace caching off; guests cannot persist or hydrate snapshots, cursors, message/reply-preview commands, receipts, or acknowledgements; contractor snapshots and queues cannot outlive membership expiry; and user-scoped data purges on logout, user switch, definitive revocation, lifecycle deadline, or the next ineligible online bootstrap.
- [ ] Quarantine/scan/promotion is enforced. EICAR, MIME mismatch, polyglot, archive bomb, oversize, active-content preview, and signed-URL-expiry tests pass.
- [ ] Push payload captures contain no confidential content; token revocation/receipt handling and locked-screen behavior pass on current iOS/Android versions.
- [ ] Policy-controlled SMS fallback for unreachable critical-notice recipients has minimized content, an approved consent/employment basis, delivery and failure handling, rate/cost limits, and audit evidence.
- [ ] Shared kiosks, pooled tablets, and shift phones are prohibited during the employee pilot. If shared-device mode is enabled later, it clears all user data and passes idle/shift sign-out, notification-isolation, cache-removal, and MDM tests first.

### Gate E: AI and translation

- [ ] AI egress remains technically off without the separate approval flag and an active server policy.
- [ ] Company approval, DPA/terms/privacy review, employee notice, exact model/provider/region, ZDR endpoint, no-fallback policy, and prohibited categories are recorded.
- [ ] Account and request settings enforce ZDR/data-collection denial; caching and prompt/output logging are off; a scheduled policy-drift check fails closed.
- [ ] Keys remain server-only; context selection cannot cross conversation membership; no tools/web fetch/arbitrary model selection exists.
- [ ] Korean-Spanish evaluation covers numbers, units, negation, urgency, equipment IDs, safety terminology, dialect/register, source preservation, failure, correction, and human review.
- [ ] Prompt-injection, malformed-output, unauthorized-citation, model timeout, provider 429/5xx, budget exhaustion, and circuit-breaker tests pass without losing the original message.
- [ ] Product/privacy copy correctly states that cloud-processed conversations are not E2EE.

### Gate F: operations and recovery

- [ ] Security/audit logs contain required metadata and no sampled tokens, signed URLs, message text, attachment content, or raw model prompts/responses.
- [ ] Alerts route to an on-call owner and were triggered in staging for cross-tenant denial, admin change, export, malware, AI-policy drift, logging loss, and backup failure.
- [ ] Database PITR/daily backup and separate Storage-object backup are configured; a full restore meets documented RPO/RTO and verifies hashes/deletions/holds.
- [ ] Incident runbooks, vendor contacts, kill switches, status communications, and one tabletop exercise are complete.
- [ ] Retention/deletion/legal-hold rules, employee notices, DPA/subprocessor review, and labor/privacy/legal approval are signed off.
- [ ] Current load tests cover shared NAT, reconnect storms, large groups, shift changes, notification fan-out, search, file scanning, and model cost ceilings.
- [ ] Independent web/API/mobile security review has no unresolved Critical or High issue; accepted Medium risks have owners and deadlines.

## Residual risks and decisions still requiring Company approval

1. Whether ordinary DMs are retained, exportable, or subject to legal hold, and how that is disclosed to employees.
2. Whether a compliance/break-glass content-access capability exists at all and which jurisdictions or organizations may enable it.
3. Whether OpenRouter may process employment communications; the exact contractual terms, region, provider, and prohibited content.
4. Whether the pilot permits BYOD or only individually assigned managed devices. Shared devices are prohibited during the pilot; a later rollout requires the conditional controls above.
5. Whether broad rollout tightens the pilot's 15-minute RPO and four-hour RTO, plus the storage-object backup vendor and disaster-recovery budget.
6. Whether Expo Push Service is acceptable as an additional processor or production push goes directly to APNs/FCM.
7. Final retention by message/notice/handoff/attachment/audit class and any legal hold/eDiscovery obligations.
8. Whether a future sealed E2EE conversation class is worth losing centralized translation, search, governance, and recovery.

Until these decisions are approved, choose the safer default: no AI egress, generic push, no hidden DM access, short pilot retention, no Restricted content in chat, managed invite-only accounts, and no claim of E2EE or regulatory compliance.

## Primary official references

- Supabase: [Production checklist](https://supabase.com/docs/guides/deployment/going-into-prod), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Securing the Data API](https://supabase.com/docs/guides/api/securing-your-api), [Auth sessions](https://supabase.com/docs/guides/auth/sessions), [MFA](https://supabase.com/docs/guides/auth/auth-mfa), [CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha), [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization), [Storage access control](https://supabase.com/docs/guides/storage/security/access-control), [Edge Function rate limiting](https://supabase.com/docs/guides/functions/examples/rate-limiting), and [Database backups](https://supabase.com/docs/guides/platform/backups).
- Expo: [Authentication](https://docs.expo.dev/develop/authentication/), [SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/), [Push delivery](https://docs.expo.dev/push-notifications/sending-notifications/), [Push service choices](https://docs.expo.dev/guides/using-push-notifications-services/), and [EAS Update code signing](https://docs.expo.dev/eas-update/code-signing/).
- OpenRouter: [Data collection](https://openrouter.ai/docs/guides/privacy/data-collection), [Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr), [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [DPA](https://openrouter.ai/data-processing-agreement), and [Terms](https://openrouter.ai/terms).
- Standards: [NIST SP 800-63B-4](https://csrc.nist.gov/pubs/sp/800/63/b/4/final), [NIST incident response](https://csrc.nist.gov/projects/incident-response), [OWASP API Security](https://owasp.org/www-project-api-security/), [OWASP MASVS](https://mas.owasp.org/MASVS/), [OWASP file uploads](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html), and [OWASP logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).
