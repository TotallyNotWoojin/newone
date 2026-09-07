import type { Message } from '@/domain/types';

/**
 * Editing and unsending close fifteen minutes after a message is sent.
 *
 * The database is the authority — private.validate_message_update() refuses a
 * late edit with message_edit_window_closed and a late unsend with
 * message_unsend_window_closed. This is the same clock, read on the phone, so
 * the two actions simply stop being offered instead of failing when tapped.
 */
export const messageEditWindowMs = 15 * 60 * 1000;

/**
 * True while a message you sent can still be changed. A message that is not
 * yours, is not on the server yet, is already deleted, or carries no timestamp
 * we can read is past changing.
 */
export function messageEditWindowOpen(
  message: Pick<Message, 'isOwn' | 'serverId' | 'deleted' | 'createdAt'>,
  now: number = Date.now(),
): boolean {
  if (!message.isOwn || !message.serverId || message.deleted) return false;
  if (!message.createdAt) return false;
  const sentAt = Date.parse(message.createdAt);
  if (Number.isNaN(sentAt)) return false;
  const age = now - sentAt;
  // A clock that runs slightly behind the server's must not close the window
  // early, so anything dated in the future counts as just sent.
  return age < messageEditWindowMs;
}
