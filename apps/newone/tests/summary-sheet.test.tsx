import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, Share } from 'react-native';

import type { ConversationSummary, Message } from '@/domain/types';
import { SummarySheet } from '@/features/chat/summary-sheet';
import { shareSummary as shareSummaryWeb } from '@/features/chat/summary-export.web';

const PERSONAL_REALM = '11111111-1111-4111-8111-111111111111';
const mockPush = jest.fn<(_href: unknown) => void>();
const mockClipboardWrite = jest.fn<(_value: string) => Promise<void>>(async () => undefined);
const mockFileCreate = jest.fn();
const mockFileWrite = jest.fn<(_content: string) => void>();
const mockFileDelete = jest.fn();
const mockFileArgs = jest.fn<(..._args: unknown[]) => void>();
let mockFileExists = false;
let mockWorkspace: Record<string, any>;

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: (href: unknown) => mockPush(href) }),
}));
jest.mock('expo-clipboard', () => ({
  setStringAsync: (value: string) => mockClipboardWrite(value),
}));
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache/' },
  File: function File(this: any, ...args: unknown[]) {
    mockFileArgs(...args);
    this.uri = `file:///cache/${String(args[1])}`;
    Object.defineProperty(this, 'exists', { get: () => mockFileExists });
    this.create = mockFileCreate;
    this.write = mockFileWrite;
    this.delete = mockFileDelete;
  },
}));
jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));

const self = { id: 'user-self', displayName: 'Jordan Lee', suspended: false };
const other = { id: 'user-other', displayName: 'Ana Torres', suspended: false };

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conversation-a',
    title: 'Ana Torres',
    initials: 'AT',
    avatarColor: '#123456',
    kind: 'direct',
    canManage: true,
    ...overrides,
  } as any;
}

function message(serverId: string, createdAt?: string): Message {
  return {
    id: `local-${serverId}`,
    serverId,
    conversationId: 'conversation-a',
    senderId: other.id,
    senderName: other.displayName,
    senderInitials: 'AT',
    senderColor: '#654321',
    originalText: `Message ${serverId}`,
    sourceLanguage: 'en',
    translationState: 'not_requested',
    createdAt,
    sentAt: '10:00',
    isOwn: false,
    deliveryState: 'delivered',
    priority: 'normal',
  } as Message;
}

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'summary-a',
    conversationId: 'conversation-a',
    versionNumber: 2,
    language: 'en',
    status: 'ready_for_review',
    primaryTopic: 'Weekend plans',
    summary: 'You asked whether Saturday works. They said yes and suggested meeting at noon.',
    keyTopics: [{ text: 'Saturday', sourceMessageIds: ['101'] }],
    decisions: [],
    actionItems: [],
    ambiguities: [],
    sourceMessageIds: ['101', '102', '103'],
    sourceFirstMessageId: '101',
    sourceLastMessageId: '103',
    sourceFingerprint: 'a'.repeat(64),
    outputFingerprint: 'b'.repeat(64),
    sourceState: 'current',
    policyState: 'current',
    requestMode: 'manual',
    requestedByUserId: self.id,
    correctionOfSummaryId: null,
    provenance: {
      processorType: 'ai', provider: 'openrouter', model: 'model',
      organizationAiPolicyVersion: 1, routePolicyVersion: 'r1', providerRoute: 'route',
    },
    failureCode: null,
    reviewedByUserId: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: '2026-09-04T10:00:00.000Z',
    generatedAt: '2026-09-04T10:00:05.000Z',
    ...overrides,
  };
}

const successfulAction = () => jest.fn(async () => true);

function buildWorkspace(organizationId = PERSONAL_REALM) {
  return {
    organizationId,
    currentUser: self,
    actionBusy: null,
    actionError: null,
    summaries: [summary()],
    actions: [],
    aiOutputErrorReports: [],
    people: [self, other],
    hasCapability: jest.fn(() => true),
    clearActionError: jest.fn(),
    requestConversationSummary: successfulAction(),
    correctConversationSummary: successfulAction(),
    reviewConversationSummary: successfulAction(),
    setConversationSummaryPolicy: successfulAction(),
    confirmAction: successfulAction(),
    transitionAction: successfulAction(),
  };
}

