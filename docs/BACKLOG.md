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
22. HELD migration 20260907020000_candidate_payload_username.sql: apply only once v3.1 is the installed floor (re-timestamp past 20260907040000 first); v3.0 clients reject the extra key in the workplace group form.

## v3.3: dark mode (owner decision, Sep 6 2026; moved from v3.2 on Sep 6 11:40)

23. Dark mode. Follows the phone's appearance setting first; then a Settings override (System / Light / Dark, stored with the device preferences). Bubbles stay green-tinted in dark (not neutral grey). Scope: dark palette for the 24 tokens with contrast checks, theme provider + converting the 39 static stylesheets to theme-aware styles, status bar / keyboard / modals / splash / tab bar / image viewer chrome, web follows. Tests: unit (hook, override, contrast gate) + a device area that screenshots every main screen in dark for the owner's visual review; the owner reviews the look on their phone (dark contact sheet + TestFlight); the automated unit tests and full device pass still run for functional regressions (agreed Sep 6 2026).

## v3.2: sign-in flow, phone signup removal, status wording, username release (owner, Sep 6 2026 11:40) — right after v3.1 ships

24. Returning sign-in becomes one flow: email first → if the account has a password: password field with a "Forgot password?" recovery link (emailed code → set a new password) → signed in; if the account has no password yet: password setup screen → email verification code → signed in. The "Email me a code / Use password" method chips go away. Server: a destination lookup that says whether a password exists (the app already reveals unknown accounts on this screen, so enumeration posture is unchanged); recovery = code-verified password set.
25. Remove the phone signup option (the Email / Phone chips); email only. Keep server phone paths inert.
26. Presence default wording: "On-site" → "Active" (consumer wording; check es/ko).
27. Deleting an account must free the username: today the deletion tombstone quarantines the released username against re-registration (migration 20260901030000). Owner expects it to free up; decide the release rule (immediate, or a short cooldown) and implement.
28. Tests for each: unit (sign-in state machine, status label), Deno (lookup + recovery routes), hosted smoke (recovery flow, username release after deletion), device suite (auth area: new sign-in flow with password / without password / forgot password; negative: phone chips absent; sessions/profile: status label), then a full pass and release as 3.2.
29. Header flash on first launch: the Chats header shows the workplace subtitle ("<organization> · On shift") for a moment before the bootstrap says the account is in the personal realm (app/index.tsx). Render the @handle line only once the realm is known; never the workplace line for consumers. (Owner saw it "for a split second when first logged in", Sep 6 2026.)
Decisions Sep 6 2026 11:50: usernames are freed immediately on deletion; the sign-in flow in item 24 is confirmed as written.
