# Held migrations

Migrations that must not be applied yet. The CLI refuses to push anything newer while an older unapplied file sits in `supabase/migrations`, so held files live here until their time.

One file is held right now: `20260910150000_consumer_gates_stop_querying_empty_workplace_tables.sql` — see below. `20260907020000_candidate_payload_username.sql` was released on Sep 9 2026 as `20260909230000_candidate_payload_username.sql`, once v3.6 made v3.0 six releases old.

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


## 20260910150000_consumer_gates_stop_querying_empty_workplace_tables

Held Sep 10 2026, deliberately, after measuring it.

It reduces four gates to the constants they already return for every row:
`dynamic_group_policy_conversation` and `dynamic_group_user_currently_eligible`
(0 policies), `currently_off_shift_internal` (no organization is
shift-authoritative), and the granted-role branch of `actor_has_permission`
(0 role assignments; all 365 memberships are plain members).

It is behaviour-preserving on the data that exists. It is held because the
reason for writing it did not survive measurement:

| gate | cost per call (EXPLAIN ANALYZE, per-row varying arguments) |
|---|---|
| `dynamic_group_policy_conversation` | ~14µs |
| `currently_off_shift_internal` | ~40µs |
| `actor_has_permission` | 740µs, but the hot paths short-circuit before reaching it — `can_view_org_member_for_actor` is 0.03ms per person |

So it buys a few milliseconds on a bootstrap that walks 194 conversations, and
nothing anyone would notice. That is not enough to justify rewriting an
access-control function on a live database on its own.

Its real value is as a **prerequisite**: these four are the last hot-path
readers of the workplace tables. Release it as the first step of the table
removal, not before — and re-read the lesson above first, because
`actor_has_permission` is exactly the kind of function something else may have
rewritten in the meantime.
