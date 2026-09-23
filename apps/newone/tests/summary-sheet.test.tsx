import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { ConversationSummary } from '@/domain/types';
import { SummarySheet } from '@/features/chat/summary-sheet';
import { shareSummary as shareSummaryWeb } from '@/features/chat/summary-export.web';
import { projectWorkspaceFields } from './fixtures/project-workspace';
import { resetConversationProjectsStore } from '@/features/projects/use-conversation-projects';

const PERSONAL_REALM = '11111111-1111-4111-8111-111111111111';
const mockPush = jest.fn<(_href: unknown) => void>();
const mockClipboardWrite = jest.fn<(_value: string) => Promise<void>>(async () => undefined);
const mockFileCreate = jest.fn();
const mockFileWrite = jest.fn<(_content: string | Uint8Array) => void>();
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
const mockShareAsync = jest.fn<(_uri: string, _options: Record<string, string>) => Promise<void>>(async () => undefined);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
jest.mock('expo-sharing', () => ({
  isAvailableAsync: async () => true,
  shareAsync: (uri: string, options: Record<string, string>) => mockShareAsync(uri, options),
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
    unreadCount: 0,
    ...overrides,
  } as any;
}

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'summary-a',
    conversationId: 'conversation-a',
    versionNumber: 2,
    language: 'en',
    status: 'ready_for_review',
    primaryTopic: 'Weekend plans',
    summary: 'You asked whether Saturday works. Ana said yes and suggested meeting at noon.',
    keyTopics: [{ text: 'Saturday', sourceMessageIds: ['101'] }],
    decisions: [{ text: 'Meet at noon', sourceMessageIds: ['102'] }],
    actionItems: [{ title: 'Book the cabin', owner: 'Ana', dueAt: null, sourceMessageIds: ['103'] }],
    ambiguities: [],
    sourceMessageIds: ['101', '102', '103'],
    sourceFirstMessageId: '101',
    sourceLastMessageId: '103',
    sourceFingerprint: 'a'.repeat(64),
    outputFingerprint: 'b'.repeat(64),
    scopeKind: 'last_7_days',
    scopeSubject: 'the trip',
    sourceMessageCount: 143,
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
    ...projectWorkspaceFields(),
    organizationId,
    currentUser: self,
    actionBusy: null,
    actionError: null,
    summaries: [summary()],
    actions: [],
    aiOutputErrorReports: [],
    people: [self, other],
    unreadDividerIds: {},
    hasCapability: jest.fn(() => true),
    clearActionError: jest.fn(),
    requestConversationSummary: successfulAction(),
    exportConversationSummary: jest.fn(async (_summary: unknown, format: 'pdf' | 'docx') => ({
      bytes: PDF_BYTES,
      contentType: format === 'pdf' ? 'application/pdf' : DOCX_TYPE,
    })),
    messages: {},
    correctConversationSummary: successfulAction(),
    reviewConversationSummary: successfulAction(),
    setConversationSummaryPolicy: successfulAction(),
    confirmAction: successfulAction(),
    transitionAction: successfulAction(),
  };
}

function disabledState(element: { props: { accessibilityState?: { disabled?: boolean } } } | undefined) {
  return element?.props.accessibilityState?.disabled === true;
}

function selectedState(element: { props: { accessibilityState?: { selected?: boolean } } } | undefined) {
  return element?.props.accessibilityState?.selected === true;
}

