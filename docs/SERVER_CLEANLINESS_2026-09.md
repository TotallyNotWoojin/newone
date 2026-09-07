# Server cleanliness audit — September 2026

Backlog item 51. Report only: nothing was dropped, deleted, migrated or deployed. Every
number below came from the live project read-only (Supabase Management API) or from a
grep over the repo at commit `fe7a6c3`.

The app was pivoted from a workplace messenger to a consumer texting app, and the
database was wiped just before v3.2. The live project holds **one organization** — the
personal realm — 9 auth users, 7 active memberships (all `role = 'member'`), 2
conversations and 4 messages. There is no workplace tenant, so every workplace table is
not merely small, it has never held a row.

## Headline

The application schema is **6 MB**. The database is **279 MB**. The 273 MB difference is
cron bookkeeping that nothing reads, and the single most expensive query in the system is
a bootstrap RPC that calls itself through thirteen stacked generations of its own past.

| | |
|---|---|
| Total database | 279 MB |
| `public` + `private` (the actual app) | 6,088 kB |
| `cron.job_run_details` | **222 MB (80% of the database)** |
| `net._http_response` | 23 MB |
| Tables that have never received one row | **44 of 83 (53%)** |
| Indexes never scanned | **229 of 417 (55%)** |
| DB functions | 642 across 635 names, 1.23 MB of source |
| Edge Function invocations from cron | **~38,800/day ≈ 1.16 M/month** |

---

## 1. `cron.job_run_details` is 80% of the database and nothing purges it

**What it is.** pg_cron writes one row per job execution. Six jobs run on 5s/10s/10s/30s/
60s/2m schedules, so the table gains ~39,500 rows and ~37 MB per day.

**Evidence.**

```sql
select count(*) rows, pg_size_pretty(pg_total_relation_size('cron.job_run_details')),
       min(start_time) from cron.job_run_details;
-- 179,760 rows | 222 MB | 2026-09-01 23:12:35+00
select pg_size_pretty(pg_database_size(current_database()));  -- 279 MB
```

Six days of history occupy 222 MB. `grep -rn "job_run_details" supabase/ tests/ scripts/ docs/`
returns exactly one hit — a line in `docs/DEPLOYMENT.md` telling an operator to read it.
**No migration, Edge Function, worker or script ever deletes from it.** By contrast pg_net
does self-purge: `pg_stat_statements` shows its retention delete
(`DELETE FROM net._http_response WHERE created < now() - $1`) ran 154,963 times.

**Cost.** 37 MB/day, ~1.1 GB/month, unbounded. It is already 36× the entire application
schema and will dominate disk, backup size and restore time. Nothing reads it except a
human debugging a job.

**Risk to fix: safe.** It is operational telemetry, not application data. A retention
window (keep 7 days) plus a one-off purge is a pure win. It needs no application change
and cannot affect the client. The purge and the schedule belong in a migration.

## 2. `bff_bootstrap_messaging_state` is a 13-deep chain of its own old versions

**What it is.** The first call every client makes after sign-in. The public wrapper picks
one of two implementations, and each implementation is a decorator that calls the previous
generation and then re-queries and rewrites the JSON payload it gets back:

```
public.bff_bootstrap_messaging_state
  └─ v12_impl ─ v11_impl ─ v10_impl ─ v9_impl ─ v8_impl ─ v7_impl
       └─ v7_pre_dynamic_group_impl ─ v6_impl ─ v5_impl ─ v4_impl ─ v3_impl ─ v2_impl ─ _impl
```

Thirteen nested `security definer` functions, each re-running `private.require_service_role()`,
and at least one (`v11_impl`) re-running the full authorization check
`private.assert_bff_request_internal` and re-aggregating the conversation array a second time.

**Evidence.** The wrapper body and each `_impl` body were read with `pg_get_functiondef`;
the chain was confirmed by building a call graph over all 642 function sources. The cost:

```sql
select calls, total_exec_time, mean_exec_time, max_exec_time from pg_stat_statements ...
-- bff_bootstrap_messaging_state: 11,443 calls | 12,618,821 ms | 1,102.8 ms mean | 4,397 ms max
```

