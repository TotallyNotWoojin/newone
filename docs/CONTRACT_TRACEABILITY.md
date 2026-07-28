# Product requirement traceability

This file maps the product requirements extracted from the supplied contractor agreement to the implementation. It is an engineering checklist, not a legal interpretation of the agreement.

| Requirement | Implementation | Proof / release note |
|---|---|---|
| Real-time in-line Korean ↔ Spanish chat | Responsive chat, source/translation pair, 4.5-second visible polling | Near-real-time MVP; original is sent independently before translation |
| No copy/paste translation workflow | Automatic post-send translation and recipient-language-first rendering | OpenRouter requires approved credentials and release switch |
| Automatic language detection/routing | Hangul/Latin detection, mixed/short warning, ko/es runtime validation | AI detected-language mismatch is persisted and displayed |
| Automatic thread/shift summaries | Manager session auto-refresh after eight new messages or a handoff; manual refresh also available | Strict JSON, source fingerprint, source links, deduped actions |
| Basic company-personnel authentication/access | Private Sites identity, mandatory production allowlist, roles, active state, explicit thread membership | Ingress header stripping/replacement must be verified in deployment |
| Message history and basic search | D1 history, newest 300-message active window, POST search over source/translation/name | Full retention policy and archival window remain Company decisions |
| Web/mobile access and current browsers | Responsive desktop/tablet/mobile UI and web manifest | Native apps are not required |
| Failure handling | Original-first persistence, provider status, retryable claims, current-tab outbox, generic API errors | Tab-close durability is intentionally not claimed without managed-device storage policy |
| Secrets not hardcoded | Server-only environment credential, example file contains blanks | Company owns production key and rotation |
| Deployment and documentation | Sites configuration, migration, README, deployment/user/architecture/safety/test docs | Production Company configuration and approvals still required |
| Training | User guide plus training checklist in deployment guide | Training delivery is a human/company activity |
| Privacy/safety limitations and human review | Persistent originals, warnings, source links, emergency reminder, high-impact review policy | AI egress blocked until approval/DPA/quality gates pass |

## Added beyond the minimum

- Exact OpenRouter provider-region pinning with ZDR, data denial, cache off, and fallback off
- Separate data-egress approval switch
- Idempotent message, translation, and summary workflows
- Runtime request and model-output validation
- Latest-window message query that remains correct beyond 300 messages
- Manager-only brief/action mutation with action audit events
- Foreign keys and database enum checks
- Security headers and private no-store APIs
- Search query moved from URL to POST body
- Model-cost and bilingual golden-set evaluation plan
- Production runbook, rollback steps, and release blockers

## Explicitly outside this MVP

Native iOS/Android binaries, voice/video, emergency alarm replacement, automated employment decisions, guaranteed offline durability after closing the tab, and unreviewed high-impact translations remain outside the product boundary.
