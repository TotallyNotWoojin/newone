import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ConversationList } from '@/features/chat/conversation-list';
import type { SearchSuggestion } from '@/features/search/chat-search';

let mockWorkspace: any;

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));

const people = [
  { id: 'person-ana', displayName: 'Ana Ruiz', username: 'ana_r' },
  { id: 'person-ben', displayName: 'Ben Cole', username: 'bencole' },
];

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conversation-beach',
    title: 'Beach trip',
    subtitle: '3 people',
    lastMessage: 'Bring the umbrella',
    kind: 'group',
    unreadCount: 0,
    pinned: false,
    lastActivity: '18:00',
    avatarColor: '#496D62',
    initials: 'BT',
    presence: 'offline',
    priority: 'normal',
    muted: false,
    managementOnly: false,
    memberIds: ['person-me', 'person-ana', 'person-ben'],
    ...overrides,
  } as any;
}

const suggestions: SearchSuggestion[] = [
  {
    kind: 'person',
    key: 'person:person-ana',
    personId: 'person-ana',
    title: 'Ana Ruiz',
    subtitle: '@ana_r',
    known: true,
  },
  {
    kind: 'conversation',
    key: 'conversation:conversation-beach',
    conversationId: 'conversation-beach',
    title: 'Beach trip',
    subtitle: '3 people',
    group: true,
  },
  {
    kind: 'message',
    key: 'message:message-1',
    conversationId: 'conversation-beach',
    messageId: 'message-1',
    title: 'Beach trip',
    subtitle: 'Ana brought the umbrella',
  },
];

function listProps(overrides: Record<string, unknown> = {}) {
  return {
    conversations: [
      conversation(),
      conversation({
        id: 'conversation-ana',
        title: 'Ana Ruiz',
        kind: 'direct',
        subtitle: '@ana_r',
        lastMessage: 'See you at six',
        memberIds: [],
        directParticipantId: 'person-ana',
      }),
    ],
    filter: 'all',
    search: '',
    people,
    suggestions: [],
    onFilterChange: jest.fn(),
    onSearchChange: jest.fn(),
    onSelect: jest.fn(),
    onCompose: jest.fn(),
    ...overrides,
  } as any;
}

beforeEach(() => {
  mockWorkspace = { conversationAvatarUrls: {}, people: [] };
});

describe('the one search field on Chats', () => {
  test('suggestions arrive in phone order: people, then chats and groups, then messages', async () => {
    await render(<ConversationList {...listProps({ search: 'an', suggestions })} />);

    expect(screen.getByText('search.sectionPeople')).toBeTruthy();
    expect(screen.getByText('search.sectionChats')).toBeTruthy();
    expect(screen.getByText('search.sectionMessages')).toBeTruthy();
    expect(screen.getByText('@ana_r')).toBeTruthy();
    expect(screen.getByText('Ana brought the umbrella')).toBeTruthy();
  });

  test('tapping a person writes the name and the comma so the next one can be typed', async () => {
    const onSearchChange = jest.fn();
    await render(<ConversationList {...listProps({
      search: 'an',
      suggestions,
      onSearchChange,
    })} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Ana Ruiz · @ana_r' }));
    expect(onSearchChange).toHaveBeenCalledWith('Ana Ruiz, ');
  });

  test('a chat or a message hit is somewhere to go, not a chip', async () => {
    const onOpenSuggestion = jest.fn();
    const onSearchChange = jest.fn();
    await render(<ConversationList {...listProps({
      search: 'beach',
      suggestions,
      onOpenSuggestion,
      onSearchChange,
    })} />);

    await fireEvent.press(screen.getByRole('button', {
      name: 'Beach trip · Ana brought the umbrella',
    }));
    expect(onOpenSuggestion).toHaveBeenCalledWith(expect.objectContaining({ kind: 'message' }));
    expect(onSearchChange).not.toHaveBeenCalled();
  });

  test('chips are drawn with their own clear control and one tap removes just that one', async () => {
    const onSearchChange = jest.fn();
    await render(<ConversationList {...listProps({
      search: 'Ana Ruiz, Ben Cole, ',
      onSearchChange,
    })} />);

    // The remove affordance is part of the chip, so it is there on a phone
    // with no hover at all.
    const chips = screen.getAllByRole('button', { name: 'search.chipRemove' });
    expect(chips).toHaveLength(2);

    await fireEvent.press(chips[0]!);
    expect(onSearchChange).toHaveBeenCalledWith('Ben Cole, ');
  });

  test('typing edits only the tail and leaves the chips standing', async () => {
    const onSearchChange = jest.fn();
    await render(<ConversationList {...listProps({
      search: 'Ana Ruiz, be',
      onSearchChange,
    })} />);

    const input = screen.getByTestId('chat-search-field');
    expect(input.props.value).toBe('be');
    await fireEvent.changeText(input, 'bea');
    expect(onSearchChange).toHaveBeenCalledWith('Ana Ruiz, bea');
  });

  test('an empty field types straight through and the clear control appears once used', async () => {
    const onSearchChange = jest.fn();
    const view = await render(<ConversationList {...listProps({ onSearchChange })} />);
    expect(screen.queryByRole('button', { name: 'common.clearSearch' })).toBeNull();

    await fireEvent.changeText(screen.getByTestId('chat-search-field'), 'be');
    expect(onSearchChange).toHaveBeenCalledWith('be');

    await view.rerender(<ConversationList {...listProps({ onSearchChange, search: 'be' })} />);
    await fireEvent.press(screen.getByRole('button', { name: 'common.clearSearch' }));
    expect(onSearchChange).toHaveBeenLastCalledWith('');
  });

  test('two people chipped leave only the conversation containing both', async () => {
    const view = await render(<ConversationList {...listProps({ search: 'Ana Ruiz, ' })} />);
    expect(screen.getAllByText('Beach trip').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ana Ruiz').length).toBeGreaterThan(0);

    await view.rerender(<ConversationList {...listProps({ search: 'Ana Ruiz, Ben Cole, ' })} />);
    expect(screen.getByText('Beach trip')).toBeTruthy();
    // The direct chat with Ana does not contain Ben, so it drops out.
    expect(screen.queryByText('See you at six')).toBeNull();
  });

  test('a word the rows cannot answer still keeps the chats the server matched', async () => {
    const view = await render(<ConversationList {...listProps({
      search: 'Ana Ruiz, sandcastle',
    })} />);
    expect(screen.getByText('chat.noResults')).toBeTruthy();

    await view.rerender(<ConversationList {...listProps({
      search: 'Ana Ruiz, sandcastle',
      suggestions: [suggestions[2]!],
    })} />);
    expect(screen.queryByText('chat.noResults')).toBeNull();
    expect(screen.getAllByText('Beach trip').length).toBeGreaterThan(1);
  });

  test('nothing at all says so, and the filter panel is offered only when there is one', async () => {
    const onOpenAdvancedSearch = jest.fn();
    const view = await render(<ConversationList {...listProps({ search: 'zzz' })} />);
    expect(screen.getByText('search.nothingFound')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'search.moreFilters' })).toBeNull();

    await view.rerender(<ConversationList {...listProps({ search: 'zzz', onOpenAdvancedSearch })} />);
    await fireEvent.press(screen.getByRole('button', { name: 'search.moreFilters' }));
    expect(onOpenAdvancedSearch).toHaveBeenCalled();
  });

  test('the field says it is working while the server answers', async () => {
    await render(<ConversationList {...listProps({ search: 'an', searchLoading: true })} />);
    expect(screen.queryByText('search.nothingFound')).toBeNull();
  });
});