**3 h 30 m of cumulative database CPU — 89% of all RPC execution time in the project** —
to serve 2 conversations and 4 messages. The next-worst RPC totals 21 minutes.

The scan amplification is visible in `pg_stat_user_tables`. Dividing lifetime index scans
by the 11,443 bootstrap calls (an over-attribution — other RPCs scan these tables too, but
bootstrap is 89% of the time, so the order of magnitude holds):

| table | index scans | ÷ bootstrap calls | live rows |
|---|---|---|---|
| `organization_memberships` | 78,692,147 | ~6,877 | 7 |
| `organizations` | 42,573,178 | ~3,720 | 1 |
| `conversation_members` | 26,498,861 | ~2,316 | 4 |
| `dynamic_group_policies` | 10,961,183 | ~958 | **0, forever** |
| `contact_connections` | 10,813,863 | ~945 | 2 |
| `organization_role_assignments` | 8,622,367 | ~754 | **0, forever** |
| `member_blocks` | 8,249,313 | ~721 | 0 |
| `organization_unit_members` | 3,334,308 | ~291 | **0, forever** |

Roughly 2,700 index lookups per bootstrap land on workplace tables that can never contain
a row in the consumer product.

**How it got here.** This is a deliberate convention, not an accident: migrations rename
the old function to `*_pre_<feature>_impl` or bump to `_vN+1_impl` and write a new one that
wraps it. `grep -h "rename to" supabase/migrations/*.sql | wc -l` → 24. It keeps each
migration small and reviewable, and it costs a stacked re-query per generation forever.

**Other chains found:** `bff_read_conversation_page` is **9 deep** (the second-hottest read
path in a chat app). `bff_report_message` 4, `bff_send_message_request` 3,
`bff_resolve_push_job` 3, `bff_enqueue_translation` 3. Versioned families kept live:
`bff_bootstrap_messaging_state` 13 generations / 97 kB, `bff_resolve_push_job` 4 / 40 kB,
`bff_search` 3 / 38 kB, `bff_enqueue_translation` 3 / 21 kB — 196 kB of stacked source.

**Risk to fix: needs a migration, and it is the highest-value work in this report.**
Flattening v12→v1 into a single function for the personal realm is a self-contained change
behind an unchanged public signature. The workplace branch (`v9_impl`) can be left alone.
This is the one item where the win is measured in seconds of user-visible latency, not
kilobytes. It wants its own careful stream with the device suite run against it.

## 3. Cron polls ~1.16 M times a month and finds work 0.1% of the time

**What it is.** Six cron jobs, five of which `net.http_post` an Edge Function.

| job | schedule | runs/24 h | what it claims |
|---|---|---|---|
| `newone-outbox-worker` | 5 seconds | 17,225 | outbox jobs |
| `newone-ai-worker` | 10 seconds | 8,626 | translation / detection / summary |
| `newone-attachment-scan-worker` | 10 seconds | 8,626 | attachment scans |
| `newone-push-receipt-worker` | 30 seconds | 2,878 | push receipts |
| `newone-maintenance-worker` | 1 minute | 1,440 | announcements + handoffs (see §4) |
| `newone-language-detection-revive` | 2 minutes | 720 | in-database only, no HTTP |

**Evidence.**

```sql
select jobid, count(*) from cron.job_run_details
where start_time > now() - interval '24 hours' group by jobid;   -- table above, 0 failures
select min(created_at), max(created_at), count(*) from private.outbox_jobs;
-- 22 rows, all created in the last 24 h
```

The outbox worker ran **17,225 times in 24 hours to process 22 jobs — a 0.13% hit rate**.
`bff_claim_outbox_topics` has 37,149 calls in `pg_stat_statements`; the outbox has taken
2,271 inserts in the database's entire life.

**Cost.** ~38,800 Edge Function invocations/day, ~1.16 M/month, plus 83,620 `net.http_post`
calls (168 s of DB time) and 85,172 `job_run_details` inserts — which is what fills §1.

