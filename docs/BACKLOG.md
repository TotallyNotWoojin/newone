# Backlog (v3 and later)

Paused until the owner says go. Items are in rough priority order.

## Product

1. **Full-screen image viewer.** Done Sep 5 2026 (v2.5): tapping a photo opens it full screen from the preview URL with pinch-to-zoom on iOS and a download action; tap the image to hide the bar. Still open: pinch-to-zoom on Android (needs a gesture-handler zoom), swipe-to-dismiss, and inline video playback (no video player library is installed yet).
2. **People search only matches a username prefix.** `bff_search_users_by_username` matches `lower(username) LIKE '<query>%'`, and any query that isn't `^[a-z0-9][a-z0-9_]{1,29}$` returns an empty list silently — so uppercase, spaces, and Korean input find nobody with no explanation. Two real users (display names "DDONG" and "Kyle LEE", usernames `dongai77` and `leeiy0712`) could not find each other at all. Fix: also match display name, case-insensitively and across scripts; failing that, show "search by username, e.g. dongai77" and stop silently swallowing non-matching input. Consider an invite/share link so nobody has to know a username.
3. Password recovery / alternate sign-in path beyond the emailed code.
4. **Done Sep 6 2026 (v3.1, stream B):** snappier animations (screen transitions, sheet presentation).
5. **Done Sep 6 2026 (v3.1):** confirmation before declining a message request (a mis-tap currently declines immediately).
6. **Done Sep 6 2026 (v3.1):** the "Reconnecting…" status banner should overlay instead of pushing the list down (a tap aimed at a row can land on the row below when it clears).

## Engineering

6. **Done Sep 6 2026 (v3.1, "Translation delayed" state):** language detection retries: keep the revive cron, and surface a "translation delayed" state in the bubble while a provider outage lasts.
7. Branch-coverage gate: bring Jest branches back above 91% (currently 89.97%) with tests for the reconcile prune, the read-marking path, and the chip label.
8. Manual auth-user deletion from the Supabase dashboard fails on the profile foreign key (no cascade); the in-app delete-account path handles it.
9. Device suite: reuse accounts across areas to cut setup time; media-05 thumbnail tap in the Files picker still unverified.
10. Store listings in Spanish and Korean (the app already ships those languages).

## Follow-ups from v3 verification (Sep 5 2026)

11. Summaries call the other person "participant 1" because display names are not sent to the model. Send first names (or map participant labels back to names client-side) so a summary reads "Diego agreed to…". Done Sep 6 2026 (v3.1): the resolve RPC sends sender display names; the worker labels speakers by first name ("you" for the reader).
12. **Done Sep 6 2026 (v3.1, client follow-ups; see 21 for the server side):** chats-list preview from a live message event still shows the original language until the next reconcile; update the preview when the translation arrives (client, workspace.tsx message-event path).
13. **Done Sep 6 2026 (v3.1, stream C):** a real server-side "mute all notifications" (device_registrations.notifications_muted); today the Settings switch only reflects OS permission and deep-links to system settings.
14. **Done Sep 6 2026 (v3.1, migration held — see 22):** show @usernames in the group pickers (Add people, New group). The server can match handles now; to return them, first make both client parsers tolerate the key (`parseConversationMemberCandidatePage` does; `parseGroupCreationCandidates` uses exactKeys), ship that client, then add `username` to the SQL outputs — the reverse order broke shipped builds (defect AD).

## v3.1: summaries (owner decision, Sep 6 2026) — start after v3.0 ships

