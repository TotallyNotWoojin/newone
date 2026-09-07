import { describe, expect, test } from '@jest/globals';

import {
  announcesVisibleConversation,
  getVisibleConversation,
  setVisibleConversation,
} from '@/device/visible-conversation';

describe('the chat that is on screen', () => {
  test('is remembered and cleared', () => {
    setVisibleConversation('conversation-1');
    expect(getVisibleConversation()).toBe('conversation-1');
    setVisibleConversation(null);
    expect(getVisibleConversation()).toBeNull();
    setVisibleConversation('');
    expect(getVisibleConversation()).toBeNull();
  });

  test('silences a notification for itself and nothing else', () => {
    expect(announcesVisibleConversation({ conversation_id: 'a' }, 'a')).toBe(true);
    expect(announcesVisibleConversation({ conversation_id: 'b' }, 'a')).toBe(false);
    // No chat open: every notification is announced.
    expect(announcesVisibleConversation({ conversation_id: 'a' }, null)).toBe(false);
    // A notification that names no chat is announced.
    expect(announcesVisibleConversation({ event_type: 'announcement.published' }, 'a')).toBe(false);
    expect(announcesVisibleConversation(undefined, 'a')).toBe(false);
    expect(announcesVisibleConversation({ conversation_id: 42 }, 'a')).toBe(false);
  });
});
