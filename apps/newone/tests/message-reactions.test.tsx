import { describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import {
  isSingleEmoji,
  maxReactionCodePoints,
  normalizeReactionEmoji,
  quickReactionEmojis,
} from '@/features/chat/message-reactions';
import { ReactionRow } from '@/features/chat/reaction-row';

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

describe('the reaction row', () => {
  test('offers the six reactions in order, and neither of the two that were dropped', () => {
    expect([...quickReactionEmojis]).toEqual(['👍', '❤️', '😂', '😮', '😢', '🙏']);
    expect(quickReactionEmojis).not.toContain('✅');
    expect(quickReactionEmojis).not.toContain('👀');
  });

  test('renders every reaction plus the "+" and sends the one that is pressed', async () => {
    const onReact = jest.fn<(emoji: string) => void>();
    await render(<ReactionRow onReact={onReact} />);

    for (const emoji of quickReactionEmojis) {
      expect(screen.getByLabelText(`chat.react ${emoji}`)).toBeTruthy();
    }
    expect(screen.getByLabelText('chat.reactMore')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('chat.react 😂'));
    expect(onReact).toHaveBeenCalledWith('😂');
    expect(onReact).toHaveBeenCalledTimes(1);
  });

  test('scrolls sideways instead of wrapping onto a second line', async () => {
    await render(<ReactionRow onReact={jest.fn<(emoji: string) => void>()} />);
    const scroller = screen.getByTestId('reaction-row');
    expect(scroller.props.horizontal).toBe(true);
    const contentStyle = scroller.props.contentContainerStyle as { flexWrap?: string };
    expect(contentStyle.flexWrap).toBeUndefined();
  });

  test('"+" opens a field that takes whatever emoji the keyboard produces', async () => {
    const onReact = jest.fn<(emoji: string) => void>();
    await render(<ReactionRow onReact={onReact} />);

    expect(screen.queryByPlaceholderText('chat.reactAnyEmoji')).toBeNull();
    fireEvent.press(screen.getByLabelText('chat.reactMore'));
    await waitFor(() => expect(screen.queryByPlaceholderText('chat.reactAnyEmoji')).not.toBeNull());

    fireEvent.changeText(screen.getByPlaceholderText('chat.reactAnyEmoji'), '🦄');
    await waitFor(() => expect(screen.getByPlaceholderText('chat.reactAnyEmoji').props.value).toBe('🦄'));
    fireEvent.press(screen.getByLabelText('chat.reactSendEmoji'));

    expect(onReact).toHaveBeenCalledWith('🦄');
    await waitFor(() => expect(screen.queryByPlaceholderText('chat.reactAnyEmoji')).toBeNull());
  });

  test('refuses text typed into the field, and clears the complaint on the next keystroke', async () => {
    const onReact = jest.fn<(emoji: string) => void>();
    await render(<ReactionRow onReact={onReact} />);
    fireEvent.press(screen.getByLabelText('chat.reactMore'));
    await waitFor(() => expect(screen.queryByPlaceholderText('chat.reactAnyEmoji')).not.toBeNull());

    fireEvent.changeText(screen.getByPlaceholderText('chat.reactAnyEmoji'), 'nope');
    await waitFor(() => expect(screen.getByPlaceholderText('chat.reactAnyEmoji').props.value).toBe('nope'));
    fireEvent(screen.getByPlaceholderText('chat.reactAnyEmoji'), 'submitEditing');

    expect(onReact).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('chat.reactOneEmojiOnly')).not.toBeNull());

    fireEvent.changeText(screen.getByPlaceholderText('chat.reactAnyEmoji'), '🐙');
    await waitFor(() => expect(screen.queryByText('chat.reactOneEmojiOnly')).toBeNull());
    fireEvent(screen.getByPlaceholderText('chat.reactAnyEmoji'), 'submitEditing');
    expect(onReact).toHaveBeenCalledWith('🐙');
  });

  test('every control dims while it is held down', async () => {
    await render(<ReactionRow onReact={jest.fn<(emoji: string) => void>()} />);
    for (const label of ['chat.react 👍', 'chat.reactMore']) {
      const style = screen.getByLabelText(label).props.style;
      expect(style).toBeTruthy();
    }
    fireEvent.press(screen.getByLabelText('chat.reactMore'));
    await waitFor(() => expect(screen.queryByPlaceholderText('chat.reactAnyEmoji')).not.toBeNull());
    // Pressing "+" again puts the field away without sending anything.
    fireEvent.press(screen.getByLabelText('chat.reactMore'));
    await waitFor(() => expect(screen.queryByPlaceholderText('chat.reactAnyEmoji')).toBeNull());
  });

  test('the row stays quiet while a reaction is already in flight', async () => {
    const onReact = jest.fn<(emoji: string) => void>();
    await render(<ReactionRow disabled onReact={onReact} />);
    const options = { includeHiddenElements: true };
    fireEvent.press(screen.getByLabelText('chat.react 👍', options));
    fireEvent.press(screen.getByLabelText('chat.reactMore', options));
    expect(onReact).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('chat.reactAnyEmoji')).toBeNull();
  });
});

describe('the single-emoji check', () => {
  test.each([
    ['👍', 'a plain emoji'],
    ['❤️', 'an emoji carrying a variation selector'],
    ['🙏', 'one of the six'],
    ['👍🏽', 'an emoji with a skin tone'],
    ['👩‍💻', 'a joined sequence'],
    ['👨‍👩‍👧‍👦', 'a long joined sequence'],
    ['🇰🇷', 'a country flag'],
    ['🏴󠁧󠁢󠁳󠁣󠁴󠁿', 'a subdivision flag'],
    ['#️⃣', 'a keycap'],
    ['9️⃣', 'a digit keycap'],
    ['☂️', 'an emoji from the older symbol blocks'],
    ['🫠', 'a recently added emoji'],
  ])('accepts %s (%s)', (value) => {
    expect(isSingleEmoji(value)).toBe(true);
  });

  test.each([
    ['', 'nothing'],
    ['   ', 'blank space'],
    ['ok', 'a word'],
    ['a', 'a letter'],
    ['1', 'a bare digit without its keycap'],
    ['👍👍', 'two emoji'],
    ['👍 ', 'an emoji with a trailing space'],
    ['👍!', 'an emoji with punctuation'],
    ['hi 👍', 'text before an emoji'],
    ['👍‍', 'a trailing joiner'],
    ['🇰', 'half a flag'],
    ['🇰🇷🇺🇸', 'two flags'],
    ['→', 'an arrow that is not an emoji'],
    ['한', 'a Korean syllable'],
    ['<script>', 'markup'],
  ])('refuses %s (%s)', (value) => {
    expect(isSingleEmoji(value)).toBe(false);
  });

  test('refuses a sequence longer than the cap', () => {
    const tooLong = '👩'.concat('‍👩'.repeat(maxReactionCodePoints));
    expect(isSingleEmoji(tooLong)).toBe(false);
  });

  test('normalizing trims the keyboard’s stray space and rejects everything else', () => {
    expect(normalizeReactionEmoji(' 🙏 ')).toBe('🙏');
    expect(normalizeReactionEmoji('nope')).toBeNull();
    expect(normalizeReactionEmoji('')).toBeNull();
    expect(normalizeReactionEmoji(undefined as unknown as string)).toBeNull();
  });
});
