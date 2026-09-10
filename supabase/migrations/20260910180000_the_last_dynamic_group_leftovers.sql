-- The last dynamic-group leftovers, and why signup broke without this.
--
-- 20260910170000 dropped enqueue_dynamic_group_user_source_change_internal,
-- but two trigger functions on public.organization_memberships still called
-- it. organization_memberships is a table we keep, so its triggers survived
-- the drop -- and signup inserts a membership, so every signup failed with a
-- 503 the moment the migration landed. The generator only looked for triggers
-- belonging to functions it was dropping; these two belong to functions it was
-- not, and it never asked what those functions called.
--
-- The two triggers marked a user's membership as a dynamic-group source
-- change so the reconciler could re-evaluate policy-managed membership. There
-- are no policies and no reconciler, so there is nothing to mark.

drop trigger if exists organization_memberships_96_dynamic_group_source
  on public.organization_memberships;
drop trigger if exists organization_memberships_97_dynamic_group_access_source
  on public.organization_memberships;

drop function if exists private.mark_dynamic_group_user_source_change();
drop function if exists private.mark_dynamic_group_membership_access_change();
drop function if exists private.dynamic_group_user_eligible_for_spec(uuid,uuid,jsonb,timestamp with time zone);
drop function if exists public.bff_update_organization_conversation_controls(uuid,uuid,uuid,text,integer,integer,integer,text,text,text);
drop function if exists private.bff_update_organization_conversation_controls_impl(uuid,uuid,uuid,text,integer,integer,integer,text,text,text);
