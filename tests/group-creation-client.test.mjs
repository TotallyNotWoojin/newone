import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseConversationMemberRoleReceipt,
  parseGroupCreationCandidates,
  parseGroupCreationReceipt,
} from '../apps/newone/src/data/repositories/group-creation-dto.mjs';

const conversationId = '40000000-0000-4000-8000-000000000004';
const userId = '50000000-0000-4000-8000-000000000005';

const candidateReceipt = {
  candidates: [{
    userId,
    displayName: 'Luis Ortega',
    // Consumer @handles are part of the authorization-scoped identity now.
    username: null,
    avatarPath: null,
    jobTitle: 'Contract operator',
    membershipRole: 'member',
    membershipType: 'guest',
    accessExpiresAt: '2026-09-03T20:00:00.000Z',
  }],
  limit: 25,
};

const creationReceipt = {
  conversationId,
  kind: 'team',
  name: 'Packaging handoff',
  description: 'Coordinate packaging and dispatch.',
  historyPolicy: 'since_join',
  historyDisclosure: {
    policy: 'since_join',
    visibleFrom: '2026-08-04T20:00:00.000Z',
    labelKey: 'conversation.history.since_join',
  },
  postingMode: 'admins_only',
  joinPolicy: 'approval_required',
  configuredJoinPolicy: 'approval_required',
  visibility: 'organization',
  memberCount: 3,
  memberLimit: 500,
  isReadOnly: false,
};

test('candidate parser preserves only authorization-scoped identity and guest expiry fields', () => {
  assert.deepEqual(parseGroupCreationCandidates(candidateReceipt), candidateReceipt);
  assert.throws(() => parseGroupCreationCandidates({
    ...candidateReceipt,
    candidates: [{ ...candidateReceipt.candidates[0], email: 'private@example.com' }],
  }), /Invalid group creation candidate/);
  assert.throws(() => parseGroupCreationCandidates({
    ...candidateReceipt,
    candidates: [{
      ...candidateReceipt.candidates[0],
      membershipRole: 'admin',
    }],
  }), /Invalid guest group creation candidate/);
  assert.throws(() => parseGroupCreationCandidates({
    ...candidateReceipt,
    candidates: [{ ...candidateReceipt.candidates[0], accessExpiresAt: null }],
  }), /Invalid guest group creation candidate/);
});

test('creation parser accepts a coherent authoritative receipt and rejects hidden widening', () => {
  assert.deepEqual(parseGroupCreationReceipt(creationReceipt), creationReceipt);
  assert.throws(() => parseGroupCreationReceipt({ ...creationReceipt, privatePolicy: true }), /Invalid group creation receipt/);
  assert.throws(() => parseGroupCreationReceipt({
    ...creationReceipt,
    joinPolicy: 'invite_only',
  }), /Invalid effective group join policy/);
  assert.throws(() => parseGroupCreationReceipt({
    ...creationReceipt,
    historyDisclosure: {
      ...creationReceipt.historyDisclosure,
      visibleFrom: null,
    },
  }), /Invalid group history disclosure/);
});

test('member role parser requires an exact changed CAS receipt', () => {
  const receipt = {
    conversationId,
    userId,
    previousRole: 'member',
    role: 'admin',
  };
  assert.deepEqual(parseConversationMemberRoleReceipt(receipt), receipt);
  assert.throws(() => parseConversationMemberRoleReceipt({ ...receipt, role: 'member' }), /unchanged/);
  assert.throws(() => parseConversationMemberRoleReceipt({ ...receipt, actorUserId: userId }), /Invalid conversation member role receipt/);
});
