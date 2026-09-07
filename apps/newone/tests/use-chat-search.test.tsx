import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { parseSearch, type SearchPersonRef } from '@/features/search/chat-search';
import { useChatSearch } from '@/features/search/use-chat-search';

let mockWorkspace: any;
let mockSearch: jest.Mock<(..._args: unknown[]) => Promise<any>>;

jest.mock('@/state/workspace', () => ({ useWorkspace: () => mockWorkspace }));
jest.mock('@/lib/supabase', () => ({ getSupabaseClient: () => null }));
jest.mock('@/data/repositories/bff-search-repository', () => ({
  BffSearchRepository: jest.fn().mockImplementation(() => ({
    search: (...args: unknown[]) => mockSearch(...args),
  })),
}));

const people: SearchPersonRef[] = [
  { id: 'person-ana', displayName: 'Ana Ruiz', username: 'ana_r' },
];

function Probe({ value }: { value: string }) {
  const { strangers, messages, loading } = useChatSearch(parseSearch(value, people));
  return (
    <>
      <Text>{`strangers:${strangers.map((person) => person.id).join('|')}`}</Text>
      <Text>{`messages:${messages.map((message) => message.id).join('|')}`}</Text>
      <Text>{`loading:${loading}`}</Text>
    </>
  );
}

beforeEach(() => {
  mockSearch = jest.fn<(..._args: unknown[]) => Promise<any>>().mockResolvedValue({
    results: [
      {
        type: 'messages',
        id: 'message-1',
        title: 'Beach trip',
        snippet: 'Ana brought the umbrella',
        conversationId: 'conversation-beach',
        occurredAt: '2026-09-01T10:00:00.000Z',
        matchedSource: 'original',
        matchedLanguage: null,
      },
      {
        type: 'conversations',
        id: 'conversation-beach',
        title: 'Beach trip',
        snippet: '',
        conversationId: 'conversation-beach',
        occurredAt: '2026-09-01T09:00:00.000Z',
        matchedSource: 'conversation',
        matchedLanguage: null,
      },
      {
        type: 'messages',
        id: 'orphan',
        title: 'Orphan',
        snippet: '',
        conversationId: null,
        occurredAt: '2026-09-01T08:00:00.000Z',
        matchedSource: 'original',
        matchedLanguage: null,
      },
    ],
    nextCursor: null,
    hasMore: false,
  });
  mockWorkspace = {
    organizationId: '20000000-0000-4000-8000-000000000001',
    searchUsers: jest.fn(async (..._args: unknown[]) => [
      { userId: 'user-sam', username: 'sam_stranger', displayName: 'Sam Stranger' },
      { userId: 'user-nameless', username: 'nameless', displayName: null },
    ] as unknown[]),
  };
});

describe('the Chats field asking the server', () => {
  test('a single letter asks nothing at all', async () => {
    const view = await render(<Probe value="a" />);
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(mockWorkspace.searchUsers).not.toHaveBeenCalled();
    expect(mockSearch).not.toHaveBeenCalled();
    expect(screen.getByText('loading:false')).toBeTruthy();
    await view.unmount();
  });

  test('two letters ask both existing services once, debounced', async () => {
    const view = await render(<Probe value="sam" />);

    await waitFor(() => expect(screen.getByText('strangers:user-sam|user-nameless')).toBeTruthy());
    expect(mockWorkspace.searchUsers).toHaveBeenCalledTimes(1);
    expect(mockWorkspace.searchUsers).toHaveBeenCalledWith('sam');
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: '20000000-0000-4000-8000-000000000001',
      query: 'sam',
      types: ['messages'],
      limit: 20,
    }));
    // Only real message hits survive: other result types and rows with no
    // conversation are not places to jump to.
    expect(screen.getByText('messages:message-1')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('loading:false')).toBeTruthy());
    await view.unmount();
  });

  test('chips alone are answered on the device, with no message search', async () => {
    const view = await render(<Probe value="Ana Ruiz, " />);
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockWorkspace.searchUsers).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('chips plus a word search the word, not the names', async () => {
    const view = await render(<Probe value="Ana Ruiz, sandcastle" />);

    await waitFor(() => expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      query: 'sandcastle',
    })));
    await view.unmount();
  });

  test('a refused search leaves the field empty and not stuck loading', async () => {
    mockSearch.mockRejectedValue(new Error('nope'));
    mockWorkspace.searchUsers = jest.fn(async (..._args: unknown[]) => {
      throw new Error('nope');
    });
    const view = await render(<Probe value="sam" />);

    await waitFor(() => expect(screen.getByText('loading:false')).toBeTruthy());
    expect(screen.getByText('strangers:')).toBeTruthy();
    expect(screen.getByText('messages:')).toBeTruthy();
    await view.unmount();
  });
});