async function open(props: Record<string, unknown> = {}) {
  const onClose = jest.fn();
  const onReportError = jest.fn<(_summaryId: string) => void>();
  const view = await render(
    <SummarySheet
      conversation={conversation()}
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
  test('shows the latest recap: title, the span covered, who took part, the lines, and nothing else', async () => {
    await open();
    expect(screen.getByText('chat.summarySheetTitle')).toBeTruthy();
    expect(screen.getByText('chat.summaryScopeLine · chat.summaryScopeAbout')).toBeTruthy();
    expect(screen.getByText('Weekend plans')).toBeTruthy();
    // The header: the days the recap covers (a 7-day range reaching back from
    // the request) and who took part (owner's father, Sep 14 2026).
    expect(screen.getByText(/2026/)).toBeTruthy();
    expect(screen.getByText('chat.summaryParticipants: Jordan Lee, Ana Torres')).toBeTruthy();
    expect(screen.getByText(/You asked whether Saturday works/)).toBeTruthy();
    // No decisions or to-do sections: the recap is the lines alone.
    expect(screen.queryByText('chat.summaryDecisions')).toBeNull();
    expect(screen.queryByText('chat.summaryTodo')).toBeNull();
    expect(screen.queryByText(/Meet at noon/)).toBeNull();
    expect(screen.queryByText('chat.summaryReadyReview')).toBeNull();
    expect(screen.queryByLabelText('chat.correctSummary')).toBeNull();
    expect(screen.queryByLabelText('chat.reviewSummary')).toBeNull();
    expect(screen.queryByLabelText('chat.summarySchedule')).toBeNull();
    expect(screen.queryByLabelText('chat.reportSummaryError')).toBeNull();
    expect(screen.queryByText('Saturday')).toBeNull();
    expect(screen.queryByText(/\bs0\d{3}\b/)).toBeNull();
  });

  test('the header shows the date and hours of the first and last message covered when they are loaded', async () => {
    mockWorkspace.messages = {
      'conversation-a': [
        { id: 'm1', serverId: '101', createdAt: new Date(2026, 8, 14, 14, 49).toISOString() },
        { id: 'm3', serverId: '103', createdAt: new Date(2026, 8, 14, 15, 44).toISOString() },
      ],
    };
    await open();
    expect(screen.getByText('Sep 14, 2026 · 2:49 PM – 3:44 PM')).toBeTruthy();
  });

  test('offers Everything by default; the reader picks a range and says what it should cover', async () => {
    await open();
    // "Unread" is gone from the chips and the longer spans arrived (owner, Sep 14 2026).
    expect(screen.queryByLabelText('chat.summaryRangeUnread')).toBeNull();
    expect(selectedState(screen.getByLabelText('chat.summaryRangeEverything'))).toBe(true);
    for (const key of ['chat.summaryRangeToday', 'chat.summaryRangeYesterday', 'chat.summaryRangeWeek', 'chat.summaryRangeMonth', 'chat.summaryRangeQuarter']) {
      expect(screen.getByLabelText(key)).toBeTruthy();
    }
    await fireEvent.press(screen.getByLabelText('chat.summaryRangeWeek'));
    expect(selectedState(screen.getByLabelText('chat.summaryRangeWeek'))).toBe(true);
    expect(selectedState(screen.getByLabelText('chat.summaryRangeEverything'))).toBe(false);
    await fireEvent.changeText(screen.getByLabelText('chat.summarySubject'), 'the trip');
    await fireEvent.press(screen.getByLabelText('chat.summarizeAll'));
    expect(mockWorkspace.requestConversationSummary).toHaveBeenCalledWith('conversation-a', { kind: 'last_7_days', subject: 'the trip' });
  });

  test('unread messages change nothing about the default, and an earlier recap never narrows a request', async () => {
    mockWorkspace.unreadDividerIds = { 'conversation-a': 'local-104' };
    // The newest version already covers every loaded message: still summarizable.
    mockWorkspace.summaries = [summary({ sourceLastMessageId: '105', sourceMessageIds: ['101', '102', '103', '104', '105'] })];
    const withDivider = await open({ conversation: conversation({ unreadCount: 3 }) });
    expect(screen.queryByLabelText('chat.summaryRangeUnread')).toBeNull();
    expect(selectedState(screen.getByLabelText('chat.summaryRangeEverything'))).toBe(true);
    expect(disabledState(screen.getByLabelText('chat.summarizeAll'))).toBe(false);
    await fireEvent.press(screen.getByLabelText('chat.summarizeAll'));
    expect(mockWorkspace.requestConversationSummary).toHaveBeenCalledWith('conversation-a', { kind: 'everything', subject: '' });
    await withDivider.view.unmount();
  });

  test('another member\'s recap is theirs alone: it never shows here', async () => {
    mockWorkspace.summaries = [summary({ id: 'theirs', versionNumber: 9, requestedByUserId: 'user-other' })];
    await open();
    expect(screen.getByText('chat.summaryEmpty')).toBeTruthy();
    expect(screen.queryByText('Weekend plans')).toBeNull();
  });

  test('shows a loading state while a recap is generating and disables copy and the downloads without one', async () => {
    mockWorkspace.summaries = [summary({ status: 'generating', summary: '', primaryTopic: '', outputFingerprint: null })];
    const generating = await open();
    expect(screen.getByText('chat.summaryGenerating')).toBeTruthy();
    expect(screen.getByText('chat.summaryScopeLine · chat.summaryScopeAbout')).toBeTruthy();
    expect(disabledState(screen.getByLabelText('chat.summarizeAll'))).toBe(true);
    expect(disabledState(screen.getByLabelText('chat.copy'))).toBe(true);
    await generating.view.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.summaries = [];
    const empty = await open();
    expect(screen.getByText('chat.summaryEmpty')).toBeTruthy();
    expect(screen.queryByText(/chat\.summaryScopeLine/)).toBeNull();
    expect(disabledState(screen.getByLabelText('chat.copy'))).toBe(true);
    expect(disabledState(screen.getByLabelText('chat.summaryPdf'))).toBe(true);
    expect(disabledState(screen.getByLabelText('chat.summaryWord'))).toBe(true);
    expect(disabledState(screen.getByLabelText('chat.summarizeAll'))).toBe(false);
    await empty.view.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.actionBusy = 'summary-request:conversation-a';
    await open();
    expect(disabledState(screen.getByLabelText('chat.summarizeAll'))).toBe(true);
  });

  test('copies the recap as clean text with its header and lines, and nothing else', async () => {
    await open();
    await fireEvent.press(screen.getByLabelText('chat.copy'));
    await waitFor(() => expect(mockClipboardWrite).toHaveBeenCalledTimes(1));
    const copied = mockClipboardWrite.mock.calls[0]?.[0] ?? '';
    expect(copied.startsWith('Weekend plans\nAna Torres · chat.summaryScopeLine · chat.summaryScopeAbout\n')).toBe(true);
    expect(copied).toContain('\nchat.summaryParticipants: Jordan Lee, Ana Torres\n\nYou asked whether Saturday works.');
    expect(copied).not.toContain('chat.summaryDecisions');
    expect(copied).not.toContain('Meet at noon');
    expect(copied).not.toMatch(/\bs0\d{3}\b|\[sources/);
    expect(screen.getByText('chat.summaryCopied')).toBeTruthy();
  });

  test('PDF asks the service for the file and hands it to the share sheet, where it is saved', async () => {
    mockFileExists = true;
    await open();
    await fireEvent.press(screen.getByLabelText('chat.summaryPdf'));
    await waitFor(() => expect(mockShareAsync).toHaveBeenCalledTimes(1));
    expect(mockWorkspace.exportConversationSummary).toHaveBeenCalledWith(expect.objectContaining({ id: 'summary-a' }), 'pdf');
    const fileName = String(mockFileArgs.mock.calls[0]?.[1]);
    expect(fileName).toMatch(/^Gist summary – Ana Torres – \d{4}-\d{2}-\d{2}\.pdf$/);
    expect(mockFileDelete).toHaveBeenCalledTimes(1);
    expect(mockFileCreate).toHaveBeenCalledTimes(1);
    expect(mockFileWrite.mock.calls[0]?.[0]).toBe(PDF_BYTES);
    expect(mockShareAsync).toHaveBeenCalledWith(`file:///cache/${fileName}`, expect.objectContaining({ mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'Weekend plans' }));
    expect(screen.queryByText('chat.summaryShareFailed')).toBeNull();
  });

  test('Word saves the service\'s .docx through the share sheet; a failed share is reported; a refused export shows nothing extra', async () => {
    const first = await open();
    await fireEvent.press(screen.getByLabelText('chat.summaryWord'));
    await waitFor(() => expect(mockShareAsync).toHaveBeenCalledTimes(1));
    expect(mockWorkspace.exportConversationSummary).toHaveBeenCalledWith(expect.objectContaining({ id: 'summary-a' }), 'docx');
    const fileName = String(mockFileArgs.mock.calls[0]?.[1]);
    expect(fileName).toMatch(/^Gist summary – Ana Torres – \d{4}-\d{2}-\d{2}\.docx$/);
    expect(mockShareAsync).toHaveBeenCalledWith(`file:///cache/${fileName}`, expect.objectContaining({ mimeType: DOCX_TYPE }));
    await first.view.unmount();

    mockShareAsync.mockRejectedValueOnce(new Error('no share targets'));
    const second = await open();
    await fireEvent.press(screen.getByLabelText('chat.summaryWord'));
    await waitFor(() => expect(screen.getByText('chat.summaryShareFailed')).toBeTruthy());
    await second.view.unmount();

    // The workspace already surfaces a refused export as its action error.
    mockWorkspace = buildWorkspace();
    mockWorkspace.exportConversationSummary = jest.fn(async () => null);
    await open();
    await fireEvent.press(screen.getByLabelText('chat.summaryPdf'));
    await waitFor(() => expect(mockWorkspace.exportConversationSummary).toHaveBeenCalledTimes(1));
    // Nothing reached the share sheet beyond the two earlier presses.
    expect(mockShareAsync).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('chat.summaryShareFailed')).toBeNull();
  });

  test('says to pick a shorter range when a recap was too long or refused, and to try again otherwise', async () => {
    const failed = (failureCode: string) => summary({
      status: 'failed', summary: '', primaryTopic: '', outputFingerprint: null, failureCode,
    });
    for (const code of ['summary_range_too_long', 'provider_refused', 'ai_output_needs_review']) {
      mockWorkspace = buildWorkspace();
      mockWorkspace.summaries = [failed(code)];
      const view = await open();
      expect(screen.getByText('chat.summaryTooLong')).toBeTruthy();
      expect(screen.queryByText('chat.summaryFailed')).toBeNull();
      expect(screen.queryByText(new RegExp(code))).toBeNull();
      expect(screen.queryByLabelText('chat.createManualHandoff')).toBeNull();
      expect(disabledState(screen.getByLabelText('chat.summarizeAll'))).toBe(false);
      await view.view.unmount();
    }
    mockWorkspace = buildWorkspace();
    mockWorkspace.summaries = [failed('provider_unavailable')];
    await open();
    expect(screen.getByText('chat.summaryRetry')).toBeTruthy();
    expect(screen.queryByText('chat.summaryFailed')).toBeNull();
    expect(screen.queryByText(/provider_unavailable/)).toBeNull();
  });

  test('shows the reader their own latest recap rather than someone else\'s newer one', async () => {
    mockWorkspace.summaries = [
      summary({ id: 'theirs', versionNumber: 5, requestedByUserId: other.id, primaryTopic: 'Their recap' }),
      summary(),
    ];
    await open();
    expect(screen.getByText('Weekend plans')).toBeTruthy();
    expect(screen.queryByText('Their recap')).toBeNull();
  });
});

