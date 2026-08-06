import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import {
  MessageOutboxSection,
  type MessageOutboxCopy,
} from '@/components/settings/message-outbox-section';
import type { VisibleMessageOutboxItem } from '@/data/persistence/types';

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: ({ children, ...props }: { children: ReactNode }) => (
      <ReactNative.View {...props}>{children}</ReactNative.View>
    ),
  };
});

const copy: MessageOutboxCopy = {
  title: 'Controlled outbox',
  description: 'Authoritative local delivery queue.',
  emptyTitle: 'Queue empty',
  emptyBody: 'No pending messages.',
  queued: 'Queued',
  sending: 'Sending',
  failed: 'Failed',
  attempts: 'Attempts',
  created: 'Created',
  unknownConversation: 'Unknown conversation',
  edit: 'Edit queued message',
  retry: 'Retry queued message',
  cancel: 'Cancel queued message',
  editTitle: 'Edit message',
  editDescription: 'Edit before delivery.',
  message: 'Message body',
  save: 'Save message',
  cancelTitle: 'Cancel message?',
  cancelDescription: 'Remove the local queued message.',
  cancelAmbiguousDescription: 'Delivery may already have happened.',
  cancelConfirm: 'Confirm cancellation',
  ambiguous: 'Delivery outcome is uncertain.',
  errorCode: 'Error code',
};

function item(overrides: Partial<VisibleMessageOutboxItem>): VisibleMessageOutboxItem {
  return {
    id: 'outbox-default',
    conversationId: 'conversation-known',
    clientMessageId: 'client-default',
    body: 'Controlled message body',
    createdAt: '2030-01-02T03:04:05.000Z',
    attempts: 0,
    state: 'queued',
    lastErrorCode: null,
    canEdit: false,
    canRetry: false,
    deliveryAmbiguous: false,
    ...overrides,
  };
}

const queued = item({
  id: 'outbox-queued',
  clientMessageId: 'client-queued',
  body: 'Queued body',
  createdAt: '2030-01-01T00:00:00.000Z',
  canEdit: true,
});
const sending = item({
  id: 'outbox-sending',
  clientMessageId: 'client-sending',
  body: 'Sending body',
  state: 'sending',
});
const failed = item({
  id: 'outbox-failed',
  conversationId: 'conversation-missing',
  clientMessageId: 'client-failed',
  body: 'Failed body',
  createdAt: '2030-01-03T00:00:00.000Z',
  attempts: 2,
  state: 'failed',
  lastErrorCode: 'network_unavailable',
  canRetry: true,
  deliveryAmbiguous: true,
});

let onEdit: jest.Mock<(outboxId: string, body: string) => Promise<boolean>>;
let onRetry: jest.Mock<(outboxId: string) => Promise<boolean>>;
let onCancel: jest.Mock<(outboxId: string) => Promise<boolean>>;
let onClearError: jest.Mock<() => void>;
let resolveConversationTitle: jest.Mock<(conversationId: string) => string | null>;

beforeEach(() => {
  onEdit = jest.fn(async () => true);
  onRetry = jest.fn(async () => true);
  onCancel = jest.fn(async () => true);
  onClearError = jest.fn();
  resolveConversationTitle = jest.fn((conversationId) => (
    conversationId === 'conversation-known' ? 'Operations' : null
  ));
});

function section(overrides: Record<string, unknown> = {}) {
  return (
    <MessageOutboxSection
      actionBusy={null}
      actionError={null}
      copy={copy}
      items={[failed, sending, queued]}
      onCancel={onCancel}
      onClearError={onClearError}
      onEdit={onEdit}
      onRetry={onRetry}
      resolveConversationTitle={resolveConversationTitle}
      {...overrides}
    />
  );
}

