import type { WorkspaceCapability } from '../../domain/types';

export const WORKSPACE_CAPABILITIES: readonly WorkspaceCapability[];
export function parseWorkspaceCapabilities(value: unknown): WorkspaceCapability[];
