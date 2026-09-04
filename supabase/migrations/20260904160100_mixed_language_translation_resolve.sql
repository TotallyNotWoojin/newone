-- Mixed-language translation rows (source 'und' on a message whose detection
-- completed as the sender's language) pass egress resolution and are handed
-- to the translator with source 'und', so a same-language reader's request
-- (20260904160000) reaches the provider instead of being blocked as stale.
-- Everything else in the resolver is unchanged from the foundation.

create or replace function private.bff_resolve_translation_job_for_egress_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_provider text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype;
  v_message public.messages%rowtype;
  v_translation public.message_translations%rowtype;
  v_current_hash bytea;
  v_has_demand boolean := false;
  v_policy_version integer;
  v_route_policy text;
  v_reason text;
begin
  perform private.require_service_role();
  if coalesce(p_provider, '') !~ '^[a-z0-9][a-z0-9._/-]{1,159}$' then
    raise exception 'valid canonical processor id required' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id and job.topic = 'translation'
    and job.status = 'processing' and job.claimed_by = p_worker_id
    and job.claimed_until > now()
  for update;
  if not found then
    raise exception 'active translation lease required' using errcode = '55000';
  end if;
  select message.* into v_message
  from public.messages message
  where message.organization_id = v_job.organization_id
    and message.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
    and message.id = (v_job.payload ->> 'message_id')::bigint;
  if found and v_message.body is not null then
    v_current_hash := extensions.digest(convert_to(v_message.body, 'UTF8'), 'sha256');
  end if;
  select translation.* into v_translation
  from public.message_translations translation
  where translation.organization_id = v_job.organization_id
    and translation.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
    and translation.message_id = (v_job.payload ->> 'message_id')::bigint
    and translation.target_language = lower(v_job.payload ->> 'target_language')
  for update;
  if v_message.id is null or v_translation.id is null
    or v_message.deleted_at is not null or v_message.body is null
    or v_message.language_detection_state <> 'completed'
    or v_message.detected_language is null
    or (
      v_translation.source_language <> v_message.detected_language
      and not (
        v_translation.source_language = 'und'
        and coalesce(v_message.language_detection_method, '') like '%:sender-language'
      )
    )
    or v_translation.source_body_sha256 is distinct from v_current_hash
    or v_translation.status not in ('queued', 'processing') then
    v_reason := 'source_stale_or_deleted';
  elsif not private.ai_use_case_approved(
      v_job.organization_id, 'translation', lower(p_provider)
    ) then
    v_reason := 'tenant_ai_policy_denied';
  else
    select exists (
      select 1
      from public.conversation_members member
      join public.organization_memberships organization_member
        on organization_member.organization_id = member.organization_id
       and organization_member.user_id = member.user_id
       and organization_member.status = 'active'
      join public.profiles profile on profile.user_id = member.user_id
      left join public.organization_user_preferences preference
        on preference.organization_id = member.organization_id
       and preference.user_id = member.user_id
      left join public.message_user_visibility visibility
        on visibility.organization_id = member.organization_id
       and visibility.conversation_id = member.conversation_id
       and visibility.message_id = v_message.id
       and visibility.user_id = member.user_id
      where member.organization_id = v_job.organization_id
        and member.conversation_id = v_message.conversation_id
        and member.status = 'active'
        and visibility.user_id is null
        and (
          lower(coalesce(preference.message_language, profile.preferred_language))
            = v_translation.target_language
          or member.user_id::text = coalesce(v_job.payload ->> 'requested_by_user_id', '')
        )
    ) into v_has_demand;
    if not v_has_demand then v_reason := 'no_active_recipient_demand'; end if;
  end if;
  if v_reason is not null then
    if v_translation.id is not null and v_message.id is not null
      and v_message.deleted_at is null and v_message.body is not null then
      update public.message_translations translation
      set status = 'blocked', translated_body = null, provider = null,
          model = null, confidence = null, failure_code = v_reason
      where translation.id = v_translation.id
        and translation.status in ('queued', 'processing');
    end if;
    perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
    return jsonb_build_object(
      'authorized', false, 'provider_egress_allowed', false,
      'reason', v_reason, 'message_id', v_job.payload ->> 'message_id',
      'target_language', v_job.payload ->> 'target_language'
    );
  end if;
  select policy.policy_version, policy.route_policy
    into v_policy_version, v_route_policy
  from public.organization_ai_policies policy
  where policy.organization_id = v_job.organization_id
    and policy.enabled and policy.revoked_at is null;
  update public.message_translations translation
  set status = 'processing', failure_code = null
  where translation.id = v_translation.id;
  update private.outbox_jobs job
  set payload = job.payload || jsonb_build_object(
        'resolved_provider', lower(p_provider),
        'ai_policy_version', v_policy_version,
        'translation_id', v_translation.id,
        'source_resolved_at', now()
      ),
      updated_at = now()
  where job.id = p_job_id;
  return jsonb_build_object(
    'authorized', true, 'provider_egress_allowed', true,
    'translation_id', v_translation.id,
    'organization_id', v_job.organization_id,
    'conversation_id', v_message.conversation_id,
    'message_id', v_message.id,
    'source_body', v_message.body,
    'source_language', v_translation.source_language,
    'target_language', v_translation.target_language,
    'source_sha256', encode(v_current_hash, 'hex'),
    'processor_id', lower(p_provider),
    'ai_policy_version', v_policy_version,
    'route_policy', v_route_policy,
    'provider_route_policy', 'zero_retention_only'
  );
end;
$$;

