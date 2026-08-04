export const WORKSPACE_CAPABILITIES = Object.freeze([
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
  'communications.publish',
  'unit.manage',
  'conversation.manage',
  'language.review',
  'recovery.manage',
  'handoff.manage',
  'actions.confirm',
  'reports.investigate',
  'reports.assign',
]);

const knownCapabilities = new Set(WORKSPACE_CAPABILITIES);

/**
 * Filter the complete server projection before bounding and deduplicating it.
 * Owners receive base product capabilities plus every built-in role permission,
 * so truncating the raw alphabetic list first can discard security controls at
 * the end of the list.
 */
export function parseWorkspaceCapabilities(value) {
  if (!Array.isArray(value)) return [];
  const recognized = new Set();
  for (const item of value) {
    if (typeof item === 'string' && knownCapabilities.has(item)) recognized.add(item);
  }
  return WORKSPACE_CAPABILITIES.filter((capability) => recognized.has(capability));
}
