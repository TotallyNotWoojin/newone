# Privacy and safety release policy

The authoritative security design is [SECURITY_ARCHITECTURE_V2.md](SECURITY_ARCHITECTURE_V2.md). This file is the operational summary for product and release reviewers.

## Default state

- Development uses synthetic data.
- Open/anonymous workspace enrollment is disabled before any employee pilot.
- AI employee-data egress is disabled by default.
- Encrypted offline workspace caching is disabled by default. If a deployment explicitly enables it, guests remain online-only and never persist workspace snapshots, cursors, queued messages, or reply previews; expired memberships fail closed; and contractor snapshots and queued commands are capped to the membership expiry.
- Message originals remain functional when translation, push, scanning, or other processors fail.
- Private DMs are member-private inside a company-governed service. Newone does not claim technical end-to-end encryption while server translation, search, retention, or governance exists.
- Ordinary managers and administrators have no browse-all private-message capability.

## Data minimization

Routine telemetry may contain correlation IDs, safe route/error classes, latency, queue state, model policy/version, cost, delivery-provider status, and security-event metadata. It may not contain message/translation/search text, attachments, OTPs, invite tokens, credentials, signed URLs, raw model prompts/responses, or full personal contact values.

Push payloads default to an opaque event ID and privacy-safe category. A push never grants access to the underlying content.

Offline encryption protects a cache at rest but cannot revoke it while the device is disconnected. On its next online contact, an ineligible membership triggers user-store deletion. A persisted employee envelope cannot be hydrated after its 24-hour expiry, but an app that already decrypted the workspace can keep that in-memory view while it remains disconnected until the process ends or revalidates. Newone cannot remotely wipe that memory or ciphertext unless the company separately manages the device. Deployments requiring immediate cutoff keep offline workspace caching disabled.

## OpenRouter and model processing

Adding `OPENROUTER_API_KEY` does not enable live processing. The server also requires:

1. `NEWONE_AI_DATA_EGRESS_APPROVED=true` in the exact environment;
2. a versioned approved model and exact provider/region allowlist;
3. zero-data-retention and data-collection denial controls;
4. fallback, cache, plugins, web search, and tools disabled;
5. a spend/volume limit and kill switch;
6. completed contract, DPA, privacy/labor, security, employee-notice, and bilingual-quality review.

The adapter validates structured output and stores provenance without logging raw content. Context selection is limited to records the requesting member is authorized to access. Model timeout, invalid output, routing drift, budget exhaustion, or provider outage pauses the derived job and never retracts the original.

## Human review

Machine translation or summaries are never the sole authority for emergency response or a high-impact employment, disciplinary, legal, medical, payroll, accommodation, immigration, or safety decision. Preserve and label the original; require a qualified person to review the relevant language and source context.

## Attachments

Every upload uses a server-generated tenant/conversation path, private quarantine, size and MIME validation, malware/content scanning, and a clean-only read rule. Pending, failed, quarantined, blocked, deleted-message, expired-link, nonmember, and suspended-member denial paths require automated tests.

## Retention and investigation

Delete-for-me, delete-for-everyone, configured retention, legal deletion, Auth-user deletion, and legal hold are distinct workflows. Deletion covers message bodies, translations, attachments/objects, search derivatives, caches, and eventual backup expiry.

Any investigation access must be case-scoped, approved, time-bounded, reasoned, and audited. Whether such a capability exists at all is a Company decision; it is not silently inherited from an administrator role.

## Private safety reports

A member may privately report a visible message, a group-like workspace surface, or another organization member. Every path requires the versioned disclosure notice and affirmative consent. The server derives and freezes the target label and a tenant-bound target fingerprint; a client cannot supply either. Message reports copy only the reported message and the explicitly bounded, consent-time-visible context. Group and member reports copy no message content.

Intake never notifies the target or publishes to a group topic. It commits one content-free durable fanout intent, independent of organization size. A service-only worker expands that intent set-wise using authorization at processing time, excludes the reporter and any reported person, and enqueues idempotent per-user inbox invalidations. Offboarded investigators are removed before delivery and newly authorized investigators are included. Blocking or target offboarding removes discovery and communication access but does not erase a previously accepted contact or overlapping shared-conversation safety-report route. A pending/declined request and an unrelated inactive, private, or cross-tenant member remain unavailable through identifier guessing, and target membership status is never included in investigator DTOs.

## Quality incident response

When a materially harmful translation or processing result is reported:

1. stop relying on the derived output and use an approved bilingual person or interpreter;
2. preserve the original, derived version, model/provider policy, timestamps, and authorized sources;
3. correct the operational record without overwriting evidence;
4. classify numbers, units, negation, identifiers, urgency, dialect/register, and source ambiguity;
5. add a deidentified regression case to the controlled evaluation set;
6. disable the model route if the release threshold is crossed;
7. follow the incident and employee-notification procedure.

## Production prohibition

Real employee data remains prohibited until every applicable launch gate has stored evidence and no unresolved Critical/High security issue exists. A functional UI, configured publishable key, or successful model call does not override this policy.
