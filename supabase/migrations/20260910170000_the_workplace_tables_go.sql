-- The workplace tables go.
--
-- Everything that read them has been dealt with first. 36 functions were
-- rewritten to stop reading tables that have been empty for months -- an
-- aggregate over an empty table is null, an EXISTS over one is false, and a
-- branch guarded by such an EXISTS never ran -- so none of this changes what
-- the database returns. The rest only ever served the workplace product and
-- go with the tables.
--
-- Measured on the live project before writing this: every one of these tables
-- holds zero rows, every organization_memberships row is a plain 'member',
-- there are no role assignments, no dynamic-group policies, and the single
-- organization is not shift-authoritative.
--
-- organization_ai_policies stays. It is one row, it gates translation and
-- summaries through private.ai_use_case_approved, and it is the only remaining
-- way to turn AI off. It is infrastructure rather than workplace product.

set local check_function_bodies = off;

-- 2. A report no longer belongs to an organization unit.

alter table private.message_reports drop column if exists conversation_unit_id;

-- 3. The tables. These go before the functions below, because a table
-- still carrying a trigger is exactly what stops that trigger's function
-- being dropped; dropping the table takes its triggers with it.

drop table if exists public.announcement_acknowledgements cascade;
drop table if exists public.announcement_recipients cascade;
drop table if exists public.announcement_versions cascade;
drop table if exists public.announcements cascade;
drop table if exists public.conversation_join_requests cascade;
drop table if exists public.conversation_summary_policies cascade;
drop table if exists public.dynamic_group_policies cascade;
drop table if exists public.dynamic_group_policy_versions cascade;
drop table if exists public.glossary_reviews cascade;
drop table if exists public.glossary_term_versions cascade;
drop table if exists public.glossary_terms cascade;
drop table if exists public.handoff_acknowledgements cascade;
drop table if exists public.handoff_versions cascade;
drop table if exists public.operational_action_events cascade;
drop table if exists public.operational_actions cascade;
drop table if exists public.organization_ai_policy_versions cascade;
drop table if exists public.organization_invites cascade;
drop table if exists public.organization_role_assignments cascade;
drop table if exists public.organization_role_permissions cascade;
drop table if exists public.organization_roles cascade;
drop table if exists public.organization_unit_members cascade;
drop table if exists public.organization_units cascade;
drop table if exists public.shift_assignments cascade;
drop table if exists public.shift_handoffs cascade;
drop table if exists private.dynamic_group_access_intervals cascade;
drop table if exists private.dynamic_group_dirty_users cascade;
drop table if exists private.dynamic_group_policy_previews cascade;
drop table if exists private.dynamic_group_policy_source_boundaries cascade;
drop table if exists private.dynamic_group_reconciliation_queue cascade;

-- 3b. Two triggers sit on tables we keep, so they have to be named
-- before their functions can go. messages_85_maybe_auto_summary fired on
-- every message insert to look for an automatic-summary policy; no policy can
-- exist any more, so it could only ever return null.

drop trigger if exists messages_85_maybe_auto_summary on public.messages;
drop trigger if exists organizations_95_dynamic_group_shift_authority_source on public.organizations;

-- 4. Functions that only ever served the workplace product.

drop function if exists bff_bootstrap_organization(uuid,text,text,text,text);
drop function if exists bff_request_conversation_join(uuid,uuid,uuid,uuid,text,text);
drop function if exists bff_search(uuid,uuid,uuid,text,text[],text,integer,uuid,timestamp with time zone,timestamp with time zone,text[],uuid,text);
drop function if exists bff_update_organization_conversation_controls(uuid,uuid,uuid,text,integer,integer,integer,text,text,text);
drop function if exists private.bff_bootstrap_organization_impl(uuid,text,text,text,text);
drop function if exists private.bff_request_conversation_join_impl(uuid,uuid,uuid,uuid,text,text);
drop function if exists private.bff_search_impl(uuid,uuid,uuid,text,text[],text,integer,uuid,timestamp with time zone,timestamp with time zone);
drop function if exists private.bind_announcement_ack_version();
drop function if exists private.bind_announcement_acknowledgement_evidence();
drop function if exists private.bind_handoff_ack_version();
drop function if exists private.broadcast_organization_conversation_controls_internal(uuid);
drop function if exists private.dynamic_group_policy_candidates(uuid,jsonb,timestamp with time zone);
drop function if exists private.enqueue_dynamic_group_user_source_change_internal(uuid,uuid,text,timestamp with time zone);
drop function if exists private.mark_dynamic_group_unit_source_change();
drop function if exists private.maybe_queue_automatic_summary();
drop function if exists private.reconcile_dynamic_group_user_internal(uuid,uuid,uuid,timestamp with time zone,text);
drop function if exists private.snapshot_announcement_audience_internal(uuid,uuid,uuid,jsonb,timestamp with time zone);
drop function if exists private.snapshot_announcement_version();
drop function if exists private.snapshot_handoff_version();
drop function if exists private.validate_organization_unit_hierarchy();

-- 5. Trigger functions whose only triggers went with those tables.

drop function if exists private.audit_announcement_version_insert();
drop function if exists private.bind_announcement_ack_version();
drop function if exists private.bind_announcement_acknowledgement_evidence();
drop function if exists private.bind_announcement_audience_spec();
drop function if exists private.bind_handoff_ack_version();
drop function if exists private.prevent_ai_policy_version_mutation();
drop function if exists private.prevent_announcement_acknowledgement_mutation();
drop function if exists private.prevent_dynamic_group_version_mutation();
drop function if exists private.prevent_role_assignment_identity_reassignment();
drop function if exists private.prevent_shift_assignment_identity_reassignment();
drop function if exists private.prevent_unit_member_identity_reassignment();
drop function if exists private.snapshot_announcement_recipients();
drop function if exists private.snapshot_announcement_version();
drop function if exists private.snapshot_handoff_version();
drop function if exists private.validate_acknowledgement_insert();
drop function if exists private.validate_active_role_assignment_access();
drop function if exists private.validate_announcement_recipient_update();
drop function if exists private.validate_announcement_write();
drop function if exists private.validate_conversation_join_request_write();
drop function if exists private.validate_dynamic_group_access_interval_mutation();
drop function if exists private.validate_dynamic_group_policy_write();
drop function if exists private.validate_dynamic_group_version_insert();
drop function if exists private.validate_handoff_insert();
drop function if exists private.validate_handoff_update();
drop function if exists private.validate_invite_update();
drop function if exists private.validate_organization_unit_hierarchy();
drop function if exists private.validate_unit_update();

