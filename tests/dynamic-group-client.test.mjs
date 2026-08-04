import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDynamicGroupPauseReceipt,
  parseDynamicGroupPolicyList,
  parseDynamicGroupPolicySpec,
  parseDynamicGroupPreviewReceipt,
  parseDynamicGroupPublishReceipt,
  parseDynamicGroupSaveReceipt,
} from '../apps/newone/src/data/repositories/dynamic-group-dto.mjs';

const policyId = '10000000-0000-4000-8000-000000000001';
const conversationId = '20000000-0000-4000-8000-000000000002';
const unitId = '30000000-0000-4000-8000-000000000003';
const addedId = '40000000-0000-4000-8000-000000000004';
const removedId = '50000000-0000-4000-8000-000000000005';
const unchangedId = '60000000-0000-4000-8000-000000000006';
const versionId = '70000000-0000-4000-8000-000000000007';
const selectorFingerprint = 'a'.repeat(64);
const previewFingerprint = 'b'.repeat(64);
const membershipFingerprint = 'c'.repeat(64);

const policySpec = {
  siteIds: [],
  departmentIds: [],
  teamIds: [unitId],
  lineIds: [],
  unitIds: [],
  includeDescendants: true,
  operationalRoles: ['forklift operator', 'shift lead'],
  membershipRoles: ['manager', 'member'],
  shiftMode: 'current',
  scheduledShiftStartsAt: null,
  scheduledShiftEndsAt: null,
};

test('dynamic-group selector parsing is exact, normalized, and schedule bounded', () => {
  assert.deepEqual(parseDynamicGroupPolicySpec(policySpec), policySpec);
  assert.throws(
    () => parseDynamicGroupPolicySpec({ ...policySpec, arbitrarySql: 'select *' }),
    /Invalid dynamic-group policy selector/,
  );
  assert.throws(
    () => parseDynamicGroupPolicySpec({ ...policySpec, operationalRoles: ['Shift Lead'] }),
    /Invalid operational role/,
  );
  assert.throws(
    () => parseDynamicGroupPolicySpec({ ...policySpec, membershipRoles: [] }),
    /Invalid dynamic-group policy selector/,
  );
  assert.throws(
    () => parseDynamicGroupPolicySpec({
      ...policySpec,
      shiftMode: 'scheduled',
      scheduledShiftStartsAt: '2026-08-05T08:00:00Z',
      scheduledShiftEndsAt: '2026-09-10T08:00:00Z',
    }),
    /Invalid dynamic-group shift window/,
  );
});

test('dynamic-group policy list is bounded, ordered, and exposes CAS editing state only', () => {
  const policy = {
    policyId,
    conversationId,
    conversationName: 'Night shift packaging',
    conversationKind: 'shift',
    conversationUnitId: unitId,
    status: 'active',
    version: 3,
    draftState: 'published',
    policySpec,
    maximumMembers: 250,
    selectorFingerprint,
    publishedVersionId: versionId,
    lastPreviewFingerprint: previewFingerprint,
    lastPreviewedAt: '2026-08-04T18:00:00Z',
    lastSyncedAt: '2026-08-04T18:01:00Z',
    nextEvaluationAt: null,
    sourceChangedAt: null,
    createdAt: '2026-08-03T18:00:00Z',
    updatedAt: '2026-08-04T18:01:00Z',
  };
  assert.deepEqual(parseDynamicGroupPolicyList({
    policies: [policy],
    limit: 1,
    nextAfterPolicyId: policyId,
  }), {
    policies: [policy],
    limit: 1,
    nextAfterPolicyId: policyId,
  });
  assert.throws(() => parseDynamicGroupPolicyList({
    policies: [{ ...policy, privatePreviewData: true }],
    limit: 1,
    nextAfterPolicyId: policyId,
  }), /Invalid dynamic-group policy/);
  assert.throws(() => parseDynamicGroupPolicyList({
    policies: [policy],
    limit: 2,
    nextAfterPolicyId: policyId,
  }), /Invalid dynamic-group policy cursor/);
});

test('save and preview receipts bind the exact version and disjoint audience samples', () => {
  const save = {
    policyId,
    conversationId,
    version: 3,
    draftState: 'draft',
    selectorFingerprint,
    requiresPreview: true,
    publishedVersionId: versionId,
  };
  assert.deepEqual(parseDynamicGroupSaveReceipt(save), save);
  const preview = {
    policyId,
    policyVersion: 3,
    previewFingerprint,
    selectorFingerprint,
    membershipStateFingerprint: membershipFingerprint,
    evaluatedAt: '2026-08-04T18:02:00Z',
    validUntil: '2026-08-04T18:07:00Z',
    eligibleCount: 2,
    addedCount: 1,
    removedCount: 1,
    unchangedCount: 1,
    addedSampleUserIds: [addedId],
    removedSampleUserIds: [removedId],
    unchangedSampleUserIds: [unchangedId],
    nextBoundaryAt: null,
  };
  assert.deepEqual(parseDynamicGroupPreviewReceipt(preview), preview);
  assert.throws(
    () => parseDynamicGroupPreviewReceipt({
      ...preview,
      unchangedSampleUserIds: [addedId],
    }),
    /overlapping dynamic-group preview samples/,
  );
  assert.throws(
    () => parseDynamicGroupPreviewReceipt({ ...preview, eligibleCount: 3 }),
    /Invalid dynamic-group preview counts/,
  );
});

test('publish and pause receipts reject widened or incoherent lifecycle claims', () => {
  const publish = {
    policyId,
    policyVersion: 3,
    publishedVersionId: versionId,
    status: 'active',
    draftState: 'published',
    eligibleCount: 2,
    addedCount: 1,
    removedCount: 1,
    unchangedCount: 1,
    selectorFingerprint,
    nextEvaluationAt: null,
  };
  assert.deepEqual(parseDynamicGroupPublishReceipt(publish), publish);
  assert.throws(
    () => parseDynamicGroupPublishReceipt({ ...publish, status: 'paused' }),
    /Invalid dynamic-group publish receipt/,
  );
  const pause = {
    policyId,
    policyVersion: 3,
    status: 'paused',
    pausedAt: '2026-08-04T18:10:00Z',
  };
  assert.deepEqual(parseDynamicGroupPauseReceipt(pause), pause);
  assert.throws(
    () => parseDynamicGroupPauseReceipt({ ...pause, reason: 'private' }),
    /Invalid dynamic-group pause receipt/,
  );
});
