-- Drop the workplace RPCs that no longer have a caller.
--
-- The gateway routes for announcements, handoffs, operational actions,
-- dynamic-group policies, glossary proposals, moderation case queues,
-- organization and AI policy, role assignments, invitations, member
-- administration, preservation holds, audit export, conversation discovery
-- and join requests, and summary policy are gone. These are the functions
-- behind them, and nothing in the database or the edge functions calls them
-- any more -- every one was checked against both.
--
-- Deliberately NOT dropped here: the dynamic_group_* access helpers, the
-- organization_* permission tables, organization_ai_policies and
-- shift_assignments. Those are still read by the live consumer path
-- (actor_has_permission has 44 callers, ai_use_case_approved 17, and
-- currently_off_shift_internal is reached from bff_resolve_push_job_impl),
-- so unwinding them is its own change with its own device pass.
-- private.can_view_organization_units also stays: two RLS policies on the
-- organization_units tables are defined in terms of it.


drop function if exists private.announcement_audience_candidates(uuid,uuid,jsonb,timestamp with time zone);
drop function if exists private.announcement_audience_spec_is_live(uuid,jsonb);
drop function if exists private.assert_announcement_audience_authorized(uuid,uuid,uuid,jsonb);
drop function if exists private.assert_dynamic_group_policy_authorized(uuid,uuid,uuid,jsonb,timestamp with time zone);
drop function if exists private.backfill_organization_ai_policy_history();
drop function if exists private.bff_acknowledge_announcement_impl(uuid,uuid,uuid,uuid,uuid,jsonb,text,text);
drop function if exists private.bff_acknowledge_handoff_impl(uuid,uuid,uuid,uuid,text,uuid,text,text);
drop function if exists private.bff_assign_moderation_case_impl(uuid,uuid,uuid,uuid,uuid,integer,text,text,text);
drop function if exists private.bff_authorize_invite_otp_impl(text,text,text,text,text,text,text);
drop function if exists private.bff_cancel_conversation_join_request_impl(uuid,uuid,uuid,uuid,integer,text,text);
drop function if exists private.bff_cancel_scheduled_announcement_impl(uuid,uuid,uuid,uuid,text,text,text);
drop function if exists private.bff_claim_moderation_case_impl(uuid,uuid,uuid,uuid,integer,text,text,text);
drop function if exists private.bff_confirm_operational_action_impl(uuid,uuid,uuid,uuid,uuid,timestamp with time zone,text,text);
drop function if exists private.bff_correct_announcement_impl(uuid,uuid,uuid,uuid,uuid,text,text,text,boolean,timestamp with time zone,text,text,text);
drop function if exists private.bff_correct_handoff_impl(uuid,uuid,uuid,uuid,text,text,text,timestamp with time zone,timestamp with time zone,bigint[],timestamp with time zone,text,text,text);
drop function if exists private.bff_correct_handoff_v2_impl(uuid,uuid,uuid,uuid,uuid,integer,text,text,text,timestamp with time zone,timestamp with time zone,bigint[],timestamp with time zone,text,text,text);
drop function if exists private.bff_create_announcement_impl(uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,timestamp with time zone,timestamp with time zone,jsonb,text,text,text,jsonb,text,text);
drop function if exists private.bff_create_handoff_impl(uuid,uuid,uuid,uuid,text,text,text,timestamp with time zone,timestamp with time zone,bigint[],timestamp with time zone,text,text);
drop function if exists private.bff_create_targeted_announcement_impl(uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,timestamp with time zone,timestamp with time zone,jsonb,text,text,text,jsonb,jsonb,text,text);
drop function if exists private.bff_decide_conversation_join_request_impl(uuid,uuid,uuid,uuid,integer,text,text,text,text);
drop function if exists private.bff_export_audit_events_impl(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text[],uuid,text,text);
drop function if exists private.bff_get_organization_ai_policy_impl(uuid,uuid,uuid);
drop function if exists private.bff_grant_role_assignment_impl(uuid,uuid,uuid,uuid,text,text,uuid,timestamp with time zone,text,text,text);
drop function if exists private.bff_issue_organization_invite_impl(uuid,uuid,uuid,text,text,uuid,text,text,text,integer,text,text);
drop function if exists private.bff_issue_organization_invite_v2_impl(uuid,uuid,uuid,text,text,uuid,text,text,text,integer,text,timestamp with time zone,uuid,text,text);
drop function if exists private.bff_list_announcement_non_acknowledgers_impl(uuid,uuid,uuid,uuid,uuid,integer);
drop function if exists private.bff_list_conversation_join_requests_impl(uuid,uuid,uuid,uuid,integer);
drop function if exists private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer);
drop function if exists private.bff_list_managed_announcements_impl(uuid,uuid,uuid,integer);
drop function if exists private.bff_list_role_assignments_impl(uuid,uuid,uuid,uuid,integer);
drop function if exists private.bff_mark_announcement_read_impl(uuid,uuid,uuid,uuid,text,text);
drop function if exists private.bff_pause_dynamic_group_policy_impl(uuid,uuid,uuid,uuid,integer,text,text,text);
drop function if exists private.bff_place_message_preservation_hold_impl(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text);
drop function if exists private.bff_preview_announcement_audience_impl(uuid,uuid,uuid,uuid,integer);
drop function if exists private.bff_preview_dynamic_group_impl(uuid,uuid,uuid,uuid,integer);
drop function if exists private.bff_preview_dynamic_group_v2_impl(uuid,uuid,uuid,uuid,integer,integer);
drop function if exists private.bff_preview_targeted_announcement_audience_impl(uuid,uuid,uuid,uuid,jsonb,integer);
drop function if exists private.bff_process_announcement_obligations_impl(uuid,integer);
drop function if exists private.bff_process_dynamic_group_boundaries_impl(integer);
drop function if exists private.bff_process_dynamic_group_reconciliation_impl(integer,integer);
drop function if exists private.bff_process_overdue_handoffs_impl(uuid,integer);
drop function if exists private.bff_promote_due_announcements_impl(uuid,integer);
drop function if exists private.bff_propose_glossary_term_impl(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,text);
drop function if exists private.bff_propose_operational_action_impl(uuid,uuid,uuid,uuid,bigint,text,text,text,text);
drop function if exists private.bff_propose_operational_action_pre_dynamic_group_impl(uuid,uuid,uuid,uuid,bigint,text,text,text,text);
drop function if exists private.bff_publish_dynamic_group_policy_impl(uuid,uuid,uuid,uuid,integer,text,text,text);
drop function if exists private.bff_query_moderation_cases_impl(uuid,uuid,uuid,text[],timestamp with time zone,uuid,integer);
drop function if exists private.bff_read_moderation_case_impl(uuid,uuid,uuid,uuid);
drop function if exists private.bff_release_message_preservation_hold_impl(uuid,uuid,uuid,uuid,text,text,text);
drop function if exists private.bff_resolve_invite_principal_impl(uuid,uuid,uuid,text,text);
drop function if exists private.bff_resolve_push_job_pre_dynamic_group_impl(uuid,bigint,uuid,integer);
drop function if exists private.bff_review_conversation_summary_pre_dynamic_group_impl(uuid,uuid,uuid,uuid,text,text,text,text);
drop function if exists private.bff_review_glossary_version_impl(uuid,uuid,uuid,uuid,text,text,text,text);
drop function if exists private.bff_revoke_role_assignment_impl(uuid,uuid,uuid,uuid,text,text,text);
drop function if exists private.bff_save_dynamic_group_policy_impl(uuid,uuid,uuid,uuid,uuid,uuid,text[],boolean,text,text);
drop function if exists private.bff_save_dynamic_group_policy_v2_impl(uuid,uuid,uuid,uuid,uuid,integer,jsonb,integer,text,text);
drop function if exists private.bff_set_organization_ai_policy_impl(uuid,uuid,uuid,boolean,text[],text[],text,text,text,text);
drop function if exists private.bff_set_organization_ai_policy_v2_impl(uuid,uuid,uuid,boolean,text[],text[],text,integer,text,text,text);
drop function if exists private.bff_set_summary_policy_impl(uuid,uuid,uuid,uuid,text,integer,text,text);
drop function if exists private.bff_sign_handoff_impl(uuid,uuid,uuid,uuid,uuid,text,text);
drop function if exists private.bff_sync_dynamic_group_impl(uuid,uuid,uuid,uuid,text,text);
drop function if exists private.bff_transition_moderation_case_impl(uuid,uuid,uuid,uuid,text,integer,text,jsonb,text,text);
drop function if exists private.bff_transition_operational_action_impl(uuid,uuid,uuid,uuid,text,text,text,text);
drop function if exists private.dynamic_group_candidate_membership_allowed(uuid,uuid,timestamp with time zone);
drop function if exists private.dynamic_group_candidate_membership_valid_until(uuid,uuid,timestamp with time zone);
drop function if exists private.dynamic_group_membership_state_fingerprint(uuid,jsonb,timestamp with time zone);
drop function if exists private.dynamic_group_policy_candidates(uuid,jsonb,timestamp with time zone);
drop function if exists private.dynamic_group_policy_evaluation_time(jsonb,timestamp with time zone);
drop function if exists private.dynamic_group_policy_next_boundary(uuid,jsonb,timestamp with time zone);
drop function if exists private.dynamic_group_policy_spec_is_live(uuid,jsonb,timestamp with time zone);
drop function if exists private.dynamic_group_selector_fingerprint(jsonb);
drop function if exists private.dynamic_group_user_eligible_for_spec(uuid,uuid,jsonb,timestamp with time zone);
drop function if exists private.handoff_source_snapshot_internal(uuid,uuid,uuid,bigint[]);
drop function if exists private.normalize_dynamic_group_policy_spec(jsonb);
drop function if exists private.reconcile_dynamic_group_user_internal(uuid,uuid,uuid,timestamp with time zone,text);
drop function if exists private.redeem_organization_invite_impl(text,text);
drop function if exists public.bff_acknowledge_announcement(uuid,uuid,uuid,uuid,text,text);
drop function if exists public.bff_acknowledge_announcement(uuid,uuid,uuid,uuid,uuid,jsonb,text,text);
drop function if exists public.bff_acknowledge_handoff(uuid,uuid,uuid,uuid,text,text,text);
drop function if exists public.bff_acknowledge_handoff(uuid,uuid,uuid,uuid,text,uuid,text,text);
drop function if exists public.bff_assign_moderation_case(uuid,uuid,uuid,uuid,uuid,integer,text,text,text);
drop function if exists public.bff_authorize_invite_otp(text,text,text,text,text,text,text);
drop function if exists public.bff_cancel_conversation_join_request(uuid,uuid,uuid,uuid,integer,text,text);
drop function if exists public.bff_cancel_scheduled_announcement(uuid,uuid,uuid,uuid,text,text,text);
drop function if exists public.bff_claim_moderation_case(uuid,uuid,uuid,uuid,integer,text,text,text);
drop function if exists public.bff_confirm_operational_action(uuid,uuid,uuid,uuid,uuid,timestamp with time zone,text,text);
drop function if exists public.bff_correct_announcement(uuid,uuid,uuid,uuid,uuid,text,text,text,boolean,timestamp with time zone,text,text,text);
drop function if exists public.bff_correct_handoff(uuid,uuid,uuid,uuid,text,text,text,timestamp with time zone,timestamp with time zone,bigint[],timestamp with time zone,text,text,text);
drop function if exists public.bff_correct_handoff_v2(uuid,uuid,uuid,uuid,uuid,integer,text,text,text,timestamp with time zone,timestamp with time zone,bigint[],timestamp with time zone,text,text,text);
drop function if exists public.bff_create_announcement(uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,timestamp with time zone,timestamp with time zone,jsonb,text,text,text,jsonb,jsonb,text,text);
drop function if exists public.bff_create_announcement(uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,timestamp with time zone,timestamp with time zone,jsonb,text,text,text,jsonb,text,text);
drop function if exists public.bff_create_handoff(uuid,uuid,uuid,uuid,text,text,text,timestamp with time zone,timestamp with time zone,bigint[],timestamp with time zone,text,text);
drop function if exists public.bff_create_handoff(uuid,uuid,uuid,uuid,text,text,text,timestamp with time zone,timestamp with time zone,text,text);
drop function if exists public.bff_decide_conversation_join_request(uuid,uuid,uuid,uuid,integer,text,text,text,text);
drop function if exists public.bff_export_audit_events(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text[],uuid,text,text);
drop function if exists public.bff_get_organization_ai_policy(uuid,uuid,uuid);
drop function if exists public.bff_grant_role_assignment(uuid,uuid,uuid,uuid,text,text,uuid,timestamp with time zone,text,text,text);
drop function if exists public.bff_issue_organization_invite(uuid,uuid,uuid,text,text,uuid,text,text,text,integer,text,text);
drop function if exists public.bff_issue_organization_invite_v2(uuid,uuid,uuid,text,text,uuid,text,text,text,integer,text,timestamp with time zone,uuid,text,text);
drop function if exists public.bff_list_announcement_non_acknowledgers(uuid,uuid,uuid,uuid,uuid,integer);
drop function if exists public.bff_list_conversation_join_requests(uuid,uuid,uuid,uuid,integer);
drop function if exists public.bff_list_dynamic_group_policies(uuid,uuid,uuid,uuid,integer);
drop function if exists public.bff_list_managed_announcements(uuid,uuid,uuid,integer);
drop function if exists public.bff_list_role_assignments(uuid,uuid,uuid,uuid,integer);
drop function if exists public.bff_mark_announcement_read(uuid,uuid,uuid,uuid,text,text);
drop function if exists public.bff_pause_dynamic_group_policy(uuid,uuid,uuid,uuid,integer,text,text,text);
drop function if exists public.bff_place_message_preservation_hold(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text);
drop function if exists public.bff_preview_announcement_audience(uuid,uuid,uuid,uuid,integer);
drop function if exists public.bff_preview_announcement_audience(uuid,uuid,uuid,uuid,jsonb,integer);
drop function if exists public.bff_preview_dynamic_group(uuid,uuid,uuid,uuid,integer);
drop function if exists public.bff_preview_dynamic_group_v2(uuid,uuid,uuid,uuid,integer,integer);
drop function if exists public.bff_process_announcement_obligations(uuid,integer);
drop function if exists public.bff_process_dynamic_group_boundaries(integer);
drop function if exists public.bff_process_dynamic_group_reconciliation(integer,integer);
drop function if exists public.bff_process_overdue_handoffs(uuid,integer);
drop function if exists public.bff_promote_due_announcements(uuid,integer);
drop function if exists public.bff_propose_glossary_term(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,text);
drop function if exists public.bff_propose_operational_action(uuid,uuid,uuid,uuid,bigint,text,text,text,text);
drop function if exists public.bff_publish_announcement(uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,timestamp with time zone,text,text);
drop function if exists public.bff_publish_dynamic_group_policy(uuid,uuid,uuid,uuid,integer,text,text,text);
drop function if exists public.bff_query_moderation_cases(uuid,uuid,uuid,text[],timestamp with time zone,uuid,integer);
drop function if exists public.bff_read_moderation_case(uuid,uuid,uuid,uuid);
drop function if exists public.bff_release_message_preservation_hold(uuid,uuid,uuid,uuid,text,text,text);
drop function if exists public.bff_resolve_invite_principal(uuid,uuid,uuid,text,text);
drop function if exists public.bff_review_glossary_version(uuid,uuid,uuid,uuid,text,text,text,text);
drop function if exists public.bff_revoke_role_assignment(uuid,uuid,uuid,uuid,text,text,text);
drop function if exists public.bff_save_dynamic_group_policy(uuid,uuid,uuid,uuid,uuid,uuid,text[],boolean,text,text);
drop function if exists public.bff_save_dynamic_group_policy_v2(uuid,uuid,uuid,uuid,uuid,integer,jsonb,integer,text,text);
drop function if exists public.bff_set_organization_ai_policy(uuid,uuid,uuid,boolean,text[],text[],text,text,text,text);
drop function if exists public.bff_set_organization_ai_policy_v2(uuid,uuid,uuid,boolean,text[],text[],text,integer,text,text,text);
drop function if exists public.bff_set_summary_policy(uuid,uuid,uuid,uuid,text,integer,text,text);
drop function if exists public.bff_sign_handoff(uuid,uuid,uuid,uuid,text,text);
drop function if exists public.bff_sign_handoff(uuid,uuid,uuid,uuid,uuid,text,text);
drop function if exists public.bff_sync_dynamic_group(uuid,uuid,uuid,uuid,text,text);
drop function if exists public.bff_transition_moderation_case(uuid,uuid,uuid,uuid,text,integer,text,jsonb,text,text);
drop function if exists public.bff_transition_operational_action(uuid,uuid,uuid,uuid,text,text,text,text);
drop function if exists public.redeem_organization_invite(text,text);
