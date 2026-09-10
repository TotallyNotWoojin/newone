# Held migrations

Migrations that must not be applied yet. The CLI refuses to push anything newer while an older unapplied file sits in `supabase/migrations`, so held files live here until their time.

Nothing is held right now. `20260910150000_consumer_gates_stop_querying_empty_workplace_tables.sql` was superseded on Sep 10 2026: the table removal rewrote all four of its gates as part of `20260910160000`, so the held snapshot had nothing left to add. `20260907020000_candidate_payload_username.sql` was released on Sep 9 2026 as `20260909230000_candidate_payload_username.sql`, once v3.6 made v3.0 six releases old.

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


## The lesson from the workplace table removal, Sep 10 2026

Rewriting 36 functions to stop reading tables that were about to be dropped
broke production four times. Every one of them was the same mistake: a
transform that pattern-matched on SQL text without understanding SQL
structure, and a check that proved the result parsed rather than that it meant
the same thing.

| what broke | how long | the substitution |
|---|---|---|
| signup | ~10 min | two triggers on a **kept** table called a function the drop removed |
| bootstrap | ~15 min | `LEFT JOIN LATERAL (select …)` became `left join lateral null` |
| search | ~20 min | dropped `public.bff_search`, the live entry point, after checking callers of a differently-named dead function |
| push | ~40 min | a **CTE body** `eligible_users as ( … )` became `as null`, deleting the consumer recipient list along with the workplace arms |

Balanced parentheses were not enough: every one of those parsed. And the
migration necessarily ran with `check_function_bodies = off`, because the
functions reference each other, so Postgres accepted all of it silently and
nothing failed until real traffic reached each path.

If you do this again, these are the checks that each caught a real bug, and
they are cheap:

- **The CTE list must be identical before and after.** Removing a union arm by
  line number took the `numbered` CTE with it, twice.
- **No `as null`, no `join null`, no `from null`.** A bare null is what a
  scalar-subquery substitution leaves behind when the thing it replaced was a
  CTE body or a lateral join.
- **No function may be both created and dropped by the same migration.** The
  auth hook appeared as both; the drop ran last and would have deleted it,
  breaking every login.
- **Every RPC name the edge functions reference must exist.** One grep over
  `supabase/functions` against `pg_proc` would have caught `bff_search`
  immediately.
- **Walk the triggers on tables you are keeping**, not only on the ones you
  are dropping, and ask what those trigger functions call.

And verify against traffic, not against the schema. The hosted smokes found
three of the four; the fourth (push) surfaced only because `group-rules-smoke`
waits on real delivery. Run the smokes after each migration, not at the end.
