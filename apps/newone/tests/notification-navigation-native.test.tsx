import { act, renderHook, waitFor } from '@testing-library/react-native';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockPush = jest.fn();
const mockAddResponseListener: any = jest.fn();
const mockGetLastResponse: any = jest.fn();
const mockClearLastResponse: any = jest.fn();
const mockSetBadgeCount: any = jest.fn();
const mockRemove = jest.fn();
let responseListener: ((response: any) => void) | null = null;

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'default-action',
  addNotificationResponseReceivedListener: (listener: (response: any) => void) => {
    responseListener = listener;
    return mockAddResponseListener(listener);
  },
  getLastNotificationResponseAsync: (...args: unknown[]) => mockGetLastResponse(...args),
  clearLastNotificationResponseAsync: (...args: unknown[]) => mockClearLastResponse(...args),
  setBadgeCountAsync: (...args: unknown[]) => mockSetBadgeCount(...args),
}));

import { useNotificationNavigation } from '@/device/notification-navigation.native';

const organizationId = '10000000-0000-4000-8000-000000000001';
const otherOrganizationId = '20000000-0000-4000-8000-000000000002';
const conversationId = '30000000-0000-4000-8000-000000000003';

function response(overrides: Record<string, unknown> = {}) {
  return {
    actionIdentifier: 'default-action',
    notification: {
      request: {
        identifier: 'notification-controlled',
        content: {
          data: {
            organization_id: organizationId,
            event_type: 'message.changed',
            conversation_id: conversationId,
            message_id: '101',
          },
        },
      },
    },
    ...overrides,
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  responseListener = null;
  mockAddResponseListener.mockReturnValue({ remove: mockRemove });
  mockGetLastResponse.mockResolvedValue(null);
  mockClearLastResponse.mockResolvedValue(undefined);
  mockSetBadgeCount.mockResolvedValue(true);
});

describe('native notification response navigation', () => {
  test('registers a response listener, routes a matching tap once, and maintains the badge', async () => {
    const { unmount } = await renderHook(() => useNotificationNavigation({
      enabled: true,
      organizationId,
      badgeCount: 7.9,
    }));
    await waitFor(() => expect(mockGetLastResponse).toHaveBeenCalled());
    expect(mockSetBadgeCount).toHaveBeenCalledWith(7);

    const tap = response();
    await act(async () => { responseListener?.(tap); });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/conversation/${conversationId}`));
    expect(mockClearLastResponse).toHaveBeenCalledTimes(1);
    expect(mockSetBadgeCount).toHaveBeenCalledWith(0);

    await act(async () => { responseListener?.(tap); });
    expect(mockPush).toHaveBeenCalledTimes(1);
    await unmount();
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  test('queues a valid tap until workspace authorization becomes available', async () => {
    const { rerender } = await renderHook(
      (props: { enabled: boolean; organizationId: string | null }) => useNotificationNavigation({
        ...props,
        badgeCount: 0,
      }),
      { initialProps: { enabled: false, organizationId: null } },
    );
    await waitFor(() => expect(responseListener).not.toBeNull());
    await act(async () => { responseListener?.(response()); });
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockClearLastResponse).not.toHaveBeenCalled();

    await rerender({ enabled: true, organizationId });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/conversation/${conversationId}`));
  });

  test('clears invalid actions and malformed destinations without routing', async () => {
    await renderHook(() => useNotificationNavigation({ enabled: true, organizationId, badgeCount: 0 }));
    await waitFor(() => expect(responseListener).not.toBeNull());
    await act(async () => { responseListener?.(response({ actionIdentifier: 'dismiss-action' })); });
    await act(async () => { responseListener?.(response({
      notification: {
        request: {
          identifier: 'malformed-notification',
          content: { data: { organization_id: organizationId, event_type: 'unknown' } },
        },
      },
    })); });
    expect(mockClearLastResponse).toHaveBeenCalledTimes(2);
    expect(mockPush).not.toHaveBeenCalled();
  });

  test('clears a cross-organization destination but never routes it', async () => {
    await renderHook(() => useNotificationNavigation({ enabled: true, organizationId, badgeCount: 0 }));
    await waitFor(() => expect(responseListener).not.toBeNull());
    const tap = response();
    tap.notification.request.content.data.organization_id = otherOrganizationId;
    await act(async () => { responseListener?.(tap); });
    await waitFor(() => expect(mockClearLastResponse).toHaveBeenCalled());
    expect(mockSetBadgeCount).toHaveBeenCalledWith(0);
    expect(mockPush).not.toHaveBeenCalled();
  });

  test('handles a cold-start response and ignores a response resolved after unmount', async () => {
    mockGetLastResponse.mockResolvedValueOnce(response());
    const first = await renderHook(() => useNotificationNavigation({ enabled: true, organizationId, badgeCount: 1 }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/conversation/${conversationId}`));
    await first.unmount();

    let resolveLast: (value: any) => void = () => undefined;
    mockGetLastResponse.mockImplementationOnce(() => new Promise((resolve) => { resolveLast = resolve; }));
    const second = await renderHook(() => useNotificationNavigation({ enabled: true, organizationId, badgeCount: 1 }));
    await second.unmount();
    await act(async () => { resolveLast(response({ notification: {
      request: {
        identifier: 'late-notification',
        content: response().notification.request.content,
      },
    } })); });
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  test('bounds badge values and skips badge writes until a workspace is authorized', async () => {
    const { rerender } = await renderHook(
      (props: { enabled: boolean; organizationId: string | null; badgeCount: number }) =>
        useNotificationNavigation(props),
      { initialProps: { enabled: false, organizationId: null, badgeCount: 5 } },
    );
    expect(mockSetBadgeCount).not.toHaveBeenCalled();
    await rerender({ enabled: true, organizationId, badgeCount: -5 });
    await waitFor(() => expect(mockSetBadgeCount).toHaveBeenCalledWith(0));
    await rerender({ enabled: true, organizationId, badgeCount: 120 });
    await waitFor(() => expect(mockSetBadgeCount).toHaveBeenCalledWith(99));
  });

  test('contains native API rejection paths without unhandled errors', async () => {
    mockGetLastResponse.mockRejectedValueOnce(new Error('cold-start unavailable'));
    mockClearLastResponse.mockRejectedValue(new Error('clear unavailable'));
    mockSetBadgeCount.mockRejectedValue(new Error('badge unavailable'));
    await renderHook(() => useNotificationNavigation({ enabled: true, organizationId, badgeCount: 1 }));
    await waitFor(() => expect(responseListener).not.toBeNull());
    await act(async () => { responseListener?.(response({ actionIdentifier: 'dismiss-action' })); });
    await act(async () => { responseListener?.(response({
      notification: {
        request: {
          identifier: 'second-notification',
          content: response().notification.request.content,
        },
      },
    })); });
    await act(async () => { await Promise.resolve(); });
    expect(mockPush).toHaveBeenCalledWith(`/conversation/${conversationId}`);
  });
});
