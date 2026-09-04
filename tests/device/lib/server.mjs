// Server truth through the Supabase Management API (same credentials the
// hosted smokes use). Unlike smoke-lib.managementSql this never exits the
// process: a failed query is returned as evidence so one area cannot kill
// the whole suite.
import { EXPECTED_PROJECT_REF } from '../../hosted/lib.mjs';
import { PERSONAL_REALM_ID, loadAccessToken } from '../../hosted/smoke-lib.mjs';

export const ORG = PERSONAL_REALM_ID;
let token = null;

export function lit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export async function sql(query) {
  token ??= loadAccessToken();
  const response = await fetch(`https://api.supabase.com/v1/projects/${EXPECTED_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`management sql ${response.status}: ${body?.message ?? JSON.stringify(body)}`);
  return Array.isArray(body) ? body : body?.result ?? [];
}

export async function one(query) {
  return (await sql(query))[0] ?? null;
}

export async function profileByUsername(username) {
  return await one(`select user_id, username::text as username, display_name, status_message, preferred_language
    from public.profiles where username = ${lit(username)}`);
}

export async function profileByUserId(userId) {
  return await one(`select p.user_id, p.username::text as username, p.display_name, p.status_message, p.preferred_language,
      (select deleted_at is not null from auth.users u where u.id = p.user_id) as auth_soft_deleted
    from public.profiles p where p.user_id = ${lit(userId)}::uuid`);
}

export async function connection(userA, userB) {
  return await one(`select status, requested_by_user_id, responded_at
    from public.contact_connections
    where organization_id = ${lit(ORG)}
      and member_low_user_id = least(${lit(userA)}::uuid, ${lit(userB)}::uuid)
      and member_high_user_id = greatest(${lit(userA)}::uuid, ${lit(userB)}::uuid)`);
}

export async function directConversation(userA, userB) {
  return await one(`select c.id, c.kind from public.conversations c
    where c.organization_id = ${lit(ORG)} and c.kind = 'direct'
      and exists (select 1 from public.conversation_members m where m.conversation_id = c.id and m.user_id = ${lit(userA)}::uuid)
      and exists (select 1 from public.conversation_members m where m.conversation_id = c.id and m.user_id = ${lit(userB)}::uuid)
    order by c.created_at desc limit 1`);
}

export async function groupByName(name) {
  return await one(`select id, kind, name, is_archived, created_by_user_id from public.conversations
    where organization_id = ${lit(ORG)} and name = ${lit(name)} order by created_at desc limit 1`);
}

export async function messages(conversationId) {
  return await sql(`select id::text as id, sender_user_id, kind, body, edited_at, deleted_at, reply_to_message_id::text as reply_to,
      created_at,
      (select count(*) from public.message_reactions r where r.message_id = m.id) as reactions,
      (select string_agg(emoji || ':' || user_id::text, ',') from public.message_reactions r where r.message_id = m.id) as reaction_detail,
      exists (select 1 from public.message_pins p where p.message_id = m.id) as pinned,
      (select string_agg(user_id::text, ',') from public.message_user_visibility v where v.message_id = m.id) as hidden_for,
      exists (select 1 from public.message_forward_provenance f where f.target_message_id = m.id) as forwarded,
      (select string_agg(target_language || '=' || status, ',') from public.message_translations t where t.message_id = m.id) as translations
    from public.messages m
    where organization_id = ${lit(ORG)} and conversation_id = ${lit(conversationId)}
    order by created_at asc`);
}

export async function messageByBody(conversationId, bodyLike) {
  return await one(`select id::text as id, sender_user_id, kind, body, edited_at, deleted_at, reply_to_message_id::text as reply_to, created_at,
      (select string_agg(emoji || ':' || user_id::text, ',') from public.message_reactions r where r.message_id = m.id) as reaction_detail,
      exists (select 1 from public.message_pins p where p.message_id = m.id) as pinned,
      (select string_agg(user_id::text, ',') from public.message_user_visibility v where v.message_id = m.id) as hidden_for,
      exists (select 1 from public.message_forward_provenance f where f.target_message_id = m.id) as forwarded,
      (select string_agg(target_language || '=' || status || ':' || coalesce(left(translated_body, 80), ''), ' | ') from public.message_translations t where t.message_id = m.id) as translations,
      (select min(t.created_at) from public.message_translations t where t.message_id = m.id) as translation_created_at,
      (select min(t.updated_at) filter (where t.status = 'completed') from public.message_translations t where t.message_id = m.id) as translation_completed_at,
      (select string_agg(user_id::text || ':' || coalesce(read_at::text, 'unread'), ',') from public.message_receipts rc where rc.message_id = m.id) as receipts
    from public.messages m
    where organization_id = ${lit(ORG)} and conversation_id = ${lit(conversationId)} and body ilike ${lit(`%${bodyLike}%`)}
    order by created_at desc limit 1`);
}

export async function messageById(messageId) {
  return await one(`select id::text as id, sender_user_id, kind, body, edited_at, deleted_at, created_at
    from public.messages where id = ${lit(messageId)}::bigint`);
}

export async function attachments(conversationId) {
  return await sql(`select id, message_id::text as message_id, file_name, mime_type, byte_size, scan_status, detected_mime_type, created_by_user_id, created_at
    from public.message_attachments where organization_id = ${lit(ORG)} and conversation_id = ${lit(conversationId)} order by created_at asc`);
}

export async function members(conversationId) {
  return await sql(`select user_id, role, status, left_at from public.conversation_members
    where organization_id = ${lit(ORG)} and conversation_id = ${lit(conversationId)} order by joined_at asc`);
}

export async function preferences(conversationId, userId) {
  return await one(`select is_favorite, is_pinned, is_hidden, notification_level, muted_until, translation_mode
    from public.conversation_preferences where organization_id = ${lit(ORG)} and conversation_id = ${lit(conversationId)} and user_id = ${lit(userId)}::uuid`);
}

export async function conversationRow(conversationId) {
  return await one(`select id, kind, name, description, is_archived, avatar_path from public.conversations where id = ${lit(conversationId)}`);
}

export async function block(blocker, blocked) {
  return await one(`select count(*)::int as blocks from public.member_blocks
    where organization_id = ${lit(ORG)} and blocker_user_id = ${lit(blocker)}::uuid and blocked_user_id = ${lit(blocked)}::uuid`);
}

export async function tombstone(userId, username) {
  return await one(`select
    (select display_name from public.profiles where user_id = ${lit(userId)}::uuid) as display_name,
    (select username::text from public.profiles where user_id = ${lit(userId)}::uuid) as username,
    (select count(*)::int from private.reserved_usernames where username = ${lit(username)} and reserved_reason = 'post-deletion-quarantine') as quarantined,
    (select count(*)::int from public.organization_memberships where user_id = ${lit(userId)}::uuid and status <> 'deactivated') as live_memberships,
    (select deleted_at is not null from auth.users where id = ${lit(userId)}::uuid) as auth_soft_deleted`);
}

export async function sessions(userId) {
  return await sql(`select id, session_id, installation_id, platform, app_version, revoked_at, last_seen_at
    from private.session_installations where user_id = ${lit(userId)}::uuid order by created_at asc`);
}

export async function summaries(conversationId) {
  return await sql(`select id, status, request_mode, failure_code, primary_topic, left(summary_body, 200) as summary_body, created_at, updated_at
    from public.conversation_summaries where conversation_id = ${lit(conversationId)} order by created_at desc`);
}

export async function devices(userId) {
  return await sql(`select platform, push_token_type, revoked_at, created_at from public.device_registrations where user_id = ${lit(userId)}::uuid`);
}

export async function outboxFailures(sinceIso) {
  return await sql(`select topic, status, attempts, last_error_code, created_at from private.outbox_jobs
    where created_at >= ${lit(sinceIso)} and (status <> 'completed' or last_error_code is not null) order by created_at desc limit 20`);
}

// Poll a query until predicate passes or the deadline expires. Returns the
// last row plus the elapsed time so latencies can be reported.
export async function waitFor(queryFn, predicate, { timeoutMs = 60_000, intervalMs = 4_000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await queryFn();
      if (predicate(last)) return { ok: true, row: last, elapsedMs: Date.now() - started };
    } catch (error) {
      last = { error: String(error) };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ok: false, row: last, elapsedMs: Date.now() - started };
}
