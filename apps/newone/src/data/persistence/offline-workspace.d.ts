import type { WorkspaceSnapshot } from '@/data/repositories/contracts';

export function offlineWorkspaceCacheKey(userId: unknown): string | null;
export function offlineWorkspaceExpiresAt(snapshot: unknown, now?: number): string | null;
export function offlineWorkspaceSnapshotExpiresAt(snapshot: unknown): string | null;
export function serializeOfflineWorkspace(snapshot: unknown, now?: number): string | null;
export function parseOfflineWorkspace(
  serialized: unknown,
  expectedUserId: unknown,
  now?: number,
): WorkspaceSnapshot | null;
