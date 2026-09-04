import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { Message } from '@/domain/types';
import { ConversationDetails } from '@/features/chat/conversation-details';
import { ConversationList } from '@/features/chat/conversation-list';
import { ConversationPane } from '@/features/chat/conversation-pane';

const mockPush = jest.fn<(_href: unknown) => void>();
const mockReplace = jest.fn<(_href: unknown) => void>();
const mockClipboardWrite = jest.fn<(_value: string) => Promise<void>>(async () => undefined);
const mockDocumentPicker = jest.fn<(_options?: unknown) => Promise<{
  canceled: boolean;
  assets: { uri: string; name: string; mimeType: string; size: number }[];
}>>(async () => ({
  canceled: false,
  assets: [{
    uri: 'file://controlled-document.pdf',
    name: 'controlled-document.pdf',
    mimeType: 'application/pdf',
    size: 2048,
  }],
}));
type PickedMediaAsset = {
  uri: string;
  fileName?: string | null;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  type?: 'image' | 'video';
};
const mockImageLibrary = jest.fn<(_options?: unknown) => Promise<{
  canceled: boolean;
  assets: PickedMediaAsset[];
}>>(async () => ({
  canceled: false,
  assets: [{
    uri: 'file://controlled-photo.jpg',
    fileName: 'controlled-photo.jpg',
    mimeType: 'image/jpeg',
    fileSize: 4096,
    width: 800,
    height: 600,
  }],
}));
const mockCamera = jest.fn<(_options?: unknown) => Promise<{
  canceled: boolean;
  assets: PickedMediaAsset[];
}>>(async () => ({
  canceled: false,
  assets: [{
    uri: 'file://controlled-camera.jpg',
    fileName: 'controlled-camera.jpg',
    mimeType: 'image/jpeg',
    fileSize: 2048,
    width: 640,
    height: 480,
  }],
}));
const mockCameraPermission = jest.fn(async () => ({ granted: true }));
const mockLibraryPermission = jest.fn(async () => ({ granted: true }));

let mockWorkspace: Record<string, any>;

jest.mock('expo-router', () => ({
  useRouter: () => ({
    back: jest.fn(),
    push: (href: unknown) => mockPush(href),
    replace: (href: unknown) => mockReplace(href),
  }),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: (value: string) => mockClipboardWrite(value),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...mockArgs: unknown[]) => mockDocumentPicker(...mockArgs),
}));

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: () => mockCameraPermission(),
  requestMediaLibraryPermissionsAsync: () => mockLibraryPermission(),
  launchCameraAsync: (...mockArgs: unknown[]) => mockCamera(...mockArgs),
  launchImageLibraryAsync: (...mockArgs: unknown[]) => mockImageLibrary(...mockArgs),
}));

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string) => key,
  }),
}));

jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));

const self = {
  id: 'user-self',
  displayName: 'Jordan Lee',
  initials: 'JL',
  avatarColor: '#123456',
  roleLabel: 'Supervisor',
  role: 'manager',
  site: 'Denver',
  department: 'Operations',
  preferredLanguage: 'en',
  presence: 'online',
  connectionState: 'self',
};

const colleague = {
  id: 'user-colleague',
  displayName: 'Ana Torres',
  initials: 'AT',
  avatarColor: '#654321',
  roleLabel: 'Operator',
  role: 'employee',
  site: 'Denver',
  department: 'Operations',
  preferredLanguage: 'es',
  presence: 'away',
  connectionState: 'connected',
};

const candidate = {
  id: 'user-candidate',
  displayName: 'Morgan Park',
  initials: 'MP',
  avatarColor: '#336699',
  roleLabel: 'Technician',
  role: 'employee',
  site: 'Denver',
  department: 'Maintenance',
  preferredLanguage: 'en',
  presence: 'offline',
  connectionState: 'available',
};

function successfulAction() {
  return jest.fn(async (..._mockArgs: unknown[]) => true);
}

async function noopSend(
  _text: string,
  _replyTo?: Message,
  _mentionUserIds?: string[],
): Promise<void> {}

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conversation-main',
    organizationId: 'organization-a',
    title: 'Plant Operations',
    initials: 'PO',
    avatarColor: '#225544',
    kind: 'group',
    subtitle: 'Live shift coordination',
    participantCount: 3,
    lastMessage: 'Line two is stable',
    lastActivity: 'now',
    unreadCount: 2,
    lastReadMessageId: 'message-system',
    pinned: true,
    favorite: false,
    muted: false,
    notificationLevel: 'all',
    translationMode: 'automatic',
    translationPair: 'EN ↔ ES',
    priority: 'safety',
    description: 'Authorized plant operations group',
    myRole: 'owner',
    canManage: true,
    canManageConversation: true,
    policyManaged: false,
    memberIds: [self.id, colleague.id, candidate.id],
    memberRoles: { [self.id]: 'owner', [colleague.id]: 'admin', [candidate.id]: 'member' },
    historyPolicy: 'all',
    historyDisclosure: { policy: 'all', visibleFrom: null, labelKey: 'conversation.history.all' },
    postingMode: 'all_members',
    configuredJoinPolicy: 'approval_required',
    joinPolicy: 'approval_required',
    visibility: 'organization',
    canPost: true,
    departure: {
      eligible: true,
      restriction: null,
      requiresOwnershipTransfer: true,
      historyPreserved: true,
      futureAccessRevoked: true,
    },
    ...overrides,
  } as any;
}

function translatedMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'message-translated',
    serverId: 'message-translated',
    conversationId: 'conversation-main',
    senderId: self.id,
    senderName: self.displayName,
    senderInitials: self.initials,
    senderColor: self.avatarColor,
    originalText: 'Lock the north gate at 18:00.',
    translatedText: 'Cierre la puerta norte a las 18:00.',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    translationState: 'translated',
    translation: {
      id: 'translation-a',
      sourceLanguage: 'en',
      targetLanguage: 'es',
      sourceBodySha256: 'source-hash',
      status: 'completed',
      translatedText: 'Cierre la puerta norte a las 18:00.',
      provider: 'openrouter',
      model: 'qwen/tested-model',
      confidence: 0.96,
      policyVersion: 4,
      policyState: 'current',
      reviewedByUserId: null,
      reviewedAt: null,
      failureCode: null,
      createdAt: '2026-08-04T18:00:00.000Z',
      updatedAt: '2026-08-04T18:00:01.000Z',
      correction: {
        id: 'correction-a',
        status: 'pending',
        correctedText: 'Cierre la entrada norte a las 18:00.',
        rationale: 'Uses the site term.',
        proposedByUserId: colleague.id,
        reviewedByUserId: null,
        reviewedAt: null,
        reviewNote: null,
        createdAt: '2026-08-04T18:01:00.000Z',
        updatedAt: '2026-08-04T18:01:00.000Z',
      },
    },
    languageDetection: {
      state: 'completed',
      detectedLanguage: 'en',
      confidence: 0.98,
      method: 'server-detector',
      detectedAt: '2026-08-04T18:00:00.000Z',
    },
    sentAt: '12:00',
    dayLabel: 'Today',
    isOwn: true,
    deliveryState: 'read',
    receipt: {
      scope: 'aggregate',
      recipientCount: 3,
      deliveredCount: 3,
      visibleReadCount: 2,
      visibleReadEligibleCount: 2,
      delivered: true,
      deliveredAt: '2026-08-04T18:00:02.000Z',
      read: true,
      readAt: '2026-08-04T18:00:03.000Z',
    },
    priority: 'important',
    mentionUserIds: [self.id, colleague.id],
    edited: true,
    pinned: true,
    forwarded: true,
    replyTo: { senderName: colleague.displayName, preview: 'Please confirm.' },
    reactions: [{ emoji: '✅', count: 2, reactedByMe: true }],
    ...overrides,
  } as any;
}

function incomingMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'message-incoming',
    serverId: 'message-incoming',
    conversationId: 'conversation-main',
    senderId: colleague.id,
    senderName: colleague.displayName,
    senderInitials: colleague.initials,
    senderColor: colleague.avatarColor,
    originalText: 'La válvula necesita revisión.',
    sourceLanguage: 'es',
    translationState: 'failed',
    translation: {
      id: 'translation-failed',
      sourceLanguage: 'es',
      targetLanguage: 'en',
      sourceBodySha256: 'failed-source-hash',
      status: 'failed',
      translatedText: null,
      provider: null,
      model: null,
      confidence: null,
      policyVersion: null,
      policyState: 'stale',
      reviewedByUserId: null,
      reviewedAt: null,
      failureCode: 'provider_timeout',
      createdAt: '2026-08-04T18:02:00.000Z',
      updatedAt: '2026-08-04T18:02:05.000Z',
      correction: null,
    },
    languageDetection: {
      state: 'ambiguous',
      detectedLanguage: 'es',
      confidence: 0.51,
      method: 'server-detector',
      detectedAt: '2026-08-04T18:02:00.000Z',
    },
    sentAt: '12:02',
    dayLabel: 'Today',
    isOwn: false,
    deliveryState: 'failed',
    failureReason: 'controlled failure',
    priority: 'safety',
    mentionUserIds: [self.id],
    attachment: {
      id: 'attachment-a',
      kind: 'document',
      name: 'safety-procedure.pdf',
      sizeLabel: '24 KB',
      status: 'clean',
      mimeType: 'application/pdf',
      byteSize: 24576,
      downloadUrl: 'https://example.invalid/signed',
    },
    ...overrides,
  } as any;
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'summary-a',
    conversationId: 'conversation-main',
    versionNumber: 2,
    language: 'en',
    status: 'ready_for_review',
    primaryTopic: 'Gate and valve safety',
    summary: 'The shift must secure the gate and inspect the valve.',
    keyTopics: [{ text: 'North gate', sourceMessageIds: ['message-translated'] }],
    decisions: [{ text: 'Lock at 18:00', sourceMessageIds: ['message-translated'] }],
    actionItems: [{ title: 'Inspect valve', owner: 'Ana', dueAt: '18:30', sourceMessageIds: ['message-incoming'] }],
    ambiguities: [{ text: 'Valve identifier', sourceMessageIds: ['missing-source'] }],
    sourceMessageIds: ['message-translated', 'missing-source'],
    sourceFirstMessageId: 'message-translated',
    sourceLastMessageId: 'message-incoming-old',
    sourceFingerprint: 'summary-source-hash',
    outputFingerprint: 'summary-output-hash',
    sourceState: 'current',
    policyState: 'current',
    requestMode: 'manual',
    requestedByUserId: self.id,
    correctionOfSummaryId: null,
    provenance: {
      processorType: 'ai',
      provider: 'openrouter',
      model: 'qwen/tested-model',
      organizationAiPolicyVersion: 4,
      routePolicyVersion: 'route-1',
      providerRoute: 'openrouter',
    },
    failureCode: null,
    reviewedByUserId: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: '2026-08-04T18:03:00.000Z',
    generatedAt: '2026-08-04T18:03:05.000Z',
    ...overrides,
  } as any;
}

function buildWorkspace() {
  const primary = conversation();
  return {
    actionBusy: null,
    actionError: null,
    actions: [
      {
        id: 'action-proposed', conversationId: primary.id, sourceMessageId: 'message-incoming',
        title: 'Inspect the valve', details: null, status: 'proposed', proposedByUserId: self.id,
        assigneeUserId: null, assigneeName: null, dueAt: null,
        createdAt: '2026-08-04T18:00:00.000Z', updatedAt: '2026-08-04T18:00:00.000Z',
      },
      {
        id: 'action-progress', conversationId: primary.id, sourceMessageId: null,
        title: 'Secure gate', details: null, status: 'in_progress', proposedByUserId: colleague.id,
        assigneeUserId: self.id, assigneeName: self.displayName, dueAt: null,
        createdAt: '2026-08-04T18:00:00.000Z', updatedAt: '2026-08-04T18:00:00.000Z',
      },
    ],
    aiOutputErrorReports: [],
    connectivity: 'online',
    conversationAvatarUrls: { [primary.id]: 'https://example.invalid/avatar.jpg' },
    conversations: [
      primary,
      conversation({ id: 'conversation-target', title: 'Maintenance', initials: 'MT', pinned: false }),
    ],
    currentUser: self,
    messageDisplayLanguage: 'en',
    messagePagination: { [primary.id]: { hasMore: true, loading: false } },
    organizationId: 'organization-a',
    people: [self, colleague, candidate],
    summaries: [summary()],
    unreadDividerIds: { [primary.id]: 'message-incoming' },
    hasCapability: jest.fn((capability: string) => [
      'actions.confirm', 'language.review', 'reports.investigate',
    ].includes(capability)),
    observeConversation: successfulAction(),
    refresh: successfulAction(),
    loadMyAiOutputErrorReports: successfulAction(),
    loadOlderMessages: successfulAction(),
    markConversationRead: successfulAction(),
    ensureMessageLoaded: jest.fn(async (_conversationId: string, messageId: string) => messageId !== 'missing-source'),
    requestTranslation: successfulAction(),
    proposeTranslationCorrection: successfulAction(),
    reviewTranslationCorrection: successfulAction(),
    requestConversationSummary: successfulAction(),
    correctConversationSummary: successfulAction(),
    reviewConversationSummary: successfulAction(),
    reportAiOutputError: successfulAction(),
    setConversationSummaryPolicy: successfulAction(),
    clearActionError: jest.fn(),
    confirmAction: successfulAction(),
    transitionAction: successfulAction(),
    downloadAttachment: successfulAction(),
    deleteMessage: successfulAction(),
    hideMessageForMe: successfulAction(),
    forwardMessage: successfulAction(),
    proposeAction: successfulAction(),
    editMessage: successfulAction(),
    toggleReaction: successfulAction(),
    setMessagePinned: successfulAction(),
    reportMessage: successfulAction(),
    updateConversation: successfulAction(),
    updateConversationPreferences: successfulAction(),
    updateConversationControls: successfulAction(),
    addConversationMember: successfulAction(),
    removeConversationMember: successfulAction(),
    updateConversationMemberRole: successfulAction(),
    leaveConversation: successfulAction(),
    closeIncident: successfulAction(),
    reportGroup: successfulAction(),
    queryConversationMemberCandidates: jest.fn(async () => ({
      candidates: [{
        userId: candidate.id,
        membershipId: 'membership-candidate',
        displayName: candidate.displayName,
        initials: candidate.initials,
        avatarColor: candidate.avatarColor,
        avatarPath: null,
        roleLabel: candidate.roleLabel,
        department: candidate.department,
        site: candidate.site,
        suspended: false,
      }],
      nextCursor: null,
    })),
    loadConversationJoinRequests: jest.fn(async () => [{
      requestId: 'join-a',
      conversationId: primary.id,
      requesterUserId: candidate.id,
      requesterDisplayName: candidate.displayName,
      status: 'pending',
      version: 1,
      requestedAt: '2026-08-04T18:00:00.000Z',
      expiresAt: '2026-08-05T18:00:00.000Z',
    }]),
    decideConversationJoinRequest: successfulAction(),
    uploadConversationAvatar: successfulAction(),
    removeConversationAvatar: successfulAction(),
    sendAttachment: successfulAction(),
    cancelAttachmentUpload: successfulAction(),
    retryAttachmentUpload: successfulAction(),
  };
}

