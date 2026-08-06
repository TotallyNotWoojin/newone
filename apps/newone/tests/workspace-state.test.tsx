import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import {
  WorkspaceStatePanel,
  WorkspaceStatusBanner,
} from '@/components/workspace/workspace-state';

const mockRefresh = jest.fn();
const mockTranslate = (key: string) => key;
let mockWorkspace: Record<string, unknown>;

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: mockTranslate }),
}));

jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));

beforeEach(() => {
  mockRefresh.mockImplementation(async () => undefined);
  mockWorkspace = {
    actionError: null,
    connectivity: 'online',
    conversations: [{ id: 'conversation-a', managementOnly: false }],
    error: null,
    failedOutboxCount: 0,
    handoffs: [{ id: 'handoff-a' }],
    offlineQueueAvailable: true,
    outboxCount: 0,
    people: [{ id: 'person-a', connectionState: 'accepted' }],
    realtimeState: 'connected',
    refresh: mockRefresh,
    status: 'ready',
    updates: [{ id: 'update-a' }],
  };
});

describe('authoritative workspace state surfaces', () => {
  test('shows loading while no authoritative workspace snapshot exists', async () => {
    mockWorkspace.status = 'loading';
    await render(<WorkspaceStatePanel resource="chats" />);
    expect(screen.getByText('status.loading')).toBeTruthy();
  });

  test('shows the classified workspace failure and retries deliberately', async () => {
    mockWorkspace.status = 'error';
    mockWorkspace.error = 'The authorized workspace could not be loaded.';
    await render(<WorkspaceStatePanel resource="people" />);
    expect(screen.getByText('The authorized workspace could not be loaded.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'status.retry' }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  test.each<[
    'chats' | 'people' | 'updates' | 'handoffs',
    'conversations' | 'people' | 'updates' | 'handoffs',
    string,
  ]>([
    ['chats', 'conversations', 'status.emptyChats'],
    ['people', 'people', 'status.emptyPeople'],
    ['updates', 'updates', 'status.emptyUpdates'],
    ['handoffs', 'handoffs', 'status.emptyHandoffs'],
  ])('shows the real empty state for %s', async (resource, collection, title) => {
    mockWorkspace[collection] = [];
    await render(<WorkspaceStatePanel resource={resource} />);
    expect(screen.getByText(title)).toBeTruthy();
  });

  test('keeps management-only records out of the ordinary chat surface', async () => {
    mockWorkspace.conversations = [{ id: 'managed', managementOnly: true }];
    await render(<WorkspaceStatePanel resource="chats" />);
    expect(screen.getByText('status.emptyChats')).toBeTruthy();
  });

  test('prioritizes offline and security-impacting delivery states', async () => {
    mockWorkspace.connectivity = 'offline';
    const view = await render(<WorkspaceStatusBanner />);
    expect(screen.getByText('status.offline')).toBeTruthy();

    mockWorkspace.connectivity = 'online';
    mockWorkspace.actionError = 'Authorization changed.';
    await view.rerender(<WorkspaceStatusBanner />);
    expect(screen.getByText('Authorization changed.').parent?.props.accessibilityRole).toBe('alert');

    mockWorkspace.actionError = null;
    mockWorkspace.failedOutboxCount = 2;
    await view.rerender(<WorkspaceStatusBanner />);
    expect(screen.getByText('2 · chat.failed')).toBeTruthy();
  });

  test('stays absent when connectivity and delivery state are healthy', async () => {
    const view = await render(<WorkspaceStatusBanner />);
    expect(view.toJSON()).toBeNull();
  });
});
