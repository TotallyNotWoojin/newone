# Newone user guide

Newone is a company-owned workplace messenger for web, iOS, and Android. It lets verified coworkers use private direct messages, groups, official updates, shift handoffs, and Korean-Spanish translation without exchanging personal phone numbers.

This guide describes the intended employee-pilot product. A control is available only when the organization enables it and the signed-in membership has permission.

## Safety boundary

Newone is not an emergency alarm. For an immediate hazard, use the site alarm, radio, supervisor, evacuation, lockout/tagout, or other required emergency procedure first.

Delivery, read state, translation, and acknowledgement mean different things:

- **Delivered**: an eligible client or device accepted the item.
- **Read**: the recipient opened it.
- **Acknowledged**: the recipient deliberately confirmed it.
- None of these proves comprehension. Use the approved teach-back or human-review process for critical instructions.

## Enroll and sign in

1. Open the invitation issued for your employee record.
2. Verify the intended email, phone, or separately delivered employee code.
3. Complete the configured passwordless or password flow.
4. Enroll a second factor when your role requires it.
5. Review the organization name and your verified profile before continuing.

There is no public workspace registration. Never forward an invitation, OTP, recovery link, or QR code. Newone support will never ask for one.

## Chats

Chats combines direct and group conversations in recency order. Use filters for unread, direct, groups, and official communication; search can find permitted people and message history.

To start a direct conversation:

1. Open **People**.
2. Find the verified coworker by name, role, site, or team.
3. Save them as a contact if useful.
4. Select **Message**. Depending on company policy, a connection request may need acceptance first.

To create a group, choose **New group**, add the intended members, confirm the name and purpose, then review the membership before creating it. Group owners/admins can manage membership within their delegated scope. A person added later does not automatically receive earlier history unless policy explicitly permits it.

## Send and receive messages

- Newone stores the sender's original text first.
- A stable local send identifier makes retries safe after poor connectivity.
- Pending, sent, delivered, read, and failed states are shown separately.
- Reply, react, edit, delete, copy, forward, pin, and report controls appear only when policy allows them.
- Offline messages remain in the encrypted native outbox and reconcile after reconnect. Web offline storage is organization-controlled.

For operational messages, include the exact location, equipment/part ID, quantity, unit, time, condition, and requested action. Never assume a translation corrected an ambiguous source.

## Translation

Incoming messages can show an approved translation in your preferred language while keeping the labeled original visible. Newone detects the original language on the server; the label may show Korean, Spanish, English, mixed, or unknown plus an ambiguity warning. Your profile language helps choose the translation you receive but is not treated as proof of what the sender wrote. Translation may be queued, ready, need review, or fail; original messaging continues in every state.

Human review is required before relying on machine translation for safety, legal, disciplinary, medical, payroll, immigration, accommodation, or other high-impact communication. Numbers, units, negation, urgency, deadlines, and equipment identifiers deserve explicit verification.

Use **Report translation** to identify an error. A correction creates a traceable derived version; it never overwrites the sender's original record.

## Conversation and shift summaries

An authorized conversation member or supervisor can request a summary of a permitted source window. An organization may also enable an automatic draft at a configured message threshold or shift boundary. A summary shows its primary topic, concise account, key topics, decisions, proposed action items, ambiguities, cited source messages, and AI/human-review status.

1. Confirm that the selected conversation and time/message range are correct.
2. Wait for **Ready for review**; a queued, failed, or unavailable summary does not stop ordinary messaging.
3. Open the cited originals for any important claim, decision, number, unit, identifier, owner, or deadline.
4. Correct or reject unsupported text, then approve only the exact version you reviewed.
5. Confirm proposed actions separately before assigning an owner or due time.

A summary is a derived convenience layer. It does not edit the conversation, acknowledge an update, assign work, or issue a shift handoff. If a source message changes or is removed under policy, Newone supersedes the affected summary rather than silently presenting it as current.

## Files and photos

Choose the attachment control to take a photo, select an image, or choose an approved document. Upload does not make a file immediately readable: Newone validates type/size, uploads it to a private quarantine path, scans it, and marks it available only when clean.

Blocked or failed files cannot be opened. A copied link does not bypass conversation membership and expires quickly.

## Updates and critical notices

**Updates** contains official communication outside ordinary chat noise. Each update shows its publisher, audience, version/correction state, severity, publication time, and translation status.

Authorized publishers choose exactly one base audience: the company, the current update channel, or one or more sites/departments/teams/units. They can then narrow it by exact job title or configured operational role, account access role, preferred language, and people currently on an authoritative shift. Preview the count, exclusions, and notification languages after every selector change. A scheduled update is evaluated again when it actually publishes, so a person who moved shifts or left the company is not retained from an earlier preview.

If acknowledgement is required, read the original/approved translation and select **Acknowledge** deliberately. Supervisors can see delivery and acknowledgement gaps for the targeted notice without opening unrelated private chats.

## Shift handoffs and actions

**Work** contains source-linked shift handoffs and confirmed operational actions.

1. The outgoing lead selects the time window and source messages.
2. Newone may draft a summary when approved AI processing is available.
3. A person edits and signs the outgoing version.
4. The incoming lead reviews the sources and acknowledges the exact signed version.
5. Any extracted action begins unconfirmed; a person verifies its owner and timing.

AI output cannot silently assign work or modify a signed handoff.

## Notifications, availability, and privacy

Configure per-conversation mute, mentions, quiet hours, language, and preview preferences in **You**. The organization can restrict previews on locked screens. Presence is approximate and must not be treated as attendance or productivity evidence.

Blocking stops optional direct contact but does not suppress required official notices. Reporting creates a scoped safety record; it does not give an ordinary administrator access to all private messages.

## Devices and account security

In **You → Password**, add or change a password so you can sign in with your email and password. A one-time code sent to your email always works too, and it is the way back in if you forget the password: there is no separate reset link.

In **You → Devices and sessions**, review active devices and revoke anything unfamiliar. Sign out before returning or replacing a device. A suspended account loses new access even if an older token has not reached its nominal expiry.

On shared equipment, use only an organization-approved shared-device mode. Shared devices are not permitted during the initial employee pilot.

## Administrator guide

The role-gated web administration surface manages organization units, members, invitations, dynamic groups, devices, session revocation, update audiences, retention policy, audit metadata, and launch-gate evidence. It does not provide a browse-all private-message inbox.

High-risk actions require MFA/recent authentication, reason, scope, expiry where applicable, and an audit record. Suspension must revoke sessions and push destinations and remove future authorization atomically.

## Support

Use **You → Help and support** for access trouble, lost devices, abuse reports, translation incidents, or accessibility issues. Do not paste message bodies, credentials, OTPs, invite tokens, or signed file links into an ordinary support ticket unless a separately authorized diagnostic workflow requests a minimized sample.
