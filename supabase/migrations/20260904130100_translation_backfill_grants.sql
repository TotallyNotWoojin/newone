-- The replaced preferences command is executed by the API's service role
-- through its public wrapper; the previous migration revoked it from public
-- without granting service_role, which turned every preference update into
-- 403 (hosted, translation-backfill-smoke).
grant execute on function private.bff_update_conversation_preferences_impl(
  uuid, uuid, uuid, uuid, jsonb, text, text
) to service_role;
grant execute on function private.bff_update_conversation_preferences_pre_translation_backfill_impl(
  uuid, uuid, uuid, uuid, jsonb, text, text
) to service_role;
grant execute on function private.backfill_conversation_translations_internal(
  uuid, uuid, uuid, integer
) to service_role;
