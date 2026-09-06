-- Two summaries of the same messages collided.
--
-- Before v3.1 a summary was defined by its message set alone, so uniqueness on
-- (organization, conversation, source_fingerprint, language, correction_of)
-- was right. v3.1 lets the reader choose the range AND ask about a subject, and
-- each reader summarizes for themselves: the same messages legitimately produce
-- one summary per reader, per scope, per subject. The old rule refused the
-- second one with a conflict, so asking a follow-up question about the same
-- chat failed (owner report, Sep 6 2026: "what's my name" succeeded, then
-- "cheeseburgers" over the same messages returned 409).
--
-- The request function already returns the existing row when the reader, the
-- message set, the language, the scope kind and the subject all match, so
-- uniqueness now covers exactly that key.

begin;

alter table public.conversation_summaries
  drop constraint if exists conversation_summaries_organization_id_conversation_id_sour_key;

drop index if exists public.conversation_summaries_source_version_unique_idx;

create unique index if not exists conversation_summaries_reader_scope_unique_idx
  on public.conversation_summaries (
    organization_id,
    conversation_id,
    source_fingerprint,
    language_code,
    coalesce(correction_of_summary_id, '00000000-0000-0000-0000-000000000000'::uuid),
    requested_by_user_id,
    scope_kind,
    coalesce(scope_subject, '')
  );

commit;
