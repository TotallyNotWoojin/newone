# Held migrations

Migrations that must not be applied yet. The CLI refuses to push anything newer while an older unapplied file sits in `supabase/migrations`, so held files live here until their time.

- `20260907020000_candidate_payload_username.sql` — adds `username` to group-picker candidate payloads. v3.0 clients parse those payloads with an exact key set (workplace group form), so this ships only once v3.1 is the installed floor. Re-timestamp past the latest applied migration, move it back, then `supabase db push`.