**Risk to fix: safe, but it is a latency trade.** These intervals buy responsiveness: a 5 s
outbox poll means a push goes out within 5 s. Backing off (or moving to a
`pg_notify`/`net.http_post`-on-enqueue wake, which `private.wake_ai_worker_on_enqueue`
already exists to do) preserves latency and removes the idle polling. Do not simply
lengthen the intervals without checking the perceived delivery delay — the owner will feel
it. The two clear wins here are §4 and turning §1's growth off.

## 4. `newone-maintenance-worker` is 100% workplace machinery and does nothing

**What it is.** The whole worker calls exactly three RPCs:

```
$ grep -oE "bff_[a-z_]+" supabase/functions/newone-maintenance-worker/handler.ts | sort -u
bff_process_announcement_obligations
bff_process_overdue_handoffs
bff_promote_due_announcements
```

Announcements and shift handoffs. Both tables have **never received a row**
(`announcements.n_tup_ins = 0`, `shift_handoffs.n_tup_ins = 0`,
`announcement_versions.n_tup_ins = 0`, `handoff_versions.n_tup_ins = 0`), and the
`/updates` and `/handoffs` screens are hidden from the personal realm.

`pg_stat_statements` confirms the work is real and pointless: `bff_process_announcement_obligations`
3,109 calls, `bff_process_overdue_handoffs` 3,109 calls.

**Cost.** 1,440 Edge invocations/day (43,200/month), 4,320 RPC round-trips/day, 1,440 rows/day
into `job_run_details`, forever, on tables that are empty by construction in the consumer
product.

**Risk to fix: safe today, would break the workplace realm if the schema went too.**
Disabling *the cron job* is safe and reversible — it is one `cron.unschedule`, it touches no
application data, and re-enabling it is one line. Keep the Edge Function and the three RPCs
so the workplace realm still works if it is ever populated. This is the cleanest single win
in the report: one line removes 43,200 monthly invocations and a fifth of the log growth.

## 5. Half the schema has never held a row

**What it is.** 44 of 83 tables (2,248 kB, 37% of the app schema) have `n_tup_ins = 0` over
the database's entire life — not "empty since the wipe", but never written. 44 of the 83 RLS
policies are attached to them.

```sql
select relname, pg_size_pretty(pg_total_relation_size(relid)), seq_scan, idx_scan
from pg_stat_user_tables where schemaname in ('public','private') and n_tup_ins = 0;
```

Grouped by the workplace feature they belong to:

- **Announcements** (5): `announcements`, `announcement_versions`, `announcement_recipients`, `announcement_acknowledgements`, `organization_ai_policy_versions`
- **Shifts / handoffs** (4): `shift_handoffs`, `shift_assignments`, `handoff_versions`, `handoff_acknowledgements`
- **Dynamic groups** (7): `dynamic_group_policies`, `dynamic_group_policy_versions`, `dynamic_group_policy_previews`, `dynamic_group_access_intervals`, `dynamic_group_dirty_users`, `dynamic_group_reconciliation_queue`, `dynamic_group_policy_source_boundaries`
- **Glossary** (3): `glossary_terms`, `glossary_term_versions`, `glossary_reviews`
- **Org structure** (6): `organization_units`, `organization_unit_members`, `organization_roles`, `organization_role_assignments`, `organization_role_permissions`, `organization_invites`
- **Moderation / recovery / audit** (10): `account_recovery_cases` + `_events` + `_approvals` + `_execution_sessions`, `audit_export_receipts`, `audit_query_receipts`, `message_preservation_holds`, `ai_regression_examples`, `ai_control_plane_proofs`, `conversation_summary_review_records`
- **Operational actions** (2): `operational_actions`, `operational_action_events`
- **Other** (7): `conversation_join_requests`, `translation_corrections`, `saved_contacts`, `organization_ai_policies`, `conversation_summary_policies`, `bootstrap_idempotency_keys`, `organizations` (1 row, hot — not dead)

**Cost.** 2.2 MB of structure is trivial. The real cost is that some are on the hot path:
`dynamic_group_policies` 10.9 M index scans, `organization_role_assignments` 8.6 M,
`organization_unit_members` 3.3 M — all against zero rows, all paid on every request
(see §2). Empty tables are cheap to store and expensive to join.

