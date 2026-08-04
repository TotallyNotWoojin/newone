# Newone delivery and acceptance checklist

Status: evidence template; not a claim of acceptance
Last updated: August 3, 2026

Use this document to assemble the Milestone 2 delivery package and the three-business-day Company review described in the supplied agreement. A checked box requires linked evidence from the exact release candidate. Do not check an item because a neighboring test passed.

## Release identity

```text
Delivery date/time and timezone:
Repository and immutable commit/tag:
Release candidate identifier:
Development/staging project reference:
Production project reference (if approved):
Web origin:
iOS bundle/build identifier (additional scope):
Android package/build identifier (additional scope):
AI model/provider policy version:
Database migration versions:
Edge Function versions:
Prepared by:
Reviewed by:
```

## Required delivery package

- [ ] Complete source code at the immutable reference above, including universal client, BFF, database migration, Edge Functions/workers, tests, configuration examples, and assets.
- [ ] [Third-party dependency and service inventory](THIRD_PARTY_COMPONENTS.md), release lockfiles, SBOM/license report, and reviewed vulnerability report.
- [ ] [Deployment/configuration runbook](DEPLOYMENT.md), with every actual environment variable and owner-controlled external account identified.
- [ ] [Architecture documentation](ARCHITECTURE.md) and [detailed platform architecture](PLATFORM_ARCHITECTURE_V2.md).
- [ ] [User guide](USER_GUIDE.md) in the agreed delivery languages/formats.
- [ ] [Training guide](TRAINING_GUIDE.md) and completed training record for one session of up to two hours.
- [ ] [Privacy and safety policy](PRIVACY_AND_SAFETY.md), named support/security contacts, processor approval, retention decision, and employee notice/consent decision.
- [ ] Database schema/types, API contracts, test fixtures, migration/rollback notes, and backup plus Storage-object restore evidence.
- [ ] Web deployment and, because the Company later requested expanded scope, iOS/Android build/signing/store handoff artifacts or an explicit owner-account blocker.
- [ ] External account/credential ownership transferred without putting secrets in the repository, chat transcript, certificate, screenshots, or ordinary logs.

## Contract acceptance demonstrations

### Access and history

- [ ] A Company-authorized synthetic Korean-language user enrolls/signs in; an unknown or uninvited identity cannot join.
- [ ] A Company-authorized synthetic Spanish-language user enrolls/signs in.
- [ ] Both users can reopen authorized history and basic search without seeing another organization or unauthorized conversation.
- [ ] Session listing/revocation, privileged MFA, and suspended-member denial are demonstrated.

### Korean to Spanish

- [ ] The Korean-language user sends a Korean original in the live conversation without copy/paste or a manual language switch.
- [ ] Server-side detection records Korean with detector provenance rather than trusting a profile/client claim.
- [ ] The Spanish-language recipient sees the original and in-line Spanish translation, with status/provenance and one-tap original access.
- [ ] Numbers, units, date/time, negation, urgency, names, and synthetic equipment identifiers match or are visibly flagged for review.
- [ ] Provider delay/failure leaves the original usable and produces a clear retryable/terminal derived state.

### Spanish to Korean

- [ ] The Spanish-language user replies in Spanish without copy/paste or a manual language switch.
- [ ] Server-side detection records Spanish with detector provenance.
- [ ] The Korean-language recipient sees the original and in-line Korean translation.
- [ ] The same invariant and degraded-mode checks pass in the reverse direction.

### Conversation/shift summary

- [ ] An authorized user selects or triggers an exact conversation/shift source window.
- [ ] The generated structured draft contains a required primary topic, concise summary, key topics, decisions, proposed action items, and ambiguities.
- [ ] Factual decisions/actions link to authorized source messages; the ordered source IDs and fingerprint are stored.
- [ ] The reviewer opens cited originals, corrects a seeded mistake, and approves the exact corrected version.
- [ ] Approval does not modify originals, issue a handoff, acknowledge a notice, or assign work.
- [ ] An unauthorized/former member cannot request, generate, search, or read the summary.
- [ ] An edited/deleted/expired source supersedes or invalidates the affected draft.
- [ ] AI-disabled/provider-failed mode leaves original conversation/history and manual operational work available.

## Expanded product demonstrations

- [ ] Chats shows independent DMs and groups, reply/thread/mention/reaction, delivery/read states, copy/forward provenance, pin, delete-for-me, edit/delete-for-everyone policy, report, and block.
- [ ] People distinguishes verified directory, saved contact, favorite, connection policy, scoped unit access, and block.
- [ ] Updates distinguishes ordinary messages, official versioned updates, delivery, read, and deliberate acknowledgement.
- [ ] Work distinguishes a reviewed conversation summary, an issued/signed handoff, incoming acknowledgement, and human-confirmed action.
- [ ] Private attachment quarantine, malware/integrity scan, clean-only grant, expiry, deletion, and copied-URL denial pass.
- [ ] Native and installed-web offline sends survive restart, reauthorize on reconnect, preserve order, and deduplicate.
- [ ] Realtime reconnect backfills correctly; suspension removes active access inside the target and disables push/session destinations.
- [ ] English, Korean, and Spanish product localization plus core accessibility journeys pass on supported web/iOS/Android targets.
- [ ] Locked-screen push contains no confidential text by default, and provider ticket versus delivery receipt is recorded honestly.

## Release and security evidence

- [ ] Commands and results in [acceptance test plan](ACCEPTANCE_TESTS.md) are attached with date, environment, commit, runner, owner, and reviewer.
- [ ] The working [release evidence ledger](RELEASE_EVIDENCE.md) has been reconciled to the immutable candidate; every preliminary, not-run, blocked, and external result remains truthfully labeled.
- [ ] No unresolved Critical/High code, dependency, infrastructure, mobile, API, Auth, RLS, Realtime, Storage, or privacy issue remains.
- [ ] Production project, domain/TLS, custom SMTP/Auth delivery, Turnstile, scanner, push, backup/PITR, object restore, observability, support, and incident ownership are configured and tested, or the release is explicitly marked blocked.
- [ ] OpenRouter/AI egress has Company approval, processor/region/DPA/subprocessor review, budget/kill switch, and qualified Korean–Spanish evaluation; otherwise it remains disabled.
- [ ] Data retention, deletion, investigation, export, role delegation, DM policy, urgent notice, device, and employee notice/consent decisions are recorded by the Company.
- [ ] The old ChatGPT Sites prototype is not linked, routed, presented, or used as the delivered application.
- [ ] Production smoke, rollback, provider-kill-switch, incident tabletop, database restore, separate object restore, and post-restore authorization reconciliation are attached.

## Open items and disposition

```text
Item / requirement:
Severity and user impact:
Reproduction/evidence:
Within agreed scope?:
Owner:
Target date:
Disposition (fixed / accepted exception / blocked / change order):
Approver:
```

## Acceptance record

This section mirrors the evidence needed for the agreement's Exhibit B but does not replace a signed Company certificate.

```text
Final delivery date:
Version / immutable repository reference:
Deployment location(s):
Training session completion date and attendees/roles:
Open items: none / attached list
Company review window started:
Company written deficiency notice received: yes / no, date
Acceptance status: accepted / accepted with listed items / not accepted
Company authorized signer and date:
Contractor acknowledgement and date:
Thirty-day defect-warranty period start/end (only after final acceptance):
```

Do not fill in signatures, acceptance, warranty dates, or production status on anyone's behalf. Those are external actions and evidence, not software-generated facts.
