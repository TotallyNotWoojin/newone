# Newone product research: WhatsApp and frontline communications

Research cut-off: July 27, 2026

## Executive conclusion

Newone should copy WhatsApp's interaction model, not WhatsApp's identity or governance model.

The product pattern is:

> WhatsApp-familiar messaging + frontline operations workflows + enterprise identity and governance + purpose-built Korean-Spanish translation.

WhatsApp succeeds because it opens to a recency-ordered inbox of people and groups, messages take almost no training, and the same mental model works on a phone and the web. A company communications system needs that simplicity, but it also needs company-owned accounts, immediate offboarding, scoped administration, retention, acknowledgements, auditability, and structured operational workflows.

The old one-channel prototype does not fit this product model and is not the foundation for the replacement client.

## What WhatsApp actually is

### Core information architecture

WhatsApp is not one room. Its stable product surfaces are:

- **Chats:** a single recency-ordered inbox mixing direct messages and groups, with avatars, previews, timestamps, unread counts, pinned items, drafts, and filters such as All, Unread, Favorites, and Groups.
- **Conversation:** message bubbles, date and unread dividers, delivery state, quoted replies, reactions, mentions, attachments, voice notes, search, and a participant or group header.
- **Groups:** named conversations with a profile, description, participant list, admin roles, invite approval, polls, events, shared media, and moderation.
- **Communities:** an umbrella that organizes related groups and provides an announcement space. This maps naturally to company, site, department, line, and shift.
- **Channels/Updates:** one-to-many broadcasts kept out of the personal chat list.
- **Calls:** separate history and actions for voice and video.
- **Settings:** profile, privacy, notifications, storage, account security, linked devices, and per-chat controls.

