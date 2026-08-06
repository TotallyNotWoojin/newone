# Newone training guide

Status: delivery-ready agenda; live delivery remains a Company/contractor acceptance activity
Last updated: August 3, 2026

## Purpose

This guide supports the one training session of up to two hours required by the supplied contractor agreement. It is designed for a mixed group of employees, supervisors, publishers, administrators, support staff, and bilingual reviewers. Training must use synthetic accounts and messages until the release gates permit employee data.

Training is not proof that the product is deployed, accepted, or safe for live employee information. The trainer records the environment, release/commit, attendees, devices, languages, exercises completed, unresolved questions, and follow-up owner.

This guide assumes an isolated, genuinely hosted training or development backend populated with approved synthetic accounts through the normal server contracts. There is no in-client fictional-data bypass. Until that hosted environment and the required accounts/providers are provisioned and exercised, the training journeys remain pending rather than simulated locally in the client.

## Required preparation

The trainer must complete these checks before the session:

1. Use an isolated training or development organization with Korean-, Spanish-, and English-language synthetic users.
2. Confirm the exact web URL and installed iOS/Android build IDs. Do not use the decommissioned ChatGPT Sites prototype.
3. Prepare employee, supervisor, communications publisher, people administrator, security administrator, and language-reviewer accounts with least-privilege scopes.
4. Confirm sign-in email/SMS delivery, CAPTCHA, MFA for privileged users, Realtime, Storage scanning, push test credentials, and the support contact.
5. Confirm whether AI egress is enabled for synthetic training data. If disabled, demonstrate the intended degraded state instead of entering real content.
6. Load a bilingual glossary containing synthetic equipment IDs, dates, units, names, and ambiguous short phrases.
7. Prepare one disconnected or throttled device for offline/reconnect exercises.
8. Prepare one synthetic critical update, one source-linked shift summary/handoff, one harmless attachment, one connection request, and one report case.
9. Verify screen sharing and recording policy. Do not record message content, OTPs, recovery codes, access tokens, or employee personal information.

## Learning outcomes

At the end of the session, participants should be able to:

- sign in through the company-controlled flow and protect/revoke a session;
- distinguish Chats, Updates, People, Work, and You;
- find a verified coworker and understand contact, connection, favorite, mute, and block as different controls;
- use DMs and groups, including reply, mention, reaction, copy, forward, pin, delete-for-me, and report where policy permits;
- understand sent, delivered, read, acknowledged, queued, failed, and retried states;
- view the original and translated text, interpret detected-language/ambiguity labels, and report a translation problem;
- request, inspect, correct, and approve an authorized summary without treating it as the original record or an issued handoff;
- read and deliberately acknowledge an official critical notice;
- draft, review, sign, and acknowledge a source-linked handoff;
- operate during an AI, push, scanner, or network outage without losing the original message workflow;
- find security, privacy, accessibility, language, device, and support controls;
- explain the boundaries: Newone is not an emergency alarm, a qualified interpreter, an employee-performance system, or end-to-end encrypted while server processing is enabled.

## Two-hour agenda

| Time | Audience | Topic and exercise | Evidence |
|---|---|---|---|
| 0:00–0:10 | Everyone | Product purpose, navigation, original-first model, privacy/security boundaries, support and emergency paths | Opening questions recorded |
| 0:10–0:25 | Everyone | Invitation/sign-in, CAPTCHA, verification, session/device list, MFA for privileged accounts, sign-out and recovery | Each role signs in; one test session revoked |
| 0:25–0:45 | Everyone | People search, verified profiles, saved contacts/favorites, connection policy, DM, group, block and report | Pair completes directory-to-DM journey |
| 0:45–1:05 | Everyone | Message composer, offline send/retry, reply/mention/reaction, attachments, copy/forward/pin/delete-for-me, delivery/read state | Bilingual message and queued-send exercise completed |
| 1:05–1:20 | Everyone | Automatic language detection, Korean–Spanish translation, original reveal, ambiguity, correction/reporting, high-impact warning | Reviewer checks IDs/numbers/units and corrects a synthetic error |
| 1:20–1:35 | Supervisors and reviewers; others observe | Authorized conversation/shift summary, cited originals, primary topic, decisions, proposed actions, ambiguity, correction and approval | Exact summary version approved; source links opened |
| 1:35–1:47 | Everyone | Updates versus chat, critical notice delivery/read/acknowledgement, correction and escalation semantics | Each participant deliberately acknowledges a test notice |
| 1:47–1:57 | Supervisors/admins | Handoff signoff/incoming acknowledgement, action confirmation, role scope, suspension/session revocation, audit metadata | Synthetic handoff completed; forbidden admin action demonstrated |
| 1:57–2:00 | Everyone | Help, quick knowledge check, unresolved questions, support contacts and follow-up | Attendance and completion recorded |

