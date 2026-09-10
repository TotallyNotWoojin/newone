import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { PERSONAL_REALM_ORGANIZATION_ID } from '@/constants/personal-realm';
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
    ['people', 'people', 'status.emptyPeopleConsumer'],
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

describe('empty states', () => {
  test('the empty chats and people panels carry the copy people actually read', async () => {
    mockWorkspace.conversations = [];
    const chats = await render(<WorkspaceStatePanel resource="chats" />);
    expect(screen.getByText('status.emptyChats')).toBeTruthy();
    expect(screen.getByText('status.emptyChatsBodyConsumer')).toBeTruthy();
    await chats.unmount();

    // Only yourself is nobody.
    mockWorkspace.people = [{ id: 'self', connectionState: 'self' }];
    const people = await render(<WorkspaceStatePanel resource="people" />);
    expect(screen.getByText('status.emptyPeopleConsumer')).toBeTruthy();
    expect(screen.getByText('status.emptyPeopleBodyConsumer')).toBeTruthy();
    await people.unmount();
  });
});
describe('degraded realtime indicator', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('shows the reconnecting banner only after 10s of continuous degraded state, and rewaits after a recovery', async () => {
    jest.useFakeTimers();
    try {
      mockWorkspace.realtimeState = 'degraded';
      const view = await render(<WorkspaceStatusBanner />);
      expect(screen.queryByText('status.reconnecting')).toBeNull();

      await act(async () => { jest.advanceTimersByTime(9_999); });
      expect(screen.queryByText('status.reconnecting')).toBeNull();

      await act(async () => { jest.advanceTimersByTime(1); });
      expect(screen.getByText('status.reconnecting')).toBeTruthy();

      // Recovering hides it immediately — no lingering stale indicator.
      mockWorkspace.realtimeState = 'connected';
      await view.rerender(<WorkspaceStatusBanner />);
      expect(screen.queryByText('status.reconnecting')).toBeNull();

      // A fresh degraded spell always waits out the full delay again.
      mockWorkspace.realtimeState = 'degraded';
      await view.rerender(<WorkspaceStatusBanner />);
      expect(screen.queryByText('status.reconnecting')).toBeNull();
      await act(async () => { jest.advanceTimersByTime(9_999); });
      expect(screen.queryByText('status.reconnecting')).toBeNull();
      await act(async () => { jest.advanceTimersByTime(1); });
      expect(screen.getByText('status.reconnecting')).toBeTruthy();

      await view.unmount();
    } finally {
      jest.clearAllTimers();
    }
  });

  test('floats over the list as a pill so rows never shift when it appears or clears', async () => {
    mockWorkspace.realtimeState = 'connecting';
    const view = await render(<WorkspaceStatusBanner />);
    expect(screen.getByText('status.reconnecting')).toBeTruthy();
    // An absolute layer over the list; taps beside the pill still reach the rows.
    const layer = view.root!;
    expect(layer.props.pointerEvents).toBe('box-none');
    const layerStyle = StyleSheet.flatten(layer.props.style);
    expect(layerStyle.position).toBe('absolute');
    expect(layerStyle.left).toBe(0);
    expect(layerStyle.right).toBe(0);
    expect(layerStyle.minHeight).toBeUndefined();
    await view.unmount();
  });

  test('surfaces the immediate connecting/error copy without waiting, and never both at once', async () => {
    mockWorkspace.realtimeState = 'connecting';
    const connecting = await render(<WorkspaceStatusBanner />);
    expect(screen.getByText('status.reconnecting')).toBeTruthy();
    await connecting.unmount();

    mockWorkspace.realtimeState = 'error';
    const errored = await render(<WorkspaceStatusBanner />);
    expect(screen.getByText('status.reconnecting')).toBeTruthy();
    await errored.unmount();

    mockWorkspace.realtimeState = 'subscribed';
    const healthy = await render(<WorkspaceStatusBanner />);
    expect(screen.queryByText('status.reconnecting')).toBeNull();
    await healthy.unmount();
  });
});
