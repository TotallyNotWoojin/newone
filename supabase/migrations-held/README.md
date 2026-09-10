# Held migrations

Migrations that must not be applied yet. The CLI refuses to push anything newer while an older unapplied file sits in `supabase/migrations`, so held files live here until their time.

Nothing is held right now. `20260907020000_candidate_payload_username.sql` was released on Sep 9 2026 as `20260909230000_candidate_payload_username.sql`, once v3.6 made v3.0 six releases old.
