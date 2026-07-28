# Newone Relay user guide

## Purpose

Relay helps Korean- and Spanish-speaking employees share operational information while keeping the exact original message visible. It is a communication aid, not an emergency alarm and not proof that a recipient understood a message.

For an immediate hazard, use the plant alarm, radio, supervisor, evacuation, lockout/tagout, or other required site procedure first.

## Sign in and access

Sign in with the company-authorized account. A successful sign-in establishes identity, but conversations appear only when an administrator has assigned that account to them. Contact an administrator if the workspace says no conversations are assigned.

## Read messages

- Incoming messages show your preferred language first when a translation is ready.
- The original is always preserved directly below or above the translation.
- Captions identify the original language and the recipient view. Do not infer direction from flags.
- “Original delivered · translation pending” means the source message arrived even though AI is still working.
- A yellow “Verify translation” notice means the model found ambiguity or a source-language mismatch.
- “Human reviewed” applies only to that specific sample. It does not apply to later AI output.

## Send a message

1. Choose a structured type when relevant: Safety, Production, Maintenance, Quality, or Shift handoff.
2. Include exact location, equipment/part ID, quantity, unit, time, condition, and required action.
3. Confirm the detected language, especially for short or mixed-language text.
4. Press Enter or select Send. Use Shift+Enter for a new line.

Relay stores the original first. Translation failure never erases or retracts it.

When offline, messages remain in the current tab’s outbox and retry after connectivity returns. Keep the tab open. Closing or reloading it can discard unsent items; this avoids silently storing sensitive employee messages on a shared device.

## Safety and high-impact messages

Human review is required before relying on machine translation for:

- safety instructions or hazard response;
- legal, disciplinary, hiring, termination, or performance matters;
- medical, accommodation, or benefits information;
- payroll, immigration, or other high-impact decisions;
- a message where a number, unit, negation, deadline, or equipment ID could change the outcome.

When possible, ask the recipient to restate the critical instruction in their own words. A delivered or translated status is not confirmation of comprehension.

## Search

Select Search or press Command/Ctrl+K. Search accepts Korean, Spanish, equipment IDs, and names. A result identifies whether the match came from the original or translation. Filters narrow the current results to safety, maintenance, or quality messages.

Search is limited to conversations assigned to your account.

## Shift brief and action items

The brief panel shows a Korean or Spanish summary, source buttons, and action items. Source buttons jump back to supporting messages.

For manager/admin accounts, Relay automatically refreshes a brief when eight messages have arrived since the last brief or a Shift handoff message arrives. The same source set is deduplicated so repeated requests do not create duplicate actions. A manager can also request a fresh brief manually.

AI-created actions begin as “Needs confirmation.” A manager must verify the source, owner, and timing before treating the action as assigned. Status changes are recorded in an audit table.

## Sign out

Use the arrow beside your profile in the left rail. On shared equipment, close the browser after signing out.
