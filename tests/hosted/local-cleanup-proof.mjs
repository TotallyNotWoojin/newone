#!/usr/bin/env node

import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cleanupSql } from './run.mjs';
import { EXPECTED_PROJECT_REF, makeRunId, sqlLiteral } from './lib.mjs';

const DATABASE_CONTAINER = 'supabase_db_newone';

function runSql(sql, { tuplesOnly = false } = {}) {
  const args = [
    'exec',
    '-i',
    DATABASE_CONTAINER,
    'psql',
    '-X',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
  ];
  if (tuplesOnly) args.push('-A', '-t');
  const result = spawnSync('docker', args, {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const startedAt = new Date();
const runId = makeRunId(startedAt, randomBytes(4).toString('hex'));
const ownerId = randomUUID();
const memberId = randomUUID();
const organizationId = randomUUID();
const conversationId = randomUUID();
const clientNonce = randomUUID();
const networkHash = randomBytes(32).toString('hex');
const globalRateKey = `${runId}:global-rate-proof`;
const ownerEmail = `${runId}-owner-a@example.invalid`;
const memberEmail = `${runId}-member-a@example.invalid`;
const organizationSlug = `${runId}-org-a`;

const setup = `begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into auth.users (id, email, email_confirmed_at, created_at, updated_at) values
  (${sqlLiteral(ownerId)}::uuid, ${sqlLiteral(ownerEmail)}, now(), now(), now()),
  (${sqlLiteral(memberId)}::uuid, ${sqlLiteral(memberEmail)}, now(), now(), now());
insert into public.organizations (id, slug, name, created_by_user_id) values (
  ${sqlLiteral(organizationId)}::uuid,
  ${sqlLiteral(organizationSlug)},
  'Hosted cleanup proof',
  ${sqlLiteral(ownerId)}::uuid
);
insert into public.organization_memberships (organization_id, user_id, role) values
  (${sqlLiteral(organizationId)}::uuid, ${sqlLiteral(ownerId)}::uuid, 'owner'),
  (${sqlLiteral(organizationId)}::uuid, ${sqlLiteral(memberId)}::uuid, 'member');
insert into public.conversations (
  id, organization_id, kind, name, visibility, created_by_user_id
) values (
  ${sqlLiteral(conversationId)}::uuid,
  ${sqlLiteral(organizationId)}::uuid,
  'group',
  'Cleanup proof room',
  'invite_only',
  ${sqlLiteral(ownerId)}::uuid
);
insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  (${sqlLiteral(organizationId)}::uuid, ${sqlLiteral(conversationId)}::uuid, ${sqlLiteral(ownerId)}::uuid, 'owner', ${sqlLiteral(ownerId)}::uuid),
  (${sqlLiteral(organizationId)}::uuid, ${sqlLiteral(conversationId)}::uuid, ${sqlLiteral(memberId)}::uuid, 'member', ${sqlLiteral(ownerId)}::uuid);
select set_config(
  'request.jwt.claims',
  ${sqlLiteral(JSON.stringify({ role: 'service_role', sub: ownerId }))},
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body, language_code
) values (
  ${sqlLiteral(organizationId)}::uuid,
  ${sqlLiteral(conversationId)}::uuid,
  ${sqlLiteral(ownerId)}::uuid,
  ${sqlLiteral(clientNonce)}::uuid,
  'text',
  'Controlled non-empty cleanup proof input',
  'en'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select private.consume_rate_limit(
  'create-direct-hour',
  ${sqlLiteral(`${organizationId}:${ownerId}`)},
  10,
  3600
);
select private.consume_rate_limit(
  'bff-network:conversation.direct.create',
  ${sqlLiteral(`${organizationId}:${networkHash}`)},
  100,
  3600
);
select private.consume_rate_limit(
  'hosted-cleanup-proof-global',
  ${sqlLiteral(globalRateKey)},
  10,
  60
);
insert into public.message_mentions (
  organization_id, conversation_id, message_id, mentioned_user_id
)
select
  ${sqlLiteral(organizationId)}::uuid,
  ${sqlLiteral(conversationId)}::uuid,
  message.id,
  ${sqlLiteral(memberId)}::uuid
from public.messages message
where message.client_nonce = ${sqlLiteral(clientNonce)}::uuid;
commit;`;

runSql(setup);

const before = JSON.parse(runSql(`select json_build_object(
  'messages', (select count(*) from public.messages where organization_id = ${sqlLiteral(organizationId)}::uuid),
  'versions', (select count(*) from private.message_versions where organization_id = ${sqlLiteral(organizationId)}::uuid),
  'mentions', (select count(*) from public.message_mentions where organization_id = ${sqlLiteral(organizationId)}::uuid),
  'audit', (select count(*) from public.audit_events where organization_id = ${sqlLiteral(organizationId)}::uuid),
  'organization_rate_buckets', (select count(*) from private.rate_limit_buckets where organization_id = ${sqlLiteral(organizationId)}::uuid),
  'global_rate_buckets', (select count(*) from private.rate_limit_buckets where scope = 'hosted-cleanup-proof-global' and key_hash = extensions.digest(${sqlLiteral(globalRateKey)}, 'sha256'))
)::text;`, { tuplesOnly: true }));
assert(before.messages === 1, 'cleanup proof did not create a message');
assert(before.versions === 1, 'cleanup proof did not create an immutable message version');
assert(before.mentions === 1, 'cleanup proof did not create an immutable mention');
assert(before.audit > 0, 'cleanup proof did not create append-only audit evidence');
assert(before.organization_rate_buckets === 2, 'cleanup proof did not create both organization-owned rate buckets');
assert(before.global_rate_buckets === 1, 'cleanup proof did not create an unrelated global rate bucket');

const manifest = {
  runId,
  projectRef: EXPECTED_PROJECT_REF,
  startedAt: startedAt.toISOString(),
  users: [
    { id: ownerId, email: ownerEmail },
    { id: memberId, email: memberEmail },
  ],
  organizations: [
    { id: organizationId, slug: organizationSlug },
  ],
};
runSql(cleanupSql(manifest));
runSql(`delete from auth.users where id in (
  ${sqlLiteral(ownerId)}::uuid,
  ${sqlLiteral(memberId)}::uuid
);`);

const after = JSON.parse(runSql(`select json_build_object(
  'organizations', (select count(*) from public.organizations where id = ${sqlLiteral(organizationId)}::uuid),
  'messages', (select count(*) from public.messages where organization_id = ${sqlLiteral(organizationId)}::uuid),
  'versions', (select count(*) from private.message_versions where organization_id = ${sqlLiteral(organizationId)}::uuid),
  'mentions', (select count(*) from public.message_mentions where organization_id = ${sqlLiteral(organizationId)}::uuid),
  'audit', (select count(*) from public.audit_events where organization_id = ${sqlLiteral(organizationId)}::uuid),
  'organization_rate_buckets', (select count(*) from private.rate_limit_buckets where organization_id = ${sqlLiteral(organizationId)}::uuid),
  'global_rate_buckets', (select count(*) from private.rate_limit_buckets where scope = 'hosted-cleanup-proof-global' and key_hash = extensions.digest(${sqlLiteral(globalRateKey)}, 'sha256')),
  'users', (select count(*) from auth.users where id in (${sqlLiteral(ownerId)}::uuid, ${sqlLiteral(memberId)}::uuid))
)::text;`, { tuplesOnly: true }));
assert(
  Object.entries(after).every(([key, count]) => key === 'global_rate_buckets' ? count === 1 : count === 0),
  'cleanup proof left controlled organization rows behind or removed unrelated global state',
);
runSql(`delete from private.rate_limit_buckets
  where scope = 'hosted-cleanup-proof-global'
    and key_hash = extensions.digest(${sqlLiteral(globalRateKey)}, 'sha256');`);

console.log(
  `Non-empty cleanup proof passed: message=${before.messages}, version=${before.versions}, ` +
    `mention=${before.mentions}, audit=${before.audit}, organization_rate_buckets=2, ` +
    `unrelated_global_rate_bucket_preserved=1, residual_rows=0`,
);