beforeEach(() => {
  mockWorkspace = buildWorkspace();
  mockCameraPermission.mockImplementation(async () => ({ granted: true }));
  mockLibraryPermission.mockImplementation(async () => ({ granted: true }));
});

describe('conversation UI against controlled authorized workspace inputs', () => {
  test('fails closed without an identity and shows the empty selection state separately', async () => {
    mockWorkspace.currentUser = null;
    const first = await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    expect(screen.getByText('status.loading')).toBeTruthy();
    await first.unmount();

    mockWorkspace.currentUser = self;
    await render(<ConversationPane messages={[]} onSend={noopSend} />);
    expect(screen.getByText('chat.choose')).toBeTruthy();
  });

  test('renders message provenance, sends text, loads history, and executes briefing actions', async () => {
    const onSend = jest.fn(async () => undefined);
    const messages = [
      {
        ...incomingMessage({ id: 'message-system', serverId: 'message-system', originalText: '' }),
        systemEvent: { eventType: 'conversation.created', targetUserId: null },
        attachment: undefined,
      },
      translatedMessage(),
      incomingMessage(),
    ];
    await render(<ConversationPane conversation={conversation()} messages={messages} onSend={onSend} mobile />);

    await waitFor(() => expect(mockWorkspace.observeConversation).toHaveBeenCalledWith('conversation-main'));
    expect(screen.getByText('Lock the north gate at 18:00.')).toBeTruthy();
    expect(screen.getByText('Cierre la puerta norte a las 18:00.')).toBeTruthy();
    expect(screen.getByText('La válvula necesita revisión.')).toBeTruthy();

    await fireEvent.press(screen.getByText('chat.loadOlder'));
    await waitFor(() => expect(mockWorkspace.loadOlderMessages).toHaveBeenCalledWith('conversation-main'));

    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'Confirmed for this shift');
    await fireEvent.press(screen.getByLabelText('chat.send'));
    expect(onSend).toHaveBeenCalledWith('Confirmed for this shift', undefined, []);

    await fireEvent.press(screen.getByText('chat.briefing'));
    expect(screen.getByText('Gate and valve safety')).toBeTruthy();
    expect(screen.getByText('Inspect the valve')).toBeTruthy();

    await fireEvent.press(screen.getAllByLabelText('chat.openSource missing-source')[0]);
    await waitFor(() => expect(screen.getByText('chat.sourceUnavailable')).toBeTruthy());

    await fireEvent.press(screen.getAllByLabelText('chat.confirmAction')[0]);
    await fireEvent.press(screen.getByLabelText(colleague.displayName));
    await fireEvent.changeText(screen.getByLabelText('chat.dueAt'), '2026-08-04T19:00:00.000Z');
    await fireEvent.press(screen.getAllByLabelText('chat.confirmAction').at(-1)!);
    await waitFor(() => expect(mockWorkspace.confirmAction).toHaveBeenCalledWith(
      'action-proposed', colleague.id, '2026-08-04T19:00:00.000Z',
    ));

    await fireEvent.press(screen.getByLabelText('chat.completeAction'));
    expect(mockWorkspace.transitionAction).toHaveBeenCalledWith('action-progress', 'completed');
  });

  test('runs translation correction, message actions, and reply composition through the real pane', async () => {
    const onSend = jest.fn(async () => undefined);
    const message = translatedMessage();
    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={onSend} />);

    await fireEvent.press(screen.getByText('chat.showProvenance'));
    expect(screen.getByText(/chat\.machineRoute/)).toBeTruthy();

    await fireEvent.press(screen.getByText('chat.proposeCorrection'));
    await fireEvent.changeText(screen.getByLabelText('chat.correctedTranslation'), 'Cierre la entrada norte a las 18:00.');
    await fireEvent.changeText(screen.getByLabelText('chat.correctionRationale'), 'Approved site terminology.');
    await fireEvent.press(screen.getByLabelText('chat.submitCorrection'));
    await waitFor(() => expect(mockWorkspace.proposeTranslationCorrection).toHaveBeenCalledWith(
      message,
      'Cierre la entrada norte a las 18:00.',
      'Approved site terminology.',
    ));

    await fireEvent(screen.getByText('Lock the north gate at 18:00.'), 'longPress');
    await fireEvent.press(screen.getByLabelText('chat.copy'));
    await waitFor(() => expect(mockClipboardWrite).toHaveBeenCalledWith(message.originalText));

    await fireEvent(screen.getByText('Lock the north gate at 18:00.'), 'longPress');
    await fireEvent.press(screen.getByLabelText('chat.reply'));
    expect(screen.getByText(/chat\.replyingTo Jordan Lee/)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'Reply acknowledged');
    await fireEvent.press(screen.getByLabelText('chat.send'));
    expect(onSend).toHaveBeenLastCalledWith('Reply acknowledged', message, []);

    await fireEvent(screen.getByText('Lock the north gate at 18:00.'), 'longPress');
    await fireEvent.press(screen.getByLabelText('chat.react 👍'));
    await waitFor(() => expect(mockWorkspace.toggleReaction).toHaveBeenCalledWith(message, '👍'));
  });

  test('selects a real file input and sends it through the workspace attachment boundary', async () => {
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);

    await fireEvent.press(screen.getByLabelText('chat.addAttachment'));
    await fireEvent.press(screen.getByLabelText('chat.photoLibrary'));
    await waitFor(() => expect(screen.getByText('controlled-photo.jpg')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('chat.imageOriginal'));
    await fireEvent.changeText(screen.getByLabelText('chat.captionOptional'), 'Valve damage photo');
    await fireEvent.press(screen.getByLabelText('chat.sendSecurely'));

    await waitFor(() => expect(mockWorkspace.sendAttachment).toHaveBeenCalledWith(
      'conversation-main',
      expect.objectContaining({ uri: 'file://controlled-photo.jpg', imageMode: 'original' }),
      'Valve damage photo',
    ));
  });

  test('routes unauthorized management shells to admin and opens authorized controls', async () => {
    const restricted = conversation({ managementOnly: true, canManageConversation: false });
    const first = await render(<ConversationPane conversation={restricted} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.managementOnlyOpenAdmin'));
    expect(mockPush).toHaveBeenCalledWith('/admin');
    await first.unmount();

    const authorized = conversation({ managementOnly: true, canManageConversation: true });
    await render(<ConversationPane conversation={authorized} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.managementOnlyOpen'));
    expect(screen.getByText('chat.controlsTitle')).toBeTruthy();
  });

  test('filters/selects conversations, requests group access, and renders details', async () => {
    const onSelect = jest.fn();
    const onFilter = jest.fn();
    const onSearch = jest.fn();
    const onRequestJoin = jest.fn(async () => true);
    const direct = conversation({
      id: 'conversation-direct', kind: 'direct', directParticipantId: colleague.id,
      title: colleague.displayName, initials: colleague.initials, pinned: false, unreadCount: 1,
      presence: 'away', notificationLevel: 'mentions', translationPair: 'ES → EN',
    });
    await render(
      <>
        <ConversationList
          conversations={[conversation(), direct]}
          discoverableConversations={[{
            conversationId: 'discoverable-a',
            kind: 'group',
            name: 'Safety Committee',
            description: 'Open safety coordination',
            avatarPath: null,
            visibility: 'organization',
            postingMode: 'all_members',
            joinPolicy: 'approval_required',
            memberCount: 8,
            historyDisclosure: { policy: 'since_join', visibleFrom: null, labelKey: 'conversation.history.since_join' },
            myJoinRequest: null,
          }]}
          desktop
          filter="all"
          onCompose={jest.fn()}
          onFilterChange={onFilter}
          onRequestJoin={onRequestJoin}
          onSearchChange={onSearch}
          onSelect={onSelect}
          organizationName="Controlled Company"
          search=""
          selectedId="conversation-main"
        />
        <ConversationDetails conversation={direct} />
      </>,
    );

    await fireEvent.press(screen.getByLabelText('chat.filterDirect'));
    expect(onFilter).toHaveBeenCalledWith('direct');
    await fireEvent.press(screen.getAllByText(colleague.displayName)[0]);
    expect(onSelect).toHaveBeenCalledWith('conversation-direct');
    await fireEvent.press(screen.getByText('chat.requestToJoin'));
    expect(onRequestJoin).toHaveBeenCalledWith('discoverable-a');
    expect(screen.getByText('chat.notifications')).toBeTruthy();
  });

  test('executes every mutable own-message action while preserving failures for retry', async () => {
    const message = translatedMessage();
    mockWorkspace.setMessagePinned = jest.fn(async () => false);
    mockWorkspace.toggleReaction = jest.fn(async () => false);
    mockWorkspace.editMessage = jest.fn(async () => false);
    mockWorkspace.deleteMessage = jest.fn(async () => false);
    mockWorkspace.forwardMessage = jest.fn(async () => false);
    mockWorkspace.proposeAction = jest.fn(async () => false);
    mockWorkspace.hideMessageForMe = jest.fn(async () => false);

    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);
    await fireEvent(screen.getByText(message.originalText), 'longPress');

    await fireEvent.press(screen.getByLabelText('chat.unpin'));
    await fireEvent.press(screen.getByLabelText('chat.react ❤️'));
    await fireEvent.changeText(screen.getByLabelText('chat.editMessage'), 'Updated canonical message');
    await fireEvent.press(screen.getByLabelText('chat.saveEdit'));
    await fireEvent.press(screen.getByLabelText('chat.deleteEveryone'));
    await fireEvent.press(screen.getByLabelText('Maintenance'));
    await fireEvent.press(screen.getByLabelText('chat.forwardConfirm'));
    await fireEvent.changeText(screen.getByLabelText('chat.actionTitle'), 'Verify gate lock');
    await fireEvent.changeText(screen.getByLabelText('chat.actionDetails'), 'Inspect the north gate at shift close.');
    await fireEvent.press(screen.getByLabelText('chat.actionCreate'));
    await fireEvent.press(screen.getByLabelText('chat.deleteMe'));

    await waitFor(() => {
      expect(mockWorkspace.setMessagePinned).toHaveBeenCalledWith(message, false);
      expect(mockWorkspace.toggleReaction).toHaveBeenCalledWith(message, '❤️');
      expect(mockWorkspace.editMessage).toHaveBeenCalledWith(message, 'Updated canonical message');
      expect(mockWorkspace.deleteMessage).toHaveBeenCalledWith(message);
      expect(mockWorkspace.forwardMessage).toHaveBeenCalledWith(message, 'conversation-target');
      expect(mockWorkspace.proposeAction).toHaveBeenCalledWith(
        message,
        'Verify gate lock',
        'Inspect the north gate at shift close.',
      );
      expect(mockWorkspace.hideMessageForMe).toHaveBeenCalledWith(message);
    });
  });

  test('requires explicit scoped-disclosure consent before reporting an incoming message', async () => {
    const message = incomingMessage({ attachment: undefined });
    mockWorkspace.reportMessage = jest.fn(async () => false);

    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);
    await fireEvent(screen.getByText(message.originalText), 'longPress');
    await fireEvent.press(screen.getByLabelText('chat.reportThreat'));
    await fireEvent.changeText(screen.getByLabelText('chat.reportDetails'), 'Threatening instruction in the reported message.');

    const oneMessageChoices = screen.getAllByLabelText('1 message');
    await fireEvent.press(oneMessageChoices[0]);
    const twoMessageChoices = screen.getAllByLabelText('2 messages');
    await fireEvent.press(twoMessageChoices[1]);
    expect(screen.getByText('Consent is required before this report can be submitted.')).toBeTruthy();
    await fireEvent.press(screen.getByText('I understand and consent to this limited disclosure.'));
    await fireEvent.press(screen.getByLabelText('chat.submitReport'));

    await waitFor(() => expect(mockWorkspace.reportMessage).toHaveBeenCalledWith(
      message,
      'threat',
      'Threatening instruction in the reported message.',
      {
        consentToShare: true,
        contextBefore: 1,
        contextAfter: 2,
        noticeVersion: 'moderation-report-v2',
      },
    ));
  });

  test('reviews, corrects, schedules, and reports a versioned conversation summary', async () => {
    const existingSummary = summary();
    await render(<ConversationPane
      conversation={conversation()}
      messages={[translatedMessage(), incomingMessage()]}
      onSend={noopSend}
    />);
    await fireEvent.press(screen.getByText('chat.briefing'));

    await fireEvent.press(screen.getByLabelText('chat.correctSummary'));
    await fireEvent.changeText(screen.getByLabelText('chat.primaryTopic'), 'Verified gate safety');
    await fireEvent.changeText(screen.getByLabelText('chat.summaryBody'), 'The gate must be secured and the valve inspected.');
    await fireEvent.press(screen.getByLabelText('chat.saveCorrection'));
    await waitFor(() => expect(mockWorkspace.correctConversationSummary).toHaveBeenCalledWith(
      existingSummary,
      'Verified gate safety',
      'The gate must be secured and the valve inspected.',
    ));

    await fireEvent.press(screen.getByLabelText('chat.reviewSummary'));
    await fireEvent.changeText(screen.getByLabelText('chat.reviewNote'), 'Sources and actions verified.');
    await fireEvent.press(screen.getByLabelText('chat.approveExactVersion'));
    await waitFor(() => expect(mockWorkspace.reviewConversationSummary).toHaveBeenCalledWith(
      existingSummary.id,
      'approve',
      'Sources and actions verified.',
    ));

    await fireEvent.press(screen.getByLabelText('chat.summarySchedule'));
    await fireEvent.press(screen.getByLabelText('chat.summaryMessageCount'));
    await fireEvent.changeText(screen.getByLabelText('chat.summaryThreshold'), '25');
    await fireEvent.press(screen.getByLabelText('chat.saveSummarySchedule'));
    await waitFor(() => expect(mockWorkspace.setConversationSummaryPolicy).toHaveBeenCalledWith(
      'conversation-main',
      'message_count',
      25,
    ));

    await fireEvent.press(screen.getByLabelText('chat.reportSummaryError'));
    await fireEvent.press(screen.getByLabelText('quality.categoryMissingSource'));
    await fireEvent.changeText(screen.getByLabelText('quality.whatWentWrong'), 'The valve action lacks a loaded source.');
    const reportChecks = screen.getAllByRole('checkbox');
    await fireEvent.press(reportChecks[0]);
    await fireEvent.press(reportChecks[1]);
    await fireEvent.press(screen.getByLabelText('quality.submitReport'));
    await waitFor(() => expect(mockWorkspace.reportAiOutputError).toHaveBeenCalledWith({
      outputKind: 'summary',
      translationId: null,
      summaryId: existingSummary.id,
      category: 'missing_source',
      details: 'The valve action lacks a loaded source.',
      highConsequence: true,
      qualityUseConsent: true,
    }));
  });

  test('covers missing, processing, failed, and stale summary states without inventing output', async () => {
    const messages = [translatedMessage()];
    mockWorkspace.summaries = [];
    const missing = await render(<ConversationPane conversation={conversation()} messages={messages} onSend={noopSend} />);
    await fireEvent.press(screen.getByText('chat.briefing'));
    await fireEvent.press(screen.getByLabelText('chat.requestSummary'));
    expect(mockWorkspace.requestConversationSummary).toHaveBeenCalledWith('conversation-main', ['message-translated']);
    await missing.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.summaries = [summary({ status: 'failed', failureCode: 'provider_unavailable' })];
    const failed = await render(<ConversationPane conversation={conversation()} messages={messages} onSend={noopSend} />);
    await fireEvent.press(screen.getByText('chat.briefing'));
    expect(screen.getByText(/provider_unavailable/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.createManualHandoff'));
    expect(mockPush).toHaveBeenCalledWith('/handoffs');
    await failed.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.summaries = [summary({ status: 'generating' })];
    const processing = await render(<ConversationPane conversation={conversation()} messages={messages} onSend={noopSend} />);
    await fireEvent.press(screen.getByText('chat.briefing'));
    expect(screen.getByText('chat.summaryProcessingBody')).toBeTruthy();
    await processing.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.summaries = [summary({
      status: 'approved',
      sourceState: 'stale',
      reviewedAt: '2026-08-04T18:05:00.000Z',
      reviewedByUserId: self.id,
      reviewNote: 'Controlled reviewer note.',
    })];
    await render(<ConversationPane conversation={conversation()} messages={messages} onSend={noopSend} />);
    await fireEvent.press(screen.getByText('chat.briefing'));
    expect(screen.getByText('chat.summarySourceStale')).toBeTruthy();
    expect(screen.getByText('Controlled reviewer note.')).toBeTruthy();
  });

  test('exercises conversation security controls, scoped membership, reporting, and departure', async () => {
    const managedConversation = conversation({ avatarPath: 'organization-a/conversation-main/avatar.jpg' });
    mockWorkspace.conversations[0] = managedConversation;
    mockWorkspace.updateConversation = jest.fn(async () => false);
    mockWorkspace.leaveConversation = jest.fn(async () => false);
    mockWorkspace.reportGroup = jest.fn(async () => false);
    mockWorkspace.addConversationMember = jest.fn(async () => false);
    mockWorkspace.queryConversationMemberCandidates = jest.fn(async (
      _conversationId: string,
      _query: string,
      cursor: string | null,
    ) => cursor ? ({
      candidates: [{
        userId: 'user-external-two', membershipId: 'membership-external-two', displayName: 'Riley Chen',
        initials: 'RC', avatarColor: null, avatarPath: null, roleLabel: 'Inspector', department: 'Safety',
        site: 'Denver', suspended: false,
      }],
      nextCursor: null,
    }) : ({
      candidates: [{
        userId: 'user-external-one', membershipId: 'membership-external-one', displayName: 'Casey Wright',
        initials: 'CW', avatarColor: null, avatarPath: null, roleLabel: 'Engineer', department: 'Maintenance',
        site: 'Denver', suspended: false,
      }],
      nextCursor: 'cursor-next',
    }));

    await render(<ConversationPane conversation={managedConversation} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));

    await fireEvent.press(screen.getByLabelText('chat.addFavorite'));
    await fireEvent.press(screen.getByLabelText('Mentions only'));
    await fireEvent.press(screen.getByLabelText('Muted until changed'));
    await fireEvent.press(screen.getByLabelText('1 hour'));
    await fireEvent.press(screen.getByLabelText('8 hours'));
    await fireEvent.press(screen.getByLabelText('1 week'));
    await fireEvent.press(screen.getByLabelText('Off'));
    await fireEvent.press(screen.getByLabelText('Automatic'));

    await fireEvent.press(screen.getByLabelText('group.changeAvatar'));
    await waitFor(() => expect(screen.getByLabelText('group.avatarSelected')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('group.saveAvatar'));
    await waitFor(() => expect(mockWorkspace.uploadConversationAvatar).toHaveBeenCalledWith(
      managedConversation.id,
      expect.objectContaining({ uri: 'file://controlled-photo.jpg', imageMode: 'optimized' }),
    ));
    await fireEvent.press(screen.getByLabelText('group.removeAvatar'));

    await fireEvent.press(screen.getByLabelText('chat.reportSpam'));
    await fireEvent.changeText(screen.getByLabelText('chat.reportDetails'), 'Repeated unsolicited operational messages.');
    await fireEvent.press(screen.getByText('I understand and consent to this limited disclosure.'));
    await fireEvent.press(screen.getByLabelText('chat.submitReport'));
    await waitFor(() => expect(mockWorkspace.reportGroup).toHaveBeenCalledWith(
      managedConversation,
      'spam',
      'Repeated unsolicited operational messages.',
      { consentToShare: true, noticeVersion: 'moderation-report-v2' },
    ));

    await fireEvent.changeText(screen.getByLabelText('chat.name'), 'Controlled Operations');
    await fireEvent.changeText(screen.getByLabelText('chat.description'), 'Scoped operations coordination.');
    await fireEvent.press(screen.getByLabelText('chat.saveConversation'));
    await fireEvent.press(screen.getByLabelText('chat.adminsOnly'));
    await fireEvent.press(screen.getByLabelText('chat.inviteOnly'));
    await fireEvent.changeText(screen.getByLabelText('chat.changeReason'), 'Restrict posting during audit.');
    await fireEvent.press(screen.getByLabelText('chat.saveAccessControls'));

    await fireEvent.press(screen.getByLabelText('chat.reviewJoinRequests'));
    await waitFor(() => expect(screen.getByText('chat.approveJoin')).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText('chat.decisionReason'), 'Approved for assigned maintenance work.');
    await fireEvent.press(screen.getByLabelText('chat.approveJoin'));

    await fireEvent.press(screen.getByLabelText('chat.memberRole · Ana Torres'));
    await fireEvent.press(screen.getByLabelText('chat.removeMember Morgan Park'));
    await fireEvent.changeText(screen.getByLabelText('chat.memberSearchLabel'), 'casey');
    await fireEvent.press(screen.getByLabelText('chat.memberSearchAction'));
    await waitFor(() => expect(screen.getByText('Casey Wright')).toBeTruthy());
    await fireEvent.press(screen.getByText('Casey Wright'));
    await fireEvent.press(screen.getAllByLabelText('chat.adminRole').at(-1)!);
    await fireEvent.press(screen.getByLabelText('chat.loadMoreMembers'));
    await waitFor(() => expect(screen.getByText('Riley Chen')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('chat.addSelectedMember'));

    await fireEvent.press(screen.getAllByText('Ana Torres').at(-1)!);
    await fireEvent.press(screen.getByText('I understand that history is preserved and my future access ends.'));
    await fireEvent.press(screen.getByLabelText('Leave group'));
    await fireEvent.press(screen.getByLabelText('chat.archiveConversation'));

    await waitFor(() => {
      expect(mockWorkspace.updateConversationPreferences).toHaveBeenCalled();
      expect(mockWorkspace.updateConversationControls).toHaveBeenCalledWith(managedConversation.id, {
        postingMode: 'admins_only',
        joinPolicy: 'invite_only',
        visibility: 'invite_only',
        reason: 'Restrict posting during audit.',
      });
      expect(mockWorkspace.decideConversationJoinRequest).toHaveBeenCalled();
      expect(mockWorkspace.updateConversationMemberRole).toHaveBeenCalledWith(
        managedConversation.id,
        colleague.id,
        'admin',
        'member',
      );
      expect(mockWorkspace.removeConversationMember).toHaveBeenCalledWith(managedConversation.id, candidate.id);
      expect(mockWorkspace.addConversationMember).toHaveBeenCalledWith(
        managedConversation.id,
        'user-external-one',
        'admin',
      );
      expect(mockWorkspace.leaveConversation).toHaveBeenCalledWith(managedConversation.id, colleague.id);
      expect(mockWorkspace.updateConversation).toHaveBeenCalledWith(managedConversation.id, { isArchived: true });
    });
  });

  test('selects and removes bounded mentions before sending canonical message input', async () => {
    const onSend = jest.fn(async () => undefined);
    const mentionSelf = { ...self, id: '11111111-1111-4111-8111-111111111111' };
    const mentionColleague = { ...colleague, id: '22222222-2222-4222-8222-222222222222' };
    const mentionCandidate = { ...candidate, id: '33333333-3333-4333-8333-333333333333' };
    mockWorkspace.currentUser = mentionSelf;
    mockWorkspace.people = [mentionSelf, mentionColleague, mentionCandidate];
    const mentionConversation = conversation({
      memberIds: [mentionSelf.id, mentionColleague.id, mentionCandidate.id],
      memberRoles: {
        [mentionSelf.id]: 'owner',
        [mentionColleague.id]: 'admin',
        [mentionCandidate.id]: 'member',
      },
    });
    await render(<ConversationPane conversation={mentionConversation} messages={[]} onSend={onSend} />);

    await fireEvent.press(screen.getByText('Mention people'));
    await fireEvent.changeText(screen.getByLabelText('Search conversation members to mention'), 'Ana');
    await fireEvent.press(screen.getByText(colleague.displayName));
    expect(screen.getByLabelText('Selected: Ana Torres')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Remove mention: Ana Torres'));
    await fireEvent.changeText(screen.getByLabelText('Search conversation members to mention'), 'no matching member');
    expect(screen.getByText('No matching conversation members.')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Search conversation members to mention'), 'Morgan');
    await fireEvent.press(screen.getByText(candidate.displayName));
    await fireEvent.press(screen.getByText('Close mentions'));
    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'Please inspect the valve.');
    await fireEvent.press(screen.getByLabelText('chat.send'));

    expect(onSend).toHaveBeenCalledWith('Please inspect the valve.', undefined, [mentionCandidate.id]);
  });

  test('reviews a translation decision and files a separate quality report', async () => {
    const message = translatedMessage();
    mockWorkspace.reviewTranslationCorrection = jest.fn(async () => false);
    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);

    await fireEvent.press(screen.getByText('chat.reviewCorrection'));
    await fireEvent.changeText(screen.getByLabelText('chat.reviewNote'), 'Terminology requires a documented decision.');
    await fireEvent.press(screen.getByLabelText('chat.requestChanges'));
    await fireEvent.press(screen.getByLabelText('chat.rejectCorrection'));
    await fireEvent.press(screen.getByLabelText('chat.approveCorrection'));
    await waitFor(() => {
      expect(mockWorkspace.reviewTranslationCorrection).toHaveBeenCalledWith(
        message,
        'changes_requested',
        'Terminology requires a documented decision.',
      );
      expect(mockWorkspace.reviewTranslationCorrection).toHaveBeenCalledWith(
        message,
        'rejected',
        'Terminology requires a documented decision.',
      );
      expect(mockWorkspace.reviewTranslationCorrection).toHaveBeenCalledWith(
        message,
        'approved',
        'Terminology requires a documented decision.',
      );
    });

    await fireEvent.press(screen.getAllByLabelText('common.closeDialog').at(-1)!);
    await fireEvent.press(screen.getByText('chat.reportTranslationError'));
    await fireEvent.press(screen.getByLabelText('quality.categoryTerminology'));
    await fireEvent.changeText(screen.getByLabelText('quality.whatWentWrong'), 'The selected site term changes the operational meaning.');
    await fireEvent.press(screen.getAllByRole('checkbox')[0]);
    await fireEvent.press(screen.getByLabelText('quality.submitReport'));
    await waitFor(() => expect(mockWorkspace.reportAiOutputError).toHaveBeenCalledWith({
      outputKind: 'translation',
      translationId: message.translation.id,
      summaryId: null,
      category: 'terminology',
      details: 'The selected site term changes the operational meaning.',
      highConsequence: true,
      qualityUseConsent: false,
    }));
  });

  test('requests translation only from eligible language-detection states', async () => {
    const failed = incomingMessage({
      id: 'message-failed-translation',
      serverId: 'message-failed-translation',
      originalText: 'La bomba necesita servicio.',
      attachment: undefined,
      languageDetection: {
        state: 'completed', detectedLanguage: 'es', confidence: 0.97,
        method: 'server-detector', detectedAt: '2026-08-04T18:02:00.000Z',
      },
    });
    const notRequested = incomingMessage({
      id: 'message-not-requested',
      serverId: 'message-not-requested',
      originalText: 'Revise la presión.',
      attachment: undefined,
      translation: undefined,
      translationState: 'not_requested',
      languageDetection: {
        state: 'completed', detectedLanguage: 'es', confidence: 0.95,
        method: 'server-detector', detectedAt: '2026-08-04T18:03:00.000Z',
      },
    });
    await render(<ConversationPane conversation={conversation()} messages={[failed, notRequested]} onSend={noopSend} />);
    await fireEvent.press(screen.getByText('chat.showProvenance'));
    expect(screen.getByText(/failed-source-hash/)).toBeTruthy();
    await fireEvent.press(screen.getByText('chat.retryTranslation'));
    await fireEvent.press(screen.getByText('chat.requestTranslation'));
    expect(mockWorkspace.requestTranslation).toHaveBeenCalledWith(failed);
    expect(mockWorkspace.requestTranslation).toHaveBeenCalledWith(notRequested);
  });

  test('handles secure attachment retry, cancellation, progress, cleanup, and download states', async () => {
    const attachmentMessage = (
      id: string,
      state: 'preparing' | 'uploading' | 'failed' | 'cancelled' | 'uploaded',
      status: 'clean' | 'scanning' | 'quarantined' | 'blocked',
      progress: number,
    ) => incomingMessage({
      id,
      serverId: id,
      originalText: `Attachment state ${state}`,
      attachment: {
        id: `attachment-${id}`,
        kind: 'document',
        name: `${id}.pdf`,
        sizeLabel: '24 KB',
        status,
        mimeType: 'application/pdf',
        byteSize: 24576,
        downloadUrl: status === 'clean' ? 'https://example.invalid/signed' : null,
        transfer: { state, progress },
      },
      deliveryState: state === 'failed' ? 'failed' : 'pending',
      failureReason: state === 'failed' ? 'Upload transport failed.' : undefined,
    });
    const preparing = attachmentMessage('preparing-file', 'preparing', 'scanning', -0.2);
    const uploading = attachmentMessage('uploading-file', 'uploading', 'scanning', 1.4);
    const failed = attachmentMessage('failed-file', 'failed', 'scanning', 0.4);
    const cancelled = attachmentMessage('cancelled-file', 'cancelled', 'scanning', 0.2);
    const uploaded = attachmentMessage('uploaded-file', 'uploaded', 'clean', 1);

    await render(<ConversationPane
      conversation={conversation()}
      messages={[preparing, uploading, failed, cancelled, uploaded]}
      onSend={noopSend}
    />);
    expect(screen.getByLabelText('chat.attachmentProgress 0%')).toBeTruthy();
    expect(screen.getByLabelText('chat.attachmentProgress 100%')).toBeTruthy();
    await fireEvent.press(screen.getByText('chat.attachmentRetry'));
    const cancelActions = screen.getAllByText('chat.attachmentCancel');
    await fireEvent.press(cancelActions[0]);
    await fireEvent.press(screen.getByText('chat.attachmentFinishCleanup'));
    await fireEvent.press(screen.getByLabelText('uploaded-file.pdf, chat.fileClean'));

    expect(mockWorkspace.retryAttachmentUpload).toHaveBeenCalledWith(failed);
    expect(mockWorkspace.cancelAttachmentUpload).toHaveBeenCalledWith(preparing);
    expect(mockWorkspace.cancelAttachmentUpload).toHaveBeenCalledWith(cancelled);
    expect(mockWorkspace.downloadAttachment).toHaveBeenCalledWith(uploaded);
  });

  test('uses camera and document picker results as secure attachment inputs', async () => {
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.addAttachment'));
    await fireEvent.press(screen.getByLabelText('chat.camera'));
    await waitFor(() => expect(screen.getByText('controlled-camera.jpg')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('chat.imageOptimized'));
    await fireEvent.press(screen.getByLabelText('chat.chooseFile'));
    await waitFor(() => expect(screen.getByText('controlled-document.pdf')).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText('chat.captionOptional'), 'Controlled document evidence');
    await fireEvent.press(screen.getByLabelText('chat.sendSecurely'));

    await waitFor(() => expect(mockWorkspace.sendAttachment).toHaveBeenCalledWith(
      'conversation-main',
      expect.objectContaining({
        uri: 'file://controlled-document.pdf',
        name: 'controlled-document.pdf',
        mimeType: 'application/pdf',
        imageMode: 'optimized',
      }),
      'Controlled document evidence',
    ));
  });

  test('reconciles scroll position, unread placement, focused sources, and appended messages', async () => {
    const initial = translatedMessage({
      id: 'message-initial', serverId: 'message-initial', originalText: 'Initial controlled message.',
    });
    mockWorkspace.unreadDividerIds = { 'conversation-main': 'message-initial' };
    const view = await render(<ConversationPane
      conversation={conversation({ lastReadMessageId: null })}
      focusMessageId="message-initial"
      messages={[initial]}
      onSend={noopSend}
    />);
    const root = view.root!;
    const scroll = root.queryAll((node) => typeof node.props.onScroll === 'function')[0];
    await fireEvent(scroll, 'scroll', {
      nativeEvent: {
        contentOffset: { y: 40 },
        contentSize: { height: 1000 },
        layoutMeasurement: { height: 300 },
      },
    });
    const layoutNodes = root.queryAll((node) => typeof node.props.onLayout === 'function');
    for (const [index, node] of layoutNodes.entries()) {
      // Real layout events are persistable; RN's KeyboardAvoidingView (now a
      // descendant of the measured wrapper) calls event.persist() first.
      await fireEvent(node, 'layout', { persist() {}, nativeEvent: { layout: { y: 120 + index * 40, height: 40 } } });
    }
    await fireEvent(scroll, 'contentSizeChange', 320, 1000);

    const appended = incomingMessage({
      id: 'message-appended', serverId: 'message-appended', originalText: 'New controlled message.',
    });
    await view.rerender(<ConversationPane
      conversation={conversation({ lastReadMessageId: null })}
      focusMessageId="message-initial"
      messages={[initial, appended]}
      onSend={noopSend}
    />);
    await waitFor(() => expect(screen.getByText(/1 chat\.newMessages/)).toBeTruthy());
    await fireEvent.press(screen.getByText(/1 chat\.newMessages/));
    expect(mockWorkspace.markConversationRead).toHaveBeenCalledWith('conversation-main');

    await fireEvent(scroll, 'scroll', {
      nativeEvent: {
        contentOffset: { y: 700 },
        contentSize: { height: 1000 },
        layoutMeasurement: { height: 300 },
      },
    });
    await fireEvent(scroll, 'contentSizeChange', 320, 1200);
  });

  test('closes successful message mutations and preserves explicit cancellation behavior', async () => {
    const message = translatedMessage();
    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);

    const openActions = async () => fireEvent(screen.getByText(message.originalText), 'longPress');
    await openActions();
    await fireEvent.press(screen.getByLabelText('chat.unpin'));
    await openActions();
    await fireEvent.changeText(screen.getByLabelText('chat.editMessage'), 'Successful edit');
    await fireEvent.press(screen.getByLabelText('chat.saveEdit'));
    await openActions();
    await fireEvent.press(screen.getByLabelText('chat.deleteEveryone'));
    await openActions();
    await fireEvent.press(screen.getByLabelText('Maintenance'));
    await fireEvent.press(screen.getByLabelText('chat.forwardConfirm'));
    await openActions();
    await fireEvent.changeText(screen.getByLabelText('chat.actionTitle'), 'Successful action');
    await fireEvent.press(screen.getByLabelText('chat.actionCreate'));
    await openActions();
    await fireEvent.press(screen.getByLabelText('chat.deleteMe'));
    await openActions();
    await fireEvent.press(screen.getByLabelText('chat.reply'));
    await fireEvent.press(screen.getByLabelText('chat.cancelReply'));
    await openActions();
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog').at(-1)!);

    expect(mockWorkspace.setMessagePinned).toHaveBeenCalledWith(message, false);
    expect(mockWorkspace.editMessage).toHaveBeenCalledWith(message, 'Successful edit');
    expect(mockWorkspace.deleteMessage).toHaveBeenCalledWith(message);
    expect(mockWorkspace.forwardMessage).toHaveBeenCalledWith(message, 'conversation-target');
    expect(mockWorkspace.proposeAction).toHaveBeenCalledWith(message, 'Successful action', '');
    expect(mockWorkspace.hideMessageForMe).toHaveBeenCalledWith(message);
  });

  test('closes a successful consented incoming-message report', async () => {
    const message = incomingMessage({ attachment: undefined });
    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);
    await fireEvent(screen.getByText(message.originalText), 'longPress');
    await fireEvent.changeText(screen.getByLabelText('chat.reportDetails'), 'Controlled privacy report.');
    await fireEvent.press(screen.getByText('I understand and consent to this limited disclosure.'));
    await fireEvent.press(screen.getByLabelText('chat.submitReport'));
    await waitFor(() => expect(mockWorkspace.reportMessage).toHaveBeenCalled());
    expect(screen.queryByText('chat.actionsTitle')).toBeNull();
  });

  test('renders system, receipt, detection, translation, and priority branch variants', async () => {
    const systemTypes = [
      'conversation.posting.admins_only',
      'conversation.posting.all_members',
      'conversation.join.approved',
      'conversation.created',
      'conversation.member.added',
      'conversation.member.removed',
      'conversation.member.role_changed',
      'conversation.avatar.changed',
      'conversation.avatar.removed',
    ];
    const systemMessages = systemTypes.map((eventType, index) => incomingMessage({
      id: `system-${index}`,
      serverId: `system-${index}`,
      originalText: '',
      attachment: undefined,
      systemEvent: {
        eventType,
        targetUserId: index === 2 ? 'unknown-company-member' : index > 3 && index < 7 ? colleague.id : null,
      },
    }));
    const approvedCorrection = translatedMessage({
      id: 'approved-translation',
      serverId: 'approved-translation',
      isOwn: false,
      originalText: 'Approved correction source.',
      priority: 'normal',
      deliveryState: 'delivered',
      receipt: {
        scope: 'aggregate', recipientCount: 2, deliveredCount: 2,
        visibleReadCount: 0, visibleReadEligibleCount: 0,
      },
      translation: {
        ...translatedMessage().translation,
        id: 'translation-reported',
        reviewedByUserId: colleague.id,
        reviewedAt: '2026-08-04T18:10:00.000Z',
        policyState: 'stale',
        correction: {
          ...translatedMessage().translation.correction,
          status: 'approved',
          reviewedByUserId: colleague.id,
          reviewedAt: '2026-08-04T18:09:00.000Z',
        },
      },
    });
    mockWorkspace.aiOutputErrorReports = [{ translationId: 'translation-reported' }];
    const variantMessages = [
      approvedCorrection,
      incomingMessage({
        id: 'detection-failed', serverId: 'detection-failed', originalText: 'Detection failed input.',
        attachment: undefined, translation: undefined, translationState: 'not_requested',
        languageDetection: { state: 'failed', detectedLanguage: null, confidence: null, method: null, detectedAt: null },
        priority: 'normal', deliveryState: 'sent',
      }),
      incomingMessage({
        id: 'detection-pending', serverId: 'detection-pending', originalText: 'Detection pending input.',
        attachment: undefined, translation: undefined, translationState: 'not_requested',
        languageDetection: { state: 'pending', detectedLanguage: null, confidence: null, method: null, detectedAt: null },
        priority: 'important', deliveryState: 'delivered',
      }),
      incomingMessage({
        id: 'no-detection', serverId: 'no-detection', originalText: 'No detection metadata.',
        attachment: undefined, translation: undefined, translationState: 'not_requested',
        languageDetection: undefined, priority: 'normal', deliveryState: 'sent',
      }),
      incomingMessage({
        id: 'blocked-translation', serverId: 'blocked-translation', originalText: 'Blocked translation source.',
        attachment: undefined, translationState: 'blocked',
        languageDetection: {
          state: 'completed', detectedLanguage: 'es', confidence: 0.9,
          method: 'server-detector', detectedAt: '2026-08-04T18:11:00.000Z',
        },
        translation: {
          ...incomingMessage().translation,
          id: 'translation-blocked', status: 'blocked', failureCode: 'policy_blocked', policyVersion: 4,
        },
      }),
      translatedMessage({
        id: 'own-pending', serverId: 'own-pending', originalText: 'Own pending receipt.',
        translatedText: null, translation: undefined, translationState: 'not_requested',
        languageDetection: undefined, receipt: undefined, deliveryState: 'pending', priority: 'normal',
        mentionUserIds: [], edited: false, pinned: false, forwarded: false, replyTo: undefined, reactions: [],
      }),
      translatedMessage({
        id: 'own-failed', serverId: 'own-failed', originalText: 'Own failed receipt.',
        translatedText: null, translation: undefined, translationState: 'not_requested',
        languageDetection: undefined, receipt: undefined, deliveryState: 'failed', priority: 'normal',
        mentionUserIds: [], edited: false, pinned: false, forwarded: false, replyTo: undefined, reactions: [],
      }),
    ];
    await render(<ConversationPane
      conversation={conversation({ kind: 'announcement', unreadCount: 0, lastReadMessageId: null })}
      messages={[...systemMessages, ...variantMessages]}
      onSend={noopSend}
    />);

    expect(screen.getByText('chat.systemPostingAdminsOnly')).toBeTruthy();
    expect(screen.getByText('chat.systemPostingAllMembers')).toBeTruthy();
    expect(screen.getByText(/chat\.systemJoinApproved/)).toBeTruthy();
    expect(screen.getByText('chat.systemConversationCreated')).toBeTruthy();
    expect(screen.getByText('chat.systemAvatarChanged')).toBeTruthy();
    expect(screen.getByText('chat.systemAvatarRemoved')).toBeTruthy();
    expect(screen.getByText('quality.reportSubmitted')).toBeTruthy();
    expect(screen.getByText('chat.translationPolicyStale')).toBeTruthy();
    expect(screen.getByText(/chat\.reviewedCorrection/)).toBeTruthy();
    expect(screen.getByText('chat.languageDetectionFailed')).toBeTruthy();
    expect(screen.getByText('chat.languageDetectionPending')).toBeTruthy();
    expect(screen.getByText(/policy_blocked/)).toBeTruthy();
  });

  test('renders direct and incident authorization boundaries including read-only posting', async () => {
    const onBack = jest.fn();
    const direct = conversation({
      kind: 'direct', directParticipantId: colleague.id, presence: 'online', memberIds: [self.id, colleague.id],
      priority: 'normal', translationMode: 'off', translationPair: undefined, unreadCount: 0,
      lastReadMessageId: null, departure: undefined, canManage: false, canManageConversation: false,
    });
    const directView = await render(<ConversationPane conversation={direct} messages={[]} onSend={noopSend} mobile onBack={onBack} />);
    await fireEvent.press(screen.getByLabelText('chat.back'));
    expect(onBack).toHaveBeenCalled();
    expect(screen.queryByText('chat.translationBoundary')).toBeNull();
    await directView.unmount();

    const incidentView = await render(<ConversationPane conversation={conversation({
      kind: 'incident', incidentSeverity: 'critical', incidentClassification: 'Electrical fire',
      isReadOnly: false, priority: 'normal', departure: undefined,
    })} messages={[]} onSend={noopSend} />);
    expect(screen.getByText(/chat\.incidentActive · critical/)).toBeTruthy();
    expect(screen.getByText('Electrical fire')).toBeTruthy();
    await incidentView.unmount();

    await render(<ConversationPane conversation={conversation({
      kind: 'incident', incidentSeverity: undefined, closureReason: 'Resolved by incident commander.',
      isReadOnly: true, canPost: false, priority: 'normal', departure: undefined,
    })} messages={[]} onSend={noopSend} />);
    expect(screen.getByText(/chat\.incidentClosed/)).toBeTruthy();
    expect(screen.getByText('Resolved by incident commander.')).toBeTruthy();
    expect(screen.getByText('chat.incidentReadOnly')).toBeTruthy();
    expect(screen.queryByLabelText('chat.message')).toBeNull();
  });

  test('executes management-only controls against scoped member profiles', async () => {
    const management = conversation({
      managementOnly: true,
      canManage: true,
      canManageConversation: true,
      visibility: 'unit',
      memberIds: ['scoped-member-id'],
      memberRoles: { 'scoped-member-id': 'member' },
      memberProfiles: [{
        id: 'scoped-member-id', displayName: 'Scoped Member', initials: 'SM', avatarColor: '#884422',
      }],
      departure: undefined,
      description: undefined,
    });
    mockWorkspace.updateConversation = jest.fn<(..._args: unknown[]) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await render(<ConversationPane conversation={management} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.managementOnlyOpen'));
    expect(screen.getByText('Scoped Member')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.adminRole · Scoped Member'));
    await fireEvent.changeText(screen.getByLabelText('chat.name'), 'Scoped Management');
    await fireEvent.changeText(screen.getByLabelText('chat.description'), 'Scoped profile management only.');
    await fireEvent.press(screen.getByLabelText('chat.saveConversation'));
    await fireEvent.press(screen.getByLabelText('chat.unitVisible'));
    await fireEvent.changeText(screen.getByLabelText('chat.changeReason'), 'Keep the unit scope.');
    await fireEvent.press(screen.getByLabelText('chat.saveAccessControls'));
    await fireEvent.press(screen.getByLabelText('chat.archiveConversation'));

    await waitFor(() => {
      expect(mockWorkspace.updateConversationMemberRole).toHaveBeenCalledWith(
        management.id,
        'scoped-member-id',
        'member',
        'admin',
      );
      expect(mockWorkspace.updateConversation).toHaveBeenCalledWith(management.id, {
        name: 'Scoped Management',
        description: 'Scoped profile management only.',
      });
      expect(mockWorkspace.updateConversation).toHaveBeenCalledWith(management.id, { isArchived: true });
    });
  });

  test('closes active incidents and handles rejected join requests with authoritative reasons', async () => {
    const incident = conversation({
      kind: 'incident', priority: 'normal', incidentSeverity: 'high', incidentClassification: 'Equipment fire',
      departure: undefined, isReadOnly: false,
    });
    const incidentView = await render(<ConversationPane conversation={incident} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    await fireEvent.changeText(screen.getByLabelText('chat.closeReason'), 'Incident commander verified containment.');
    await fireEvent.press(screen.getByLabelText('chat.closeIncidentConfirm'));
    await waitFor(() => expect(mockWorkspace.closeIncident).toHaveBeenCalledWith(
      incident.id,
      'Incident commander verified containment.',
    ));
    await incidentView.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.decideConversationJoinRequest = jest.fn(async () => true);
    mockWorkspace.loadConversationJoinRequests = jest.fn(async () => [{
      requestId: 'join-reject', conversationId: 'conversation-main', requesterUserId: candidate.id,
      requesterDisplayName: null, status: 'pending', version: 3,
      requestedAt: '2026-08-04T18:00:00.000Z', expiresAt: '2026-08-05T18:00:00.000Z',
    }]);
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    await fireEvent.press(screen.getByLabelText('chat.reviewJoinRequests'));
    await waitFor(() => expect(screen.getByText('chat.companyMember')).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText('chat.decisionReason'), 'Assignment scope is not active.');
    await fireEvent.press(screen.getByLabelText('chat.rejectJoin'));
    expect(mockWorkspace.decideConversationJoinRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'join-reject', version: 3 }),
      'rejected',
      'Assignment scope is not active.',
    );
  });

  test('renders timed mute, policy-managed membership, delegated controls, and departure restrictions', async () => {
    const muted = conversation({
      favorite: true,
      mutedUntil: '2099-08-04T19:00:00.000Z',
      notificationLevel: 'mentions',
      translationMode: 'off',
      historyDisclosure: {
        policy: 'since_join', visibleFrom: '2026-08-04T17:00:00.000Z', labelKey: 'conversation.history.since_join',
      },
      departure: { eligible: false, restriction: 'policy_managed', requiresOwnershipTransfer: false },
    });
    const mutedView = await render(<ConversationPane conversation={muted} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    await fireEvent.press(screen.getByLabelText('chat.removeFavorite'));
    await fireEvent.press(screen.getByLabelText('Remove timed mute'));
    expect(screen.getByText(/You cannot leave this company-managed audience yourself/)).toBeTruthy();
    expect(mockWorkspace.updateConversationPreferences).toHaveBeenCalledWith(muted.id, {
      notificationLevel: 'mentions', mutedUntil: null,
    });
    await mutedView.unmount();

    mockWorkspace = buildWorkspace();
    const policyManaged = conversation({
      policyManaged: true, canManage: false, canManageConversation: true,
      departure: { eligible: false, restriction: 'policy_managed', requiresOwnershipTransfer: false },
    });
    const policyView = await render(<ConversationPane conversation={policyManaged} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    expect(screen.getByText('chat.policyManagedMembers')).toBeTruthy();
    expect(screen.queryByLabelText('chat.saveAccessControls')).toBeNull();
    await policyView.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.addConversationMember = jest.fn(async () => true);
    const delegated = conversation({ canManage: false, canManageConversation: true, myRole: 'admin', departure: undefined });
    await render(<ConversationPane conversation={delegated} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    expect(screen.getByText('chat.delegatedMemberSecurity')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.removeMember Morgan Park'));
    await fireEvent.changeText(screen.getByLabelText('chat.memberSearchLabel'), 'morgan');
    await fireEvent(screen.getByLabelText('chat.memberSearchLabel'), 'submitEditing');
    await waitFor(() => expect(screen.getAllByText(candidate.displayName).length).toBeGreaterThan(0));
    await fireEvent.press(screen.getAllByText(candidate.displayName).at(-1)!);
    await fireEvent.press(screen.getByLabelText('chat.addSelectedMember'));
    await waitFor(() => expect(mockWorkspace.addConversationMember).toHaveBeenCalledWith(
      delegated.id,
      candidate.id,
      'member',
    ));
  });

  test('renders latest summary provenance and every operational-action lifecycle state', async () => {
    const latest = summary({
      id: 'summary-latest',
      versionNumber: 4,
      status: 'corrected',
      primaryTopic: '',
      summary: '',
      keyTopics: [],
      decisions: [],
      actionItems: [],
      ambiguities: [],
      policyState: 'stale',
      sourceLastMessageId: 'older-source',
      provenance: {
        processorType: 'manual', provider: null, model: null,
        organizationAiPolicyVersion: null, routePolicyVersion: null, providerRoute: null,
      },
      reviewedAt: null,
      reviewedByUserId: null,
      reviewNote: null,
    });
    mockWorkspace.summaries = [summary({ id: 'summary-old', versionNumber: 1 }), latest];
    mockWorkspace.aiOutputErrorReports = [{ summaryId: latest.id }];
    mockWorkspace.hasCapability = jest.fn(() => false);
    mockWorkspace.actions = [
      ...mockWorkspace.actions,
      {
        id: 'action-confirmed', conversationId: 'conversation-main', sourceMessageId: null,
        title: 'Confirmed inspection', details: null, status: 'confirmed', proposedByUserId: colleague.id,
        assigneeUserId: self.id, assigneeName: self.displayName, dueAt: null,
        createdAt: '2026-08-04T18:00:00.000Z', updatedAt: '2026-08-04T18:00:00.000Z',
      },
      {
        id: 'action-completed', conversationId: 'conversation-main', sourceMessageId: null,
        title: 'Completed inspection', details: null, status: 'completed', proposedByUserId: colleague.id,
        assigneeUserId: colleague.id, assigneeName: colleague.displayName, dueAt: null,
        createdAt: '2026-08-04T18:00:00.000Z', updatedAt: '2026-08-04T18:00:00.000Z',
      },
      {
        id: 'action-confirmed-other', conversationId: 'conversation-main', sourceMessageId: null,
        title: 'Other assignee confirmation', details: null, status: 'confirmed', proposedByUserId: colleague.id,
        assigneeUserId: colleague.id, assigneeName: colleague.displayName, dueAt: null,
        createdAt: '2026-08-04T18:00:00.000Z', updatedAt: '2026-08-04T18:00:00.000Z',
      },
      {
        id: 'action-progress-other', conversationId: 'conversation-main', sourceMessageId: null,
        title: 'Other assignee progress', details: null, status: 'in_progress', proposedByUserId: colleague.id,
        assigneeUserId: colleague.id, assigneeName: colleague.displayName, dueAt: null,
        createdAt: '2026-08-04T18:00:00.000Z', updatedAt: '2026-08-04T18:00:00.000Z',
      },
      {
        id: 'action-cancelled', conversationId: 'conversation-main', sourceMessageId: null,
        title: 'Cancelled inspection', details: null, status: 'cancelled', proposedByUserId: colleague.id,
        assigneeUserId: null, assigneeName: null, dueAt: null,
        createdAt: '2026-08-04T18:00:00.000Z', updatedAt: '2026-08-04T18:00:00.000Z',
      },
    ];
    await render(<ConversationPane
      conversation={conversation({ canManage: false })}
      messages={[translatedMessage()]}
      onSend={noopSend}
    />);
    await fireEvent.press(screen.getByText('chat.briefing'));
    expect(screen.getByText('chat.summaryPolicyStale')).toBeTruthy();
    expect(screen.getByText(/chat\.manualCorrection/)).toBeTruthy();
    expect(screen.getByText('quality.reportSubmitted')).toBeTruthy();
    expect(screen.getByText('Completed inspection')).toBeTruthy();
    expect(screen.getByText('Cancelled inspection')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.startAction'));
    await fireEvent.press(screen.getByLabelText('chat.cancelAction'));
    await fireEvent.press(screen.getByLabelText('chat.requestSummary'));
    expect(mockWorkspace.transitionAction).toHaveBeenCalledWith('action-confirmed', 'in_progress');
    expect(mockWorkspace.transitionAction).toHaveBeenCalledWith('action-progress', 'cancelled');
    expect(mockWorkspace.requestConversationSummary).toHaveBeenCalledWith('conversation-main', ['message-translated']);
  });

  test('supports rejecting reviews, closing summary dialogs, and shift-close schedules', async () => {
    mockWorkspace.reviewConversationSummary = jest.fn(async () => false);
    await render(<ConversationPane
      conversation={conversation()}
      messages={[translatedMessage()]}
      onSend={noopSend}
    />);
    await fireEvent.press(screen.getByText('chat.briefing'));

    await fireEvent.press(screen.getByLabelText('chat.correctSummary'));
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog').at(-1)!);
    await fireEvent.press(screen.getByLabelText('chat.reviewSummary'));
    await fireEvent.changeText(screen.getByLabelText('chat.reviewNote'), 'Source evidence is incomplete.');
    await fireEvent.press(screen.getByLabelText('chat.rejectSummary'));
    expect(mockWorkspace.reviewConversationSummary).toHaveBeenCalledWith(
      'summary-a', 'reject', 'Source evidence is incomplete.',
    );
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog').at(-1)!);

    await fireEvent.press(screen.getByLabelText('chat.summarySchedule'));
    await fireEvent.press(screen.getByLabelText('chat.summaryManual'));
    await fireEvent.press(screen.getByLabelText('chat.summaryShiftClose'));
    await fireEvent.press(screen.getByLabelText('chat.saveSummarySchedule'));
    await waitFor(() => expect(mockWorkspace.setConversationSummaryPolicy).toHaveBeenCalledWith(
      'conversation-main', 'shift_close', null,
    ));
  });

  test('routes queued and superseded summaries to the manual handoff workflow', async () => {
    mockWorkspace.summaries = [summary({ status: 'queued' })];
    const queued = await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByText('chat.briefing'));
    await fireEvent.press(screen.getByLabelText('chat.createManualHandoff'));
    expect(mockPush).toHaveBeenCalledWith('/handoffs');
    await queued.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.summaries = [summary({ status: 'superseded', failureCode: null })];
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByText('chat.briefing'));
    expect(screen.getByText('chat.summaryStaleBody')).toBeTruthy();
    expect(screen.queryByText(/chat\.failureCode/)).toBeNull();
  });

  test('renders own image-transfer and nullable translation-provenance branches', async () => {
    const ownAttachment = (
      id: string,
      state: 'preparing' | 'failed' | 'cancelled' | 'uploaded',
      status: 'clean' | 'scanning' | 'blocked' | 'quarantined',
    ) => translatedMessage({
      id,
      serverId: id,
      clientMessageId: `client-${id}`,
      originalText: `Own attachment ${state}`,
      translatedText: null,
      translation: undefined,
      translationState: 'not_requested',
      languageDetection: undefined,
      priority: 'normal',
      mentionUserIds: [],
      edited: false,
      pinned: false,
      forwarded: false,
      replyTo: undefined,
      reactions: [],
      attachment: {
        id: `attachment-${id}`, kind: 'image', name: `${id}.jpg`, sizeLabel: '12 KB',
        status, mimeType: 'image/jpeg', byteSize: 12288,
        downloadUrl: status === 'clean' ? 'https://example.invalid/image' : null,
        transfer: { state, progress: 0.35 },
      },
      failureReason: undefined,
      deliveryState: state === 'failed' ? 'failed' : 'pending',
    });
    const nullableTranslation = translatedMessage({
      id: 'nullable-translation',
      serverId: 'nullable-translation',
      originalText: 'Nullable translation provenance.',
      isOwn: true,
      priority: 'normal',
      deliveryState: 'sent',
      receipt: {
        scope: 'aggregate', recipientCount: 2, deliveredCount: 1,
        visibleReadCount: 0, visibleReadEligibleCount: 0,
      },
      languageDetection: {
        state: 'completed', detectedLanguage: 'en', confidence: null, method: null,
        detectedAt: '2026-08-04T18:00:00.000Z',
      },
      translation: {
        ...translatedMessage().translation,
        id: 'nullable-translation-record', provider: null, model: null, policyVersion: null,
        reviewedByUserId: null, reviewedAt: '2026-08-04T18:12:00.000Z',
        correction: {
          ...translatedMessage().translation.correction,
          status: 'approved', reviewedByUserId: null, reviewedAt: null,
        },
      },
    });
    await render(<ConversationPane
      conversation={conversation()}
      messages={[
        ownAttachment('own-preparing', 'preparing', 'scanning'),
        ownAttachment('own-failed', 'failed', 'blocked'),
        ownAttachment('own-cancelled', 'cancelled', 'quarantined'),
        ownAttachment('own-uploaded', 'uploaded', 'clean'),
        nullableTranslation,
      ]}
      onSend={noopSend}
    />);
    expect(screen.getByLabelText('own-uploaded.jpg, chat.fileClean')).toBeTruthy();
    expect(screen.getByText('chat.attachmentFailureBody')).toBeTruthy();
    await fireEvent.press(screen.getByText('chat.showProvenance'));
    expect(screen.getByText(/chat\.notAvailable \/ chat\.notAvailable/)).toBeTruthy();
    expect(screen.getByText(/chat\.humanReviewed/)).toBeTruthy();
    expect(screen.getByLabelText('1/2 chat.receiptDelivered · chat.receiptReadPrivate')).toBeTruthy();
  });

  test('covers initial bottom positioning, prepend anchors, and authoritative focus loading', async () => {
    mockWorkspace.unreadDividerIds = {};
    mockWorkspace.loadOlderMessages = jest.fn<(..._args: unknown[]) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const initial = translatedMessage({
      id: 'bottom-initial', serverId: 'bottom-initial', originalText: 'Bottom initial message.',
    });
    const view = await render(<ConversationPane
      conversation={conversation({ lastReadMessageId: undefined, unreadCount: undefined })}
      messages={[initial]}
      onSend={noopSend}
    />);
    const scroll = view.root!.queryAll((node) => typeof node.props.onScroll === 'function')[0];
    await fireEvent(scroll, 'contentSizeChange', 320, 1000);
    await waitFor(() => expect(mockWorkspace.markConversationRead).toHaveBeenCalledWith('conversation-main'));
    await fireEvent(scroll, 'scroll', {
      nativeEvent: {
        contentOffset: { y: 60 }, contentSize: { height: 1000 }, layoutMeasurement: { height: 300 },
      },
    });
    await fireEvent.press(screen.getByText('chat.loadOlder'));
    await fireEvent.press(screen.getByText('chat.loadOlder'));
    await fireEvent(scroll, 'contentSizeChange', 320, 1200);

    const ownTail = translatedMessage({
      id: 'bottom-own-tail', serverId: 'bottom-own-tail', originalText: 'Own appended tail.',
    });
    await view.rerender(<ConversationPane
      conversation={conversation({ lastReadMessageId: undefined, unreadCount: undefined })}
      messages={[initial, ownTail]}
      onSend={noopSend}
    />);
    await fireEvent(scroll, 'contentSizeChange', 320, 1300);
    expect(mockWorkspace.loadOlderMessages).toHaveBeenNthCalledWith(1, 'conversation-main');
    expect(mockWorkspace.loadOlderMessages).toHaveBeenNthCalledWith(2, 'conversation-main');
    await view.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.ensureMessageLoaded = jest.fn(async () => true);
    await render(<ConversationPane
      conversation={conversation()}
      focusMessageId="authoritative-loadable-message"
      messages={[]}
      onSend={noopSend}
    />);
    await waitFor(() => expect(mockWorkspace.ensureMessageLoaded).toHaveBeenCalledWith(
      'conversation-main', 'authoritative-loadable-message',
    ));
  });

  test('fails closed for queued, deleted, attachment, and translation-disabled message actions', async () => {
    const queued = translatedMessage({
      id: 'queued-client-message', serverId: undefined, clientMessageId: 'queued-client-message',
      originalText: 'Queued client-only message.', pinned: false,
    });
    const queuedView = await render(<ConversationPane conversation={conversation()} messages={[queued]} onSend={noopSend} />);
    await fireEvent(screen.getByText(queued.originalText), 'longPress');
    expect(screen.getByText('chat.queuedEdit')).toBeTruthy();
    expect(screen.queryByLabelText('chat.saveEdit')).toBeNull();
    await fireEvent.press(screen.getByLabelText('chat.pin'));
    await queuedView.unmount();

    mockWorkspace = buildWorkspace();
    const deleted = translatedMessage({
      id: 'deleted-message', serverId: 'deleted-message', originalText: 'Deleted canonical marker.',
      deleted: true, pinned: false,
    });
    const deletedView = await render(<ConversationPane conversation={conversation()} messages={[deleted]} onSend={noopSend} />);
    await fireEvent(screen.getByText(deleted.originalText), 'longPress');
    expect(screen.queryByLabelText('chat.saveEdit')).toBeNull();
    expect(screen.queryByLabelText('chat.actionCreate')).toBeNull();
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog').at(-1)!);
    await deletedView.unmount();

    mockWorkspace = buildWorkspace();
    const withAttachment = incomingMessage();
    const attachmentView = await render(<ConversationPane conversation={conversation()} messages={[withAttachment]} onSend={noopSend} />);
    await fireEvent(screen.getByText(withAttachment.originalText), 'longPress');
    expect(screen.getByText('chat.attachmentForwardUnavailable')).toBeTruthy();
    await attachmentView.unmount();

    mockWorkspace = buildWorkspace();
    const translationDisabled = conversation({ translationMode: 'off', translationPair: undefined });
    mockWorkspace.conversations[0] = translationDisabled;
    await render(<ConversationPane
      conversation={translationDisabled}
      messages={[translatedMessage({ mentionUserIds: [self.id, 'unknown-member-id'] })]}
      onSend={noopSend}
    />);
    expect(screen.getByText('Lock the north gate at 18:00.')).toBeTruthy();
    expect(screen.queryByText('Cierre la puerta norte a las 18:00.')).toBeNull();
    expect(screen.getByLabelText('Mentioned: you, member')).toBeTruthy();
  });

  test('covers denied picker permissions, cancelled selections, and retryable upload refusal', async () => {
    mockWorkspace.sendAttachment = jest.fn(async () => false);
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await fireEvent(screen.getByLabelText('chat.message'), 'submitEditing');
    expect(mockWorkspace.sendAttachment).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText('chat.addAttachment'));

    mockLibraryPermission.mockImplementationOnce(async () => ({ granted: false }));
    await fireEvent.press(screen.getByLabelText('chat.photoLibrary'));
    mockCameraPermission.mockImplementationOnce(async () => ({ granted: false }));
    await fireEvent.press(screen.getByLabelText('chat.camera'));
    mockImageLibrary.mockImplementationOnce(async () => ({ canceled: true, assets: [] }));
    await fireEvent.press(screen.getByLabelText('chat.photoLibrary'));
    mockCamera.mockImplementationOnce(async () => ({ canceled: true, assets: [] }));
    await fireEvent.press(screen.getByLabelText('chat.camera'));
    mockDocumentPicker.mockImplementationOnce(async () => ({ canceled: true, assets: [] }));
    await fireEvent.press(screen.getByLabelText('chat.chooseFile'));
    expect(screen.queryByLabelText('chat.imagePreview')).toBeNull();

    await fireEvent.press(screen.getByLabelText('chat.chooseFile'));
    await waitFor(() => expect(screen.getByText('controlled-document.pdf')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('chat.sendSecurely'));
    expect(mockWorkspace.sendAttachment).toHaveBeenCalled();
    expect(screen.getByText('controlled-document.pdf')).toBeTruthy();
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog').at(-1)!);
  });

  test('renders preference-busy and attachment-upload-busy guards', async () => {
    mockWorkspace.actionBusy = 'conversation-preferences';
    const defaults = conversation({
      postingMode: undefined,
      configuredJoinPolicy: undefined,
      visibility: undefined,
      memberIds: undefined,
      memberRoles: undefined,
      participantCount: undefined,
      notificationLevel: undefined,
      muted: true,
      mutedUntil: undefined,
      translationMode: undefined,
      historyDisclosure: undefined,
      departure: {
        eligible: true, restriction: null, requiresOwnershipTransfer: true,
        historyPreserved: true, futureAccessRevoked: true,
      },
    });
    const controls = await render(<ConversationPane conversation={defaults} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    expect(screen.getByText('No active replacement is available. Add an active member before leaving.')).toBeTruthy();
    expect(screen.getByLabelText('All activity').props.accessibilityState.disabled).toBeFalsy();
    await controls.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.actionBusy = 'attachment-upload';
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.addAttachment'));
    expect(screen.getByLabelText('chat.uploading')).toBeTruthy();
  });

  test('closes successful normal conversation save, archive, group report, and departure', async () => {
    const current = conversation();
    await render(<ConversationPane conversation={current} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    await fireEvent.changeText(screen.getByLabelText('chat.name'), 'Saved Operations');
    await fireEvent.changeText(screen.getByLabelText('chat.description'), '   ');
    await fireEvent.press(screen.getByLabelText('chat.saveConversation'));
    await waitFor(() => expect(mockWorkspace.updateConversation).toHaveBeenCalledWith(current.id, {
      name: 'Saved Operations', description: null,
    }));

    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    await fireEvent.press(screen.getByLabelText('chat.archiveConversation'));
    await waitFor(() => expect(mockWorkspace.updateConversation).toHaveBeenCalledWith(current.id, { isArchived: true }));

    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    await fireEvent.press(screen.getByLabelText('chat.reportPrivacy'));
    await fireEvent.changeText(screen.getByLabelText('chat.reportDetails'), 'Scoped group privacy report.');
    await fireEvent.press(screen.getByText('I understand and consent to this limited disclosure.'));
    await fireEvent.press(screen.getByLabelText('chat.submitReport'));
    await waitFor(() => expect(mockWorkspace.reportGroup).toHaveBeenCalled());

    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    await fireEvent.press(screen.getAllByText(colleague.displayName).at(-1)!);
    await fireEvent.press(screen.getByText('I understand that history is preserved and my future access ends.'));
    await fireEvent.press(screen.getByLabelText('Leave group'));
    await waitFor(() => expect(mockWorkspace.leaveConversation).toHaveBeenCalledWith(current.id, colleague.id));
  });

  test('covers successful and refused translation review and quality-report outcomes', async () => {
    const message = translatedMessage();
    mockWorkspace.reviewTranslationCorrection = jest.fn<(..._args: unknown[]) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockWorkspace.reportAiOutputError = jest.fn(async () => false);
    mockWorkspace.proposeTranslationCorrection = jest.fn(async () => false);
    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);

    for (const [action, note] of [
      ['chat.approveCorrection', 'Approved exact correction.'],
      ['chat.requestChanges', 'Request documented changes.'],
      ['chat.rejectCorrection', 'Reject unsafe correction.'],
    ] as const) {
      await fireEvent.press(screen.getByText('chat.reviewCorrection'));
      await fireEvent.changeText(screen.getByLabelText('chat.reviewNote'), note);
      await fireEvent.press(screen.getByLabelText(action));
    }
    await fireEvent.press(screen.getByText('chat.proposeCorrection'));
    await fireEvent.changeText(screen.getByLabelText('chat.correctedTranslation'), 'A distinct controlled correction.');
    await fireEvent.press(screen.getByLabelText('chat.submitCorrection'));
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog').at(-1)!);
    await fireEvent.press(screen.getByText('chat.reportTranslationError'));
    await fireEvent.changeText(screen.getByLabelText('quality.whatWentWrong'), 'Controlled report refusal.');
    await fireEvent.press(screen.getByLabelText('quality.submitReport'));

    expect(mockWorkspace.reviewTranslationCorrection).toHaveBeenCalledTimes(3);
    expect(mockWorkspace.proposeTranslationCorrection).toHaveBeenCalled();
    expect(mockWorkspace.reportAiOutputError).toHaveBeenCalled();
    expect(screen.getAllByText('chat.reportTranslationError').length).toBeGreaterThan(0);
  });

  test('covers nullable summary output, absent organization, avatar refusal, and non-authorized controls', async () => {
    mockWorkspace.organizationId = null;
    mockWorkspace.summaries = [summary({
      outputFingerprint: null,
      reviewedAt: '2026-08-04T18:20:00.000Z',
      reviewedByUserId: null,
      reviewNote: null,
      primaryTopic: '',
    })];
    const summaryView = await render(<ConversationPane
      conversation={conversation({ canManage: false })}
      messages={[translatedMessage()]}
      onSend={noopSend}
    />);
    await fireEvent.press(screen.getByText('chat.briefing'));
    expect(screen.getByText(/chat\.notAvailable · 2026-08-04T18:20:00.000Z/)).toBeTruthy();
    expect(screen.queryByLabelText('chat.reportSummaryError')).toBeNull();
    await summaryView.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.conversationAvatarUrls = {};
    mockWorkspace.uploadConversationAvatar = jest.fn(async () => false);
    mockWorkspace.queryConversationMemberCandidates = jest.fn(async () => null);
    mockWorkspace.decideConversationJoinRequest = jest.fn(async () => false);
    mockWorkspace.loadConversationJoinRequests = jest.fn(async () => [{
      requestId: 'join-stays', conversationId: 'conversation-main', requesterUserId: candidate.id,
      requesterDisplayName: candidate.displayName, status: 'pending', version: 1,
      requestedAt: '2026-08-04T18:00:00.000Z', expiresAt: '2026-08-05T18:00:00.000Z',
    }]);
    const noTransfer = conversation({
      avatarPath: undefined,
      departure: {
        eligible: true, restriction: null, requiresOwnershipTransfer: false,
        historyPreserved: true, futureAccessRevoked: true,
      },
    });
    await render(<ConversationPane conversation={noTransfer} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    expect(screen.queryByLabelText('group.avatarSelected')).toBeNull();
    mockLibraryPermission.mockImplementationOnce(async () => ({ granted: false }));
    await fireEvent.press(screen.getByLabelText('group.chooseAvatar'));
    mockImageLibrary.mockImplementationOnce(async () => ({ canceled: true, assets: [] }));
    await fireEvent.press(screen.getByLabelText('group.chooseAvatar'));
    await fireEvent.press(screen.getByLabelText('group.chooseAvatar'));
    await waitFor(() => expect(screen.getByLabelText('group.avatarSelected')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('group.saveAvatar'));
    expect(screen.getByLabelText('group.avatarSelected')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('chat.memberSearchAction'));
    await waitFor(() => expect(screen.getByText('chat.memberSearchEmpty')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('chat.reviewJoinRequests'));
    await waitFor(() => expect(screen.getByLabelText('chat.approveJoin')).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText('chat.decisionReason'), 'Keep pending for verification.');
    await fireEvent.press(screen.getByLabelText('chat.approveJoin'));
    await fireEvent.press(screen.getByLabelText('chat.rejectJoin'));
    expect(screen.getByLabelText('chat.approveJoin')).toBeTruthy();

    await fireEvent.press(screen.getByText('I understand that history is preserved and my future access ends.'));
    await fireEvent.press(screen.getByLabelText('Leave group'));
    expect(mockWorkspace.leaveConversation).toHaveBeenCalledWith(noTransfer.id, undefined);
  });

  test('renders a group with no management authority or departure controls', async () => {
    const restricted = conversation({
      canManage: false,
      canManageConversation: false,
      myRole: 'member',
      departure: undefined,
      memberRoles: undefined,
    });
    await render(<ConversationPane conversation={restricted} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    expect(screen.queryByText('chat.memberRoleSecurity')).toBeNull();
    expect(screen.queryByText('chat.delegatedMemberSecurity')).toBeNull();
    expect(screen.queryByText('Leave this group')).toBeNull();
  });

  test('shows the translation boundary from message state without a configured pair', async () => {
    const automatic = conversation({ translationPair: undefined, translationMode: 'automatic', priority: 'safety' });
    mockWorkspace.conversations[0] = automatic;
    const message = translatedMessage({
      translation: {
        ...translatedMessage().translation,
        correction: { ...translatedMessage().translation.correction, status: 'rejected' },
      },
    });
    await render(<ConversationPane conversation={automatic} messages={[message]} onSend={noopSend} />);
    expect(screen.getByText('chat.translationBoundary')).toBeTruthy();
    expect(screen.queryByText('chat.correctionPendingReview')).toBeNull();
    await fireEvent.press(screen.getByText('chat.openNotice'));
    expect(mockPush).toHaveBeenCalledWith('/updates');
  });
});

const PERSONAL_REALM_ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';

function directRequestConversation(overrides: Record<string, unknown> = {}) {
  return conversation({
    id: 'conversation-request',
    kind: 'direct',
    directParticipantId: colleague.id,
    priority: 'normal',
    translationPair: undefined,
    translationMode: 'off',
    memberIds: [self.id, colleague.id],
    ...overrides,
  });
}

function counterpart(overrides: Record<string, unknown> = {}) {
  return { ...colleague, ...overrides };
}

describe('personal realm message-request thread states', () => {
  test('shows the incoming request banner, hides the composer, and wires accept and decline', async () => {
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    mockWorkspace.people = [
      self,
      counterpart({ connectionState: 'pending', connectionRequestDirection: 'incoming' }),
      candidate,
    ];
    mockWorkspace.respondConnection = successfulAction();
    await render(
      <ConversationPane
        conversation={directRequestConversation()}
        messages={[]}
        onSend={noopSend}
        mobile
      />,
    );

    expect(screen.getByText('chat.messageRequestIncoming')).toBeTruthy();
    expect(screen.getByText('chat.messageRequestIncomingBody')).toBeTruthy();
    expect(screen.queryByText('chat.messageRequestPending')).toBeNull();
    // The composer stays hidden while the counterpart's request is pending.
    expect(screen.queryByLabelText('chat.message')).toBeNull();
    expect(screen.queryByLabelText('chat.send')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'people.accept' }));
    expect(mockWorkspace.respondConnection).toHaveBeenNthCalledWith(1, colleague.id, 'accepted');
    await fireEvent.press(screen.getByRole('button', { name: 'people.decline' }));
    expect(mockWorkspace.respondConnection).toHaveBeenNthCalledWith(2, colleague.id, 'declined');
  });

  test('shows the passive pending banner with an enabled composer for the requester on desktop', async () => {
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    mockWorkspace.people = [
      self,
      counterpart({ connectionState: 'pending', connectionRequestDirection: 'outgoing' }),
      candidate,
    ];
    const onSend = jest.fn(async () => undefined);
    await render(
      <ConversationPane
        conversation={directRequestConversation()}
        messages={[]}
        onSend={onSend}
      />,
    );

    expect(screen.getByText('chat.messageRequestPending')).toBeTruthy();
    expect(screen.queryByText('chat.messageRequestIncoming')).toBeNull();
    // The requester can still post; the server enforces the 3-message cap.
    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'Second request message');
    await fireEvent.press(screen.getByLabelText('chat.send'));
    expect(onSend).toHaveBeenCalledWith('Second request message', undefined, []);
  });

  test.each([
    ['mobile', true],
    ['desktop', false],
  ])('keeps the requester composer enabled on %s when the pair is not yet permitted and surfaces the cap error', async (_layout, mobile) => {
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    mockWorkspace.people = [
      self,
      counterpart({ connectionState: 'pending', connectionRequestDirection: 'outgoing' }),
      candidate,
    ];
    mockWorkspace.actionError = 'errors.messageRequestCap';
    const onSend = jest.fn(async () => undefined);
    await render(
      <ConversationPane
        conversation={directRequestConversation({ canPost: false })}
        messages={[]}
        onSend={onSend}
        mobile={mobile}
      />,
    );

    expect(screen.getByText('chat.messageRequestPending')).toBeTruthy();
    // The bootstrap's can_post=false for a pending pair must never read as an
    // admins-only group restriction, and must not lock the requester out.
    expect(screen.queryByText('chat.adminsOnlyPosting')).toBeNull();
    expect(screen.queryByText('chat.directPostingUnavailable')).toBeNull();
    expect(screen.getAllByText('errors.messageRequestCap').length).toBeGreaterThan(0);
    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'Third request message');
    await fireEvent.press(screen.getByLabelText('chat.send'));
    expect(onSend).toHaveBeenCalledWith('Third request message', undefined, []);
  });

  test('locks a not-permitted direct thread with direct copy while groups keep the admins-only copy', async () => {
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    mockWorkspace.people = [self, counterpart({ connectionState: 'available' }), candidate];
    const onSend = jest.fn(async () => undefined);
    const view = await render(
      <ConversationPane
        conversation={directRequestConversation({ canPost: false })}
        messages={[]}
        onSend={onSend}
      />,
    );
    expect(screen.getByText('chat.directPostingUnavailable')).toBeTruthy();
    expect(screen.queryByText('chat.adminsOnlyPosting')).toBeNull();
    expect(screen.queryByText('chat.messageRequestPending')).toBeNull();
    // A locked composer offers no input at all.
    expect(screen.queryByLabelText('chat.message')).toBeNull();
    expect(screen.queryByLabelText('chat.send')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();

    await view.rerender(
      <ConversationPane conversation={conversation({ canPost: false })} messages={[]} onSend={onSend} />,
    );
    expect(screen.getByText('chat.adminsOnlyPosting')).toBeTruthy();
    expect(screen.queryByText('chat.directPostingUnavailable')).toBeNull();

    // Read-only threads keep the incident copy regardless of kind.
    await view.rerender(
      <ConversationPane
        conversation={directRequestConversation({ canPost: false, isReadOnly: true })}
        messages={[]}
        onSend={onSend}
      />,
    );
    expect(screen.getByText('chat.incidentReadOnly')).toBeTruthy();
    expect(screen.queryByText('chat.directPostingUnavailable')).toBeNull();
  });

  test('polls the workspace every 8 seconds while a request is pending and stops once it resolves or unmounts', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const pollCalls = () => setIntervalSpy.mock.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call[1] === 8_000);
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    mockWorkspace.people = [
      self,
      counterpart({ connectionState: 'pending', connectionRequestDirection: 'incoming' }),
      candidate,
    ];
    const view = await render(
      <ConversationPane conversation={directRequestConversation()} messages={[]} onSend={noopSend} />,
    );
    expect(pollCalls()).toHaveLength(1);
    expect(mockWorkspace.refresh).not.toHaveBeenCalled();
    const [{ call: firstPoll, index: firstIndex }] = pollCalls();
    (firstPoll[0] as () => void)();
    (firstPoll[0] as () => void)();
    expect(mockWorkspace.refresh).toHaveBeenCalledTimes(2);

    // Acceptance clears the poll without a restart.
    mockWorkspace.people = [self, counterpart({ connectionState: 'connected' }), candidate];
    await view.rerender(
      <ConversationPane conversation={directRequestConversation()} messages={[]} onSend={noopSend} />,
    );
    expect(clearIntervalSpy).toHaveBeenCalledWith(setIntervalSpy.mock.results[firstIndex]!.value);
    expect(pollCalls()).toHaveLength(1);

    // A requester's own pending thread polls too, and unmounting clears it.
    mockWorkspace.people = [
      self,
      counterpart({ connectionState: 'pending', connectionRequestDirection: 'outgoing' }),
      candidate,
    ];
    await view.rerender(
      <ConversationPane conversation={directRequestConversation()} messages={[]} onSend={noopSend} />,
    );
    expect(pollCalls()).toHaveLength(2);
    const { index: secondIndex } = pollCalls()[1]!;
    await view.unmount();
    expect(clearIntervalSpy).toHaveBeenCalledWith(setIntervalSpy.mock.results[secondIndex]!.value);

    // A settled thread never starts a poll.
    mockWorkspace.people = [self, counterpart({ connectionState: 'connected' }), candidate];
    await render(
      <ConversationPane conversation={directRequestConversation()} messages={[]} onSend={noopSend} />,
    );
    expect(pollCalls()).toHaveLength(2);
  });

  test('hides the manual translation request in automatic consumer threads but keeps retry on failed rows', async () => {
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    const failed = incomingMessage({
      id: 'message-failed-translation',
      serverId: 'message-failed-translation',
      originalText: 'La bomba necesita servicio.',
      attachment: undefined,
      languageDetection: {
        state: 'completed', detectedLanguage: 'es', confidence: 0.97,
        method: 'server-detector', detectedAt: '2026-08-04T18:02:00.000Z',
      },
    });
    const notRequested = incomingMessage({
      id: 'message-not-requested',
      serverId: 'message-not-requested',
      originalText: 'Revise la presión.',
      attachment: undefined,
      translation: undefined,
      translationState: 'not_requested',
      languageDetection: {
        state: 'completed', detectedLanguage: 'es', confidence: 0.95,
        method: 'server-detector', detectedAt: '2026-08-04T18:03:00.000Z',
      },
    });
    const automatic = conversation({ translationMode: 'automatic' });
    mockWorkspace.conversations[0] = automatic;
    const view = await render(
      <ConversationPane conversation={automatic} messages={[failed, notRequested]} onSend={noopSend} />,
    );
    // The pipeline translates automatically; only a failed row offers a retry.
    expect(screen.queryByText('chat.requestTranslation')).toBeNull();
    await fireEvent.press(screen.getByText('chat.retryTranslation'));
    expect(mockWorkspace.requestTranslation).toHaveBeenCalledTimes(1);
    expect(mockWorkspace.requestTranslation).toHaveBeenCalledWith(failed);

    // An unset mode is automatic as well.
    const implicit = conversation({ translationMode: undefined });
    mockWorkspace.conversations[0] = implicit;
    await view.rerender(
      <ConversationPane conversation={implicit} messages={[failed, notRequested]} onSend={noopSend} />,
    );
    expect(screen.queryByText('chat.requestTranslation')).toBeNull();
    expect(screen.getByText('chat.retryTranslation')).toBeTruthy();

    // Workspace organizations keep the manual request.
    mockWorkspace.organizationId = 'organization-a';
    await view.rerender(
      <ConversationPane conversation={automatic} messages={[failed, notRequested]} onSend={noopSend} />,
    );
    expect(screen.getByText('chat.requestTranslation')).toBeTruthy();
    expect(screen.getByText('chat.retryTranslation')).toBeTruthy();
  });

  test('keeps workspace organizations and settled personal-realm threads free of request banners', async () => {
    mockWorkspace.people = [
      self,
      counterpart({ connectionState: 'pending', connectionRequestDirection: 'incoming' }),
      candidate,
    ];
    // A workspace org keeps ordinary composer behavior with identical people state.
    const first = await render(
      <ConversationPane conversation={directRequestConversation()} messages={[]} onSend={noopSend} />,
    );
    expect(screen.queryByText('chat.messageRequestIncoming')).toBeNull();
    expect(screen.getByLabelText('chat.message')).toBeTruthy();
    await first.unmount();

    // A personal-realm group is not a request thread.
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    const second = await render(
      <ConversationPane
        conversation={directRequestConversation({ kind: 'group', directParticipantId: undefined })}
        messages={[]}
        onSend={noopSend}
      />,
    );
    expect(screen.queryByText('chat.messageRequestIncoming')).toBeNull();
    expect(screen.getByLabelText('chat.message')).toBeTruthy();
    await second.unmount();

    // A settled (connected) direct thread shows no banner either.
    mockWorkspace.people = [self, counterpart({ connectionState: 'connected' }), candidate];
    await render(
      <ConversationPane conversation={directRequestConversation()} messages={[]} onSend={noopSend} />,
    );
    expect(screen.queryByText('chat.messageRequestIncoming')).toBeNull();
    expect(screen.queryByText('chat.messageRequestPending')).toBeNull();
    expect(screen.getByLabelText('chat.message')).toBeTruthy();
  });

  test('captures camera video with defaulted naming and sends it through the secure pipeline', async () => {
    mockCamera.mockImplementationOnce(async () => ({
      canceled: false,
      assets: [{
        uri: 'file://controlled-camera-video.mov',
        fileSize: 30 * 1024 * 1024,
        width: 1920,
        height: 1080,
        type: 'video',
      }],
    }));
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.addAttachment'));
    await fireEvent.press(screen.getByLabelText('chat.camera'));
    await waitFor(() => expect(screen.getByText(/^video-\d+\.mp4$/)).toBeTruthy());
    expect(mockCamera).toHaveBeenCalledWith({ mediaTypes: ['images', 'videos'], quality: 0.9 });

    // Video selections surface the 100 MB video cap and no image-quality choice.
    expect(screen.getAllByText(/chat\.videoFileLimit/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByLabelText('chat.imageOriginal')).toBeNull();

    await fireEvent.press(screen.getByLabelText('chat.sendSecurely'));
    await waitFor(() => expect(mockWorkspace.sendAttachment).toHaveBeenCalledWith(
      'conversation-main',
      expect.objectContaining({
        uri: 'file://controlled-camera-video.mov',
        name: expect.stringMatching(/^video-\d+\.mp4$/),
        mimeType: 'video/mp4',
        imageMode: 'optimized',
      }),
      '',
    ));
  });

  test('selects a quicktime library video and preserves the provided metadata', async () => {
    mockImageLibrary.mockImplementationOnce(async () => ({
      canceled: false,
      assets: [{
        uri: 'file://library-video.mov',
        fileName: 'inspection.mov',
        mimeType: 'video/quicktime',
        fileSize: 12 * 1024 * 1024,
        width: 1280,
        height: 720,
      }],
    }));
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.addAttachment'));
    await fireEvent.press(screen.getByLabelText('chat.photoLibrary'));
    await waitFor(() => expect(screen.getByText('inspection.mov')).toBeTruthy());
    expect(mockImageLibrary).toHaveBeenCalledWith({ mediaTypes: ['images', 'videos'], quality: 0.9 });

    await fireEvent.press(screen.getByLabelText('chat.sendSecurely'));
    await waitFor(() => expect(mockWorkspace.sendAttachment).toHaveBeenCalledWith(
      'conversation-main',
      expect.objectContaining({
        uri: 'file://library-video.mov',
        name: 'inspection.mov',
        mimeType: 'video/quicktime',
      }),
      '',
    ));
  });

  test('renders received video attachments with the standard download card on both breakpoints', async () => {
    const videoMessage = incomingMessage({
      id: 'message-video',
      serverId: 'message-video',
      originalText: 'Video evidence attached.',
      attachment: {
        id: 'attachment-video',
        kind: 'document',
        name: 'line-two.mp4',
        sizeLabel: '48 MB',
        status: 'clean',
        mimeType: 'video/mp4',
        byteSize: 48 * 1024 * 1024,
        downloadUrl: 'https://example.invalid/signed-video',
      },
    });
    const mobileView = await render(
      <ConversationPane conversation={conversation()} messages={[videoMessage]} onSend={noopSend} mobile />,
    );
    await fireEvent.press(screen.getByLabelText('line-two.mp4, chat.fileClean'));
    await waitFor(() => expect(mockWorkspace.downloadAttachment).toHaveBeenCalledWith(videoMessage));
    await mobileView.unmount();

    mockWorkspace = buildWorkspace();
    await render(<ConversationPane conversation={conversation()} messages={[videoMessage]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('line-two.mp4, chat.fileClean'));
    await waitFor(() => expect(mockWorkspace.downloadAttachment).toHaveBeenCalledWith(videoMessage));
  });
});

describe('personal realm conversation copy', () => {
  test('uses consumer wording for the empty pane, the fresh-thread badge, and system-event fallbacks', async () => {
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    const empty = await render(<ConversationPane messages={[]} onSend={noopSend} />);
    expect(screen.getByText('chat.choose')).toBeTruthy();
    expect(screen.getByText('chat.chooseBodyConsumer')).toBeTruthy();
    expect(screen.queryByText('chat.chooseBody')).toBeNull();
    await empty.unmount();

    const fresh = await render(
      <ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />,
    );
    expect(screen.getByText('chat.privateConsumer')).toBeTruthy();
    expect(screen.queryByText('chat.private')).toBeNull();
    await fresh.unmount();

    await render(
      <ConversationPane
        conversation={conversation()}
        messages={[incomingMessage({
          id: 'system-consumer',
          serverId: 'system-consumer',
          originalText: '',
          attachment: undefined,
          systemEvent: { eventType: 'conversation.member.added', targetUserId: 'unknown-consumer' },
        })]}
        onSend={noopSend}
      />,
    );
    expect(screen.getByText('chat.companyMemberConsumer chat.systemMemberAdded')).toBeTruthy();
    expect(screen.queryByText(/chat\.companyMember chat\./)).toBeNull();
  });
});

describe('personal realm message actions', () => {
  test('hides the workplace-only create-action-item affordance', async () => {
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    const message = translatedMessage();
    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);
    await fireEvent(screen.getByText(message.originalText), 'longPress');

    expect(screen.queryByText('chat.createAction')).toBeNull();
    expect(screen.queryByLabelText('chat.actionTitle')).toBeNull();
    expect(screen.queryByLabelText('chat.actionDetails')).toBeNull();
    expect(screen.queryByLabelText('chat.actionCreate')).toBeNull();
    // Every consumer-relevant action stays available.
    expect(screen.getByLabelText('chat.reply')).toBeTruthy();
    expect(screen.getByLabelText('chat.deleteMe')).toBeTruthy();
  });

  test('keeps the create-action-item affordance for workspace organizations', async () => {
    const message = translatedMessage();
    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);
    await fireEvent(screen.getByText(message.originalText), 'longPress');

    expect(screen.getByText('chat.createAction')).toBeTruthy();
    expect(screen.getByLabelText('chat.actionCreate')).toBeTruthy();
  });
});

describe('personal realm group member management', () => {
  function personalGroup(overrides: Record<string, unknown> = {}) {
    return conversation({
      organizationId: PERSONAL_REALM_ORGANIZATION_ID,
      kind: 'group',
      memberIds: [self.id, colleague.id, candidate.id],
      ...overrides,
    });
  }

  test('lets the owner promote, demote, and remove other members but never touch their own row', async () => {
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    const owner = personalGroup({
      myRole: 'owner',
      canManage: true,
      canManageConversation: true,
      memberRoles: { [self.id]: 'owner', [colleague.id]: 'admin', [candidate.id]: 'member' },
    });
    await render(<ConversationPane conversation={owner} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));

    // Role chips for every other member, in every direction (promote and demote).
    expect(screen.getByLabelText(`chat.memberRole · ${colleague.displayName}`)).toBeTruthy();
    expect(screen.getByLabelText(`chat.adminRole · ${colleague.displayName}`)).toBeTruthy();
    expect(screen.getByLabelText(`chat.ownerRole · ${colleague.displayName}`)).toBeTruthy();
    expect(screen.getByLabelText(`chat.adminRole · ${candidate.displayName}`)).toBeTruthy();

    // Remove is available for the admin and the member, never for the owner's own row.
    expect(screen.getByLabelText(`chat.removeMember ${colleague.displayName}`)).toBeTruthy();
    expect(screen.getByLabelText(`chat.removeMember ${candidate.displayName}`)).toBeTruthy();
    expect(screen.queryByLabelText(`chat.removeMember ${self.displayName}`)).toBeNull();

    // Nobody, including the owner, has an affordance to change their own role.
    expect(screen.queryByLabelText(new RegExp(`Role · ${self.displayName}$`))).toBeNull();

    await fireEvent.press(screen.getByLabelText(`chat.memberRole · ${colleague.displayName}`));
    expect(mockWorkspace.updateConversationMemberRole).toHaveBeenCalledWith(
      owner.id,
      colleague.id,
      'admin',
      'member',
    );
    await fireEvent.press(screen.getByLabelText(`chat.removeMember ${candidate.displayName}`));
    expect(mockWorkspace.removeConversationMember).toHaveBeenCalledWith(owner.id, candidate.id);
  });

  test('lets an admin remove plain members but never touch the owner, other admins, or their own row', async () => {
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    const admin = personalGroup({
      myRole: 'admin',
      canManage: false,
      canManageConversation: true,
      memberRoles: { [self.id]: 'admin', [colleague.id]: 'owner', [candidate.id]: 'member' },
    });
    await render(<ConversationPane conversation={admin} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));

    // An admin never sees role controls at all — only the server-trusted
    // owner can promote or demote.
    expect(screen.queryByLabelText(new RegExp('^chat\\.(member|admin|owner)Role · '))).toBeNull();

    // Remove is available only for the plain member.
    expect(screen.getByLabelText(`chat.removeMember ${candidate.displayName}`)).toBeTruthy();
    expect(screen.queryByLabelText(`chat.removeMember ${colleague.displayName}`)).toBeNull();
    expect(screen.queryByLabelText(`chat.removeMember ${self.displayName}`)).toBeNull();

    await fireEvent.press(screen.getByLabelText(`chat.removeMember ${candidate.displayName}`));
    expect(mockWorkspace.removeConversationMember).toHaveBeenCalledWith(admin.id, candidate.id);
  });

  test('shows a plain member no management affordances at all', async () => {
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    const member = personalGroup({
      myRole: 'member',
      canManage: false,
      canManageConversation: false,
      memberRoles: { [self.id]: 'member', [colleague.id]: 'owner', [candidate.id]: 'admin' },
    });
    await render(<ConversationPane conversation={member} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));

    expect(screen.getAllByText(colleague.displayName).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(new RegExp('^chat\\.(member|admin|owner)Role · '))).toBeNull();
    expect(screen.queryByLabelText(/^chat\.removeMember /)).toBeNull();
    expect(screen.queryByText('chat.addMember')).toBeNull();
  });
  test('shows why an own text message was not sent, next to the Not sent label', async () => {
    const unsent = incomingMessage({
      id: 'message-unsent',
      serverId: null,
      senderId: self.id,
      senderName: self.displayName,
      isOwn: true,
      originalText: 'Unsent controlled text',
      sourceLanguage: 'en',
      translationState: 'queued',
      translation: undefined,
      languageDetection: undefined,
      attachment: undefined,
      deliveryState: 'failed',
      failureReason: 'This request already holds its 3 messages.',
      priority: 'normal',
      mentionUserIds: [],
    });
    await render(<ConversationPane
      conversation={conversation({ lastReadMessageId: null })}
      messages={[unsent]}
      onSend={noopSend}
    />);
    expect(screen.getByText('Unsent controlled text')).toBeTruthy();
    expect(screen.getByText('chat.failed · This request already holds its 3 messages.')).toBeTruthy();
  });
});
