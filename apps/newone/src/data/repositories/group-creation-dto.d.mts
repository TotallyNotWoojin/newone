export type InitialConversationRole = 'owner' | 'admin' | 'member';

export interface GroupCreationCandidate {
  userId: string;
  displayName: string;
  avatarPath: string | null;
  jobTitle: string | null;
  membershipRole: 'owner' | 'admin' | 'manager' | 'member';
  membershipType: 'employee' | 'contractor' | 'guest';
  accessExpiresAt: string | null;
}

export interface GroupCreationCandidatesReceipt {
  candidates: GroupCreationCandidate[];
  limit: number;
}

export interface GroupCreationReceipt {
  conversationId: string;
  kind: 'group' | 'team' | 'shift' | 'incident';
  name: string;
  description: string | null;
  historyPolicy: 'all' | 'since_join';
  historyDisclosure: {
    policy: 'all' | 'since_join';
    visibleFrom: string | null;
    labelKey: 'conversation.history.all' | 'conversation.history.since_join';
  };
  postingMode: 'all_members' | 'admins_only';
  joinPolicy: 'invite_only' | 'approval_required';
  configuredJoinPolicy: 'inherit' | 'invite_only' | 'approval_required';
  visibility: 'invite_only' | 'organization' | 'unit';
  memberCount: number;
  memberLimit: number;
  isReadOnly: false;
}

/** No group was created: this one already holds exactly those people. */
export interface GroupAlreadyExistsReceipt {
  alreadyExists: true;
  conversationId: string;
}

export interface ConversationMemberRoleReceipt {
  conversationId: string;
  userId: string;
  previousRole: InitialConversationRole;
  role: InitialConversationRole;
}

export function parseGroupCreationCandidates(value: unknown): GroupCreationCandidatesReceipt;
export function parseGroupCreationReceipt(value: unknown): GroupCreationReceipt;
export function groupAlreadyExists(value: unknown): boolean;
export function parseGroupAlreadyExistsReceipt(value: unknown): GroupAlreadyExistsReceipt;
export function parseConversationMemberRoleReceipt(value: unknown): ConversationMemberRoleReceipt;
