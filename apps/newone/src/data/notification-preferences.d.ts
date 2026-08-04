export type ConversationNotificationLevel = 'all' | 'mentions' | 'none';

export function normalizeNotificationLevel(value: unknown): ConversationNotificationLevel;
export function activeMutedUntil(value: unknown, now?: number): string | null;
export function isConversationMuted(level: unknown, mutedUntil: unknown, now?: number): boolean;
export function temporaryMutePatch(
  level: unknown,
  durationSeconds: number,
  now?: number,
): { notificationLevel: Exclude<ConversationNotificationLevel, 'none'>; mutedUntil: string } | null;