**Risk to remove: would break the workplace realm.** These are the workplace product. The
owner has not said the workplace realm is retired, and dropping them is irreversible without
a restore. **Recommend not dropping any of them.** The value is captured for free by §2 —
stop *joining* them on the consumer path, and their storage cost rounds to nothing.

## 6. 229 of 417 indexes have never been scanned

```sql
select relname, indexrelname, idx_scan, pg_relation_size(indexrelid) from pg_stat_user_indexes
where schemaname in ('public','private') and idx_scan = 0;   -- 229 rows, 2.29 MB
```

**This number is much less meaningful than it looks, and I want to be explicit about that.**
Two reasons an index shows zero scans here without being dead:

1. **Most are on the 44 empty tables.** An index on a table with no rows can never be
   scanned. It costs 8 kB and zero write overhead. Nothing is learned from its counter.
2. **The planner will not use an index on a near-empty table.** With 4 messages and 9
   profiles a sequential scan always wins. The five GIN full-text indexes
   (`messages_body_search_idx`, `profiles_search_idx`, `profiles_display_name_search_idx`,
   `conversations_search_idx`, `organization_memberships_job_search_idx`, 168 kB together)
   back the search feature, which is demonstrably exercised by the device suite —
   they read as unused only because the tables are tiny. **Do not drop these.**

The defensible subset is unused indexes on tables that actually take writes, where the
index is pure write overhead. 82 such indexes exist; the ones on tables with meaningful
write volume:

| table | index | size | lifetime writes |
|---|---|---|---|
| `private.rate_limit_buckets` | `rate_limit_buckets_expiry_idx` | 16 kB | 91,146 |
| `public.organization_user_preferences` | `organization_user_preferences_language_idx` | 16 kB | 2,306 |
| `public.audit_events` | `audit_events_org_cursor_idx`, `audit_events_target_idx` | 32 kB | 1,877 |
| `public.organization_memberships` | `organization_memberships_org_status_role_idx` | 56 kB | 1,443 |
| `public.messages` | `messages_reply_idx`, `messages_thread_idx`, `messages_deleted_by_idx`, `messages_avatar_candidate_retention_idx` | 32 kB | 655 |
| `public.message_receipts` | `message_receipts_user_idx`, `message_receipts_message_idx` | 32 kB | 500 |

Even here the honest cost is small: `rate_limit_buckets_expiry_idx` is the only one on a
genuinely hot write path, and an expiry index is exactly what a sweeper would want — its
zero count may mean the sweeper is missing, not the index.

**Genuinely redundant indexes** (one fully covered by another, both non-partial, same
columns, verified against `pg_get_indexdef`) — 4 of them, all on empty tables, ~32 kB:

- `private.dynamic_group_policy_source_boundaries_policy_idx` — covered by the primary key
- `private.moderation_case_evidence_case_order_idx` — covered by the unique index
- `private.message_preservation_holds_active_lookup_idx` — partial, covered by `_message_fk_idx`
- `private.message_reports_member_target_idx` — partial, covered by `_subject_idx`

**Risk: needs a migration; low value.** Worth folding into other work, not worth its own change.

## 7. Functions, Edge Functions, storage, topics

**DB functions.** 642 functions (635 names), 1.23 MB of source, 417 `security definer` in
`private`. A reachability walk from every real entry point — all 195 `public` functions
(the PostgREST surface), all 168 trigger functions, every function named in an RLS policy,
column default, check constraint, index expression or cron command, and every name appearing
anywhere in the Edge Functions, client, tests, scripts or migrations — leaves **7 unreachable
functions, 44 kB, all `security definer`**:

```
private.bff_search_impl                                          14,829 B
private.bff_resolve_push_job_pre_dynamic_group_impl              14,286 B
private.bff_resolve_principal_context_impl                        4,705 B
private.bff_update_conversation_preferences_pre_translation_...    4,124 B
private.bff_preview_announcement_audience_impl                    3,686 B
private.bff_review_conversation_summary_pre_dynamic_group_impl    2,000 B
private.is_org_owner(uuid)                                          466 B
```

