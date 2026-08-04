# Newone full product requirements

Status: implementation baseline for the replacement product
Last updated: August 3, 2026
Research basis: [WhatsApp and frontline communications research](RESEARCH_WHATSAPP_AND_WORKPLACE.md)

## 1. Product decision

Newone is a company-owned, WhatsApp-familiar communications system for multilingual frontline teams. It combines private direct messaging, operational groups, official company updates, verified shift handoffs, and Korean-Spanish translation in native mobile apps and a responsive web application.

The existing Vinext/D1 single-channel site is a **legacy prototype**. It is useful only as evidence for a few original-first translation and summary behaviors. It is not the product information architecture, identity system, persistence layer, deployment target, or visual foundation for Newone V2.

Newone V2 is an independent product:

- It does not use ChatGPT sign-in, ChatGPT account state, ChatGPT Sites hosting, or a ChatGPT user interface.
- The target product will have its own company workspaces, accounts, sessions, applications, domain, backend, data, policies, and administration. None of those production services is implied to be deployed by this requirements document.
- If OpenRouter is approved, Newone calls it only from Newone-controlled server infrastructure. Employees never need an OpenRouter or ChatGPT account.
- Native iOS and Android applications and the web application are first-class clients of the same product, not wrappers around the legacy site.

## 2. Product promise

> A worker can open Newone, find the right person or team, and communicate in their own language within seconds. The company can deliver critical information, verify handoffs, and manage access without turning everyday private messaging into an administrator-visible public channel.

Newone should feel familiar enough that a WhatsApp user can begin without formal training, while providing the identity, access, delivery, acknowledgement, lifecycle, and audit controls expected of a company system.

## 3. Problems to solve

Frontline organizations commonly have some combination of these problems:

1. Workers do not all have company email or desktop access.
2. Different sites and shifts rely on personal phone numbers, personal WhatsApp groups, paper notices, screenshots, or word of mouth.
3. Korean- and Spanish-speaking colleagues lose context, wait for a bilingual intermediary, or copy sensitive text into consumer translation tools.
4. A single large channel produces noise and leaks information to people who do not need it.
5. A read receipt cannot prove that a safety notice was understood or that a shift handoff was accepted.
6. The company cannot reliably add, move, suspend, or offboard people across informal groups.
7. Operational knowledge is hard to search, trace, retain, or hand over.
8. Existing enterprise tools often assume email identities, office workflows, and high desktop usage.

## 4. Product principles

1. **Original first.** The sender's original message is the durable record. Translation, summary, extraction, and moderation outputs are derived layers with provenance.
2. **Messaging must work without AI.** Model failure, missing approval, or provider outage must never stop original messages, files, acknowledgements, or emergency escalation instructions.
3. **Private by membership.** DMs and groups are visible only to their members and narrowly authorized compliance processes. Ordinary managers and workspace administrators cannot browse private message content.
4. **Company-owned identity.** Workspaces control membership and sessions; employees do not exchange personal phone numbers to communicate.
5. **One obvious inbox.** DMs and groups share a recency-ordered Chats surface. Workers should not have to understand channels, threads, spaces, and projects before sending a message.
6. **Official communication is distinct.** Updates and critical notices have targeting, delivery, acknowledgement, and escalation semantics that ordinary chat messages do not.
7. **Work context controls noise.** Site, team, role, line, and current shift determine membership and notification routing.
8. **Human confirmation for operational records.** AI may draft a handoff or action, but a person confirms the record and responsibility.
9. **Transparent security.** Newone must not claim end-to-end encryption while servers process content for translation, search, retention, or governance.
10. **Low-friction, low-bandwidth operation.** The core loop works on older phones, intermittent networks, and shared-device deployments.

## 5. Users and jobs to be done

### 5.1 Frontline employee

Typical context: personal or managed phone, limited time, variable connectivity, no corporate email, Korean or Spanish preference.

Jobs:

- Find a verified coworker without sharing a personal number.
- Send and receive a DM or team message in the employee's preferred language.
- See whether a message was sent, delivered, read, or failed.
- Receive routine messages only when relevant to the employee's site/team/shift.
- Read and deliberately acknowledge a critical notice.
- Report an unsafe or abusive message and block non-essential direct contact.
- Recover from a lost or replaced device without exposing prior sessions.

### 5.2 Supervisor or shift lead

Jobs:

- Communicate with the current shift, a person, or an operational group.
- See who has not received or acknowledged an official notice.
- Draft a shift handoff from source messages, edit it, sign it, and obtain incoming acknowledgement.
- Create or confirm a task from a message without silently assigning work through AI.
- Use an urgent override only for an authorized incident classification.
- Manage operational group membership within a delegated scope.

### 5.3 Operations, safety, quality, or HR communicator

Jobs:

- Target official updates by company, site, department, team, role, language, or shift.
- Require acknowledgement when policy or safety warrants it.
- See delivery and acknowledgement gaps without opening unrelated private chats.
- Publish corrected information while preserving the correction history.
- Use approved templates and translations for high-consequence notices.

### 5.4 Workspace administrator and IT/security operator

Jobs:

- Provision, verify, suspend, move, and offboard employees.
- Configure sites, teams, roles, directory visibility, dynamic groups, and policies.
- Review devices and revoke sessions immediately.
- Configure authentication, MFA, SSO, retention, legal hold, exports, integrations, and data egress.
- Investigate security events through immutable metadata and administrative audit logs.
- Operate the service without routine access to employees' private message bodies.

### 5.5 Compliance reviewer or designated investigator

Jobs:

- Receive a scoped, approved case rather than unrestricted search access.
- View only the content authorized by the case, with reason, approver, time window, and audit record.
- Preserve or export specified records under retention or legal-hold policy.
- Never use AI translation as the sole evidence in a disciplinary or legal conclusion.

