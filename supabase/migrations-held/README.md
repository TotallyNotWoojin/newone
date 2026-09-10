# Held migrations

Migrations that must not be applied yet. The CLI refuses to push anything newer while an older unapplied file sits in `supabase/migrations`, so held files live here until their time.

Nothing is held right now. `20260907020000_candidate_payload_username.sql` was released on Sep 9 2026 as `20260909230000_candidate_payload_username.sql`, once v3.6 made v3.0 six releases old.

## The lesson from 20260907020000

A held file is a **snapshot of a function**, not a patch to it. While it waits,
anything else that touches the same function moves on without it, and applying
it later silently reverts that work.

`20260907020000_candidate_payload_username.sql` sat here from Sep 7 and was
released on Sep 9. `20260908090000_picker_offers_departed_members.sql` had
rewritten the same function on Sep 8, so the release reverted it: the people
picker stopped offering anyone who had left a group, and searching it by
@username found nobody. The device suite caught it at groups-05.

Before releasing anything from here:

1. `grep -rln '<function name>' supabase/migrations/` and read everything newer
   than the held file.
2. Merge the held change into the newest definition rather than applying the
   snapshot.
3. Check the gateway too. This one also needed `onlyKeys` in
   newone-api/routes.ts to admit the new key - the server and the gateway had
   to change together, which is why it was held in the first place.
4. `tests/hosted/picker-smoke.mjs` covers this particular pair now.