describe('summary sheet', () => {
  beforeEach(() => {
    mockWorkspace = buildWorkspace('organization-a');
    mockWorkspace.actions = [{
      id: 'action-proposed', conversationId: 'conversation-a', sourceMessageId: null,
      title: 'Inspect the valve', details: null, status: 'proposed', proposedByUserId: self.id,
      assigneeUserId: null, assigneeName: null, dueAt: null,
      createdAt: '2026-09-04T10:00:00.000Z', updatedAt: '2026-09-04T10:00:00.000Z',
    }];
  });

  test('shows retry copy for a failed summary and a submitted report badge', async () => {
    mockWorkspace.summaries = [summary({
      status: 'failed', summary: '', primaryTopic: '', outputFingerprint: null, failureCode: 'provider_unavailable',
    })];
    const failed = await open();
    expect(screen.getByText('chat.summaryRetry')).toBeTruthy();
    // The manual-handoff route went with the workplace product.
    expect(screen.queryByLabelText('chat.createManualHandoff')).toBeNull();
    await failed.view.unmount();

    mockWorkspace = buildWorkspace('organization-a');
    mockWorkspace.aiOutputErrorReports = [{ summaryId: 'summary-a' }];
    mockWorkspace.summaries = [summary({ status: 'approved', sourceState: 'stale' })];
    await open({ conversation: conversation({ canManage: false }) });
    expect(screen.getByText('chat.summarySuperseded')).toBeTruthy();
    expect(screen.queryByLabelText('chat.correctSummary')).toBeNull();
    expect(screen.queryByLabelText('chat.summarySchedule')).toBeNull();
  });
});