### 5.6 Contractor or guest

Not required for the employee pilot. When enabled later, a guest must be visibly labeled, limited to named conversations, assigned an expiry, and isolated from the general directory and unrelated data.

## 6. Workspace and information architecture

### 6.1 Organization model

The navigable company hierarchy is:

```text
Organization
|-- Sites
|   |-- Departments / operational areas
|   |   |-- Teams / lines
|   |   `-- Shifts
|   `-- Local announcement audiences
`-- Company-wide announcement audiences
```

Hierarchy attributes drive directory visibility, dynamic group membership, notification routing, and administrative scope. A team is not automatically a chat; policy may create a persistent group for it.

### 6.2 Employee navigation

The primary destinations are:

1. **Chats**: DMs, group DMs, team groups, and operational groups in one recency-ordered inbox.
2. **Updates**: official announcements and critical notices, separated from conversational noise.
3. **People**: verified company directory, contacts, connection requests when required by policy, teams, and the compose flow.
4. **Work**: shift handoffs and confirmed operational actions. This can be hidden for organizations that do not enable those modules.
5. **You**: profile, language, notification schedule, privacy, devices, security, accessibility, storage, and help.

Global search is available from Chats on mobile and persistently on wider screens. The administration console is a separate role-gated web surface.

### 6.3 Conversation types

| Type | Membership | Reply model | Typical use |
|---|---|---|---|
| Direct | Exactly two active members | Both participants | Private coworker conversation |
| Group DM | Explicit, small membership | All members | Temporary coordination |
| Team group | Explicit or policy-managed membership | All members or admin-only mode | Shift, line, maintenance, quality |
| Incident group | Explicit membership, severity and closure state | All authorized responders | Bounded operational incident |
| Announcement audience | Dynamic targeting snapshot | Replies off or organized separately | Official update |
| Critical notice | Dynamic targeting snapshot plus acknowledgement | No ordinary replies | Safety, policy, urgent operations |

### 6.4 Core terminology

- **Delivered**: at least one eligible recipient device or active client accepted the item.
- **Read**: the recipient opened the conversation or update at the item position.
- **Acknowledged**: the recipient deliberately confirmed receipt or understanding. It is never inferred from read state.
- **Contact**: a directory person the user has saved for quick access. This does not reveal a personal phone number.
- **Connection**: an optional policy-controlled permission between two people when the organization does not allow unrestricted directory DMs.
- **Dynamic group**: membership derived from approved organization attributes such as site, role, team, or current shift.
- **Handoff**: a versioned, human-signed operational record with source links and an incoming acknowledgement.
- **Original**: immutable canonical message text as submitted, except for policy-governed edit/delete events that retain audit history.

## 7. Functional requirements and acceptance criteria

Priority labels:

- **Must**: required before live employee pilot.
- **Next**: required before broad multi-site rollout.
- **Later**: valuable expansion after the core system is safe and reliable.

### 7.1 Identity, enrollment, and sessions

#### ID-01 — Company workspace and invitation enrollment — Must

An account belongs to at least one organization membership. Initial pilot enrollment supports administrator-provisioned employee records plus a single-use, expiring invitation delivered by verified email or phone. Employee ID plus a separately delivered temporary code is supported where workers lack company email.

Acceptance criteria:

- An unknown person cannot create or join a company workspace without an invitation or approved domain/identity-provider rule.
- The invitation is single-use, expires, is bound to the intended organization and employee record, and is invalidated after use or revocation.
- Enrollment verifies control of the configured email or phone before activating membership.
- Duplicate enrollment cannot create two active memberships for the same authoritative employee identity.
- Logs and user-facing errors do not reveal whether an arbitrary email or phone belongs to an employee.

#### ID-02 — Authentication and recovery — Must

Support passwordless OTP/magic-link or password plus verification, with a recovery path that re-verifies the employee. CAPTCHA, IP/device/user rate limits, breached-password controls where passwords are enabled, and generic error responses are required.

Acceptance criteria:

- Repeated failed sign-in, OTP request, OTP verification, recovery, and invitation attempts are throttled independently.
- Recovery OTP request and verification consume separate destination, network, and installation budgets; requesting recovery never creates an unknown Auth user and always returns an enumeration-safe public response.
- Administrators and privileged communicators must enroll a second factor before privileged actions.
- A successful self-service recovery binds the newly verified session to its installation before returning membership data, preserves only that session, revokes every other Auth session/device/push destination, and records immutable security evidence.
- Lost-TOTP help-desk recovery requires an expiring case, externally verified evidence referenced only by a keyed digest, separation of target/verifier/approver, and two distinct approvers for a privileged target. Execution resets the exact verified factor and revokes every session/device/push destination.
- Newone does not perform human identity proofing itself. The approved verification procedure and responsible staff remain an operational launch gate, and a queued `pending_external_delivery` security notice is not delivery evidence.
- A session cannot be minted for an inactive organization membership.

#### ID-03 — Session and device control — Must

Each session is attributable to a device record with created, last-used, platform, approximate location/security signals, and revocation state.

Acceptance criteria:

- A user can list and revoke their sessions from another authenticated device.
- An administrator can revoke all sessions for a suspended member without seeing message content.
- Sensitive administrative operations verify a current session, recent authentication, and second factor.
- Native refresh credentials use OS secure storage; public browser caches never contain refresh credentials or message payloads.

#### ID-04 — Immediate suspension and offboarding — Must

One administrative action suspends membership, revokes active sessions and refresh credentials, blocks new tokens, removes future group access, and queues ownership transfer while preserving records according to policy.

Acceptance criteria:

- New database, API, and Storage authorization is denied immediately after the suspension transaction commits; this does not wait for ordinary access-token expiry.
- Active Realtime connections terminate within 60 seconds. Refresh sessions and push destinations are disabled server-side as part of suspension, while local cache purge and device cleanup occur on the next device contact.
- A previously connected offline device cannot submit queued messages after suspension.
- The offboarding record identifies the actor, reason category, time, affected sessions, and ownership-transfer result.
- Historical content is retained, anonymized, or deleted according to configured policy rather than silently disappearing.

#### ID-05 — SSO and lifecycle automation — Next

Support OIDC or SAML SSO plus SCIM/HRIS provisioning for joiner, mover, and leaver workflows. A changed site/team/role updates policy-managed groups and administrative scope without modifying past message visibility.

### 7.2 Directory, contacts, and connections

#### DIR-01 — Verified company directory — Must

People search shows company-approved name, photo/avatar, title or role, site, team, shift availability indicator, language preference when allowed, and verified status. Personal phone numbers, personal email addresses, and home information are never shown by default.

Acceptance criteria:

- Search is accent-insensitive and supports approved aliases while respecting organization and directory-scope rules.
- Disabled users do not appear as new-contact candidates.
- A person can open a profile, save a contact, or start a permitted DM in three taps or fewer from the People root.
- Cross-organization results never appear.

#### DIR-02 — Contact list and favorites — Must

Users can save directory contacts and favorite people or conversations. These are per-user preferences, not a second identity system.

Acceptance criteria:

- Saving or removing a contact does not notify or grant access to the other person.
- Favorites sync across the user's devices.
- Removing a contact does not delete an existing conversation.

#### DIR-03 — Connection requests and DM policy — Must

Organizations choose one of three DM policies: directory-open, request-first, or scoped-by-organization-unit. Blocks and investigation holds override ordinary policy in documented ways.

Acceptance criteria:

- In request-first mode, the recipient must accept before either person can send ordinary messages.
- Request spam is rate-limited; ignored or declined requests cannot be immediately repeated.
- A user can block new DMs while preserving required official communications.
- The interface explains why a person cannot be messaged without exposing confidential role or policy details.

#### DIR-04 — Personal address-book matching — Later, explicit opt-in only

Personal contacts are not uploaded by default. If enabled, matching uses explicit consent, purpose limitation, deletion controls, and the minimum data required. The employee pilot does not require this feature.

### 7.3 Chats and conversation membership

#### CHAT-01 — Mixed conversation inbox — Must

The Chats root mixes DMs and groups in reverse activity order and displays avatar, name, sender prefix where needed, last-message preview, timestamp, draft, mention, mute, unread count, delivery problem, and pin state.

Acceptance criteria:

- Filters include All, Unread, DMs, Groups, and Favorites; organization policy may add Site or Shift.
- Pinned chats remain above recency ordering within their section.
- A new message updates preview and ordering without a full refresh.
- An empty inbox directs the user to People or approved groups, not to a global public room.

#### CHAT-02 — Unique direct conversation — Must

Exactly one active direct conversation exists for the same two memberships in an organization.

Acceptance criteria:

- Concurrent compose attempts by both users resolve to the same conversation.
- Blocking or archiving does not create a duplicate direct conversation.
- A reactivated relationship follows retention policy for the prior conversation rather than silently forking history.

#### CHAT-03 — Group creation and roles — Must

Authorized users can create named group DMs and operational groups, select permitted members, set an image and description, and assign owner/admin/member roles.

Acceptance criteria:

- Group limits, creation permission, external guests, and join approval are organization-configurable.
- Every group has at least one active owner; owner removal requires transfer or a deterministic administrator recovery flow.
- Membership additions/removals and role changes create visible system events and administrative audit events.
- New-member history exposure follows the group's configured history policy and is clearly disclosed before joining.

#### CHAT-04 — Policy-managed team groups — Must

Administrators can define groups whose membership derives from site, department, team, role, line, or scheduled shift.

Acceptance criteria:

- A mover gains future access only after the authoritative membership change succeeds.
- A leaver loses future access immediately; past access follows retention policy.
- Manual membership cannot silently override a locked dynamic policy.
- A preview shows affected members before an administrator publishes a policy change.

#### CHAT-05 — Conversation controls — Must

Members can mute, archive, favorite, search, report, and leave eligible conversations. Authorized group admins can restrict posting, approve joins, remove members, and close an incident group.

Acceptance criteria:

- Users cannot leave mandatory critical-notice audiences, but can configure permitted notification behavior.
- Leaving a group reports what history and files remain accessible.
- A closed incident group becomes read-only and retains a closure record.

### 7.4 Messages, replies, reactions, and receipts

#### MSG-01 — Original-first reliable send — Must

Text is persisted as the canonical original before translation or other AI processing. The client uses a stable idempotency key and an offline outbox.

Acceptance criteria:

- A normal send appears optimistically with an explicit sending state and reconciles to one server message.
- Replaying the same idempotency key with the same content returns the existing message; different content is rejected.
- Translation failure cannot change a successful original send into a failed send.
- An interrupted send ends in sent or clearly retryable/failed state; it never disappears silently.

#### MSG-02 — Conversation timeline — Must

The timeline supports date separators, unread divider, sender grouping, replies, reactions, mentions, system events, link previews under policy, and cursor-based history pagination.

Acceptance criteria:

- Opening a conversation starts near the first unread item when one exists.
- Pagination does not duplicate, skip, or reorder messages received during loading.
- Reply preview links to the source message or explains when the source is unavailable.
- Mention notifications respect membership and do not reveal content to unauthorized users.

#### MSG-03 — Delivery and read state — Must

Newone records sent, delivered, and read states separately and lets users disable read visibility for ordinary DMs if company policy permits. Critical-notice delivery and acknowledgement remain governed separately.

Acceptance criteria:

- Group message info summarizes counts and exposes named recipient state only to permitted roles.
- A read marker never appears before the recipient actually crosses the item in an active client.
- Delivery/read events are idempotent and monotonic.
- Read state is never labeled as understanding or acknowledgement.

#### MSG-04 — Edit, delete, copy, forward, pin, and report — Must

Long-press on native or context menu on web exposes actions allowed by role, age, retention, hold, and conversation policy.

Acceptance criteria:

- Edits show an edited marker and retain a protected version history for authorized cases.
- User deletion semantics distinguish "for me" from policy-permitted "for everyone."
- Legal hold or incident preservation can block destructive deletion and explains the policy without revealing case details.
- Forwarded content is labeled and does not carry access to an attachment the new audience cannot read.

#### MSG-05 — Voice notes — Later

Record, send, play, change playback speed, transcribe, and translate voice notes. The original audio remains available under policy; transcription is labeled and source-linked.

#### MSG-06 — Polls and lightweight events — Later

Support low-risk availability polls, reminders, and events. Do not use anonymous polls for employment, safety, or disciplinary decisions without separately approved requirements.

### 7.5 Attachments and media

#### FILE-01 — Private images and documents — Must

Members can attach camera images, gallery images, PDFs, and approved operational file types. Objects are private, scoped to an organization and conversation, and accessed through short-lived authorization.

Acceptance criteria:

- Upload uses a server-issued object path and size/type policy; clients cannot choose another organization's path.
- Files are unavailable to conversation non-members even with a copied URL.
- Pending files are quarantined until malware scanning and validation complete.
- Preview/download failure does not lose the associated original caption or message.
- Metadata stripping, retention, download, forwarding, and screenshot warnings follow tenant policy.

#### FILE-02 — Camera capture and compression — Must

Native clients can capture a photo, preview it, add a caption, and upload a bandwidth-appropriate version while optionally preserving approved detail for equipment or safety evidence.

#### FILE-03 — Advanced media and large files — Next

Support video, larger files, annotation, and resumable uploads after storage, scanning, data-loss, and mobile-bandwidth controls are proven.

### 7.6 Korean-Spanish translation

#### TR-01 — Recipient-language rendering — Must

Each user chooses Korean, Spanish, or original-first display. For supported text, the UI presents the recipient-language translation with a one-tap original reveal and visible language/status label.

Acceptance criteria:

- The original remains canonical and cannot be overwritten by translation.
- Newone detects the language of every supported original server-side and routes Korean, Spanish, English, mixed, and unknown results without trusting a client-supplied language as authoritative.
- Translation states are queued, translating, translated, failed, corrected, and human-reviewed.
- Numbers, units, dates, equipment IDs, line breaks, and mentions are preserved or flagged.
- Detected language, confidence/ambiguity, detector provenance, source language used for translation, and target language are durable and visible where they affect interpretation.
- Very short, mixed-language, or ambiguous messages resolve to `und`/mixed with an uncertainty warning instead of false confidence or silent routing.
- A user can turn automatic translation off per conversation.

#### TR-02 — Safe asynchronous processing — Must

Translation begins only after original persistence and only when the organization has approved the configured processor route.

Acceptance criteria:

- If AI data egress is disabled, the original remains usable and the UI states that translation is unavailable.
- Duplicate requests for the same message, target language, glossary version, and model policy resolve to one durable translation result.
- Provider timeout, throttling, or invalid output produces a retryable or terminal status without duplicate messages.
- No model credential, provider secret, or unredacted prompt appears in a client bundle or routine log.

#### TR-03 — Glossary and correction — Must

Authorized language reviewers maintain organization/site glossaries for people, equipment, materials, procedures, acronyms, and approved safety phrasing. Users can report and propose a correction.

Acceptance criteria:

- Every translation records model route, source and target language, glossary version, timestamps, and correction/review provenance.
- A correction does not modify the original and is visibly attributed as reviewed.
- High-consequence templates can require a bilingual reviewer before publication.
- Corrected, deidentified examples can be exported to a controlled regression set.

#### TR-04 — Human-review boundary — Must

Newone displays a persistent warning that automated translation is not the sole authority for emergencies, safety, medical, legal, payroll, disciplinary, immigration, or other high-impact decisions.

### 7.7 Conversation and shift summaries

#### SUM-01 — Authorized automatic summary draft — Must

Newone can create a conversation or shift summary on an authorized user's request and, when an organization explicitly enables it, automatically at a configured message-count or shift-boundary trigger. A summary is a derived, source-linked draft; it never replaces or edits the underlying conversation.

Acceptance criteria:

- Summary generation re-authorizes the requester, conversation membership, source-message visibility, and organization AI-egress policy both when queued and when processed.
- The source window is immutable and records ordered source-message IDs, a deterministic source fingerprint, requested scope/time window, model route and policy version, prompt/schema version, detector/glossary versions where applicable, creator/trigger, and timestamps.
- The structured result includes a primary topic, concise summary, key topics, decisions, proposed action items, and ambiguities. Every factual decision and proposed action links to supporting source messages; unsupported claims are omitted or explicitly marked uncertain.
- States are queued, generating, ready-for-review, approved, corrected, failed, and superseded. Duplicate requests for the same source fingerprint and policy do not create duplicate provider work.
- An edit, policy-governed deletion, retention expiry, or authorization change affecting the source set invalidates or supersedes the prior draft rather than silently leaving it current.
- When AI data egress is disabled or the provider fails, messaging and manual handoff creation remain available and the UI shows a non-destructive summary-unavailable state.

#### SUM-02 — Summary review, correction, and operational boundary — Must

Only an authorized conversation member or supervisor within scope can view, correct, approve, or reject a summary. Automatic output remains visibly unapproved until a person accepts the exact version.

Acceptance criteria:

- Review records actor, role/scope, action, timestamp, source fingerprint, prior version, correction text, and safe audit correlation ID.
- Approval does not assign work, issue a shift handoff, acknowledge a notice, alter the original conversation, or make a disciplinary or employment decision.
- Proposed action items enter the ordinary human-confirmation workflow before an owner or due date becomes authoritative.
- A reader can open the cited originals, see AI/model and human-review provenance, report an error, and distinguish a conversation summary from an issued shift handoff.
- Summary content follows conversation authorization, retention, deletion, export, and legal-hold rules and is excluded from ordinary logs, URLs, notification previews, and unauthorized search snippets.

### 7.8 Updates and critical notices

#### UPD-01 — Targeted official update — Must

Authorized communicators can publish an official update to a snapshot of people selected by company, site, department, team, role, language, or shift.

Acceptance criteria:

- The author previews recipient count, exclusions, languages, notification class, and scheduled time before publish.
- The stored audience snapshot prevents later organization changes from rewriting who was targeted at publish time.
- Corrections create a new version, notify affected recipients, and preserve the prior version.
- Ordinary chat members cannot impersonate an official sender.

#### UPD-02 — Critical notice and acknowledgement — Must

Authorized roles can mark an update critical, set an acknowledgement deadline, provide required response instructions, and configure reminders/escalation.

Acceptance criteria:

- The recipient must take a deliberate action; scrolling, opening, delivery, or read state cannot create acknowledgement.
- Administrators see delivered, read, acknowledged, overdue, and unreachable counts separately.
- Named non-responder lists are limited to authorized operational roles and do not expose unrelated usage data.
- An acknowledgement records notice version, user, timestamp, device/session, and any required attestation text.
- A corrected material notice invalidates or explicitly carries forward prior acknowledgements according to configured policy.

#### UPD-03 — Notification escalation — Must

Critical notices can bypass quiet hours only when an authorized category and reason are supplied. The employee pilot includes policy-controlled SMS fallback capability for recipients who remain unreachable; an organization may leave actual SMS delivery disabled only through an approved policy decision and documented alternative fallback.

Acceptance criteria:

- Every urgent override and fallback attempt is audited.
- Push/SMS content is minimized on locked screens and never exposes sensitive message bodies by default.
- Newone does not claim to replace emergency sirens, 911/112, fire alarms, or legally required safety systems.

#### UPD-04 — Updates analytics — Next

Provide delivery, reach, acknowledgement, language, site/team, and time-to-acknowledge reporting with small-cohort privacy thresholds and export controls.

### 7.9 Shift handoffs and actions

#### OPS-01 — Source-linked handoff draft — Must

Authorized outgoing supervisors can create a handoff for a site/team/shift window. The handoff captures production status, open issues, safety/quality items, blockers, owners, deadlines, and urgent actions, with source links.

Acceptance criteria:

- A handoff may be created manually even when AI is disabled.
- An AI draft cites only messages/files/tasks the author is authorized to access and includes source references for every extracted factual item.
- Unsupported or uncertain claims are excluded or explicitly marked for review.
- Editing the draft retains version and reviewer history.

#### OPS-02 — Outgoing signoff and incoming acknowledgement — Must

A handoff becomes issued only after an outgoing supervisor confirms it. The incoming supervisor must acknowledge it separately and can add a discrepancy note.

Acceptance criteria:

- The issued version is immutable; corrections produce a linked superseding version.
- Signoff and acknowledgement include actor, role, time, and source version.
- Overdue handoffs notify the configured escalation path.
- A read receipt cannot substitute for either signoff or acknowledgement.

#### OPS-03 — Human-confirmed action creation — Must

A user can propose an action from a message or handoff. It is not assigned or due until an authorized person confirms owner, due time, scope, and source.

Acceptance criteria:

- AI-generated actions remain in a needs-confirmation state.
- Assignee, status, due-time, and closure changes produce append-only events.
- Completing an action does not delete or rewrite the source message.

#### OPS-04 — Operational forms and integrations — Later

Integrate maintenance, quality, incident, HR, scheduling, timekeeping, ERP, or ticketing systems through tenant-approved connectors. Newone must not become the unreviewed system of record for specialized regulated workflows.

### 7.10 Search and history

#### SEARCH-01 — Authorized unified search — Must

Search covers permitted people, conversation names, original text, translations, sender, date, files, updates, and handoffs. Results never expand the user's access.

Acceptance criteria:

- Every result is re-authorized at query time and at open time.
- Search snippets do not reveal hidden surrounding text or unauthorized attachment metadata.
- Filters include person, conversation, type, date, language, and file.
- Korean and Spanish tokenization, common aliases, exact equipment IDs, and quoted phrases are tested.
- Pagination is cursor-based and stable under new writes.

#### SEARCH-02 — Retention-aware history — Must

History reflects conversation-specific retention, user deletion semantics, legal hold, and member-history policy.

Acceptance criteria:

- Expired items disappear from ordinary search and are deleted or archived through a verifiable retention job.
- Legal-hold material is excluded from ordinary UI after expiry but preserved only for authorized cases.
- Rejoining a group does not expose history beyond the group's configured policy.

#### SEARCH-03 — Advanced enterprise discovery — Next

Add approved export, eDiscovery, and legal-hold case workflows with dual control, narrow scope, immutable audit, and data minimization.

### 7.11 Notifications, presence, and availability

#### NOTIF-01 — Per-conversation controls — Must

Users can choose all messages, mentions only, or mute for eligible conversations. They can configure quiet hours, preview privacy, sound/vibration, and device-specific preferences.

Acceptance criteria:

- Routine off-shift notifications are suppressed when shift-aware delivery is enabled.
- Muting a chat does not suppress a required critical notice unless policy explicitly permits it.
- Notification payloads contain opaque identifiers and minimal preview text according to policy.

#### NOTIF-02 — Presence restraint — Must

Newone may show available, on shift, or last active only according to organization and user privacy policy. It must not become an employee productivity surveillance score.

#### NOTIF-03 — Push-to-talk and calls — Later

Push-to-talk, voice/video calling, and screen sharing require a separate reliability, recording, emergency, consent, bandwidth, and retention design.

### 7.12 Administration, governance, and safety

#### ADM-01 — Scoped role administration — Must

Roles include organization owner, security administrator, people administrator, communications publisher, site administrator, group administrator, language reviewer, supervisor, employee, and designated investigator. Permissions are additive only where explicitly defined and are scoped by organization/site/team.

Acceptance criteria:

- Authorization uses server-controlled membership and role records, never editable profile metadata.
- A site administrator cannot administer another site or grant a role above their delegation.
- Privileged role changes require recent authentication, MFA, reason, and audit event.
- No ordinary administrative role includes blanket private-message read access.

#### ADM-02 — Audit trail — Must

Record authentication, invitation, session, membership, role, group-policy, retention, export, legal-hold, critical-notice, AI-egress, secret/configuration, and investigator-access events in an append-only security audit trail.

Acceptance criteria:

- Events include actor, target, organization, action, result, timestamp, correlation ID, and minimal safe context.
- Audit records cannot be edited through the application API.
- Routine logs and analytics exclude raw message and attachment content.
- Audit access and export are themselves audited.

#### ADM-03 — Report, block, and moderation — Must

Users can report a message, group, or member; block optional direct contact; and access a documented safety escalation path.

Acceptance criteria:

- Reporting preserves a scoped copy/reference of the reported content and immediate context with user consent and policy notice.
- Moderators see only the case scope, not the reporter's other conversations.
- The reported user is not told the reporter's identity through the product unless policy and law require it.
- Blocking cannot prevent required company notices or authorized emergency contact, and that limitation is disclosed.

#### ADM-04 — Retention and legal hold — Next

Administrators configure retention by conversation/update/handoff type within policy limits. Legal holds require designated roles, case identifiers, documented approval, and immutable scope changes.

#### ADM-05 — Data loss prevention and classification — Next

Support content classification, restricted file types, approved external connectors, export controls, and integration with enterprise DLP tooling.

### 7.13 Offline, synchronization, and reliability

#### REL-01 — Offline outbox — Must

Native clients and the installed web application queue supported sends when connectivity is unavailable and retry safely after re-authentication.

Acceptance criteria:

- The user can inspect, retry, edit, or cancel an unsent item.
- The queue is encrypted with device-bound protection on native platforms.
- A queued item is re-authorized at send time; suspension or membership removal rejects it.
- Ordering among the same sender's queued items is preserved unless the user changes it.

#### REL-02 — Realtime plus reconciliation — Must

Realtime events accelerate UI updates; the durable database and cursor synchronization are authoritative.

Acceptance criteria:

- Reconnect fetches missed events from the last durable cursor.
- Duplicate, delayed, or out-of-order realtime events converge to the same timeline.
- A backgrounded phone can return to a correct state without replaying the entire workspace.

#### REL-03 — Degraded mode — Must

Provider outages, push delays, file scanner downtime, and partial backend failures show specific non-destructive states and preserve unaffected messaging capabilities.

### 7.14 Accessibility, language, and support

#### A11Y-01 — Accessible clients — Must

Meet WCAG 2.2 AA for the web and corresponding iOS/Android accessibility guidance for core flows.

Acceptance criteria:

- Core flows work with VoiceOver, TalkBack, keyboard-only navigation, 200% text scaling, reduced motion, and sufficient contrast.
- Message status, translation state, reaction, unread, and acknowledgement are not conveyed by color alone.
- Tap targets and one-handed phone use are validated with frontline workers.

#### A11Y-02 — Product localization — Must

Navigation, settings, help, authentication, errors, and notifications ship in Korean, Spanish, and an administrator-selected fallback language. Product localization is distinct from message translation.

#### SUPPORT-01 — In-product support — Must

Users can access language-appropriate onboarding, security/recovery help, translation-report flow, privacy explanation, and a company support contact without signing in when appropriate.

## 8. Cross-platform behavior

Newone uses one Expo Router product codebase with platform-specific interaction and security adapters. Capability parity means the same account, permissions, history, messages, updates, acknowledgements, and handoffs exist across platforms; it does not mean every screen must have an identical layout.

### 8.1 Native phone: iOS and Android

- Bottom navigation for Chats, Updates, People, optional Work, and You.
- One primary pane at a time; back returns predictably to the prior list and scroll position.
- Native long-press action sheet, share picker under policy, camera/file picker, secure credential storage, push notifications, badges, deep links, haptics, and background sync.
- Composer remains reachable above the keyboard and handles safe areas, large text, and one-handed use.
- New messages do not yank the user away from older history; a new-message affordance returns to the latest item.
- Sensitive preview and screen-capture behavior follow tenant and OS policy; absolute screenshot prevention is not claimed.

### 8.2 Tablet and foldable

- Two-pane layout where width permits: conversation list plus active conversation.
- Details, search, or thread context opens as a third sheet/pane without losing compose state.
- Orientation and window resizing preserve the selected conversation and unread position.

### 8.3 Responsive web and installed PWA

- At desktop widths, use a three-region workspace: global navigation, conversation/update list, and active detail; an optional information drawer never obscures the composer.
- At narrow widths, collapse to the native phone navigation model.
- Keyboard shortcuts cover search, compose, next unread, reply, edit-last, focus composer, and escape/close.
- Browser history and deep links open the authorized conversation/update without exposing content in page titles or unauthenticated previews.
- The PWA caches only the application shell and approved low-sensitivity assets by default. Offline message caching is tenant-controlled and never stored in the service-worker cache.

### 8.4 Shared devices

Shared-device mode is **Next**. Shared kiosks, pooled tablets, and shift phones are prohibited during the employee pilot. Any later shared-device deployment is conditional on all of these controls:

- Short re-entry with organization-approved verification after an initial managed enrollment.
- Automatic lock on inactivity or shift boundary.
- No prior user's notification previews, local messages, files, drafts, credentials, or autofill after sign-out.
- Remote wipe/revocation signal and MDM/app-protection integration.

## 9. Pilot priority and release slices

### 9.1 Must: employee pilot

The first live pilot includes:

- Independent Newone identity, hosting, domain, and applications.
- Verified accounts, invitation enrollment, account recovery, MFA for privileged roles, device/session list, and immediate suspension.
- Company hierarchy, directory, contacts, DM policy, DMs, group DMs, team groups, and scoped group administration.
- Reliable text messaging, replies, reactions, mentions, receipts, offline outbox, private images/PDFs, and authorized search.
- Korean-Spanish original-first translation with automatic language detection/routing, glossary, correction/reporting, and human-review labels.
- Authorized conversation and shift summaries with immutable source sets, primary topic, decisions, proposed action items, ambiguity signaling, and explicit human approval.
- Targeted updates, critical notices, deliberate acknowledgement, reminder and escalation state, and policy-controlled SMS fallback for unreachable recipients.
- Source-linked shift handoffs, outgoing signoff, incoming acknowledgement, and human-confirmed actions.
- Shift-aware notifications, reporting/blocking, scoped roles, audit trail, retention baseline, backup, restore, and support tooling.
- Responsive web/PWA and installable iOS/Android builds with core feature parity.

### 9.2 Next: broad rollout

- OIDC/SAML SSO, SCIM/HRIS provisioning, MDM, and shared-device mode.
- Legal hold/eDiscovery, advanced retention, DLP, enterprise exports, and customer audit integration.
- Advanced delivery/acknowledgement/translation/handoff analytics with privacy thresholds.
- Resumable large media, external guest controls, and regional/data-residency options.
- Direct approved AI-provider route or customer-managed provider configuration where required.

### 9.3 Later: expansion

- Voice notes with transcription/translation, push-to-talk, voice/video calling, screen sharing, events, and polls.
- Scheduling, shift swap, timekeeping, payroll, ERP, CMMS, quality, ticketing, and digital-signage integrations.
- Surveys, recognition, knowledge hub, bots, and carefully scoped federated organizations.
- Customer-managed encryption keys and specialized DLP/archival connectors.

## 10. Pilot acceptance journeys

The employee pilot is not accepted until all of these work on supported iOS, Android, and web configurations:

1. A pre-provisioned Spanish-speaking employee enrolls without company email, finds a Korean-speaking coworker, starts a permitted DM, sends offline, reconnects, and both see one original message plus a labeled translation.
2. Two people concurrently start a DM with each other and arrive in the same conversation with no duplicate.
3. A shift membership change removes the worker from future old-shift traffic and adds future new-shift traffic without exposing unrelated past history.
4. A supervisor publishes a bilingual critical notice to the active shift, sees delivered/read/acknowledged separately, reminds non-responders, and exports the authorized acknowledgement record.
5. An outgoing supervisor drafts a source-linked handoff, corrects an AI mistake, signs it, and an incoming supervisor acknowledges the exact issued version.
6. An authorized supervisor requests a summary of a Korean-Spanish conversation, reviews the primary topic, decisions, action items, ambiguities, and source links, corrects it, and approves the exact version without changing any original message.
7. OpenRouter is unavailable or disabled; original chat, attachments, search of existing content, manual handoff, and acknowledgement continue to work.
8. An employee reports a message and blocks optional DMs; the reviewer receives only the scoped case, and the reported person gains no unrelated visibility.
9. An administrator suspends an account while that employee has a web session, a native session, and queued offline content; new database/API/Storage access and queued submissions fail immediately after commit, active Realtime closes within 60 seconds, push destinations are disabled server-side, and device cache cleanup occurs on next contact. Every transition is visible and auditable.
10. A copied attachment URL fails for a non-member, an expired session, and a removed member.
11. A user on an intermittent, bandwidth-limited connection can load the inbox, open recent text, send a short message, and understand every pending/failure state.
12. VoiceOver/TalkBack and keyboard-only users can enroll, find a person, send/read/reply, reveal the original, and acknowledge a notice.
13. A restore exercise recovers the pilot workspace inside the approved recovery objectives, bounds any loss to the 15-minute RPO, and reconciles acknowledgement and issued-handoff records without claiming zero-loss recovery.

## 11. Quality, performance, and operational expectations

Initial service objectives are targets for production validation, not unmeasured marketing claims:

| Measure | Pilot target |
|---|---|
| API availability for authenticated core messaging | 99.9% monthly, excluding announced maintenance |
| Original text accepted after send on a healthy network | p95 under 1.0 second in the selected deployment region |
| Online realtime appearance after durable commit | p95 under 2.0 seconds |
| Inbox initial usable content on supported 4G | p75 under 2.5 seconds; p95 under 5 seconds |
| Translation completion | Measured separately; never included in original-send SLO |
| Critical-notice status freshness | p95 under 30 seconds while online |
| Recovery point objective | 15 minutes or better for pilot; restore evidence must bound loss to the measured recovery point rather than imply zero-loss durability |
| Recovery time objective | 4 hours for pilot, tightened before broad rollout |
| Security revocation propagation | New database/API/Storage authorization denied immediately after suspension commit; active Realtime terminated within 60 seconds; push destination and device-cache cleanup verified on next contact |
| Accessibility | No unresolved critical WCAG 2.2 AA issue in a pilot core flow |

Operational requirements:

- Separate development, staging, and production environments with isolated data, credentials, push projects, AI policy, and audit sinks.
- Before live pilot data, use a paid production Supabase project with PITR or an approved equivalent continuous database-backup path that meets the 15-minute RPO, plus a separately verified object-storage backup path.
- Automated migration, unit, integration, authorization, abuse, offline/reconnect, and cross-platform smoke tests before release.
- Structured telemetry uses correlation IDs and safe metadata; raw message bodies, translations, attachment contents, OTPs, access tokens, and secrets are excluded from normal logs.
- On-call runbooks cover authentication, message delivery, Realtime, storage/scanning, push, provider failure, abusive traffic, security revocation, backup/restore, and data-egress disablement.
- A visible status and support path distinguishes message accepted, delivered, read, translated, and acknowledged.

### 11.1 Starter abuse limits

The authoritative numeric launch policy is the [Starting rate limits and abuse controls](SECURITY_ARCHITECTURE_V2.md#starting-rate-limits-and-abuse-controls) table. Numeric values are not duplicated here so that invitation, messaging, group, search, file, translation, administration, and vendor-budget limits cannot drift between documents.

The pilot loads those values from versioned server policy and starts fail-closed with separate IP/subnet, destination, invitation, device, session, member, organization, conversation, action, byte, and cost controls rather than one global limit. Values must be load-tested against shared-site NAT and observed worker behavior before launch. Rate-limit responses identify a retry time without disclosing target-account existence. Critical operational use has a separately authorized, expiring, audited path; it does not silently disable protections.

## 12. Product success measures

Success is demonstrated by reliable communication and accountable operations, not message volume alone.

- Enrollment completion by site, shift, language, platform, and supported identity path.
- Weekly active eligible employees and percentage able to reach the correct team/person.
- Original-message delivery latency and failure/retry rate.
- Translation completion, correction, report, and human-review rate by language direction and risk class.
- Critical-notice delivered, read, acknowledged, overdue, unreachable, and time-to-acknowledge rates.
- Handoff issued on time, incoming acknowledgement, discrepancy, overdue, and unresolved-action rate.
- Search success and result-open rate without cross-tenant or authorization defects.
- Notification opt-out/mute pressure and routine off-shift interruption rate.
- Account suspension propagation time and stale-session rejection rate.
- Support requests, abuse reports, accessibility blockers, and failed low-bandwidth journeys.

Metrics must not be repurposed as individual productivity, sentiment, or performance scores without a new approved product, legal, labor, and privacy review.

## 13. Non-goals and hard boundaries

- Newone is not a ChatGPT app, a reskinned AI chatbot, a single public company channel, or a WhatsApp Business API client.
- Newone does not require employees to disclose personal phone numbers or upload personal address books.
- The pilot does not include public social feeds, stories/status, ads, commerce catalogs, creator discovery, or customer marketing automation.
- Newone does not replace emergency services, alarms, legally required safety systems, or a qualified interpreter.
- AI does not automatically issue disciplinary actions, evaluate performance, approve payroll, determine immigration/employment eligibility, or make other high-impact employment decisions.
- An AI-drafted action is not assigned work until a person confirms it.
- Native apps are in scope, but app-store approval dates and external Apple/Google account decisions cannot be guaranteed by software implementation alone.
- End-to-end encryption is not claimed while server-side translation, search, scanning, retention, or authorized governance processing exists.
- Ordinary administrators do not get a hidden universal private-message reader.

## 14. Decisions the company must own before live data

The application can implement safe defaults, but the company must approve:

1. Authoritative employee identity source and acceptable enrollment methods.
2. Directory visibility and DM/connection policy.
3. Sites, teams, roles, administrative delegations, and critical-notice publishers.
4. Retention by record type, deletion, legal hold, export, and investigation process.
5. Managed versus personal device rules for the pilot, quiet hours, and urgent override categories. Shared devices remain prohibited until the Next-phase controls and tests pass.
6. OpenRouter or direct-model processor approval, DPA terms, regions, subprocessors, content exclusions, cost budget, and disablement owner.
7. Safety terminology, bilingual review pool, translation quality threshold, and incident procedure.
8. Support owner, security contact, incident response, recovery objectives, and rollout support hours.

These are release gates, not reasons to leave enforcement unimplemented.

## 15. Research traceability

The interaction model and product boundaries are grounded in current official product and vendor materials reviewed through July 27, 2026:

- [WhatsApp messaging](https://www.whatsapp.com/messaging), [Groups](https://www.whatsapp.com/groups), [Communities](https://www.whatsapp.com/communities/learning), [chat filters](https://about.fb.com/news/2024/04/whatsapp-chat-filters/), [events and announcement replies](https://about.fb.com/news/2024/05/events-in-whatsapp-communities/), and [message translation](https://about.fb.com/news/2025/09/introducing-message-translations-whatsapp/).
- [Microsoft frontline worker overview](https://learn.microsoft.com/en-us/microsoft-365/frontline/flw-overview?view=o365-worldwide), [Slack security](https://slack.com/trust/security), [Connecteam communication hub](https://help.connecteam.com/en/articles/5951839-the-communication-hub), [Beekeeper Streams](https://help.beekeeper.io/hc/en-us/articles/26555056784028-Streams-Overview), [Staffbase acknowledgements](https://support.staffbase.com/hc/en-us/articles/33568358597010-Using-Acknowledgements-for-News-Posts), and [Workvivo acknowledgements](https://support.workvivo.com/hc/en-gb/articles/4917998046877-Read-Acknowledge-Posts-Articles).
- [Supabase production checklist](https://supabase.com/docs/guides/deployment/going-into-prod), [Auth sessions](https://supabase.com/docs/guides/auth/sessions), [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization), and [Expo Router](https://docs.expo.dev/router/introduction/).

Vendor examples inform workflow hypotheses. Pilot research with actual employees, supervisors, administrators, security staff, and bilingual reviewers is required before claiming adoption or safety outcomes.
