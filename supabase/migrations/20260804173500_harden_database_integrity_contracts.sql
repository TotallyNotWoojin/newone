begin;

-- This trigger is shared by organization rows (whose tenant key is `id`) and
-- organization-unit rows (whose tenant key is `organization_id`). Converting
-- the selected transition row to jsonb avoids resolving a field that does not
-- exist on the trigger's concrete row type during PL/pgSQL expression setup.
create or replace function private.mark_dynamic_group_unit_source_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_source_row jsonb;
  v_organization_id uuid;
  v_boundary_at timestamptz := statement_timestamp();
begin
  if tg_table_schema <> 'public'
    or tg_table_name not in ('organizations', 'organization_units') then
    raise exception 'unsupported dynamic group unit source relation'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    v_source_row := to_jsonb(old);
  else
    v_source_row := to_jsonb(new);
  end if;

  if tg_table_schema = 'public' and tg_table_name = 'organizations' then
    v_organization_id := nullif(v_source_row ->> 'id', '')::uuid;
  else
    v_organization_id := nullif(v_source_row ->> 'organization_id', '')::uuid;
  end if;

  if v_organization_id is null then
    raise exception 'dynamic group unit source tenant could not be resolved'
      using errcode = '23502';
  end if;

  perform set_config('app.dynamic_group_policy_write_context', 'on', true);
  update public.dynamic_group_policies policy
  set source_changed_at = case when policy.source_changed_at is null
        then v_boundary_at else greatest(policy.source_changed_at, v_boundary_at) end
  where policy.organization_id = v_organization_id
    and policy.published_version_id is not null;
  perform set_config('app.dynamic_group_policy_write_context', 'off', true);

  insert into private.dynamic_group_policy_source_boundaries (
    organization_id, policy_id, boundary_at, reason
  )
  select v_organization_id, policy.id, v_boundary_at,
    left(tg_table_name || '.' || lower(tg_op), 120)
  from public.dynamic_group_policies policy
  where policy.organization_id = v_organization_id
    and policy.published_version_id is not null
  on conflict (organization_id, policy_id, boundary_at) do nothing;

  insert into private.dynamic_group_reconciliation_queue (
    organization_id, policy_id, policy_version_id, reason, requested_at, available_at
  )
  select v_organization_id, policy.id, policy.published_version_id,
    left(tg_table_name || '.' || lower(tg_op), 120), v_boundary_at, v_boundary_at
  from public.dynamic_group_policies policy
  where policy.organization_id = v_organization_id
    and policy.published_version_id is not null
  on conflict (organization_id, policy_id) do update
  set policy_version_id = excluded.policy_version_id,
      reason = excluded.reason,
      cursor_user_id = null,
      requested_at = least(
        private.dynamic_group_reconciliation_queue.requested_at,
        excluded.requested_at
      ),
      available_at = least(
        private.dynamic_group_reconciliation_queue.available_at,
        excluded.available_at
      );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- PostgreSQL does not index the referencing side of a foreign key. These
-- tenant-first, non-partial indexes cover every FK introduced after the
-- foundation migration. Minimal FK keys keep write amplification bounded and
-- also match the tenant-scoped joins used by the corresponding workflows.
create index ai_output_error_report_events_actor_fk_idx
  on private.ai_output_error_report_events (organization_id, actor_user_id);
create index ai_output_error_report_events_report_fk_idx
  on private.ai_output_error_report_events (organization_id, report_id);

create index ai_output_error_reports_conversation_fk_idx
  on private.ai_output_error_reports (organization_id, conversation_id);
create index ai_output_error_reports_reviewer_fk_idx
  on private.ai_output_error_reports (organization_id, reviewed_by_user_id);
create index ai_output_error_reports_summary_fk_idx
  on private.ai_output_error_reports (organization_id, summary_id);
create index ai_output_error_reports_translation_fk_idx
  on private.ai_output_error_reports (organization_id, translation_id);

create index ai_regression_examples_decider_fk_idx
  on private.ai_regression_examples (organization_id, decided_by_user_id);
create index ai_regression_examples_proposer_fk_idx
  on private.ai_regression_examples (organization_id, proposed_by_user_id);
create index ai_regression_examples_report_fk_idx
  on private.ai_regression_examples (organization_id, report_id);

create index audit_export_receipts_actor_fk_idx
  on private.audit_export_receipts (organization_id, actor_user_id);
create index audit_query_receipts_actor_fk_idx
  on private.audit_query_receipts (organization_id, actor_user_id);

create index summary_review_records_reviewer_fk_idx
  on private.conversation_summary_review_records (
    organization_id, conversation_id, reviewer_user_id
  );
create index summary_review_records_summary_fk_idx
  on private.conversation_summary_review_records (
    organization_id, conversation_id, summary_id
  );

create index dynamic_group_access_policy_version_fk_idx
  on private.dynamic_group_access_intervals (organization_id, policy_version_id);
create index dynamic_group_access_policy_fk_idx
  on private.dynamic_group_access_intervals (organization_id, policy_id);
create index dynamic_group_access_user_fk_idx
  on private.dynamic_group_access_intervals (organization_id, user_id);
create index dynamic_group_dirty_users_user_fk_idx
  on private.dynamic_group_dirty_users (organization_id, user_id);
create index dynamic_group_policy_previews_actor_fk_idx
  on private.dynamic_group_policy_previews (organization_id, previewed_by_user_id);
create index dynamic_group_reconciliation_version_fk_idx
  on private.dynamic_group_reconciliation_queue (organization_id, policy_version_id);

create index message_preservation_holds_message_fk_idx
  on private.message_preservation_holds (
    organization_id, conversation_id, message_id
  );
create index message_preservation_holds_placed_by_fk_idx
  on private.message_preservation_holds (organization_id, placed_by_user_id);
create index message_preservation_holds_released_by_fk_idx
  on private.message_preservation_holds (organization_id, released_by_user_id);

-- The message FK's three-column prefix also covers the separate conversation
-- FK, avoiding a redundant two-column index on the same leading keys.
create index message_reports_message_fk_idx
  on private.message_reports (organization_id, conversation_id, message_id);
create index message_versions_recorder_fk_idx
  on private.message_versions (organization_id, recorded_by_user_id);

create index conversation_join_requests_decider_fk_idx
  on public.conversation_join_requests (organization_id, decided_by_user_id);
create index dynamic_group_policies_published_version_fk_idx
  on public.dynamic_group_policies (organization_id, published_version_id);
create index dynamic_group_policy_versions_conversation_fk_idx
  on public.dynamic_group_policy_versions (organization_id, conversation_id);
create index dynamic_group_policy_versions_publisher_fk_idx
  on public.dynamic_group_policy_versions (organization_id, published_by_user_id);
create index organization_ai_policy_versions_actor_fk_idx
  on public.organization_ai_policy_versions (organization_id, changed_by_user_id);
create index organization_invites_guest_sponsor_fk_idx
  on public.organization_invites (organization_id, guest_sponsor_user_id);
create index organization_memberships_guest_sponsor_fk_idx
  on public.organization_memberships (organization_id, guest_sponsor_user_id);

commit;
