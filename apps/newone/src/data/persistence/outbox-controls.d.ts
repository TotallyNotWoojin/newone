import type { OutboxCommand, VisibleMessageOutboxItem } from '@/data/persistence/types';

export function visibleMessageOutbox(
  commands: unknown,
  userId: unknown,
  organizationId: unknown,
): VisibleMessageOutboxItem[];
export function editUnattemptedMessageCommand(
  command: unknown,
  body: unknown,
): OutboxCommand | null;
export function retryFailedMessageCommand(command: unknown): OutboxCommand | null;
