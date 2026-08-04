import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { edgeFunctionForPath } from '../apps/newone/src/config/api-routing.mjs';

const migrationPath = 'supabase/migrations/20260804162744_complete_audit_export.sql';
const migration = readFileSync(migrationPath, 'utf8');
const readEdge = readFileSync('supabase/functions/newone-read/handler.ts', 'utf8');
const commandEdge = readFileSync('supabase/functions/newone-api/routes.ts', 'utf8');
const commandRepository = readFileSync(
  'apps/newone/src/data/repositories/bff-command-repository.ts',
  'utf8',
);
const workspace = readFileSync('apps/newone/src/state/workspace.tsx', 'utf8');
const admin = readFileSync('apps/newone/src/app/admin.tsx', 'utf8');
const auditUi = readFileSync('apps/newone/src/features/admin/audit-access-section.tsx', 'utf8');
const auditCopy = readFileSync('apps/newone/src/features/admin/audit-copy.ts', 'utf8');

test('ADM-02 migration owns a unique post-message-safety timestamp and purpose-bound audit boundary', () => {
  assert.match(migrationPath, /20260804162744_complete_audit_export\.sql$/);
  assert.ok(20260804162744 > 20260804162342);
  assert.match(migration, /'audit\.query', true, 900/);
  assert.match(migration, /'audit\.export', true, 900/);
  assert.match(migration, /actor_has_permission\([\s\S]*?'audit\.read'/);
  assert.match(migration, /membership\.status = 'active'/);
  assert.match(migration, /p_date_to - p_date_from > interval '90 days'/);
  assert.match(migration, /p_date_to - p_date_from > interval '31 days'/);
  assert.match(migration, /p_limit not between 1 and 100/);
  assert.match(migration, /v_row_count > 5000/);
  assert.match(migration, /'audit-query-hour'[\s\S]*?300, 3600/);
  assert.match(migration, /'audit-export-hour'[\s\S]*?10, 3600/);
});

test('query and export receipts are immutable, forced-RLS, reconstructable, and self-auditing', () => {
  assert.match(migration, /create table private\.audit_query_receipts/);
  assert.match(migration, /cursor_before_at/);
  assert.match(migration, /returned_first_id/);
  assert.match(migration, /next_cursor_sha256/);
  assert.match(migration, /create table private\.audit_export_receipts/);
  assert.match(migration, /force row level security/g);
  assert.match(migration, /before update or delete on private\.audit_query_receipts/);
  assert.match(migration, /before update or delete on private\.audit_export_receipts/);
  assert.match(migration, /'audit\.accessed', 'audit_query_receipt'/);
  assert.match(migration, /'audit\.exported', 'audit_export_receipt'/);
  assert.match(migration, /extensions\.digest\(convert_to\(v_payload, 'UTF8'\), 'sha256'\)/);
  assert.match(migration, /jsonb_set\([\s\S]*?'\{audit_events\}', '\[\]'::jsonb/);
  assert.match(migration, /revoke select on table public\.audit_events from authenticated/);
});

test('denied audit probes are durably recorded only through a content-free trusted RPC', () => {
  assert.match(migration, /record_audit_access_denial_internal/);
  assert.match(migration, /membership\.status = 'active'/);
  assert.match(migration, /'audit\.access\.denied'/);
  assert.match(migration, /p_denial_stage not in \('session_assurance', 'permission', 'edge_authorization'\)/);
  assert.doesNotMatch(
    migration.slice(
      migration.indexOf('create or replace function private.record_audit_access_denial_internal'),
      migration.indexOf('create or replace function private.bff_query_audit_events_impl'),
    ),
    /body|message|attachment|ip_hash|user_agent_hash/,
  );
  assert.match(readEdge, /recordAuditDenial\(actor, organizationId, 'audit\.query'\)/);
  assert.match(readEdge, /rateLimit\(request, config, actor, organizationId, 'audit\.query'\)[\s\S]*?authorize\(actor, organizationId/);
  assert.match(migration, /'audit-denial-hour'[\s\S]*?300,[\s\S]*?3600/);
  assert.match(commandEdge, /schemaVersion === 1 && publicValue\.denied === true/);
});

test('Edge routes sign query cursors, enforce recent AAL2, and keep preservation routes intact', () => {
  assert.equal(edgeFunctionForPath('/v2/admin/audit/query'), 'newone-read');
  assert.equal(edgeFunctionForPath('/v2/admin/audit/export'), 'newone-api');
  assert.match(readEdge, /verifySearchCursor\(/);
  assert.match(readEdge, /signSearchCursor\(/);
  assert.match(readEdge, /operation: 'audit\.query',[\s\S]*?requireAal2: true,[\s\S]*?recentAuthSeconds: 900/);
  assert.match(commandEdge, /kind: 'audit\.export'[\s\S]*?requireAal2: true,[\s\S]*?recentAuthSeconds: 900/);
  assert.match(commandEdge, /message\.preservation\.place/);
  assert.match(commandEdge, /message\.preservation\.release/);
  assert.match(admin, /MessagePreservationSection/);
});

test('final client bounds JSON decoding and re-verifies bytes and SHA-256 before save or share', () => {
  assert.match(commandRepository, /maxResponseBytes: 4_500_000/);
  assert.match(commandRepository, /response\.headers\.get\('content-length'\)/);
  assert.match(commandRepository, /new TextEncoder\(\)\.encode\(raw\)\.byteLength > maximum/);
  assert.match(commandRepository, /Crypto\.digestStringAsync\([\s\S]*?CryptoDigestAlgorithm\.SHA256/);
  assert.match(auditUi, /observedBytes !== receipt\.payloadBytes/);
  assert.match(auditUi, /observedSha256\.toLowerCase\(\) !== receipt\.sha256/);
  assert.doesNotMatch(auditUi, /Clipboard|setStringAsync/);
  assert.match(auditUi, /setLocalError\(copy\.saveFailed\)/);
});

test('admin UI is workspace-wired and includes explicit English, Korean, and Spanish governance copy', () => {
  assert.match(workspace, /queryAudit:/);
  assert.match(workspace, /exportAudit:/);
  assert.match(admin, /AuditAccessSection/);
  assert.match(auditUi, /REASONS\.map/);
  assert.match(auditUi, /RANGES\.map/);
  assert.match(auditUi, /saveExport/);
  assert.match(auditCopy, /const copies: Record<'en' \| 'ko' \| 'es'/);
  assert.match(auditCopy, /모든 조회와 내보내기는 기록됩니다/);
  assert.match(auditCopy, /Cada consulta y exportación queda registrada/);
  assert.match(auditCopy, /never message text, attachment names, metadata, IP hashes/);
});

test('CSV hardening covers spreadsheet formulas hidden behind whitespace and controls', () => {
  assert.match(migration, /\^\[\[:space:\]\[:cntrl:\]\]\*\[=\+@-\]/);
  assert.match(migration, /then '''' \|\| coalesce\(p_value, ''\)/);
  assert.match(migration, /private\.audit_csv_cell\(row ->> 'target_id'\)/);
});
