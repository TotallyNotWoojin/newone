-- The wrapper the gateway actually calls: the previous migration taught the
-- impl about the stored thumbnail but left public.bff_link_preview_record with
-- its old signature, so every unfurl came back as dependency_unavailable.
-- The public wrapper is what the gateway calls, so it carries the new argument
-- too. Defaulted, so an older client that does not send it still records a
-- preview - without a stored thumbnail, which is the honest answer.
CREATE OR REPLACE FUNCTION public.bff_link_preview_record(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_url_sha256 text, p_url text, p_title text, p_site_name text, p_image_url text, p_status text, p_image_path text default null)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select private.bff_link_preview_record_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_url_sha256, p_url, p_title, p_site_name, p_image_url, p_status, p_image_path
  )
$function$;

grant execute on function public.bff_link_preview_record(uuid, uuid, uuid, text, text, text, text, text, text, text) to service_role;
