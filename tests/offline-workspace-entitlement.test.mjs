import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OFFLINE_WORKSPACE_MAX_AGE_MS,
  offlineWorkspaceEntitlement,
  parseOfflineWorkspaceMembership,
} from '../apps/newone/src/data/persistence/offline-workspace-entitlement.mjs';

const now = Date.parse('2026-08-04T12:00:00.000Z');
const sponsorUserId = '00000000-0000-4000-8000-000000000001';

test('employee cache entitlement is bounded to the fixed maximum age', () => {
  const entitlement = offlineWorkspaceEntitlement({
    membershipType: 'employee',
    accessExpiresAt: null,
    guestSponsorUserId: null,
  }, now);

  assert.deepEqual(entitlement, {
    eligible: true,
    expiresAt: new Date(now + OFFLINE_WORKSPACE_MAX_AGE_MS).toISOString(),
    reason: 'eligible',
  });
});

test('contractor cache entitlement never outlives membership access', () => {
  const shortExpiry = new Date(now + 90 * 60 * 1000).toISOString();
  assert.deepEqual(offlineWorkspaceEntitlement({
    membershipType: 'contractor',
    accessExpiresAt: shortExpiry,
    guestSponsorUserId: null,
  }, now), {
    eligible: true,
    expiresAt: shortExpiry,
    reason: 'eligible',
  });

  assert.equal(offlineWorkspaceEntitlement({
    membershipType: 'contractor',
    accessExpiresAt: new Date(now + 48 * 60 * 60 * 1000).toISOString(),
    guestSponsorUserId: null,
  }, now).expiresAt, new Date(now + OFFLINE_WORKSPACE_MAX_AGE_MS).toISOString());

  assert.deepEqual(offlineWorkspaceEntitlement({
    membershipType: 'contractor',
    accessExpiresAt: new Date(now).toISOString(),
    guestSponsorUserId: null,
  }, now), {
    eligible: false,
    expiresAt: null,
    reason: 'membership_expired',
  });
});

test('guests never receive or hydrate an offline workspace', () => {
  assert.deepEqual(offlineWorkspaceEntitlement({
    membershipType: 'guest',
    accessExpiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    guestSponsorUserId: sponsorUserId,
  }, now), {
    eligible: false,
    expiresAt: null,
    reason: 'guest_offline_cache_disabled',
  });
});

test('malformed, legacy, and cross-type entitlement tuples fail closed', () => {
  for (const membership of [
    null,
    {},
    { membershipType: 'employee', accessExpiresAt: new Date(now + 1_000).toISOString(), guestSponsorUserId: null },
    { membershipType: 'employee', accessExpiresAt: null, guestSponsorUserId: sponsorUserId },
    { membershipType: 'contractor', accessExpiresAt: null, guestSponsorUserId: null },
    { membershipType: 'contractor', accessExpiresAt: 'not-a-date', guestSponsorUserId: null },
    { membershipType: 'contractor', accessExpiresAt: new Date(now + 1_000).toISOString(), guestSponsorUserId: sponsorUserId },
    { membershipType: 'guest', accessExpiresAt: new Date(now + 1_000).toISOString(), guestSponsorUserId: null },
  ]) {
    assert.equal(offlineWorkspaceEntitlement(membership, now).eligible, false);
  }
  assert.equal(offlineWorkspaceEntitlement({
    membershipType: 'employee', accessExpiresAt: null, guestSponsorUserId: null,
  }, Number.NaN).eligible, false);
  assert.equal(offlineWorkspaceEntitlement({
    membershipType: 'employee', accessExpiresAt: null, guestSponsorUserId: null,
  }, Number.MAX_VALUE).eligible, false);
});

test('bootstrap membership parser preserves only exact lifecycle tuples', () => {
  const employee = {
    membershipType: 'employee', accessExpiresAt: null, guestSponsorUserId: null,
  };
  assert.deepEqual(parseOfflineWorkspaceMembership(employee), employee);
  assert.equal(Object.isFrozen(parseOfflineWorkspaceMembership(employee)), true);

  const contractor = {
    membershipType: 'contractor',
    accessExpiresAt: new Date(now + 1_000).toISOString(),
    guestSponsorUserId: null,
  };
  assert.deepEqual(parseOfflineWorkspaceMembership(contractor), contractor);
  assert.deepEqual(parseOfflineWorkspaceMembership({ membershipType: 'employee' }), employee);
  assert.deepEqual(parseOfflineWorkspaceMembership({
    membershipType: 'contractor', accessExpiresAt: contractor.accessExpiresAt,
  }), contractor);

  assert.equal(parseOfflineWorkspaceMembership({
    membershipType: 'guest',
    accessExpiresAt: contractor.accessExpiresAt,
    guestSponsorUserId: 'not-a-user-id',
  }), null);
});