Sources: [WhatsApp Messaging](https://www.whatsapp.com/messaging), [chat filters](https://about.fb.com/news/2024/04/whatsapp-chat-filters/), [Groups](https://www.whatsapp.com/groups), [Communities](https://www.whatsapp.com/communities/learning), [Channels](https://www.whatsapp.com/channels), and [Calling](https://www.whatsapp.com/calling).

### Interaction patterns worth adopting

| WhatsApp pattern | Why it works | Newone treatment |
|---|---|---|
| Mixed DM and group inbox | People scan one list instead of choosing a collaboration abstraction first | One Chats inbox, with optional filters for DMs, groups, announcements, unread, favorites, site, and shift |
| Avatar, message preview, time, unread badge | High information density without opening a thread | Use the same scan hierarchy; add language/priority state only when action is required |
| Fast compose from a contact | Starting a private conversation is low friction | Compose from a verified company directory, never an uploaded personal address book by default |
| Quoted replies and reactions | Preserve context without forcing formal threads | Include in DMs and groups; reserve nested threads for structured announcements or incidents |
| Sent, delivered, and read states | Makes reliability visible | Preserve all three; add an explicit acknowledged state for operational notices |
| Long-press message actions | Keeps the main surface clean | Reply, react, copy, translate/original, report, pin, and message info |
| Group info and admin controls | Membership is inspectable and manageable | Add owner/admin/member roles, join approval, audit history, and company policy constraints |
| Communities and announcement groups | Separates organization from conversation | Company > site/department > team/shift groups, plus official announcements |
| Per-chat mute and notification controls | Prevents overload | Add quiet hours, on-shift routing, mention-only mode, and a governed urgent override |
| Multi-device continuity | Workers can move between phone, tablet, and desktop | iOS, Android, responsive web/PWA, device inventory, and remote revocation |

WhatsApp also supports events and organized announcement replies, group member role tags, large file sharing, group voice chat, and group-history sharing for new members. These are useful references for later phases, but Newone should not copy public Status stories, public channel discovery, ads, commerce catalogs, creator tooling, or entertainment-first features. Sources: [events and announcement replies](https://about.fb.com/news/2024/05/events-in-whatsapp-communities/), [member tags and reminders](https://about.fb.com/news/2026/01/whatsapp-group-chats-member-tags-text-stickers-event-reminders/), and [group message history](https://blog.whatsapp.com/introducing-group-message-history-a-more-private-way-to-catch-up-in-group-chats).

### Translation lesson

WhatsApp introduced translation for DMs, groups, and Channels, and Android can automatically translate an entire conversation. Its privacy advantage is that translation runs on the device. Initial Android coverage included Spanish but not Korean, and platform coverage differs. Newone cannot depend on the operating system to provide reliable Korean-Spanish translation. [WhatsApp message translation](https://about.fb.com/news/2025/09/introducing-message-translations-whatsapp/)

Newone should therefore:

- Store the original text as the canonical message.
- Render a per-recipient translation beneath or in place of the original, with one-tap original reveal.
- Show translating, translated, failed, corrected, and human-reviewed states.
- Translate attachment captions independently from the attachment.
- Support a company glossary for names, equipment, safety terms, and approved phrasing.
- Keep AI summaries and extracted actions linked to their source messages.
- Never describe cloud-translated messages as end-to-end encrypted.

## How companies use WhatsApp-like systems

Companies do not use one giant room. They use different communication objects because privacy, urgency, membership, retention, and accountability differ.

### Everyday conversation

- Private employee-to-employee and employee-to-manager DMs.
- Temporary group DMs for a project, repair, incident, or event.
- Persistent groups by site, department, production line, shift, maintenance, safety, and quality.
- Guest conversations for vendors or contractors, clearly labeled and isolated.

### Official communication

- Company, site, or department announcements with replies disabled or organized separately.
- Targeted updates by role, location, language, and current shift.
- Training events, maintenance windows, and schedule-change reminders.
- Critical notices with an acknowledgement deadline, reminders, escalation, and an SMS fallback.

### Operational workflows

- Shift handoffs with production status, open issues, blockers, owners, deadlines, and urgent actions.
- Safety, maintenance, quality, HR, and translation-review queues.
- Tasks created from messages but confirmed by a person before becoming an operational record.
- Fast polls for availability, staffing, meals, transport, or low-risk decisions.
- Voice notes with transcript and translation when workers cannot easily type.

## What existing workplace products teach us

| Product | Relevant strength | Lesson for Newone |
|---|---|---|
| Microsoft Teams | Shifts, shift-based tags, shared-device mode, conditional access, retention, legal hold, eDiscovery | Route by who is working; treat shared devices and governance as first-class |
| Slack | Channels, DMs, search, workflows, retention, audit, DLP, legal hold | Make operational history searchable and integrations extensible without adopting its knowledge-worker density |
| Connecteam | Company chat, smart groups, directory, updates, acknowledgements, help desk, forms | Closest frontline workflow reference; automatic role/location group membership is essential |
| Beekeeper | Streams, campaigns, acknowledgements, tasks, escalation branches, translation | Separate chat, targeted broadcasts, and structured workflows |
| Staffbase | Mobile-first targeted news, acknowledgements, translation, SCIM/SSO, analytics | Official communication needs delivery and acknowledgement analytics |
| Workvivo | Chat plus company feed, critical push, directory, translation, analytics | Keep a distinct Updates surface and show administrators who did not receive or acknowledge a notice |

Official references: [Teams frontline overview](https://learn.microsoft.com/en-us/microsoft-365/frontline/flw-overview?view=o365-worldwide), [Teams Shifts](https://learn.microsoft.com/en-us/microsoftteams/expand-teams-across-your-org/shifts/manage-the-shifts-app-for-your-organization-in-teams), [Slack security](https://slack.com/trust/security), [Connecteam communication hub](https://help.connecteam.com/en/articles/5951839-the-communication-hub), [Beekeeper Streams](https://help.beekeeper.io/hc/en-us/articles/26555056784028-Streams-Overview), [Staffbase acknowledgements](https://support.staffbase.com/hc/en-us/articles/33568358597010-Using-Acknowledgements-for-News-Posts), and [Workvivo acknowledgements](https://support.workvivo.com/hc/en-gb/articles/4917998046877-Read-Acknowledge-Posts-Articles).

### Targeting by current work context

Teams supports shift-based tags, Connecteam uses automatically maintained smart groups, and Beekeeper restricts Streams by site, team, or topic. Newone should model site, department, line, role, and scheduled shift as attributes, then use policy-controlled dynamic groups. Employees who change role or location should move automatically. Off-shift employees should not receive routine alerts.

### Acknowledgement is not a read receipt

These are different facts:

1. **Delivered:** a device or client received the item.
2. **Read:** the user opened the item.
3. **Acknowledged:** the user deliberately confirmed understanding or receipt.

Safety instructions, policy changes, and urgent operational notices require the third state. Connecteam, Beekeeper, Staffbase, and Workvivo all implement explicit acknowledgement and non-responder reporting. Newone needs a distinct critical-notice object instead of overloading a chat message.

### Shift handoff is a signed record

A handoff should include production status, open issues, task status, deadlines, blockers, responsible people, incoming/outgoing supervisors, and urgent actions. AI can draft it from messages; the outgoing supervisor must confirm it, and the incoming supervisor must acknowledge it. Each claim remains linked to messages, photos, incidents, or tasks. Reference: [Beekeeper shift handoff guidance](https://www.beekeeper.io/blog/shift-handover-templates/).

### Offboarding must be immediate

Deleting or disabling an identity provider account is not sufficient if an existing mobile session remains valid. Newone needs one action that suspends the membership, revokes all refresh tokens and device sessions, removes future group access, transfers ownership, and preserves prior company records according to policy. Relevant cautions: [Connecteam offboarding](https://help.connecteam.com/en/articles/8222038-what-happens-if-i-have-to-let-an-employee-go-will-they-still-have-access-to-the-chat) and [Beekeeper SSO lifecycle warning](https://help.beekeeper.io/hc/en-us/articles/26554133282972-Single-Sign-On-Overview).

## Why the WhatsApp Business products are not the backend

The WhatsApp Business App serves small businesses talking to customers. The WhatsApp Business Platform serves programmatic customer engagement, support, marketing, commerce, notifications, and verification. Neither is an internal workforce identity and records system. Sources: [Business App](https://whatsappbusiness.com/products/business-app/) and [Business Platform](https://whatsappbusiness.com/products/business-platform/).

Newone specifically needs:

- Employer-controlled identity and membership.
- Joiner, mover, and leaver automation.
- Internal directory and group policy.
- Private DMs that ordinary managers cannot inspect.
- Company retention, export, legal hold, and deletion rules.
- Tenant isolation and scoped administrators.
- Device/session inventory and immediate revocation.
- Korean-Spanish translation quality controls.

Government recordkeeping guidance describes WhatsApp as a non-corporate channel because the organization does not control access to its information. That distinction applies here even if no regulated-government use is planned. [UK Cabinet Office guidance](https://www.gov.uk/government/publications/non-corporate-communication-channels-for-government-business/using-non-corporate-communication-channels-eg-whatsapp-private-email-sms-for-government-business-html)

## Adoption findings for frontline organizations

Vendor case studies are directional evidence, not independent proof, but their patterns are consistent:

- Many workers do not have corporate email, so onboarding must support pre-provisioned employee IDs, verified phone numbers, QR enrollment, or temporary access codes.
- Content must target site, role, team, and current shift; a global feed becomes noise.
- Common actions must take only a few taps.
- Native mobile apps and a real web client are both necessary.
- Shared company devices require fast sign-out and no residual employee data.
- Off-shift boundaries should be respected except for explicitly classified emergencies.
- A pilot should include workers and supervisors from different shifts, sites, languages, device types, and technical comfort levels.

Examples: [Cladtek mobile-first manufacturing deployment](https://staffbase.com/customers/cladtek), [Rone Engineering replacing texts and WhatsApp](https://connecteam.com/case-studies/rone-engineering/), [Toyota L&F searchable frontline workflows](https://slack.com/customer-stories/toyota-story), and [BACA Systems traceable safety workflows](https://slack.com/customer-stories/baca-systems-story).

## Product boundary

### Must exist before an employee pilot

- Independent Newone identity, domain, and hosting with no ChatGPT dependency.
- Native iOS and Android app plus responsive web/PWA.
- Company workspace, verified accounts, directory, contacts/connections, and role-scoped administration.
- DMs, group DMs, persistent groups, and announcement-only spaces.
- Membership by site, department, role, line, and shift.
- Realtime delivery, offline outbox, ordering, cursor pagination, drafts, replies, reactions, mentions, delivered/read states, and retry.
- Images and operational documents with private storage, malware scanning, and signed downloads.
- Search across people, groups, original text, translations, sender, date, and files.
- Per-user Korean-Spanish translation, original reveal, corrections, glossary, and human review.
- Structured shift handoffs with source links, outgoing signoff, and incoming acknowledgement.
- Critical notices with acknowledgement, reminders, escalation, and SMS fallback.
- Quiet hours, shift-aware notifications, and controlled urgent override.
- Admin console for people, roles, sites, groups, retention, reports, devices, and audit events.
- Immutable security and administrative audit trail for authentication, membership, role, policy, export, external-processing, and investigator-access events.
- Immediate account suspension, session revocation, and future-access removal.
- Reporting, blocking, moderation, backup, restore, export, and configurable retention.

### Required before broad rollout

- SSO/OIDC or SAML and SCIM/HRIS lifecycle integration.
- Shared-device and MDM policy before any shared hardware is enabled; shared kiosks, pooled tablets, and shift phones are prohibited during the employee pilot.
- Retention schedules by conversation type and legal hold/eDiscovery where required.
- Enterprise audit export, SIEM integration, and longer-term archival where required.
- Data-loss prevention and sensitive-data classification.
- Tenant key and data-residency strategy.
- Expanded disaster-recovery exercises, contracted operational SLAs, formal incident response, and scaled support tooling beyond the pilot baseline.
- Delivery, acknowledgement, translation-quality, and unresolved-handoff analytics.
- Formal low-bandwidth and Korean-Spanish safety terminology testing.

### Later expansion

- Voice notes with transcription and translation.
- Push-to-talk/walkie-talkie.
- Voice/video calling and screen sharing.
- Scheduling, clock-in, shift swaps, payroll, ERP, maintenance, and quality integrations.
- Digital signage, surveys, recognition, and guest/federated organizations.
- Customer-controlled encryption keys and advanced DLP integrations.

## Product positioning

> Newone is the company-owned, WhatsApp-familiar communications system for multilingual frontline teams: private messaging, operational groups, verified shift handoffs, and critical notices that every employee can understand and acknowledge.