These are orphaned rungs of the §2 ladder — a newer generation replaced them and stopped
calling them. A naive "no caller in any function body" search returns 84 functions, but 77
of those are trigger and RLS-policy functions reached through `pg_trigger`/`pg_policy`
rather than through source; counting them would have been wrong.

*Risk: safe, low value.* 44 kB. Being `security definer` they are a (small) standing
surface area, which is the real argument for dropping them, not the bytes.

**Edge Functions.** All nine slugs are reached — five by cron, four by the client. None is
dead at the slug level. The waste is inside `newone-api`, whose `routes.ts` is **229 kB /
6,895 lines / 110 route templates**, a large share of them workplace-only (`/v2/admin/*`,
`/v2/dynamic-groups/*`, `/v2/handoffs/*`, `/v2/glossary/*`, `/v2/updates/*`, `/v2/moderation/*`,
`/v2/actions/*`, `/v2/ai-output-error-reports/*`). Exactly one route has no reference
anywhere in the client, tests or scripts: **`/v2/ready`** — a health probe; keep it.
`/v2/glossary/*` is referenced by one client file only.

**Storage.** Three buckets. `message-attachments` and `profile-avatars` are private, empty
(post-wipe) and referenced throughout `newone-api/routes.ts`. The third, **`site`**, is
**public**, holds 4 files (`index.html`, `privacy.html`, `support.html`, `terms.html`,
8,219 bytes) and **is referenced by no code at all** — `docs/APP_STORE_LISTING.md` points
the store listing at GitHub Pages (`totallynotwoojin.github.io/newone-legal/`) instead. It
is a superseded hosting attempt. *Risk: safe*, but confirm the store listing is not still
pointing anywhere at the Supabase URL before removing. 8 kB, so the only real argument is
that it is the project's one public bucket.

**Outbox topics.** The `outbox_jobs_topic_allowed` check constraint permits 11 topics. Ten
have both a producer and a consumer. **`retention` has neither** — no DB function enqueues
it and no worker claims it; the string survives only in the constraint and in an unrelated
`messages.deletion_reason` check. *Risk: needs a migration; near-zero value* (one enum
value, no runtime cost).

## 8. Client: what ships to a consumer who can never use it

**Screens.** Three route files are workplace-only: `src/app/updates.tsx` (2,123 lines /
84,335 B), `src/app/handoffs.tsx` (934 / 37,516) and `src/app/admin.tsx` (862 / 42,016).
With their 18 exclusive dependencies (moderation, dynamic-group, audit, recovery, AI-policy
sections and copy) that is **21 modules, 9,068 lines, 387 KB — 18% of all client source**,
statically imported at module top and therefore present in the single web bundle
(`dist/_expo/static/js/web/entry-*.js`, 4.87 MB) for every consumer.

A second layer of 5 modules (79 KB) is imported by consumer screens but rendered only
behind `!personalRealm`. Combined: **~466 KB, ~21% of client source, dead to a consumer.**

Capability gating was verified end to end, not assumed: consumer signup inserts
`role = 'member'` (`20260901000000_consumer_personal_realm_signup.sql:351`), and
`private.effective_capabilities_internal` grants a bare member neither `handoff.manage`
nor `communications.publish` nor anything in `ADMIN_SURFACE_CAPABILITIES`, so
`canAccessAdminSurface()` is provably false for consumers.

**Two real defects surfaced while measuring this — worth fixing regardless of any cleanup:**

1. **`/updates` and `/handoffs` have no route guard.** `admin.tsx:135` returns a
   restriction page when `!canOpenAdmin`; the other two contain zero occurrences of
   `Redirect`, `router.replace`, `personalRealm` or `canAccessAdminSurface`. `app.json`
   sets `web.output: "static"`, and `dist/updates.html` and `dist/handoffs.html` exist —
   both are directly URL-addressable on web today. They render empty for a consumer rather
   than refusing, which is a weaker posture than `/admin`. There is also one unguarded
   in-app path: `src/features/chat/conversation-pane.tsx:486` pushes `/updates` gated only
   on `conversation.priority === 'safety'`, with no realm check. *I could not determine
   whether a personal-realm conversation can carry `priority = 'safety'` — that is server
   data and worth one query before deciding it is harmless.*
