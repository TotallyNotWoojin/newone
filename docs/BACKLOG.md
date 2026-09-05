# Backlog (v3 and later)

Paused until the owner says go. Items are in rough priority order.

## Product

1. **Full-screen image viewer.** Done Sep 5 2026 (v2.5): tapping a photo opens it full screen from the preview URL with pinch-to-zoom on iOS and a download action; tap the image to hide the bar. Still open: pinch-to-zoom on Android (needs a gesture-handler zoom), swipe-to-dismiss, and inline video playback (no video player library is installed yet).
2. **People search only matches a username prefix.** `bff_search_users_by_username` matches `lower(username) LIKE '<query>%'`, and any query that isn't `^[a-z0-9][a-z0-9_]{1,29}$` returns an empty list silently — so uppercase, spaces, and Korean input find nobody with no explanation. Two real users (display names "DDONG" and "Kyle LEE", usernames `dongai77` and `leeiy0712`) could not find each other at all. Fix: also match display name, case-insensitively and across scripts; failing that, show "search by username, e.g. dongai77" and stop silently swallowing non-matching input. Consider an invite/share link so nobody has to know a username.
3. Password recovery / alternate sign-in path beyond the emailed code.
4. Snappier animations (screen transitions, sheet presentation).
5. Confirmation before declining a message request (a mis-tap currently declines immediately).
6. The "Reconnecting…" status banner should overlay instead of pushing the list down (a tap aimed at a row can land on the row below when it clears).

## Engineering

6. Language detection retries: keep the revive cron, and surface a "translation delayed" state in the bubble while a provider outage lasts.
7. Branch-coverage gate: bring Jest branches back above 91% (currently 89.97%) with tests for the reconcile prune, the read-marking path, and the chip label.
8. Manual auth-user deletion from the Supabase dashboard fails on the profile foreign key (no cascade); the in-app delete-account path handles it.
9. Device suite: reuse accounts across areas to cut setup time; media-05 thumbnail tap in the Files picker still unverified.
10. Store listings in Spanish and Korean (the app already ships those languages).

## Follow-ups from v3 verification (Sep 5 2026)

11. Summaries call the other person "participant 1" because display names are not sent to the model. Send first names (or map participant labels back to names client-side) so a summary reads "Diego agreed to…".
12. Chats-list preview from a live message event still shows the original language until the next reconcile; update the preview when the translation arrives (client, workspace.tsx message-event path).
13. A real server-side "mute all notifications" (device_registrations.notifications_muted); today the Settings switch only reflects OS permission and deep-links to system settings.