describe('message outbox section', () => {
  test('renders empty and top-level failure states without inventing queue entries', async () => {
    const view = await render(section({ items: [], actionError: 'Queue could not be reconciled.' }));

    expect(screen.getByText('Queue empty')).toBeTruthy();
    expect(screen.getByText('No pending messages.')).toBeTruthy();
    expect(screen.getByText('Queue could not be reconciled.')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();

    await view.rerender(section({ items: [queued], actionError: null }));
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('Queued')).toBeTruthy();

    await view.unmount();
  });

  test('sorts real queue records and exposes status, error, ambiguity, retry, and busy state', async () => {
    const view = await render(section({ actionBusy: 'outbox-retry:outbox-failed' }));

    expect(resolveConversationTitle.mock.calls.map(([id]) => id)).toEqual([
      'conversation-known',
      'conversation-known',
      'conversation-missing',
    ]);
    expect(screen.getByText('Queued')).toBeTruthy();
    expect(screen.getByText('Sending')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Unknown conversation')).toBeTruthy();
    expect(screen.getByText('Error code: network_unavailable')).toBeTruthy();
    expect(screen.getByText('Delivery outcome is uncertain.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry queued message' }).props.accessibilityState)
      .toEqual({ disabled: true });

    await view.rerender(section());
    await fireEvent.press(screen.getByRole('button', { name: 'Retry queued message' }));
    expect(onRetry).toHaveBeenCalledWith('outbox-failed');

    await view.unmount();
  });

  test('validates edits, preserves the dialog after rejection, and closes after success', async () => {
    onEdit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const view = await render(section({ actionError: 'Authoritative edit rejected.' }));

    await fireEvent.press(screen.getByRole('button', { name: 'Edit queued message' }));
    expect(onClearError).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Edit message')).toBeTruthy();
    expect(screen.getByText('Authoritative edit rejected.')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('Message body'), '   ');
    expect(screen.getByRole('button', { name: 'Save message' }).props.accessibilityState)
      .toEqual({ disabled: true });
    await fireEvent.changeText(screen.getByLabelText('Message body'), 'x'.repeat(12_001));
    expect(screen.getByRole('button', { name: 'Save message' }).props.accessibilityState)
      .toEqual({ disabled: true });
    await fireEvent.changeText(screen.getByLabelText('Message body'), '  Revised controlled body  ');
    await fireEvent.press(screen.getByRole('button', { name: 'Save message' }));
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith(
      'outbox-queued',
      '  Revised controlled body  ',
    ));
    expect(screen.getByText('Edit message')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Save message' }));
    await waitFor(() => expect(screen.queryByText('Edit message')).toBeNull());
    expect(onClearError).toHaveBeenCalledTimes(2);

    await view.unmount();
  });

  test('supports explicit edit dismissal and both certain and ambiguous cancellation outcomes', async () => {
    onCancel.mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    const view = await render(section({ actionError: 'Cancellation rejected.' }));

    await fireEvent.press(screen.getByRole('button', { name: 'Edit queued message' }));
    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[0]!);
    expect(screen.queryByText('Edit message')).toBeNull();

    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel queued message' });
    await fireEvent.press(cancelButtons[0]!);
    expect(screen.getByText('Remove the local queued message.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith('outbox-queued'));
    expect(screen.getByText('Cancel message?')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() => expect(screen.queryByText('Cancel message?')).toBeNull());

    const refreshedCancelButtons = screen.getAllByRole('button', { name: 'Cancel queued message' });
    await fireEvent.press(refreshedCancelButtons[2]!);
    expect(screen.getByText('Delivery may already have happened.')).toBeTruthy();
    expect(screen.getAllByText('Delivery outcome is uncertain.').length).toBeGreaterThan(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() => expect(onCancel).toHaveBeenLastCalledWith('outbox-failed'));

    await fireEvent.press(screen.getAllByRole('button', { name: 'Cancel queued message' })[1]!);
    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[1]!);
    expect(screen.queryByText('Cancel message?')).toBeNull();

    await view.unmount();
  });
});
