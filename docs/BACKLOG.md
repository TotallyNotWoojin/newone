# Backlog (v3 and later)

Paused until the owner says go. Items are in rough priority order.

## Product

1. **Full-screen image viewer.** Tapping a photo in a conversation opens it full screen with pinch-to-zoom and swipe-to-dismiss, straight from the preview URL, instead of the small bubble preview that pushes people to download the file. Videos should get the same treatment. (Owner request, Sep 5 2026.)
2. Password recovery / alternate sign-in path beyond the emailed code.
3. Snappier animations (screen transitions, sheet presentation).
4. Confirmation before declining a message request (a mis-tap currently declines immediately).
5. The "Reconnecting…" status banner should overlay instead of pushing the list down (a tap aimed at a row can land on the row below when it clears).

## Engineering

6. Language detection retries: keep the revive cron, and surface a "translation delayed" state in the bubble while a provider outage lasts.
7. Branch-coverage gate: bring Jest branches back above 91% (currently 89.97%) with tests for the reconcile prune, the read-marking path, and the chip label.
8. Manual auth-user deletion from the Supabase dashboard fails on the profile foreign key (no cascade); the in-app delete-account path handles it.
9. Device suite: reuse accounts across areas to cut setup time; media-05 thumbnail tap in the Files picker still unverified.
10. Store listings in Spanish and Korean (the app already ships those languages).
