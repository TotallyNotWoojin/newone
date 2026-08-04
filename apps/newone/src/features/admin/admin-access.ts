import type { WorkspaceCapability } from '@/domain/types';

export const ADMIN_SURFACE_CAPABILITIES: readonly WorkspaceCapability[] = [
  'members.security',
  'sessions.revoke',
  'roles.manage',
  'roles.read',
  'audit.read',
  'message.preservation.manage',
  'ai.policy.manage',
  'directory.manage',
  'directory.read',
  'invites.manage',
  'unit.manage',
  'conversation.manage',
  'reports.investigate',
  'reports.assign',
  'recovery.manage',
  'language.review',
];

export function canAccessAdminSurface(capabilities: readonly WorkspaceCapability[]): boolean {
  return ADMIN_SURFACE_CAPABILITIES.some((capability) => capabilities.includes(capability));
}
