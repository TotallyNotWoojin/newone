import type { Person } from '@/domain/types';

export const MAX_MESSAGE_MENTIONS: 50;
export function normalizeMentionSelection(
  value: unknown,
  memberUserIds: unknown,
  currentUserId: unknown,
  limit?: number,
): string[];
export function isValidMentionSelection(
  value: unknown,
  memberUserIds: unknown,
  currentUserId: unknown,
  limit?: number,
): boolean;
export function mentionablePeople(
  people: unknown,
  memberUserIds: unknown,
  currentUserId: unknown,
): Person[];
export function parseMentionDto(value: unknown, limit?: number): string[] | null;
