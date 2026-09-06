import type { Message } from '@/domain/types';

export interface TimelineRow {
  key: string;
  message: Message;
  /** The day changes at this message; the separator renders above it. */
  showDateSeparator: boolean;
  /** The first unread message; the divider renders above it. */
  showUnreadDivider: boolean;
  /** First incoming message of a run in a group: name and avatar show. */
  showSender: boolean;
}

/** Stable identity across the optimistic → server transition. */
export function messageKey(message: Pick<Message, 'id' | 'serverId' | 'clientMessageId'>): string {
  return message.serverId ?? message.clientMessageId ?? message.id;
}

/**
 * Newest-first rows for an inverted list: the newest message is index 0, so
 * the list opens at the bottom and stays there without any scroll logic.
 * Separator and sender flags come from the chronological neighbour above.
 */
export function buildTimelineRows(
  messages: readonly Message[],
  options: { unreadDividerId?: string | null; groupConversation: boolean },
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const previous = index > 0 ? messages[index - 1] : undefined;
    rows.push({
      key: message.id,
      message,
      showDateSeparator: Boolean(message.dayLabel) && message.dayLabel !== previous?.dayLabel,
      showUnreadDivider: Boolean(options.unreadDividerId) && message.id === options.unreadDividerId,
      showSender: !message.isOwn
        && !message.systemEvent
        && options.groupConversation
        && previous?.senderId !== message.senderId,
    });
  }
  return rows;
}

/** Messages that arrived after the previously known tail (at least one when the tail changed). */
export function appendedMessageCount(messages: readonly Message[], previousTailKey: string | null): number {
  if (!messages.length) return 0;
  if (!previousTailKey) return 1;
  const previousIndex = messages.findIndex((message) => messageKey(message) === previousTailKey);
  return previousIndex >= 0 ? Math.max(1, messages.length - previousIndex - 1) : 1;
}

export const MEDIA_MAX_HEIGHT = 320;
const DEFAULT_MEDIA_RATIO = 4 / 3;

/** Fit media of the given aspect ratio (width / height) inside the bubble limits. */
export function mediaFrame(ratio: number | null | undefined, maxWidth: number, maxHeight = MEDIA_MAX_HEIGHT) {
  const aspect = ratio && Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_MEDIA_RATIO;
  const boundedWidth = Math.max(1, maxWidth);
  const height = Math.round(Math.min(maxHeight, boundedWidth / aspect));
  const width = Math.round(Math.min(boundedWidth, height * aspect));
  return { width, height };
}

/**
 * 80% of the message row minus list padding and the avatar slot, capped so a
 * desktop pane never shows a billboard-sized photo.
 */
export function mediaMaxWidth(windowWidth: number, incoming: boolean) {
  const row = windowWidth - 2 * 12 - (incoming ? 34 : 0);
  return Math.max(120, Math.min(360, Math.floor(row * 0.8) - 6));
}