const loadedMessages = [
  message('101', '2026-09-04T09:00:00.000Z'),
  message('102', '2026-09-04T09:05:00.000Z'),
  message('103', '2026-09-04T09:06:00.000Z'),
  message('104', '2026-09-04T11:00:00.000Z'),
  message('105', '2026-09-04T11:30:00.000Z'),
];

function disabledState(element: { props: { accessibilityState?: { disabled?: boolean } } } | undefined) {
  return element?.props.accessibilityState?.disabled === true;
}

async function open(props: Record<string, unknown> = {}) {
  const onClose = jest.fn();
  const onReportError = jest.fn<(_summaryId: string) => void>();
  const view = await render(
    <SummarySheet
      conversation={conversation()}
      messages={loadedMessages}
      onClose={onClose}
      onReportError={onReportError}
      visible
      {...props}
    />,
  );
  return { view, onClose, onReportError };
}

beforeEach(() => {
  mockWorkspace = buildWorkspace();
  mockFileExists = false;
});

describe('summary sheet for consumers', () => {
  test('shows the latest recap as plain prose with one scope line and no workplace controls', async () => {
    await open();
    expect(screen.getByText('chat.summarySheetTitle')).toBeTruthy();
    expect(screen.getByText('chat.summaryScope')).toBeTruthy();
    expect(screen.getByText('Weekend plans')).toBeTruthy();
    expect(screen.getByText(/You asked whether Saturday works/)).toBeTruthy();
    expect(screen.queryByText('chat.summaryReadyReview')).toBeNull();
    expect(screen.queryByLabelText('chat.correctSummary')).toBeNull();
    expect(screen.queryByLabelText('chat.reviewSummary')).toBeNull();
    expect(screen.queryByLabelText('chat.summarySchedule')).toBeNull();
    expect(screen.queryByLabelText('chat.reportSummaryError')).toBeNull();
    expect(screen.queryByText('Saturday')).toBeNull();
  });

  test('summarizes only the messages that arrived since the reader\'s last recap', async () => {
    await open();
    await fireEvent.press(screen.getByLabelText('chat.summarizeNew'));
    expect(mockWorkspace.requestConversationSummary).toHaveBeenCalledWith('conversation-a', ['104', '105']);
  });

  test('summarizes the whole loaded history when nothing was summarized before, and disables copy and share', async () => {
    mockWorkspace.summaries = [];
    await open();
    expect(screen.getByText('chat.summaryEmpty')).toBeTruthy();
    expect(screen.queryByText('chat.summaryScope')).toBeNull();
    expect(disabledState(screen.getByLabelText('chat.copy'))).toBe(true);
    expect(disabledState(screen.getByLabelText('chat.summaryShare'))).toBe(true);
    await fireEvent.press(screen.getByLabelText('chat.summarizeAll'));
    expect(mockWorkspace.requestConversationSummary).toHaveBeenCalledWith('conversation-a', ['101', '102', '103', '104', '105']);
  });

  test('shows a loading state while a recap is generating and says when there is nothing new', async () => {
    mockWorkspace.summaries = [summary({ status: 'generating', summary: '', primaryTopic: '', outputFingerprint: null })];
    const generating = await open();
    expect(screen.getByText('chat.summaryGenerating')).toBeTruthy();
    expect(disabledState(screen.getByLabelText('chat.summarizeNew'))).toBe(true);
    expect(screen.queryByText('chat.summaryNoNewMessages')).toBeNull();
    await generating.view.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.summaries = [summary({ sourceLastMessageId: '105' })];
    await open();
    expect(screen.getByText('chat.summaryNoNewMessages')).toBeTruthy();
    expect(disabledState(screen.getByLabelText('chat.summarizeNew'))).toBe(true);

    mockWorkspace.actionBusy = 'summary-request:conversation-a';
    await open({ messages: loadedMessages });
    expect(disabledState(screen.getAllByLabelText('chat.summarizeNew').at(-1))).toBe(true);
  });

  test('copies the recap as clean text', async () => {
    await open();
    await fireEvent.press(screen.getByLabelText('chat.copy'));
    await waitFor(() => expect(mockClipboardWrite).toHaveBeenCalledTimes(1));
    const copied = mockClipboardWrite.mock.calls[0]?.[0] ?? '';
    expect(copied.startsWith('Weekend plans\nAna Torres · chat.summaryScope\n\nYou asked whether Saturday works.')).toBe(true);
    expect(copied).not.toMatch(/\bs0\d{3}\b|\[sources/);
    expect(screen.getByText('chat.summaryCopied')).toBeTruthy();
  });

  test('shares the recap as a text file in the cache directory through the system share sheet', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction } as any);
    mockFileExists = true;
    await open();
    await fireEvent.press(screen.getByLabelText('chat.summaryShare'));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const fileName = String(mockFileArgs.mock.calls[0]?.[1]);
    expect(mockFileArgs.mock.calls[0]?.[0]).toBe('file:///cache/');
    expect(fileName).toMatch(/^Newone summary – Ana Torres – \d{4}-\d{2}-\d{2}\.txt$/);
    expect(mockFileDelete).toHaveBeenCalledTimes(1);
    expect(mockFileCreate).toHaveBeenCalledTimes(1);
    expect(mockFileWrite.mock.calls[0]?.[0]).toContain('You asked whether Saturday works.');
    expect(share).toHaveBeenCalledWith(
      { url: `file:///cache/${fileName}`, title: 'Weekend plans' },
      { subject: 'Weekend plans' },
    );
    expect(screen.queryByText('chat.summaryShareFailed')).toBeNull();
    share.mockRestore();
  });

  test('shares text rather than a file on Android and reports a failed share', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.dismissedAction } as any);
    const first = await open();
    await fireEvent.press(screen.getByLabelText('chat.summaryShare'));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share.mock.calls[0]?.[0]).toMatchObject({ title: 'Weekend plans' });
    expect((share.mock.calls[0]?.[0] as { message?: string }).message).toContain('You asked whether Saturday works.');
    expect((share.mock.calls[0]?.[0] as { url?: string }).url).toBeUndefined();
    await first.view.unmount();
    os.restore();

    share.mockRejectedValue(new Error('no share targets'));
    await open();
    await fireEvent.press(screen.getByLabelText('chat.summaryShare'));
    await waitFor(() => expect(screen.getByText('chat.summaryShareFailed')).toBeTruthy());
    share.mockRestore();
  });

  test('tells the reader when the last recap failed, without workplace detail', async () => {
    mockWorkspace.summaries = [summary({
      status: 'failed', summary: '', primaryTopic: '', outputFingerprint: null, failureCode: 'provider_unavailable',
    })];
    await open();
    expect(screen.getByText('chat.summaryFailed')).toBeTruthy();
    expect(screen.queryByText(/provider_unavailable/)).toBeNull();
    expect(screen.queryByLabelText('chat.createManualHandoff')).toBeNull();
    // The failed version never covered anything, so the next request is a full one.
    expect(screen.getByLabelText('chat.summarizeAll')).toBeTruthy();
  });
});