2. **Consumer copy that exists, is translated, is test-gated, and never renders.**
   `src/app/people.tsx:235` and `:387` gate the description and block-notice blocks on
   `!personalRealm`, so the consumer branch renders *nothing* instead of the
   `people.descriptionConsumer` / `people.blockNoticeConsumer` variants that were written
   for it. `apps/newone/tests/localized-security-copy.test.ts:98-115` asserts those strings
   exist and are consumer-worded, so the gap is invisible to the test suite. Same shape for
   `settings.preferencesDescription` / `…Consumer`, where neither variant renders.

**i18n catalog.** `src/i18n/catalog.ts` is 218,931 B / 3,384 lines / 1,123 keys per locale.
The three locale blocks are structurally identical and TypeScript enforces it
(`MessageKey = keyof typeof en`, `ko`/`es` typed `: Catalog`) — no drift is possible, and
there are **no missing keys**: every literal passed to `t()` resolves. Both dynamic
key-construction sites were traced to closed enums (`group.incidentSeverity*` from a
4-value literal in `new-group.tsx:497`; `chat.${role}Role` from a 3-value literal in
`conversation-pane.tsx:2714`) so nothing had to be assumed used.

- **83 keys (20,861 B) have zero references anywhere.** The largest single cluster is a
  complete admin moderation + security-audit panel (`admin.moderation*`, `admin.audit*`,
  9 keys) translated into three languages with no screen behind it. 13 are genuinely dead
  (removed recovery, phone-auth and magic-link flows).
- **43 more (9,561 B) are referenced only outside `apps/newone/src`.** Eleven of those are
  named in tests that assert they are *not* rendered; 26 exist only in
  `tests/device/suite/inventory.json`, a hand-maintained inventory that still lists
  controls (`chat.mute`, `chat.forward`, `settings.savePreferences`, …) whose keys are
  absent from the client entirely — **the device-suite inventory is stale and is describing
  a UI that no longer ships**.
- Together: **126 keys, 30,422 B, 13.9% of the file, rendered by nothing.**
- Separately, ~918 message lines / 62 KB of the catalog are workplace namespaces
  (`admin|updates|handoffs|quality`) shipped to every consumer.

**Dead client files.** The import graph from all 13 route entry points plus the test suite
leaves no unreachable `.ts`/`.tsx`/`.mjs` module — the 91% Jest coverage gate makes an
orphan impossible. But **13 `.d.ts` sidecars of `.mjs` modules (310 lines, 9,708 B) are
never loaded**: `tsconfig` inherits `moduleResolution: "bundler"`, and a `.mjs` specifier
resolves `.mts` → `.d.mts` → `.mjs`, never `.d.ts` (confirmed with `tsc --traceResolution`).
All 13 modules are imported with an explicit `.mjs` extension, so their types come from the
source. Two are byte-identical duplicates of a live `.d.mts` sibling. Zero runtime cost;
the risk is silent divergence, since nothing type-checks them against the code they claim
to describe.

**Dependencies.** 41 of 48 are used. One clear candidate — **`expo-web-browser`** (536 kB
installed): zero references in the entire tree outside its own `package.json` line, not an
`app.json` plugin, no other package in the lockfile depends on it. Two to verify, not
assume: **`expo-image`** (133 MB installed) is imported nowhere and appears only as an
`app.json` plugin entry — images go through React Native's own `Image`; and
**`expo-system-ui`** (356 kB) has no import and no plugin entry but may back
`"userInterfaceStyle": "automatic"`. Six more (`@expo/ui`, `expo-symbols`,
`expo-glass-effect`, `react-native-screens`, `expo-font`, `expo-linking`) are redundant *direct*
listings of packages `expo-router` already depends on — removing them from `package.json`
would not uninstall anything and would only stop `expo install --check` from pinning them.
Cosmetic.

## 9. Migrations superseded (informational — none can be deleted)

83 migration files, 2.45 MB. They contain **821 `CREATE FUNCTION` statements across 616
distinct names; 205 (25%) are superseded by a later migration**, meaning the live definition
no longer matches the file that first created it.