15. The reader defines each summary's scope; this REPLACES the "since last summary" boundary (owner, Sep 6 2026). Range chips: Unread (default when there are unread messages) · Today · Yesterday · Last 7 days · Everything; every request is independent, nothing is disqualified because an earlier summary covered it, and no covering-summary state is kept. The server fetches the range itself instead of relying on the client's loaded window (today the first summary covers only the loaded page, 50–100 messages). Done Sep 6 2026 (v3.1): range chips on the sheet; `bff_request_conversation_summary_scope` picks the messages (up to 2,000) from the reader's range.
16. Optional subject line ("What should this cover?") next to the range, passed to the model as the reader's instruction; chat text stays untrusted data. Scope line on the sheet and in the export reads e.g. "Last 7 days · 143 messages · about the trip". Done Sep 6 2026 (v3.1).
17. Server-side chunking for long ranges (summarize in slices, merge), lifting the 500-message / 20,000-character single-request caps and keeping the 15 s model timeout safe; a clear "too long, pick a shorter range" message instead of "Summary unavailable". Done Sep 6 2026 (v3.1): slices of at most 150 messages / 18,000 characters, per-slice structured output, one merge call; "Too long — pick a shorter range." on the sheet.
18. Show the stored Decisions and To-do lists under the prose when non-empty. Never show source citations (s0001-style refs or "open the cited original") — sleek, prose-first. Done Sep 6 2026 (v3.1).
19. Remove the leftover workplace warning copy from consumer screens: the summary disclaimer (`chat.summaryBoundary`), "authorized …" wording in search/member-search/actions descriptions, and the sign-in security note; keep the strings only where the workplace realm still uses them.
20. Owner (Sep 6 2026, 04:15): v3.0 ships as queued; v3.1 also takes the items missed in v3.0 — 4 (snappier animations), 5 (confirm before declining a request), 6 (Reconnecting banner overlays the list), 6b (translation-delayed state), 11 (names in summaries), 12 (live preview translation: a chat's preview line shows the original language until the next refresh when a message arrives while the list is open), 13 (server-side mute), 14 (@handles in group pickers).
21. Enqueue a realtime invalidation when a translation job completes (private.bff_complete_translation_job_impl) so bubbles and previews update the moment the translation lands instead of at the 30 s poll; the client follow-ups from stream B become a fallback.
22. HELD migration (now in supabase/migrations-held/) 20260907020000_candidate_payload_username.sql: apply only once v3.1 is the installed floor (re-timestamp past 20260907040000 first); v3.0 clients reject the extra key in the workplace group form.

## v3.2: sign-in flow, phone signup removal, status wording, username release (owner, Sep 6 2026 11:40) — right after v3.1 ships

24. **Done Sep 6 2026 (v3.2, stream D):** returning sign-in is one flow: email first → the service answers `{ exists, hasPassword }` (`POST /v2/auth/native/account/lookup`, web `/v2/auth/account/lookup`; rate-limited like a code request) → password field with a "Forgot password?" link → signed in; an unknown email gets "There's no account with that email." with a Create-account shortcut. Forgot password: emailed recovery code → "Set a new password" → signed in; the new password is written through the recovering session's own token (defect AF) and only then is the session activated. The "Email me a code / Use password" chips and the "Add a password" step are gone (owner, Sep 6 12:00: every pre-wipe account is deleted and signup already sets a password, so no account lacks one; a pre-wipe account without a password takes the forgot-password road). Returning sign-in becomes one flow: email first → if the account has a password: password field with a "Forgot password?" recovery link (emailed code → set a new password) → signed in; if the account has no password yet: password setup screen → email verification code → signed in. The "Email me a code / Use password" method chips go away. Server: a destination lookup that says whether a password exists (the app already reveals unknown accounts on this screen, so enumeration posture is unchanged); recovery = code-verified password set.
25. **Done Sep 6 2026 (v3.2, stream D):** the Email / Phone chips are gone everywhere (sign-in, signup, invitation); email only. The server phone paths stay inert (the lookup refuses a phone destination with 400). Remove the phone signup option (the Email / Phone chips); email only. Keep server phone paths inert.
26. Presence default wording: "On-site" → "Active" (consumer wording; check es/ko).
27. **Done Sep 6 2026 (v3.2, migration 20260907050000):** deleting an account frees the username: today the deletion tombstone quarantines the released username against re-registration (migration 20260901030000). Owner expects it to free up; decide the release rule (immediate, or a short cooldown) and implement.
28. Tests for each: unit (sign-in state machine, status label), Deno (lookup + recovery routes), hosted smoke (recovery flow, username release after deletion), device suite (auth area: new sign-in flow with password / without password / forgot password; negative: phone chips absent; sessions/profile: status label), then a full pass and release as 3.2.
29. **Done Sep 6 2026 (v3.2, 1317bbd):** header flash on first launch: the Chats header shows the workplace subtitle ("<organization> · On shift") for a moment before the bootstrap says the account is in the personal realm (app/index.tsx). Render the @handle line only once the realm is known; never the workplace line for consumers. (Owner saw it "for a split second when first logged in", Sep 6 2026.)
## v3.3 — dark mode and the navigation consolidation (owner, Sep 6 2026)

Ship together. The database is wiped right before release, as it was for v3.2.

23. **Dark mode.** Follows the phone's appearance setting; a Settings override adds System / Light / Dark, stored with the other device preferences. Bubbles stay green-tinted, not neutral. Scope: a dark palette for the 24 colour tokens with contrast checks, a theme provider, converting 39 stylesheets to read the theme at render time, and the edges (status bar, keyboard, modals, splash, tab bar, image viewer). The web app follows the same code. The owner judges the look from a dark contact sheet and TestFlight; the automated unit tests and full device pass still run for regressions.
30. **Chats owns search.** One box on Chats finds chats, messages inside them, people and groups. The Search tab goes away; navigation becomes Chats · People · Settings.
38. **That search behaves like the phone's own.** Order: people first, then chats and groups, then messages. Typing suggests people underneath the field; tapping one turns it into a chip and writes the comma itself, ready for the next name. Chips combine, so two people show the conversations containing both, which is how a group is found without its name. Names can also be typed straight through with commas. A chip clears with one tap. Group names match directly. Chips plus loose words mean "conversations with these people containing this word".
31. **People becomes Contacts.** Its search finds only people you already know; a row's main action is to start a chat. Finding strangers moves to the "+" menu.
32. **A "+" on the Chats header**, replacing the compose idea. Two plainly named choices: "Add a friend" (search by name or @handle, send a request) and "New group". Mockup to the owner before building.
35. **Group creation, rebuilt.** One screen, in order: group name, a small description box, a small round photo control, then the people. Name, description and photo are marked optional. Who can post and whether new members see earlier messages move into "Advanced options", collapsed, showing a one-line summary of the current setting when closed.
36. **At least three people in a group** (you plus two), said plainly on the form and enforced on the server at creation. A group that later drops to two because someone left keeps working.
37. **No duplicate groups.** The rule is the current member set, which always includes you. A group with exactly those members, whatever its name, is offered with a small "Open it" button instead of creating another. A group you left has a different member set, so making one with those people creates a new group; a group you were added to matches, so you are sent there. Needs an order-independent members signature on the server, maintained as people join and leave.
39. **Contacts and strangers are visibly separate** in the group picker and the add flow: "your contacts" first, "search everyone" underneath, so adding a friend and finding a stranger never look like the same action.
33. **See what your own messages become.** A Settings toggle that shows your sent bubbles the way recipients read them: your original plus its translation, in the same slim two-line form as incoming messages. Per-device preference like the others.
41. **Pinned messages have a place to live** (owner, Sep 6 2026 16:50). Pinning already works and is already tested, but nothing shows the pins: a chat's own pins open from its conversation settings, and a "Pinned" view on Chats gathers pins across every chat. Tapping one jumps to the message in place. (The device suite has recorded this as unreachable since v2: "No pinned-messages surface exists in the consumer UI".)
42. **Shared media in a chat** (owner, Sep 6 2026 16:50; owner flagged it as possibly out of scope). The phone's own "Photos" section for a conversation: a grid of everything sent in that chat, newest first, tapping opens the full-screen viewer already built, swiping moves between them. The server already records every attachment per conversation with its type and time, so this is a read view plus a grid, not new plumbing. Build it only if it does not delay the rest of v3.3; otherwise it is the first item of v3.4.

43. **More reactions** (owner, Sep 6 2026 17:00, approved). Replace the four (👍 ❤️ ✅ 👀) with 👍 ❤️ 😂 😮 😢 🙏 in one row, plus a "+" that opens the system emoji keyboard so any emoji works. The server already stores whatever emoji it is given; add a validation check for a single emoji.
44. **Tidy the long-press sheet for consumers** (owner approved Sep 6 2026). Hide the workplace review items (Propose correction, Review correction, provenance details). Remove "Delete for me" entirely. The sheet becomes: reaction row, Reply, Copy, Pin/Unpin, Forward, Translate for me, then Edit and Delete for your own messages.
45. **Editing closes after 15 minutes** (owner, Sep 6 2026 17:05). Edit is offered only within 15 minutes of sending; after that the action is gone. Enforce on the server as well as hiding it in the sheet, and keep the existing "edited" marker.
46. **Swipe right on a message to reply** (owner, Sep 6 2026 17:05), the iMessage gesture with the WhatsApp-style quoted reply we already render. Short drag, a reply arrow appearing under the bubble, snap back if released early, haptic tick on trigger. Works on both platforms; on desktop the existing Reply action covers it.

47. **Chosen from the gap survey** (owner, Sep 6 2026 17:15): (a) mark a chat unread; (b) swipe actions on a chat row — mute, archive, delete, where delete on a group means leaving it and says so; (c) a jump-to-latest button when scrolled up; (d) tapping a reply quote jumps to the original; (e) unsend inside the same 15-minute window as edit; (f) "@" mentions notify the people mentioned in a group; (g) link previews. Not chosen: disappearing messages, scheduled send.
48. **Desktop equivalents.** Gestures do not exist with a mouse: on web, message actions appear on hover and on right-click, chat-row actions appear on hover, and the reply gesture is the Reply action. Check every v3.3 item on the web app before release.

49. **A one-to-one chat has no "leave" anything** (owner, Sep 6 2026 17:25). Conversation settings for a direct chat still show the group departure block, including the workplace line "You cannot leave this company-managed audience yourself." Remove the whole section for direct chats, and remove the company wording from the consumer paths of `conversation-departure-copy.ts` (leaving a group keeps a plain confirmation).
50. **People inside a group are actionable** (owner, Sep 6 2026 17:25). The group's settings list its members, and a member row offers, plainly and compactly: message them, add as friend, mute, block, and (for owners) remove from the group. Muting a person silences their notifications everywhere, one-to-one and in groups, without hiding anything. Blocking a person means they cannot start or continue a one-to-one chat with you, and in a group their messages are hidden from you the way the phone does it, while the group carries on for everyone else. Blocking already exists on the People tab; this is the same action reachable where you actually notice someone.

51. **Server cleanliness pass** (owner, Sep 6 2026 17:35). Find what costs resources without earning them and report before deleting anything: tables and columns nothing reads, indexes never used (pg_stat_user_indexes), functions no route calls, migrations superseded by later ones, cron jobs and outbox topics with no consumer, storage buckets and objects nothing references, Edge Functions no client path reaches, catalog strings and client modules with no reference, dependencies not imported. Report with sizes and evidence; the owner approves removals. Nothing is dropped in the same change that finds it.

52. **Mark unread needs a server flag** (found by stream G, Sep 6 2026). It is session-local today, so it does not survive a relaunch or reach another device. Add `conversation_preferences.manually_unread_at`, expose it on the preferences update, clear it when the chat is opened, and read it in the bootstrap. Migration range 20260908040000+.
53. **Archive and delete are the same flag for a one-to-one chat** (found by stream G). Both set `is_hidden`. Give delete its own per-user state so archiving and deleting are distinguishable, or decide deliberately that a direct chat only archives.
54. **From the cleanliness audit, folded into v3.3** (safe items): purge and retain `cron.job_run_details` (222 MB of a 279 MB database, growing 37 MB/day); unschedule `newone-maintenance-worker` (its three jobs act only on permanently empty workplace tables, 43,200 invocations/month); replace the outbox worker's idle polling with enqueue-time wakes (17,225 polls a day for 22 jobs), following `private.wake_ai_worker_on_enqueue`; add a realm guard to `/updates` and `/handoffs` (URL-addressable on web today, no guard at all); fix the inverted condition at people.tsx:235/387 so the consumer copy that is already written and translated actually renders.
55. **After v3.3, its own pass: flatten the bootstrap and conversation-page chains** (audit items 3–5). `bff_bootstrap_messaging_state` is 13 generations of itself calling each other, 1.1 s mean and 4.4 s worst case, 89% of all database time; `bff_read_conversation_page` is 9 deep. This is the sign-in and open-a-chat latency. Wants a dedicated stream, a full device pass, and no other work merging alongside it.

56. **Link preview thumbnails are fetched but not drawn** (stream I, Sep 6 2026). Title and site name ship; the image is parsed and stored but never rendered, because drawing it would make the phone fetch a third-party URL. Finish it with either a gateway image proxy or a copy into the attachments bucket at unfurl time.
57. **Branch coverage is below its gate** (88.91% against 91%), and was already failing at 89.00% before v3.3. Most of the gap is in Pressable style callbacks the test renderer cannot exercise. Either test them properly or move the gate to a number that means something.

58. **Device suite work before the v3.3 pass** (integrator). Three areas create two-person groups, which the service now refuses: groups-01, chat-17a and show-14-group. The create-group flow already takes a second member (HAS_MEMBER2 / MEMBER2 / MEMBER2_QUERY). The groups area has three devices, so creating with B and C leaves groups-05 ("A adds C") with nobody to add; decide between a fourth signup-only account and a remove-then-re-add step. That second option first needs the re-add case checked: stream H reported that re-adding a removed member collides with the conversation_members primary key, which would be a real defect, not a test problem. Also regenerate tests/device/suite/inventory.json (the Search tab and its route are gone, and several group labels changed). **Done Sep 7 2026 (device suite repair stream):** the re-add case was checked against the live database first — migration 20260908070000 is deployed and `private.bff_add_conversation_member_impl` now revives a departed membership instead of colliding — so groups-05 became remove-from-the-member-row then add back, and the groups area creates with B and C. chat and showcase have two devices each, so their third member is an account created through the public signup route and never signed in on a simulator (`tests/device/lib/accounts.mjs`). The suite also caught up with the rest of v3.3: the Chats search field and its chips, the "+" menu (the compose entry it replaced no longer exists, so `chat.compose` is now a dead catalog string), chat-row actions and both departure confirmations, the group form's optional fields and Advanced options, the three-person rule and the duplicate guard, the group members section, the six reactions and the "+" emoji route, swipe-to-reply and the reply-quote jump, link previews, the pinned views and unpin-from-the-list, Photos and files with the viewer stepping, Appearance and "Show my translations". `tests/device/suite/inventory.json` lost the Search screen and the eight controls nothing renders any more and gained 57 controls and 104 action keys; a new `tests/device/suite/coverage-map.json` ties them to their steps (the file summary.mjs has always read but which had never been committed).
58. **The unread-count badge is white on mint, 2.2:1** (stream K, Sep 7 2026). Pre-existing in the light palette and unchanged by dark mode, but it is the only text/background pairing in the app that fails WCAG AA, and it is recorded as an explicit exemption in `src/theme/contrast.ts` so the contrast test does not lie about it. Two one-line fixes exist — draw the count in `onAccent` (6.5:1) or fill the badge with `accentStrong` and keep it white (5.5:1) — but either visibly changes the light app, so it needs the owner's eye rather than a quiet edit.

60. **The dark splash needs a native rebuild** (stream K, Sep 7 2026). `app.json` now carries `expo-splash-screen`'s `dark` variant and a root `backgroundColor`; both are baked into the native project, so they only appear after the next simulator/EAS build, not over the JavaScript bundle.


61. **Reporting: only a person can be reported** (recorded Sep 7 2026). The owner asked on Sep 5 to drop the report feature; the message and group sheets went, the person report stayed. The server routes, repository methods, workspace actions and the admin console are all still wired, and the catalog still carries `chat.reportGroup`, so a sheet can come back without rebuilding the pipe. Worth a deliberate decision before App Review: an app carrying other people's content needs a way to report content and block people, which blocking plus the person report satisfies, but message-level reporting is what reviewers most often look for.

62. **accessibilityState never reaches the browser** (found by the browser suite, Sep 7 2026). This React Native Web build reads `aria-expanded` / `aria-checked`, not `accessibilityState`, so the Advanced-options disclosure (new-group.tsx), the reaction row, two conversation-pane controls and the Settings switch rows emit no state to a screen reader on the web. Native is unaffected. Fix at the call sites by passing the aria props on web, and add an axe assertion that would have caught it.

40. **Testing:** unit tests for the theme, the search chips and the duplicate rule; Deno and hosted smokes for the members signature and the group minimum; device flows for the "+" menu, group creation, chip search, the own-translation toggle, the pinned views and (if built) the media grid; then a full device pass. The chat area's long-standing "pinned view unreachable" note becomes a real step. Dark mode's look is reviewed by the owner, not asserted.

63. **A member's actions can open below the fold** (found Sep 7 2026 by the groups device run). Tapping "Options for <name>" on the last rows of "People in this group" expands Message / Add as friend / Mute / Block / Remove from group underneath the sheet's bottom edge; the sheet scrolls, so a person can reach them, but nothing brings them into view. It cost three device steps, whose taps landed on the backdrop and dismissed the sheet (the flows now scroll first). Worth scrolling the expanded row into view when it opens, the way a disclosure normally does.

## v3.4 — the owner's Sep 7 2026 pass over the app

Decisions taken with the owner in the same message: reporting stays but shrinks
to the smallest footprint that satisfies App Review; saved contacts, favorites
and nicknames collapse into one toggle that actually does something; archived
chats leave the list and live behind a single "Archived" row at the top of
Chats.

64. **Own messages translate in a group with the setting off.** The bubble
    shows a translation whenever a row targets the reader's own language
    (conversation-pane.tsx, `translation`/`hasTranslation`), which never happens
    in a one-to-one chat and does happen in a group where another member reads
    the language you read. Only the "Show my translations" line is gated;
    this path is not gated on the message being your own at all.
65. **An image is "No messages yet" on Chats.** The row preview is the message
    body, and an attachment has none, so it falls through to the empty-chat
    text. Should read Photo / Video / the file name, and the same string should
    reach the accessibility label.
66. **Nicknames are write-only.** Stored, searchable in Contacts, displayed
    nowhere. Show the nickname wherever the person's name appears: the chat
    header, the Chats row, the contact row, the group member row.
67. **Saved and favorite collapse into one.** One star that toggles on the same
    button, saved people sorted to the top of Contacts. The separate "Remove
    saved contact" action and the favorite flag go.
68. **Archiving hides nothing.** `filterConversations` never excludes an
    archived chat and there is no archive view. Archived chats leave the list
    and gather behind one "Archived" row at the top of Chats with a count;
    swiping there unarchives.
69. **The swipe actions on a chat row are abrupt, cover the timestamp and are
    hard to hit.** They should track the finger rather than appear at once,
    stay clear of the time, and give each action a full-height target.
70. **Conversation controls save themselves.** "Save changes" and "Save
    conversation" go; a change applies when it is made.
71. **One menu per member.** The role chips and the member actions sheet are two
    menus for the same person in the same screen; merge them.
72. **Conversation controls are a mess.** Redesign for the two cases that exist:
    a one-to-one chat (a person, a few switches) and a group (people, the
    group's own settings, the dangerous things last).
73. **Reporting shrinks.** Keep one quiet path so the App Review requirement is
    met; it leaves the message and group sheets entirely.
74. **"The original is always preserved" and its neighbours.** Three keys plus
    the correction blurb, in all three languages.
75. **Unconfirmed, to diagnose:** the composer landing under the keyboard;
    uploaded images sometimes not loading; the list appearing to scroll and then
    snapping back when a message is sent; and a full audit of which
    notifications actually fire.

76. **Done Sep 8 2026 — rerun without paying for the area around it.** `--reuse-accounts <run-dir>` signs the people a run created back in instead of minting new ones (a run writes `accounts.json` as it goes, so an interrupted run is still worth reusing, and the keychain surviving a clear install means the phone is often already that person); `--steps id,id` runs only those steps, setup always; `--from-failures <run-dir>` reads a report and reruns exactly what failed. Measured on profile: one step with a reused account is 3.5 minutes against 10 for the area, and chat's 91 steps are 55.
    Still open: a step that needs what an earlier step made — a photo to remove, a group to rename — cannot stand alone, because only the accounts come back and not the state. Steps should be able to declare what they depend on so selecting one pulls those in.

77. **Redo signing up and signing in** (owner, Sep 8 2026 — v3.5, after 76). Same fields and the same security; what changes is how it looks and how it feels to use. It should follow the design language the rest of the app now has — the same surfaces, spacing, type and controls — and be slimmer and more compact: the owner should not have to scroll to create an account. Both screens, all three languages, and the device flows that drive them.

78. **Conversation controls are still not compact** (owner, Sep 8 2026, with screenshots, after 77). v3.4 tidied the sheet and hid two forms; it did not make it small. What is wrong: the sheet repeats its own header (the identity block shows the name and "4 people" that the title already says, and it is clipped); the four quick actions are oversized pills that wrap onto three rows; notifications alone fill a screen — a heading, a description, three chips, a second heading and three more chips; automatic translation repeats that shape; and "Add people" is a permanently open form with a field, a Search people button, two role chips and a full-width button. The fix: drop the identity block and let the sheet's title be the chat's name; one row of four icon buttons; notifications and translation each collapse to a single row that states the current setting and opens a small picker; "Add people" becomes a row like the other disclosures; tighter member rows. A group's sheet should fit one screen, a one-to-one chat half of it.

79. **A received message still costs a whole bootstrap** (found Sep 9 2026 while fixing the owner's slowness report). Every realtime invalidation runs `loadWorkspaceOnce`, which rebuilds every conversation in the snapshot, so a busy group pays one full bootstrap per message arriving. That was 1.9s and is now 713ms, which is why it stopped being urgent, but the shape is still wrong: the reader needs the chat list updated (order, preview, unread) and the open conversation's tail, and the second of those is a page read. Opening a chat and settling a send already take that path. The reason this was not changed at the same time is that the list genuinely needs the bootstrap's data, so it wants a narrower read — a conversations-only projection with no timeline — rather than another call bolted on. `tests/hosted/latency-probe.mjs` measures the shapes.
    Related, smaller: `followUpTranslation` runs a ladder of full bootstraps at 3s, 6s and 12s after a message whose preview is still untranslated, for the same reason — it needs the conversation row, not the timeline.

80. **The device suite should refuse a build it cannot sign into** (Sep 9 2026). A simulator build made with `CODE_SIGNING_ALLOWED=NO` cannot reach the keychain, so every sign-up in the suite dies on `ERR_KEY_CHAIN` and every area blocks in setup. This is written down in the release evidence as a side finding from build 21 and was walked into again today, costing a full run. `appBuildInfo()` already reads the app's Info.plist for the run report; it should also check the binary is signed (`codesign -dv`) and stop the run with that sentence rather than minting accounts against a build that cannot hold one.

## Dropped

34. ~~Bridging WhatsApp / iMessage / SMS into Newone~~ — dropped by the owner Sep 6 2026 after the constraints were laid out (no third-party iMessage API at all; WhatsApp only through its business platform, which cannot read personal chats; SMS/RCS bridging possible on Android only).