describe('summary sheet for workplace organizations', () => {
  beforeEach(() => {
    mockWorkspace = buildWorkspace('organization-a');
    mockWorkspace.actions = [{
      id: 'action-proposed', conversationId: 'conversation-a', sourceMessageId: null,
      title: 'Inspect the valve', details: null, status: 'proposed', proposedByUserId: self.id,
      assigneeUserId: null, assigneeName: null, dueAt: null,
      createdAt: '2026-09-04T10:00:00.000Z', updatedAt: '2026-09-04T10:00:00.000Z',
    }];
  });

  test('keeps review status, error reporting, correction, review, schedule, and operational actions', async () => {
    const { onReportError } = await open();
    expect(screen.getByText('chat.summaryReadyReview')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.reportSummaryError'));
    expect(onReportError).toHaveBeenCalledWith('summary-a');

    await fireEvent.press(screen.getByLabelText('chat.correctSummary'));
    await fireEvent.changeText(screen.getByLabelText('chat.summaryBody'), 'Saturday at noon is confirmed.');
    await fireEvent.press(screen.getByLabelText('chat.saveCorrection'));
    await waitFor(() => expect(mockWorkspace.correctConversationSummary).toHaveBeenCalledWith(
      mockWorkspace.summaries[0], 'Weekend plans', 'Saturday at noon is confirmed.',
    ));

    await fireEvent.press(screen.getByLabelText('chat.reviewSummary'));
    await fireEvent.changeText(screen.getByLabelText('chat.reviewNote'), 'Checked against the thread.');
    await fireEvent.press(screen.getByLabelText('chat.approveExactVersion'));
    await waitFor(() => expect(mockWorkspace.reviewConversationSummary).toHaveBeenCalledWith(
      'summary-a', 'approve', 'Checked against the thread.',
    ));

    await fireEvent.press(screen.getByLabelText('chat.summarySchedule'));
    await fireEvent.press(screen.getByLabelText('chat.summaryMessageCount'));
    await fireEvent.changeText(screen.getByLabelText('chat.summaryThreshold'), '25');
    await fireEvent.press(screen.getByLabelText('chat.saveSummarySchedule'));
    await waitFor(() => expect(mockWorkspace.setConversationSummaryPolicy).toHaveBeenCalledWith(
      'conversation-a', 'message_count', 25,
    ));

    expect(screen.getByText('Inspect the valve')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.confirmAction'));
    await fireEvent.press(screen.getByLabelText('Ana Torres'));
    await fireEvent.press(screen.getAllByLabelText('chat.confirmAction').at(-1)!);
    await waitFor(() => expect(mockWorkspace.confirmAction).toHaveBeenCalledWith('action-proposed', 'user-other', ''));
  });

  test('shows the failure code and manual handoff route, and a submitted report badge', async () => {
    mockWorkspace.summaries = [summary({
      status: 'failed', summary: '', primaryTopic: '', outputFingerprint: null, failureCode: 'provider_unavailable',
    })];
    const failed = await open();
    expect(screen.getByText(/provider_unavailable/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.createManualHandoff'));
    expect(mockPush).toHaveBeenCalledWith('/handoffs');
    await failed.view.unmount();

    mockWorkspace = buildWorkspace('organization-a');
    mockWorkspace.aiOutputErrorReports = [{ summaryId: 'summary-a' }];
    mockWorkspace.summaries = [summary({ status: 'approved', sourceState: 'stale' })];
    await open({ conversation: conversation({ canManage: false }) });
    expect(screen.getByText('quality.reportSubmitted')).toBeTruthy();
    expect(screen.getByText('chat.summaryApproved')).toBeTruthy();
    expect(screen.getByText('chat.summarySuperseded')).toBeTruthy();
    expect(screen.queryByLabelText('chat.correctSummary')).toBeNull();
    expect(screen.queryByLabelText('chat.summarySchedule')).toBeNull();
  });
});

describe('web share adapter', () => {
  test('uses the Web Share API when present, treats a cancelled sheet as dismissed, and falls back to the clipboard', async () => {
    const input = { fileName: 'Newone summary – A – 2026-09-05.txt', title: 'A', text: 'Body' };
    const share = jest.fn<(_data: unknown) => Promise<void>>(async () => undefined);
    Object.defineProperty(globalThis, 'navigator', { value: { share }, configurable: true });
    expect(await shareSummaryWeb(input)).toBe('shared');
    expect(share).toHaveBeenCalledWith({ title: 'A', text: 'Body' });

    share.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    expect(await shareSummaryWeb(input)).toBe('dismissed');

    share.mockRejectedValueOnce(new Error('unsupported'));
    expect(await shareSummaryWeb(input)).toBe('copied');
    expect(mockClipboardWrite).toHaveBeenLastCalledWith('Body');

    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    expect(await shareSummaryWeb(input)).toBe('copied');
  });
});