```
774 KB  20260728031052_messenger_foundation.sql          86 of its function defs later replaced
220 KB  20260804171845_complete_policy_managed_team_groups.sql   26 replaced
183 KB  20260804172200_complete_group_creation.sql               15 replaced
 89 KB  20260903030000_desync_audit_and_consumer_rules.sql        6 replaced
 82 KB  20260804165238_complete_conversation_controls.sql        15 replaced
```

`bff_bootstrap_messaging_state` is created 11 separate times across the history;
`bff_enqueue_translation_impl` 7 times. 21 live functions are created by no migration at
all — every one is a `*_pre_*_impl` produced by `alter function … rename to …`, of which
the migrations contain 24. That rename-then-wrap convention is what builds the chains in §2.

Nothing here is actionable — applied migrations are immutable. It is recorded so that
anyone reading `messenger_foundation.sql` knows that ~86 of its function bodies are no
longer what runs, and should read `pg_get_functiondef` instead of the file.

---

## Do this first

Ranked by value per unit of risk. Nothing here is dropped in the change that found it.

1. **Add retention to `cron.job_run_details` and purge it once.** Frees ~220 MB (80% of the
   database), stops ~37 MB/day of growth. Operational telemetry only. *Safe, one migration.*
2. **Unschedule `newone-maintenance-worker`.** It processes announcements and handoffs, both
   permanently empty. Removes 43,200 Edge invocations/month for one line. Keep the function
   and its RPCs for the workplace realm. *Safe, reversible.*
3. **Flatten the `bff_bootstrap_messaging_state` chain for the personal realm.** 13 stacked
   generations, 1.1 s mean / 4.4 s worst case, 3.5 h of DB CPU — 89% of all RPC time, and
   the latency the owner actually feels at sign-in. Highest value in the report; wants its
   own stream and a full device pass. *Needs a migration; do not rush it.*
4. **Then do the same for `bff_read_conversation_page` (9 deep)** — the second-hottest read
   path, and the one behind opening a chat.
5. **Stop joining the empty workplace tables on the consumer path** (falls out of 3 and 4):
   `dynamic_group_policies`, `organization_role_assignments`, `organization_unit_members`
   are scanned ~2,000 times per bootstrap against zero rows. *Do not drop the tables.*
6. **Fix the two client defects found in passing** — add a realm guard to `/updates` and
   `/handoffs` (they are URL-addressable on web today), and render the `*Consumer` copy in
   `people.tsx:235/387` that is already written, translated and test-gated.
7. **Replace idle polling with enqueue-time wakes** for the outbox worker (17,225 polls/day
   → 22 jobs, 0.13% hit rate). `private.wake_ai_worker_on_enqueue` is the existing pattern.
   *Check perceived delivery latency before and after — do not just lengthen the interval.*
8. **Refresh `tests/device/suite/inventory.json`.** 26 catalog keys it expects no longer
   exist in the client; the suite is asserting against a UI that no longer ships. This is a
   correctness problem in the safety net, not a cleanup.

Deliberately **not** recommended: dropping any of the 44 empty workplace tables, and
dropping the five GIN search indexes. The tables are the workplace product and their
storage cost is negligible once §5's joins are gone; the search indexes read as unused only
because the tables are too small for the planner to choose them.

## What I could not determine

- Whether a personal-realm conversation can carry `priority = 'safety'`, which decides
  whether `conversation-pane.tsx:486` is a live consumer path into `/updates`.
- Whether the orphaned `settings.*` and `chat.summary*` catalog clusters are pre-build
  scaffolding or debris from the v3 settings redesign. Git history would settle it.
- Whether `expo-system-ui` does invisible work for `"userInterfaceStyle": "automatic"`.
- The exact per-call attribution of index scans in §2. The counters are cumulative across
  all callers; the per-bootstrap figures are order-of-magnitude, not exact.
- Whether `rate_limit_buckets_expiry_idx` is unused because it is redundant or because the
  expiry sweeper that should use it is missing. Worth one look before touching it.
- Nine `auth.users` rows exist where the brief expected two; the extras appear to be device-suite
  accounts. Not investigated — no cleanup is proposed against user data.