function readiness(ready: Partial<Record<string, { messages: number; characters: number; ready: boolean; tooLong?: boolean }>>) {
  const range = (value?: { messages: number; characters: number; ready: boolean; tooLong?: boolean }) => ({
    messages: value?.messages ?? 12,
    characters: value?.characters ?? 900,
    ready: value?.ready ?? true,
    tooLong: value?.tooLong ?? false,
  });
  return {
    conversationId: 'conversation-a',
    minimumMessages: 3,
    minimumCharacters: 200,
    ranges: {
      unread: range(ready.unread),
      today: range(ready.today),
      yesterday: range(ready.yesterday),
      last_7_days: range(ready.last_7_days),
      last_30_days: range(ready.last_30_days),
      last_90_days: range(ready.last_90_days),
      everything: range(ready.everything),
    },
  };
}

describe('a summary once there is enough conversation for one', () => {
  beforeEach(() => resetConversationProjectsStore());

  test('keeps Summarize off and says why while the chosen range is too thin, and lets a fuller range through', async () => {
    mockWorkspace.summaries = [];
    mockWorkspace.loadSummaryReadiness = jest.fn(async () => readiness({
      today: { messages: 2, characters: 40, ready: false },
      everything: { messages: 2, characters: 40, ready: false },
      last_90_days: { messages: 2, characters: 40, ready: false },
    }));
    await open();
    await waitFor(() => expect(screen.getByText('chat.summaryNotEnough')).toBeTruthy());
    expect(screen.getByText('chat.summaryNotEnoughHint')).toBeTruthy();
    expect(disabledState(screen.getByLabelText('chat.summarizeAll'))).toBe(true);
    fireEvent.press(screen.getByLabelText('chat.summaryRangeWeek'));
    await waitFor(() => expect(screen.queryByText('chat.summaryNotEnough')).toBeNull());
    expect(disabledState(screen.getByLabelText('chat.summarizeAll'))).toBe(false);
  });

  test('when the readiness cannot be read the server decides, so the button stays on', async () => {
    mockWorkspace.loadSummaryReadiness = jest.fn(async () => null);
    await open();
    await waitFor(() => expect(mockWorkspace.loadSummaryReadiness).toHaveBeenCalledWith('conversation-a'));
    expect(screen.queryByText('chat.summaryNotEnough')).toBeNull();
    expect(disabledState(screen.getByLabelText('chat.summarizeAll'))).toBe(false);
  });

  test('names the project the summary will be saved to, and where a finished one already is', async () => {
    mockWorkspace.loadConversationProjects = jest.fn(async () => ({
      conversationId: 'conversation-a',
      selectedProjectId: 'project-1',
      projects: [
        { id: 'project-1', name: 'HDG', createdByUserId: 'user-self', createdAt: '2026-09-23T01:00:00.000Z' },
      ],
      items: [{
        id: 'item-1',
        projectId: 'project-1',
        kind: 'summary',
        title: 'Weekend plans #1',
        addedByUserId: 'user-self',
        createdAt: '2026-09-23T01:05:00.000Z',
        senderId: null,
        senderName: '',
        summary: { summaryId: 'summary-a', state: 'ready', topic: 'Weekend plans', language: 'en', createdAt: '2026-09-23T01:05:00.000Z' },
        upload: null,
        link: null,
      }],
    }));
    await open();
    await waitFor(() => expect(screen.getByText('projects.summaryWillSave')).toBeTruthy());
    expect(screen.getByTestId('summary-saved-in')).toBeTruthy();
  });
});

describe('web share adapter', () => {
  test('uses the Web Share API when present, treats a cancelled sheet as dismissed, and falls back to the clipboard', async () => {
    const input = { fileName: 'Gist summary – A – 2026-09-05.txt', title: 'A', text: 'Body' };
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
