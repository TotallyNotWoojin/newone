import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  normalizeHandoffCorrectionRequest,
  parseHandoffCorrectionReceipt,
} from '../apps/newone/src/data/repositories/handoff-correction-dto.mjs';

const organizationId = '10000000-0000-4000-8000-000000000001';
const handoffId = '10000000-0000-4000-8000-000000000002';
const versionId = '10000000-0000-4000-8000-000000000003';
const nextVersionId = '10000000-0000-4000-8000-000000000004';

function request(overrides = {}) {
  return {
    organizationId,
    handoffId,
    expectedVersionId: versionId,
    expectedVersionNumber: 3,
    title: '  Corrected pressure handoff  ',
    details: '  Gauge P-14 reads 41 PSI after calibration.  ',
    sourceLanguage: 'en',
    shiftStartedAt: '2026-08-04T08:00:00-06:00',
    shiftEndedAt: '2026-08-04T16:00:00-06:00',
    sourceMessageIds: ['102', '99'],
    acknowledgementDueAt: '2026-08-04T16:30:00-06:00',
    reason: '  Previous version transposed the pressure value.  ',
    idempotencyKey: '10000000-0000-4000-8000-000000000005',
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    handoffId,
    handoffVersionId: nextVersionId,
    versionNumber: 4,
    status: 'draft',
    requiresSignature: true,
    sourceMessageIds: [99, 102],
    sourceFingerprint: 'a'.repeat(64),
    sourceState: 'current',
    acknowledgementDueAt: '2026-08-04T22:30:00.000Z',
    reminderState: 'not_due',
    escalationState: 'not_due',
    smsFallbackAvailable: false,
    ...overrides,
  };
}

test('handoff correction requests bind the exact prior version, evidence, deadline, and reason', () => {
  const normalized = normalizeHandoffCorrectionRequest(request());
  assert.equal(normalized.title, 'Corrected pressure handoff');
  assert.equal(normalized.details, 'Gauge P-14 reads 41 PSI after calibration.');
  assert.equal(normalized.shiftStartedAt, '2026-08-04T14:00:00.000Z');
  assert.equal(normalized.shiftEndedAt, '2026-08-04T22:00:00.000Z');
  assert.equal(normalized.acknowledgementDueAt, '2026-08-04T22:30:00.000Z');
  assert.deepEqual(normalized.sourceMessageIds, ['99', '102']);
  assert.equal(normalized.reason, 'Previous version transposed the pressure value.');

  assert.throws(() => normalizeHandoffCorrectionRequest(request({ unknown: true })));
  assert.throws(() => normalizeHandoffCorrectionRequest(request({ sourceMessageIds: ['99', '99'] })));
  assert.throws(() => normalizeHandoffCorrectionRequest(request({ sourceMessageIds: [] })));
  assert.throws(() => normalizeHandoffCorrectionRequest(request({ shiftEndedAt: '2026-08-04T07:59:00-06:00' })));
  assert.throws(() => normalizeHandoffCorrectionRequest(request({ acknowledgementDueAt: '2026-08-04T15:59:00-06:00' })));
  assert.throws(() => normalizeHandoffCorrectionRequest(request({ reason: 'no' })));
});

test('handoff correction receipts fail closed on stale versions or altered evidence', () => {
  assert.deepEqual(parseHandoffCorrectionReceipt(receipt(), request()), {
    handoffId,
    versionId: nextVersionId,
    versionNumber: 4,
    status: 'draft',
    requiresSignature: true,
    sourceMessageIds: ['99', '102'],
    sourceFingerprint: 'a'.repeat(64),
    sourceState: 'current',
    acknowledgementDueAt: '2026-08-04T22:30:00.000Z',
    reminderState: 'not_due',
    escalationState: 'not_due',
    smsFallbackAvailable: false,
  });

  assert.throws(() => parseHandoffCorrectionReceipt(receipt({ versionNumber: 5 }), request()));
  assert.throws(() => parseHandoffCorrectionReceipt(receipt({ sourceMessageIds: [99] }), request()));
  assert.throws(() => parseHandoffCorrectionReceipt(receipt({ acknowledgementDueAt: null }), request()));
  assert.throws(() => parseHandoffCorrectionReceipt(receipt({ requiresSignature: false }), request()));
  assert.throws(() => parseHandoffCorrectionReceipt(receipt({ leakedAuditRow: true }), request()));
});

test('repository, workspace, and localized UI expose the complete correction flow', async () => {
  const [contracts, repository, workspace, screen, copy] = await Promise.all([
    readFile(new URL('../apps/newone/src/data/repositories/contracts.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/newone/src/data/repositories/bff-command-repository.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/newone/src/state/workspace.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../apps/newone/src/app/handoffs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../apps/newone/src/features/handoffs/handoff-correction-copy.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(contracts, /correctHandoff\(input:/);
  assert.match(repository, /\/v2\/handoffs\/\$\{encodeURIComponent\(normalized\.handoffId\)\}\/corrections/);
  assert.match(repository, /expectedVersionId: normalized\.expectedVersionId/);
  assert.match(repository, /expectedVersionNumber: normalized\.expectedVersionNumber/);
  assert.match(repository, /parseHandoffCorrectionReceipt\(payload, normalized\)/);
  for (const marker of [
    'handoff.versionId !== input.expectedVersionId',
    'expectedVersionId: input.expectedVersionId',
    "status: 'draft'",
    'correctionOfVersionId: handoff.versionId',
    "reminderState: 'not_due'",
  ]) assert.match(workspace, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const marker of [
    'correctionTarget',
    'correctionSourceMessageIds',
    'correctionAcknowledgementDueAt',
    'correctionReason',
    'workspace.correctHandoff',
    'copy.exactVersion',
    'copy.exactSources',
    'copy.deadline',
  ]) assert.match(screen, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(copy, /const ko:/);
  assert.match(copy, /const es:/);
});

test('acknowledgement confirms an exact version and carries a bounded optional discrepancy note', async () => {
  const [workspace, screen, copy] = await Promise.all([
    readFile(new URL('../apps/newone/src/state/workspace.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../apps/newone/src/app/handoffs.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../apps/newone/src/features/handoffs/handoff-acknowledgement-copy.ts', import.meta.url), 'utf8'),
  ]);
  for (const marker of [
    'handoff.versionId !== input.expectedVersionId',
    'handoff.versionNumber !== input.expectedVersionNumber',
    'versionId: input.expectedVersionId',
    'note && note.length > 2_000',
    'item.versionId === input.expectedVersionId',
  ]) assert.match(workspace, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const marker of [
    'acknowledgementTarget',
    'acknowledgementNote',
    'acknowledgementTarget.versionId',
    'expectedVersionNumber: acknowledgementTarget.versionNumber',
    'note: acknowledgementNote',
    'acknowledgementNote.trim().length > 2_000',
  ]) assert.match(screen, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(copy, /const ko:/);
  assert.match(copy, /const es:/);
  assert.match(copy, /up to 2,000 characters/);
});