If a role-specific topic does not apply to the attendees, spend the time on hands-on messaging, accessibility, low-bandwidth, or language practice. Do not extend beyond two hours without a separately agreed session.

## Hosted training exercise script

### 1. Identity and security

1. Open the exact Newone application or company-controlled web origin.
2. Enter the invited identity and complete the generic OTP/code flow. Explain why the product does not confirm whether arbitrary employee identities exist.
3. Complete CAPTCHA and, for a privileged role, TOTP MFA.
4. Open **You → Security and devices**. Identify the current platform, last-used time, and approximate security signal.
5. Revoke a different synthetic session and confirm that it cannot refresh or call an authenticated API.
6. Explain that a company administrator can suspend access but an ordinary administrator cannot browse all private conversations.

### 2. People and chat

1. In **People**, search a Korean or Spanish display name and an approved alias with/without accents.
2. Verify company/site/team context without exposing personal phone or email details.
3. Save the person as a contact and favorite. Explain that this does not grant access or notify the other person.
4. If the organization uses request-first DMs, send and accept a connection request before messaging. If directory-open is configured, explain the difference.
5. Create a small group, add only synthetic members, and show role/membership controls.
6. Send an original message, reply to it, mention a member, add a reaction, copy it, forward with provenance, pin it, and delete it only for the current user.
7. Report a test message, then show that the review case contains only the consented message/context scope.

### 3. Language and summaries

1. Send one Korean and one Spanish message containing a date, quantity, unit, negation, and synthetic equipment ID.
2. Show detected language, confidence/ambiguity, translation state, target language, original reveal, and provider/human-review provenance.
3. Send a deliberately short or mixed-language phrase and show the unknown/mixed warning. Never tell participants that uncertain output is authoritative.
4. Request a summary for the authorized source window. Inspect primary topic, concise summary, key topics, decisions, proposed action items, ambiguities, source fingerprint, and citations.
5. Open every cited original needed for the exercise, correct one synthetic mistake, and approve the exact revised version.
6. Confirm that approval did not assign an action, issue a handoff, acknowledge a notice, or edit any source message.

### 4. Official updates, handoffs, and degraded mode

1. Publish a synthetic update to a previewed audience and distinguish delivery, read, and acknowledgement.
2. A recipient opens and deliberately acknowledges the exact notice version.
3. Create a handoff from authorized sources, edit it, sign it as the outgoing supervisor, and acknowledge it separately as the incoming supervisor.
4. Disable the synthetic AI route or use the prepared failure toggle. Confirm original chat, attachments already marked clean, search of existing content, manual handoff, and acknowledgement still work.
5. Go offline, queue a short message, close/reopen where the approved platform supports durable outbox, reconnect, and confirm one deduplicated durable message.

## Participant knowledge check

Ask each participant or group to answer these questions without prompting:

1. What is the canonical record when a translation or summary differs from a message?
2. What is the difference between delivered, read, and acknowledged?
3. Does saving a contact grant that person access? Does blocking suppress required company notices?
4. What should you do when detected language is unknown or a safety translation seems wrong?
5. Does approving an AI summary assign work or issue a shift handoff?
6. Where do you revoke a lost device/session, and who is the company support contact?
7. What must you do during an emergency instead of relying solely on Newone or AI output?

The trainer records misunderstood answers and repeats the relevant exercise. Completion means the participant performed the core journey and understood the safety boundary; attendance alone is not sufficient evidence.

## Accessibility and language accommodation

- Offer the session and support material in Korean, Spanish, and the organization's fallback language.
- Ask participants which product language they prefer without inferring proficiency from role, name, or device locale.
- Demonstrate VoiceOver/TalkBack or keyboard navigation, visible focus, dynamic text/zoom, reduced motion, and non-color status labels.
- Provide a device and private assistance for participants who cannot or should not use a personal phone.
- Do not display one participant's OTP, recovery information, private chat, notification preview, or personal contact data to the room.

## Completion record template

```text
Training date/time and timezone:
Trainer:
Environment and organization:
Release commit/tag:
Web origin and native build IDs:
AI egress state and synthetic-data confirmation:
Attendee roles (avoid unnecessary personal data):
Languages/accommodations provided:
Exercises completed:
Security/session revocation exercise result:
Translation and summary exercise result:
Critical-notice and handoff exercise result:
Accessibility exercise result:
Unresolved questions/defects:
Follow-up owner and due date:
Company acknowledgement/sign-off:
```

Store the completed record in the Company's approved release-evidence system, not in application message content or this source repository unless explicitly approved.

## Related material

- [User guide](USER_GUIDE.md)
- [Acceptance and release tests](ACCEPTANCE_TESTS.md)
- [Deployment runbook](DEPLOYMENT.md)
- [Privacy and safety](PRIVACY_AND_SAFETY.md)
- [Full product requirements](FULL_PRODUCT_REQUIREMENTS.md)
- [Third-party components](THIRD_PARTY_COMPONENTS.md)
