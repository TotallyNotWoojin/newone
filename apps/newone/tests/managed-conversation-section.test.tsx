import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ManagedConversationSection } from '@/features/admin/managed-conversation-section';

let mockWorkspace: { conversations: Record<string, unknown>[] };

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
jest.mock('@/state/workspace', () => ({ useWorkspace: () => mockWorkspace }));

function conversation(overrides: Record<string, unknown>) {
  return {
    id: 'conversation-default',
    title: 'Default conversation',
    initials: 'DC',
    avatarColor: '#334455',
    kind: 'group',
    managementOnly: false,
    canManageConversation: false,
    canManageDynamicGroup: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockWorkspace = { conversations: [] };
});

describe('managed conversation section', () => {
  test('renders nothing when no authoritative conversation is management-only and manageable', async () => {
    mockWorkspace.conversations = [
      conversation({ id: 'ordinary', canManageConversation: true }),
      conversation({ id: 'inaccessible', managementOnly: true }),
    ];

    const view = await render(<ManagedConversationSection onOpen={jest.fn()} />);

    expect(screen.queryByText('chat.managementOnlyTitle')).toBeNull();
    await view.unmount();
  });

  test('filters, sorts, labels, and opens each manageable production conversation variant', async () => {
    const onOpen = jest.fn<(conversationId: string) => void>();
    mockWorkspace.conversations = [
      conversation({
        id: 'zulu',
        title: 'Zulu',
        managementOnly: true,
        canManageConversation: true,
        kind: 'announcement',
      }),
      conversation({
        id: 'alpha-b',
        title: 'Alpha',
        managementOnly: true,
        canManageDynamicGroup: true,
      }),
      conversation({
        id: 'alpha-a',
        title: 'Alpha',
        managementOnly: true,
        canManageConversation: true,
      }),
      conversation({
        id: 'excluded',
        title: 'Excluded',
        managementOnly: true,
      }),
    ];

    const view = await render(<ManagedConversationSection onOpen={onOpen} />);

    expect(screen.getByRole('header', { name: 'chat.managementOnlyTitle' })).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getAllByText('Alpha')).toHaveLength(2);
    expect(screen.getByText('Zulu')).toBeTruthy();
    expect(screen.queryByText('Excluded')).toBeNull();
    expect(screen.getAllByText('chat.managementOnlyBody')).toHaveLength(3);
    expect(screen.getByText('chat.managementOnlyDynamicBody')).toBeTruthy();

    const standardButtons = screen.getAllByRole('button', { name: 'chat.managementOnlyOpen' });
    expect(standardButtons).toHaveLength(2);
    await fireEvent.press(standardButtons[0]!);
    await fireEvent.press(screen.getByRole('button', { name: 'chat.managementOnlyOpenAdmin' }));
    await fireEvent.press(standardButtons[1]!);

    expect(onOpen.mock.calls.map(([conversationId]) => conversationId)).toEqual([
      'alpha-a',
      'alpha-b',
      'zulu',
    ]);
    await view.unmount();
  });
});
