import type { OutboxCommand } from '@/data/persistence/types';
import type { WorkspaceSnapshot } from '@/data/repositories/contracts';

export function conversationOutboxCommandIds(
  commands: OutboxCommand[],
  conversationId: string,
): string[];

export function redactDepartedConversation(
  snapshot: WorkspaceSnapshot,
  conversationId: string,
): WorkspaceSnapshot;
