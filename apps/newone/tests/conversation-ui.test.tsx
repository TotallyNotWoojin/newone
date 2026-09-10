import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { FlatList, Keyboard } from 'react-native';

import type { Message } from '@/domain/types';
import { ConversationDetails } from '@/features/chat/conversation-details';
import { ConversationList } from '@/features/chat/conversation-list';
import { ConversationPane, TRANSLATION_DELAYED_AFTER_MS } from '@/features/chat/conversation-pane';

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

jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache/' },
  File: function File() {},
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

const mockPreferences = { translatedOnly: false, showOwnTranslations: false, enterSends: true, notificationsPromptedAt: null as string | null };

jest.mock('@/state/device-preferences', () => ({
  useDevicePreferences: () => ({ preferences: mockPreferences, ready: true, setPreference: jest.fn() }),
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

type FiberLike = {
  elementType?: unknown;
  memoizedProps?: unknown;
  child?: FiberLike;
  sibling?: FiberLike;
  return?: FiberLike;
  stateNode?: { current?: FiberLike };
};

// The FlatList element itself, not the host scroll view it spreads its props
// onto (whose renderItem is FlatList's own per-render wrapper): walk the
// current fiber tree from the render root.
function timelineListProps(view: { root: unknown }): { renderItem: unknown; initialNumToRender: number } {
  let fiber = (view.root as { unstable_fiber?: FiberLike } | null)?.unstable_fiber;
  while (fiber?.return) fiber = fiber.return;
  const stack: (FiberLike | undefined)[] = [fiber?.stateNode?.current ?? fiber];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.elementType === FlatList) return node.memoizedProps as { renderItem: unknown; initialNumToRender: number };
    stack.push(node.sibling, node.child);
  }
  throw new Error('The timeline list is not rendered.');
}

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
    // Just sent, so editing and unsending are still inside their window.
    createdAt: new Date().toISOString(),
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

// Your own message as it really arrives: the translation on it is aimed at
// the other person's language, so the normal selection leaves the bubble
// with nothing but your original.
function outgoingTranslation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'translation-outgoing',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    sourceBodySha256: 'outgoing-source-hash',
    status: 'completed',
    translatedText: '18시에 북문을 잠그세요.',
    provider: 'openrouter',
    model: 'qwen/tested-model',
    confidence: 0.94,
    policyVersion: 4,
    policyState: 'current',
    reviewedByUserId: null,
    reviewedAt: null,
    failureCode: null,
    createdAt: '2026-08-04T18:00:00.000Z',
    updatedAt: '2026-08-04T18:00:01.000Z',
    correction: null,
    ...overrides,
  };
}

function ownMessage(overrides: Record<string, unknown> = {}) {
  return translatedMessage({
    translatedText: undefined,
    targetLanguage: undefined,
    translation: undefined,
    translationState: 'not_requested',
    outgoingTranslations: [outgoingTranslation()],
    ...overrides,
  });
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
    loadPinnedMessages: jest.fn(async (..._mockArgs: unknown[]) => [] as unknown[]),
    unpinMessage: successfulAction(),
    loadSharedMedia: jest.fn(async (..._mockArgs: unknown[]) => ({ items: [], cursor: null })),
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
  mockPreferences.translatedOnly = false;
  mockPreferences.showOwnTranslations = false;
  mockPreferences.enterSends = true;
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
      translatedMessage({ isOwn: false }),
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

    await fireEvent.press(screen.getByLabelText('chat.summarize'));
    expect(screen.getByText('Gate and valve safety')).toBeTruthy();
    expect(screen.getByText('The shift must secure the gate and inspect the valve.')).toBeTruthy();
    expect(screen.getByText('Inspect the valve')).toBeTruthy();
    expect(screen.queryByText(/chat\.sourceFingerprint|chat\.provenance|chat\.summaryBoundary/)).toBeNull();

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
    const message = translatedMessage({ isOwn: false });
    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={onSend} />);

    // The bubble is just the two texts; language details sit one long-press away.
    expect(screen.getByText('Cierre la puerta norte a las 18:00.')).toBeTruthy();
    expect(screen.queryByText(/chat\.originalUpper|chat\.machineTranslation|chat\.originalCanonical|chat\.detectedLanguage/)).toBeNull();
    await fireEvent(screen.getByText('Lock the north gate at 18:00.'), 'longPress');
    await fireEvent.press(screen.getByLabelText('chat.showProvenance'));
    expect(screen.getByText(/chat\.machineRoute/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.hideProvenance'));
    expect(screen.queryByText(/chat\.machineRoute/)).toBeNull();
    expect(screen.queryByText('chat.reportTranslationError')).toBeNull();

    await fireEvent.press(screen.getByLabelText('chat.proposeCorrection'));
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

  test('opening the attachment sheet puts the keyboard away so its Send button is reachable', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
    try {
      await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
      await fireEvent.press(screen.getByLabelText('chat.addAttachment'));
      expect(dismiss).toHaveBeenCalled();
      expect(screen.getByLabelText('chat.photoLibrary')).toBeTruthy();
    } finally {
      dismiss.mockRestore();
    }
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

    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);
    await fireEvent(screen.getByText(message.originalText), 'longPress');

    await fireEvent.press(screen.getByLabelText('chat.unpin'));
    await fireEvent.press(screen.getByLabelText('chat.react ❤️'));
    await fireEvent.changeText(screen.getByLabelText('chat.editMessage'), 'Updated canonical message');
    await fireEvent.press(screen.getByLabelText('chat.saveEdit'));
    await fireEvent.press(screen.getByLabelText('chat.deleteEveryone'));
    await fireEvent.press(screen.getByLabelText('chat.forward'));
    await fireEvent.press(screen.getByLabelText('Maintenance'));
    await fireEvent.press(screen.getByLabelText('chat.forwardConfirm'));
    await fireEvent.changeText(screen.getByLabelText('chat.actionTitle'), 'Verify gate lock');
    await fireEvent.changeText(screen.getByLabelText('chat.actionDetails'), 'Inspect the north gate at shift close.');
    await fireEvent.press(screen.getByLabelText('chat.actionCreate'));

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
      // "Delete for me" is gone from the sheet: a message you can see is a
      // message everyone in the chat can see.
      expect(screen.queryByLabelText('chat.deleteMe')).toBeNull();
      expect(mockWorkspace.hideMessageForMe).not.toHaveBeenCalled();
    });
  });

  test('keeps moderation-report entry points out of the message actions sheet', async () => {
    const message = incomingMessage({ attachment: undefined });
    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);
    await fireEvent(screen.getByText(message.originalText), 'longPress');
    expect(screen.getByText('chat.actionsTitle')).toBeTruthy();
    expect(screen.getByLabelText('chat.reply')).toBeTruthy();
    expect(screen.queryByText('chat.reportPrivately')).toBeNull();
    expect(screen.queryByLabelText('chat.reportThreat')).toBeNull();
    expect(screen.queryByLabelText('chat.reportDetails')).toBeNull();
    expect(screen.queryByLabelText('chat.submitReport')).toBeNull();
    expect(screen.queryByText('chat.actionsDescription')).toBeNull();
    expect(mockWorkspace.reportMessage).not.toHaveBeenCalled();
  });

  test('reviews, corrects, schedules, and reports a versioned conversation summary', async () => {
    const existingSummary = summary();
    await render(<ConversationPane
      conversation={conversation()}
      messages={[translatedMessage(), incomingMessage()]}
      onSend={noopSend}
    />);
    await fireEvent.press(screen.getByLabelText('chat.summarize'));

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
    await fireEvent.press(screen.getByLabelText('chat.summarize'));
    expect(screen.getByText('chat.summaryEmpty')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.summarizeAll'));
    expect(mockWorkspace.requestConversationSummary).toHaveBeenCalledWith('conversation-main', { kind: 'unread', subject: '' });
    await missing.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.summaries = [summary({ status: 'failed', failureCode: 'provider_unavailable' })];
    const failed = await render(<ConversationPane conversation={conversation()} messages={messages} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.summarize'));
    expect(screen.getByText(/provider_unavailable/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.createManualHandoff'));
    expect(mockPush).toHaveBeenCalledWith('/handoffs');
    await failed.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.summaries = [summary({ status: 'generating' })];
    const processing = await render(<ConversationPane conversation={conversation()} messages={messages} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.summarize'));
    expect(screen.getByText('chat.summaryGenerating')).toBeTruthy();
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
    await fireEvent.press(screen.getByLabelText('chat.summarize'));
    expect(screen.getByText('chat.summarySuperseded')).toBeTruthy();
    expect(screen.getByText('chat.summaryApproved')).toBeTruthy();
    expect(screen.queryByText('Controlled reviewer note.')).toBeNull();
  });

  test('exercises conversation security controls, scoped membership, and departure', async () => {
    const managedConversation = conversation({ avatarPath: 'organization-a/conversation-main/avatar.jpg' });
    mockWorkspace.conversations[0] = managedConversation;
    mockWorkspace.updateConversation = jest.fn(async () => false);
    mockWorkspace.leaveConversation = jest.fn(async () => false);
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
        username: 'casey_w',
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

    expect(screen.queryByText('chat.reportGroup')).toBeNull();
    expect(screen.queryByLabelText('chat.reportSpam')).toBeNull();

    await fireEvent.changeText(screen.getByLabelText('chat.name'), 'Controlled Operations');
    await fireEvent.changeText(screen.getByLabelText('chat.description'), 'Scoped operations coordination.');
    // v3.4: the record saves itself when the field is left; the Save button is gone.
    await fireEvent(screen.getByLabelText('chat.description'), 'blur');
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
    // v3.1: the candidate row shows the @handle under the name.
    expect(screen.getByText('@casey_w')).toBeTruthy();
    await fireEvent.press(screen.getByText('Casey Wright'));
    await fireEvent.press(screen.getAllByLabelText('chat.adminRole').at(-1)!);
    await fireEvent.press(screen.getByLabelText('chat.loadMoreMembers'));
    await waitFor(() => expect(screen.getByText('Riley Chen')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('chat.addSelectedMember'));

    await fireEvent.press(screen.getAllByText('Ana Torres').at(-1)!);
    await fireEvent.press(screen.getByText('I understand'));
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

    expect(screen.queryByText('Mention people')).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('chat.message'), '@');
    await fireEvent.press(screen.getByText('Mention people'));
    await fireEvent.changeText(screen.getByLabelText('Search people to mention'), 'Ana');
    await fireEvent.press(screen.getByText(colleague.displayName));
    expect(screen.getByLabelText('Selected: Ana Torres')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Remove mention: Ana Torres'));
    await fireEvent.changeText(screen.getByLabelText('Search people to mention'), 'no matching member');
    expect(screen.getByText('No one matches.')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Search people to mention'), 'Morgan');
    await fireEvent.press(screen.getByText(candidate.displayName));
    await fireEvent.press(screen.getByText('Close mentions'));
    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'Please inspect the valve.');
    await fireEvent.press(screen.getByLabelText('chat.send'));

    expect(onSend).toHaveBeenCalledWith('Please inspect the valve.', undefined, [mentionCandidate.id]);
  });

  test('reviews a translation decision from the actions sheet and offers no translation-error report', async () => {
    const message = translatedMessage();
    mockWorkspace.reviewTranslationCorrection = jest.fn(async () => false);
    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);

    await fireEvent(screen.getByText(message.originalText), 'longPress');
    expect(screen.queryByText('chat.reportTranslationError')).toBeNull();
    await fireEvent.press(screen.getByLabelText('chat.reviewCorrection'));
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
    expect(mockWorkspace.reportAiOutputError).not.toHaveBeenCalled();
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
    expect(screen.getByText('chat.translationUnavailable')).toBeTruthy();
    await fireEvent(screen.getByText('La bomba necesita servicio.'), 'longPress');
    await fireEvent.press(screen.getByLabelText('chat.showProvenance'));
    expect(screen.getByText(/failed-source-hash/)).toBeTruthy();
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog').at(-1)!);
    await fireEvent.press(screen.getByLabelText('chat.retryTranslation'));
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
    // Newest first: the oldest (preparing) upload is the last cancel control in the tree.
    const cancelActions = screen.getAllByText('chat.attachmentCancel');
    await fireEvent.press(cancelActions.at(-1)!);
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

  test('keeps the inverted timeline pinned to the newest message and counts arrivals while scrolled up', async () => {
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
    // Opening lands on the newest message, so what is on screen is read at once.
    await waitFor(() => expect(mockWorkspace.markConversationRead).toHaveBeenCalledWith('conversation-main'));
    expect(screen.getByText('chat.unreadMessages')).toBeTruthy();
    const list = view.root!.queryAll((node) => node.props.inverted === true && typeof node.props.onScroll === 'function')[0];
    // No anchor at all. The list is inverted, so a new message arrives at row
    // 0 - the bottom - and maintainVisibleContentPosition compensates for
    // anything inserted before its anchor, pushing the view off the message
    // that just arrived so the pane's jump has to drag it back. That is the
    // scroll that goes somewhere else and comes back. Older messages land at
    // the end of the rows, which an inverted list draws at the top, so nothing
    // needed anchoring in the first place.
    expect(list.props.maintainVisibleContentPosition).toBeUndefined();
    // The list is followed while the newest message is still settling, so a
    // jump made before a photo or a translation line has been measured does
    // not land short of it.
    expect(typeof list.props.onContentSizeChange).toBe('function');
    // One phone screen of compact bubbles mounts with the push transition; the rest fills in small batches.
    expect(list.props.initialNumToRender).toBeLessThanOrEqual(16);
    expect(list.props.maxToRenderPerBatch).toBeLessThanOrEqual(8);
    const renderItem = timelineListProps(view).renderItem;
    mockWorkspace.markConversationRead.mockClear();

    // Scrolled into history: an arrival shows the jump pill instead of moving the view.
    await fireEvent(list, 'scroll', {
      nativeEvent: { contentOffset: { y: 400 }, contentSize: { height: 1000 }, layoutMeasurement: { height: 300 } },
    });
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
    // Rows keep their renderer across pane re-renders, so arrivals and typing never re-render every bubble.
    expect(timelineListProps(view).renderItem).toBe(renderItem);
    expect(mockWorkspace.markConversationRead).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText(/1 chat\.newMessages/));
    expect(mockWorkspace.markConversationRead).toHaveBeenCalledWith('conversation-main');
    expect(screen.queryByText(/chat\.newMessages/)).toBeNull();

    // Offset 0 in an inverted list is the bottom: everything on screen is read.
    await fireEvent(list, 'scroll', {
      nativeEvent: { contentOffset: { y: 0 }, contentSize: { height: 1000 }, layoutMeasurement: { height: 300 } },
    });
    expect(mockWorkspace.markConversationRead).toHaveBeenCalledTimes(2);

    // An own send always returns to the newest message, so no pill appears.
    await fireEvent(list, 'scroll', {
      nativeEvent: { contentOffset: { y: 400 }, contentSize: { height: 1000 }, layoutMeasurement: { height: 300 } },
    });
    const ownTail = translatedMessage({
      id: 'message-own-tail', serverId: 'message-own-tail', originalText: 'Own appended tail.',
    });
    await view.rerender(<ConversationPane
      conversation={conversation({ lastReadMessageId: null })}
      messages={[initial, appended, ownTail]}
      onSend={noopSend}
    />);
    expect(screen.queryByText(/chat\.newMessages/)).toBeNull();
    expect(screen.getByText('Own appended tail.')).toBeTruthy();
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
    await fireEvent.press(screen.getByLabelText('chat.forward'));
    await fireEvent.press(screen.getByLabelText('Maintenance'));
    await fireEvent.press(screen.getByLabelText('chat.forwardConfirm'));
    await openActions();
    await fireEvent.changeText(screen.getByLabelText('chat.actionTitle'), 'Successful action');
    await fireEvent.press(screen.getByLabelText('chat.actionCreate'));
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
    expect(mockWorkspace.hideMessageForMe).not.toHaveBeenCalled();
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
    // The list mounts one screen of rows first (the rest fills in batches the
    // test renderer never triggers), so the system rows get their own render.
    const systemView = await render(<ConversationPane
      conversation={conversation({ kind: 'announcement', unreadCount: 0, lastReadMessageId: null })}
      messages={systemMessages}
      onSend={noopSend}
    />);
    expect(screen.getByText('chat.systemPostingAdminsOnly')).toBeTruthy();
    expect(screen.getByText('chat.systemPostingAllMembers')).toBeTruthy();
    expect(screen.getByText(/chat\.systemJoinApproved/)).toBeTruthy();
    expect(screen.getByText('chat.systemConversationCreated')).toBeTruthy();
    expect(screen.getByText('chat.systemAvatarChanged')).toBeTruthy();
    expect(screen.getByText('chat.systemAvatarRemoved')).toBeTruthy();
    await systemView.unmount();

    await render(<ConversationPane
      conversation={conversation({ kind: 'announcement', unreadCount: 0, lastReadMessageId: null })}
      messages={variantMessages}
      onSend={noopSend}
    />);
    // Bubbles carry no provenance; language details sit behind "Show details" in the sheet.
    expect(screen.queryByText('quality.reportSubmitted')).toBeNull();
    expect(screen.queryByText(/chat\.detectedLanguage|chat\.originalUpper|chat\.translationUpper/)).toBeNull();
    expect(screen.getByText('chat.translationUnavailable')).toBeTruthy();
    expect(screen.getByText('chat.requestTranslation')).toBeTruthy();
    const details = async (text: string, expected: RegExp) => {
      await fireEvent(screen.getByText(text), 'longPress');
      await fireEvent.press(screen.getByLabelText('chat.showProvenance'));
      expect(screen.getByText(expected)).toBeTruthy();
      await fireEvent.press(screen.getAllByLabelText('common.closeDialog').at(-1)!);
    };
    await details('Approved correction source.', /chat\.translationPolicyStale/);
    await details('Approved correction source.', /chat\.reviewedCorrection/);
    await details('Detection failed input.', /chat\.languageDetectionFailed/);
    await details('Detection pending input.', /chat\.languageDetectionPending/);
    await details('Blocked translation source.', /policy_blocked/);
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
    await fireEvent(screen.getByLabelText('chat.description'), 'blur');
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

  test('conversation settings open the chat\u2019s pins and its photos and files', async () => {
    const chat = conversation();
    const view = await render(<ConversationPane conversation={chat} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    expect(screen.getByLabelText('chat.pinnedTitle')).toBeTruthy();
    expect(screen.getByLabelText('chat.sharedMediaTitle')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('chat.pinnedTitle'));
    await waitFor(() => expect(mockWorkspace.loadPinnedMessages).toHaveBeenCalledWith(chat.id));
    // One sheet at a time: settings yield to the pins.
    expect(screen.queryByText('chat.controlsTitle')).toBeNull();
    await waitFor(() => expect(screen.getByText('chat.pinnedEmpty')).toBeTruthy());
    await view.unmount();

    mockWorkspace = buildWorkspace();
    const mediaView = await render(<ConversationPane conversation={chat} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    await fireEvent.press(screen.getByLabelText('chat.sharedMediaTitle'));
    await waitFor(() => expect(mockWorkspace.loadSharedMedia).toHaveBeenCalledWith(chat.id));
    await waitFor(() => expect(screen.getByText('chat.sharedMediaEmpty')).toBeTruthy());
    await mediaView.unmount();
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
    // v3.3: the shared line every chat can see says nothing about a company;
    // the workplace reason for this particular group still does.
    expect(screen.getByText(/Leaving isn’t available here/)).toBeTruthy();
    expect(screen.getByText(/A dynamic company policy manages this group/)).toBeTruthy();
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
    await fireEvent.press(screen.getByLabelText('chat.summarize'));
    // A corrected version with no text yet reads as "nothing summarized"; no provenance is shown.
    expect(screen.getByText('chat.summaryEmpty')).toBeTruthy();
    expect(screen.queryByText(/chat\.manualCorrection/)).toBeNull();
    expect(screen.queryByText(/chat\.sourceFingerprint/)).toBeNull();
    expect(screen.getByText('Completed inspection')).toBeTruthy();
    expect(screen.getByText('Cancelled inspection')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.startAction'));
    await fireEvent.press(screen.getByLabelText('chat.cancelAction'));
    // Every request names the reader's range; an earlier version never narrows it.
    await fireEvent.press(screen.getByLabelText('chat.summarizeAll'));
    expect(mockWorkspace.transitionAction).toHaveBeenCalledWith('action-confirmed', 'in_progress');
    expect(mockWorkspace.transitionAction).toHaveBeenCalledWith('action-progress', 'cancelled');
    expect(mockWorkspace.requestConversationSummary).toHaveBeenCalledWith('conversation-main', { kind: 'unread', subject: '' });
  });

  test('supports rejecting reviews, closing summary dialogs, and shift-close schedules', async () => {
    mockWorkspace.reviewConversationSummary = jest.fn(async () => false);
    await render(<ConversationPane
      conversation={conversation()}
      messages={[translatedMessage()]}
      onSend={noopSend}
    />);
    await fireEvent.press(screen.getByLabelText('chat.summarize'));

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

  test('shows queued summaries as generating and routes superseded ones to the manual handoff workflow', async () => {
    mockWorkspace.summaries = [summary({ status: 'queued' })];
    const queued = await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.summarize'));
    expect(screen.getByText('chat.summaryGenerating')).toBeTruthy();
    expect(screen.queryByLabelText('chat.createManualHandoff')).toBeNull();
    await queued.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.summaries = [summary({ status: 'superseded', failureCode: null })];
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.summarize'));
    expect(screen.getByText('chat.summarySuperseded')).toBeTruthy();
    expect(screen.queryByText(/chat\.failureCode/)).toBeNull();
    await fireEvent.press(screen.getByLabelText('chat.createManualHandoff'));
    expect(mockPush).toHaveBeenCalledWith('/handoffs');
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
    // The uploaded photo is just the photo; the others show their transfer state over a placeholder.
    expect(screen.getByLabelText('chat.imageOpen')).toBeTruthy();
    expect(screen.queryByLabelText('own-uploaded.jpg, chat.fileClean')).toBeNull();
    expect(screen.getByText('chat.attachmentFailureBody')).toBeTruthy();
    expect(screen.getByText('chat.attachmentCleanupBody')).toBeTruthy();
    expect(screen.getByLabelText('chat.attachmentProgress 35%')).toBeTruthy();
    expect(screen.getByLabelText('1/2 chat.receiptDelivered · chat.receiptReadPrivate')).toBeTruthy();
    await fireEvent(screen.getByText('Nullable translation provenance.'), 'longPress');
    await fireEvent.press(screen.getByLabelText('chat.showProvenance'));
    expect(screen.getByText(/chat\.notAvailable \/ chat\.notAvailable/)).toBeTruthy();
    expect(screen.getByText(/chat\.humanReviewed/)).toBeTruthy();
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

  test('tapping a reply quote goes to the message it answers', async () => {
    const scrollToIndex = jest
      .spyOn(FlatList.prototype, 'scrollToIndex')
      .mockImplementation(() => undefined);
    const quoted = incomingMessage({
      id: 'quoted-source', serverId: 'quoted-source', originalText: 'Please confirm the gate.',
      attachment: undefined,
    });
    const answer = translatedMessage({
      id: 'the-answer', serverId: 'the-answer', originalText: 'Confirmed, closing now.',
      replyTo: {
        messageId: 'quoted-source',
        senderName: colleague.displayName,
        preview: 'Please confirm the gate.',
      },
    });
    await render(
      <ConversationPane conversation={conversation()} messages={[quoted, answer]} onSend={noopSend} />,
    );

    const quote = screen.getByLabelText(`${colleague.displayName}: Please confirm the gate.`);
    expect(quote.props.accessibilityHint).toBe('chat.goToQuoted');
    await fireEvent.press(quote);

    // The message is already in memory, so nothing older has to be fetched.
    expect(mockWorkspace.ensureMessageLoaded).not.toHaveBeenCalled();
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ animated: true, viewPosition: 0.5 }),
    ));
  });

  test('a quote whose message has scrolled out of memory asks for the older page', async () => {
    mockWorkspace.ensureMessageLoaded = jest.fn(async () => true);
    const answer = translatedMessage({
      id: 'the-answer', serverId: 'the-answer', originalText: 'Confirmed, closing now.',
      replyTo: {
        messageId: 'far-older-message',
        senderName: colleague.displayName,
        preview: 'Please confirm the gate.',
      },
    });
    await render(<ConversationPane conversation={conversation()} messages={[answer]} onSend={noopSend} />);

    await fireEvent.press(screen.getByLabelText(`${colleague.displayName}: Please confirm the gate.`));
    await waitFor(() => expect(mockWorkspace.ensureMessageLoaded).toHaveBeenCalledWith(
      'conversation-main', 'far-older-message',
    ));
  });

  test('a quote from before reply ids were stored is not a control', async () => {
    const answer = translatedMessage({
      id: 'the-answer', serverId: 'the-answer', originalText: 'Confirmed, closing now.',
      replyTo: { senderName: colleague.displayName, preview: 'Please confirm the gate.' },
    });
    await render(<ConversationPane conversation={conversation()} messages={[answer]} onSend={noopSend} />);

    const quote = screen.getByLabelText(`${colleague.displayName}: Please confirm the gate.`);
    expect(quote.props.accessibilityHint).toBeUndefined();
    await fireEvent.press(quote);
    expect(mockWorkspace.ensureMessageLoaded).not.toHaveBeenCalled();
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
    expect(screen.queryByText('chat.attachmentForwardUnavailable')).toBeNull();
    await fireEvent.press(screen.getByLabelText('chat.forward'));
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
    expect(screen.getByText('Add someone else to the group before leaving.')).toBeTruthy();
    expect(screen.getByLabelText('All activity').props.accessibilityState.disabled).toBeFalsy();
    await controls.unmount();

    mockWorkspace = buildWorkspace();
    mockWorkspace.actionBusy = 'attachment-upload';
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.addAttachment'));
    expect(screen.getByLabelText('chat.uploading')).toBeTruthy();
  });

  test('closes successful normal conversation save, archive, and departure', async () => {
    const current = conversation();
    await render(<ConversationPane conversation={current} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    await fireEvent.changeText(screen.getByLabelText('chat.name'), 'Saved Operations');
    await fireEvent.changeText(screen.getByLabelText('chat.description'), '   ');
    await fireEvent(screen.getByLabelText('chat.description'), 'blur');
    await waitFor(() => expect(mockWorkspace.updateConversation).toHaveBeenCalledWith(current.id, {
      name: 'Saved Operations', description: null,
    }));

    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    await fireEvent.press(screen.getByLabelText('chat.archiveConversation'));
    await waitFor(() => expect(mockWorkspace.updateConversation).toHaveBeenCalledWith(current.id, { isArchived: true }));

    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    await fireEvent.press(screen.getAllByText(colleague.displayName).at(-1)!);
    await fireEvent.press(screen.getByText('I understand'));
    await fireEvent.press(screen.getByLabelText('Leave group'));
    await waitFor(() => expect(mockWorkspace.leaveConversation).toHaveBeenCalledWith(current.id, colleague.id));
  });

  test('covers successful and refused translation review and correction outcomes from the sheet', async () => {
    const message = translatedMessage();
    mockWorkspace.reviewTranslationCorrection = jest.fn<(..._args: unknown[]) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockWorkspace.proposeTranslationCorrection = jest.fn(async () => false);
    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);

    for (const [action, note] of [
      ['chat.approveCorrection', 'Approved exact correction.'],
      ['chat.requestChanges', 'Request documented changes.'],
      ['chat.rejectCorrection', 'Reject unsafe correction.'],
    ] as const) {
      await fireEvent(screen.getByText(message.originalText), 'longPress');
      await fireEvent.press(screen.getByLabelText('chat.reviewCorrection'));
      await fireEvent.changeText(screen.getByLabelText('chat.reviewNote'), note);
      await fireEvent.press(screen.getByLabelText(action));
      await waitFor(() => expect(screen.queryByLabelText('chat.reviewNote')).toBeNull());
    }
    await fireEvent(screen.getByText(message.originalText), 'longPress');
    await fireEvent.press(screen.getByLabelText('chat.proposeCorrection'));
    await fireEvent.changeText(screen.getByLabelText('chat.correctedTranslation'), 'A distinct controlled correction.');
    await fireEvent.press(screen.getByLabelText('chat.submitCorrection'));
    await waitFor(() => expect(mockWorkspace.proposeTranslationCorrection).toHaveBeenCalled());
    // A refused correction keeps its form open for another attempt.
    expect(screen.getByLabelText('chat.correctedTranslation')).toBeTruthy();
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog').at(-1)!);

    expect(mockWorkspace.reviewTranslationCorrection).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('chat.reportTranslationError')).toBeNull();
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
    await fireEvent.press(screen.getByLabelText('chat.summarize'));
    expect(screen.getByText('The shift must secure the gate and inspect the valve.')).toBeTruthy();
    expect(screen.queryByText(/chat\.notAvailable/)).toBeNull();
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

    await fireEvent.press(screen.getByText('I understand'));
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

describe('personal realm direct threads', () => {
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

  test('consumer threads offer a request for untranslated messages and a rate-limited retry for failed rows', async () => {
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
    // Automatic mode does not backfill: a message that never got a row (for
    // example received while translation was off) can still be requested, and
    // a failed row offers a retry.
    expect(screen.getByText('chat.requestTranslation')).toBeTruthy();
    expect(screen.getByText('chat.translationUnavailable')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.retryTranslation'));
    expect(mockWorkspace.requestTranslation).toHaveBeenCalledTimes(1);
    expect(mockWorkspace.requestTranslation).toHaveBeenCalledWith(failed);
    // The tap starts a 30-second cooldown on that bubble; a second tap inside
    // it is ignored, so a retry cannot be spammed.
    expect(screen.queryByText('chat.retry')).toBeNull();
    await fireEvent.press(screen.getByText('chat.retryTranslationWait'));
    expect(mockWorkspace.requestTranslation).toHaveBeenCalledTimes(1);

    // An unset mode is automatic as well.
    const implicit = conversation({ translationMode: undefined });
    mockWorkspace.conversations[0] = implicit;
    await view.rerender(
      <ConversationPane conversation={implicit} messages={[failed, notRequested]} onSend={noopSend} />,
    );
    expect(screen.getByText('chat.requestTranslation')).toBeTruthy();
    expect(screen.getByText('chat.retryTranslationWait')).toBeTruthy();

    // Workspace organizations keep the manual request as before.
    mockWorkspace.organizationId = 'organization-a';
    await view.rerender(
      <ConversationPane conversation={automatic} messages={[failed, notRequested]} onSend={noopSend} />,
    );
    expect(screen.getByText('chat.requestTranslation')).toBeTruthy();
    expect(screen.getByText('chat.retryTranslationWait')).toBeTruthy();
  });

  test('always renders the composer for an active member, even when the counterpart is still pending', async () => {
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    for (const state of [
      counterpart({ connectionState: 'pending', connectionRequestDirection: 'incoming' }),
      counterpart({ connectionState: 'pending', connectionRequestDirection: 'outgoing' }),
      counterpart({ connectionState: 'connected' }),
    ]) {
      mockWorkspace.people = [self, state, candidate];
      const view = await render(
        <ConversationPane conversation={directRequestConversation()} messages={[]} onSend={noopSend} />,
      );
      // No request banner, no accept/decline, no polling: the thread is an ordinary chat.
      expect(screen.queryByText('chat.messageRequestIncoming')).toBeNull();
      expect(screen.queryByText('chat.messageRequestPending')).toBeNull();
      expect(screen.queryByRole('button', { name: 'people.accept' })).toBeNull();
      expect(screen.getByLabelText('chat.message')).toBeTruthy();
      await fireEvent.changeText(screen.getByLabelText('chat.message'), 'Hello there');
      expect(screen.getByLabelText('chat.send')).toBeTruthy();
      await view.unmount();
    }
    expect(mockWorkspace.refresh).not.toHaveBeenCalled();
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

    // A chat whose row shows a message, opened before its page has arrived,
    // is loading - not empty. It used to claim "no messages yet" for the whole
    // round trip, which is what made opening a chat look broken.
    mockWorkspace.messagePagination = {};
    const pending = await render(
      <ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />,
    );
    expect(screen.getByLabelText('chat.loadingMessages')).toBeTruthy();
    expect(screen.queryByText('chat.privateConsumer')).toBeNull();
    await pending.unmount();

    // A thread with nothing in it yet: no preview on its row, nothing unread.
    // A chat that does have history shows a spinner instead, covered below.
    mockWorkspace.messagePagination = {};
    const fresh = await render(
      <ConversationPane
        conversation={conversation({ lastMessage: '', unreadCount: 0 })}
        messages={[]}
        onSend={noopSend} />,
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
    expect(screen.queryByLabelText('chat.deleteMe')).toBeNull();
  });

  test('gives the personal realm exactly the consumer sheet and nothing from the review desk', async () => {
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    const message = translatedMessage();
    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);
    await fireEvent(screen.getByText(message.originalText), 'longPress');

    // The reaction row comes first, then the actions, then your own message's.
    expect(screen.getByTestId('reaction-row')).toBeTruthy();
    for (const emoji of ['👍', '❤️', '😂', '😮', '😢', '🙏']) {
      expect(screen.getByLabelText(`chat.react ${emoji}`)).toBeTruthy();
    }
    expect(screen.getByLabelText('chat.reactMore')).toBeTruthy();
    for (const label of ['chat.reply', 'chat.copy', 'chat.unpin', 'chat.forward']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByLabelText('chat.editMessage')).toBeTruthy();
    expect(screen.getByLabelText('chat.saveEdit')).toBeTruthy();
    expect(screen.getByLabelText('chat.deleteEveryone')).toBeTruthy();

    // The review desk stays at work.
    expect(screen.queryByLabelText('chat.showProvenance')).toBeNull();
    expect(screen.queryByLabelText('chat.hideProvenance')).toBeNull();
    expect(screen.queryByLabelText('chat.proposeCorrection')).toBeNull();
    expect(screen.queryByLabelText('chat.reviewCorrection')).toBeNull();
    expect(screen.queryByText('chat.sourceFingerprint')).toBeNull();
    expect(screen.queryByLabelText('chat.deleteMe')).toBeNull();
    expect(screen.queryByText('chat.deleteMeHint')).toBeNull();

    // Forward opens its picker only when it is asked for.
    expect(screen.queryByText('chat.forwardTo')).toBeNull();
    await fireEvent.press(screen.getByLabelText('chat.forward'));
    expect(screen.getByText('chat.forwardTo')).toBeTruthy();
  });

  test('drops Edit and Delete from the sheet once the fifteen minutes are up', async () => {
    const fresh = translatedMessage();
    const freshView = await render(
      <ConversationPane conversation={conversation()} messages={[fresh]} onSend={noopSend} />,
    );
    await fireEvent(screen.getByText(fresh.originalText), 'longPress');
    expect(screen.getByLabelText('chat.editMessage')).toBeTruthy();
    expect(screen.getByLabelText('chat.saveEdit')).toBeTruthy();
    expect(screen.getByLabelText('chat.deleteEveryone')).toBeTruthy();
    await freshView.unmount();

    mockWorkspace = buildWorkspace();
    const old = translatedMessage({
      id: 'message-old',
      serverId: 'message-old',
      originalText: 'Sent a long time ago.',
      createdAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    });
    await render(<ConversationPane conversation={conversation()} messages={[old]} onSend={noopSend} />);
    await fireEvent(screen.getByText(old.originalText), 'longPress');

    expect(screen.queryByLabelText('chat.editMessage')).toBeNull();
    expect(screen.queryByLabelText('chat.saveEdit')).toBeNull();
    expect(screen.queryByLabelText('chat.deleteEveryone')).toBeNull();
    // Everything that does not change the message is still there.
    expect(screen.getByLabelText('chat.reply')).toBeTruthy();
    expect(screen.getByLabelText('chat.copy')).toBeTruthy();
    expect(screen.getByLabelText('chat.forward')).toBeTruthy();
    expect(screen.getByTestId('reaction-row')).toBeTruthy();
  });

  test('keeps the translation review items for workspace organizations', async () => {
    const message = translatedMessage();
    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);
    await fireEvent(screen.getByText(message.originalText), 'longPress');

    expect(screen.getByLabelText('chat.showProvenance')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.showProvenance'));
    expect(screen.getByLabelText('chat.hideProvenance')).toBeTruthy();
  });

  test('keeps the create-action-item affordance for workspace organizations', async () => {
    const message = translatedMessage();
    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);
    await fireEvent(screen.getByText(message.originalText), 'longPress');

    expect(screen.getByText('chat.createAction')).toBeTruthy();
    expect(screen.getByLabelText('chat.actionCreate')).toBeTruthy();
  });
});

describe('group member management', () => {
  // The consumer group's people live in GroupMembersSection (its own tests):
  // plain rows with message, add, mute, block and remove. The roster below —
  // role chips, a remove icon, a change reason, a join-request console — is the
  // workplace product, so these exercise it there and the consumer rule is
  // asserted separately.
  test('a consumer group is not asked to justify a change, and reviews no join requests', async () => {
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    const group = conversation({
      organizationId: PERSONAL_REALM_ORGANIZATION_ID,
      kind: 'group',
      memberIds: [self.id, colleague.id, candidate.id],
      myRole: 'owner',
      canManage: true,
      memberRoles: { [self.id]: 'owner', [colleague.id]: 'member', [candidate.id]: 'member' },
    });
    await render(<ConversationPane conversation={group} messages={[]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.conversationSettings'));
    expect(screen.queryByLabelText('chat.changeReason')).toBeNull();
    expect(screen.queryByLabelText('chat.reviewJoinRequests')).toBeNull();
    // The roster itself stays: it carries roles, ownership transfer and the
    // group photo, and taking it away took those with it. Consolidating it with
    // the people section is a design change, not a release-day edit.
    expect(screen.getByText('chat.addMember')).toBeTruthy();
  });

  function personalGroup(overrides: Record<string, unknown> = {}) {
    return conversation({
      organizationId: PERSONAL_REALM_ORGANIZATION_ID,
      kind: 'group',
      memberIds: [self.id, colleague.id, candidate.id],
      ...overrides,
    });
  }

  test('lets the owner promote, demote, and remove other members but never touch their own row', async () => {
    mockWorkspace.organizationId = 'workplace-organization';
    const owner = personalGroup({
      organizationId: 'workplace-organization',
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
    mockWorkspace.organizationId = 'workplace-organization';
    const admin = personalGroup({
      organizationId: 'workplace-organization',
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

describe('compact timeline, translated-only mode, and composer behaviour', () => {
  test('shows only the translation when the device prefers it and reveals the original per message', async () => {
    mockPreferences.translatedOnly = true;
    // Collapsing to the translation is about reading somebody else's message;
    // your own is governed by "Show my translations" alone (v3.4).
    const translated = translatedMessage({ isOwn: false });
    const untranslated = incomingMessage({ attachment: undefined });
    await render(<ConversationPane conversation={conversation()} messages={[translated, untranslated]} onSend={noopSend} />);
    expect(screen.getByText('Cierre la puerta norte a las 18:00.')).toBeTruthy();
    expect(screen.queryByText('Lock the north gate at 18:00.')).toBeNull();
    await fireEvent.press(screen.getByLabelText('chat.showOriginal'));
    expect(screen.getByText('Lock the north gate at 18:00.')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.hideOriginal'));
    expect(screen.queryByText('Lock the north gate at 18:00.')).toBeNull();
    // Without a completed translation the original stays, with one quiet status line and no toggle.
    expect(screen.getByText('La válvula necesita revisión.')).toBeTruthy();
    expect(screen.getByText('chat.translationUnavailable')).toBeTruthy();
    expect(screen.getAllByLabelText('chat.showOriginal')).toHaveLength(1);
  });

  test('shows your own message the way the other side reads it once the device asks for it', async () => {
    mockPreferences.showOwnTranslations = true;
    await render(<ConversationPane conversation={conversation()} messages={[ownMessage()]} onSend={noopSend} />);
    expect(screen.getByText('Lock the north gate at 18:00.')).toBeTruthy();
    expect(screen.getByText('18시에 북문을 잠그세요.')).toBeTruthy();
    // Both lines are already there, so the collapsed form's toggle stays away.
    expect(screen.queryByLabelText('chat.showOriginal')).toBeNull();
  });

  test('leaves your own messages alone while the setting is off', async () => {
    await render(<ConversationPane conversation={conversation()} messages={[ownMessage()]} onSend={noopSend} />);
    expect(screen.getByText('Lock the north gate at 18:00.')).toBeTruthy();
    expect(screen.queryByText('18시에 북문을 잠그세요.')).toBeNull();
  });

  test('an approved correction is what your own message shows, because it is what they read', async () => {
    mockPreferences.showOwnTranslations = true;
    const corrected = ownMessage({
      outgoingTranslations: [outgoingTranslation({
        correction: {
          id: 'correction-outgoing',
          status: 'approved',
          correctedText: '18시에 북쪽 출입구를 잠그세요.',
          rationale: 'Uses the site term.',
          proposedByUserId: colleague.id,
          reviewedByUserId: colleague.id,
          reviewedAt: '2026-08-04T18:02:00.000Z',
          reviewNote: null,
          createdAt: '2026-08-04T18:01:00.000Z',
          updatedAt: '2026-08-04T18:02:00.000Z',
        },
      })],
    });
    await render(<ConversationPane conversation={conversation()} messages={[corrected]} onSend={noopSend} />);
    expect(screen.getByText('18시에 북쪽 출입구를 잠그세요.')).toBeTruthy();
    expect(screen.queryByText('18시에 북문을 잠그세요.')).toBeNull();
  });

  test('a translation still in flight adds nothing to your own bubble', async () => {
    mockPreferences.showOwnTranslations = true;
    const inFlight = ownMessage({
      outgoingTranslations: [outgoingTranslation({ status: 'queued', translatedText: null, provider: null, model: null })],
    });
    await render(<ConversationPane conversation={conversation()} messages={[inFlight]} onSend={noopSend} />);
    expect(screen.getByText('Lock the north gate at 18:00.')).toBeTruthy();
    expect(screen.queryByText('18시에 북문을 잠그세요.')).toBeNull();
    // No status line either: the bubble must not grow a line seconds after it lands.
    expect(screen.queryByText('chat.translating')).toBeNull();
    expect(screen.queryByText('chat.translationDelayed')).toBeNull();
  });

  test('a message nobody needed translated stays a single line', async () => {
    mockPreferences.showOwnTranslations = true;
    await render(
      <ConversationPane
        conversation={conversation()}
        messages={[ownMessage({ outgoingTranslations: undefined })]}
        onSend={noopSend}
      />,
    );
    expect(screen.getByText('Lock the north gate at 18:00.')).toBeTruthy();
    expect(screen.queryByText('chat.translating')).toBeNull();
    expect(screen.queryByText('chat.translationUnavailable')).toBeNull();
  });

  test('a failed outgoing translation says nothing on your own bubble', async () => {
    mockPreferences.showOwnTranslations = true;
    const failed = ownMessage({
      outgoingTranslations: [outgoingTranslation({
        status: 'failed', translatedText: null, provider: null, model: null, failureCode: 'provider_timeout',
      })],
    });
    await render(<ConversationPane conversation={conversation()} messages={[failed]} onSend={noopSend} />);
    expect(screen.getByText('Lock the north gate at 18:00.')).toBeTruthy();
    expect(screen.queryByText('chat.translationUnavailable')).toBeNull();
    expect(screen.queryByLabelText('chat.retryTranslation')).toBeNull();
  });

  test('translated-only keeps its collapsed form for incoming messages while your own show both lines', async () => {
    mockPreferences.translatedOnly = true;
    mockPreferences.showOwnTranslations = true;
    // An own message that also carries a translation into this reader's own
    // language. From v3.4 that incoming row is ignored on your own message —
    // it is what put a translation under your own bubble with the setting off
    // — so your own bubble shows your words and, because the setting is on
    // here, the outgoing translation the other side reads.
    const own = translatedMessage({ outgoingTranslations: [outgoingTranslation()] });
    const incoming = incomingMessage({
      attachment: undefined,
      translatedText: 'The valve needs a check.',
      translationState: 'translated',
      translation: {
        id: 'translation-incoming', sourceLanguage: 'es', targetLanguage: 'en',
        sourceBodySha256: 'incoming-source-hash', status: 'completed',
        translatedText: 'The valve needs a check.', provider: 'openrouter',
        model: 'qwen/tested-model', confidence: 0.93, policyVersion: 4,
        policyState: 'current', reviewedByUserId: null, reviewedAt: null,
        failureCode: null, createdAt: '2026-08-04T18:02:00.000Z',
        updatedAt: '2026-08-04T18:02:05.000Z', correction: null,
      },
    });
    await render(<ConversationPane conversation={conversation()} messages={[own, incoming]} onSend={noopSend} />);
    expect(screen.getByText('Lock the north gate at 18:00.')).toBeTruthy();
    expect(screen.getByText('18시에 북문을 잠그세요.')).toBeTruthy();
    expect(screen.queryByText('Cierre la puerta norte a las 18:00.')).toBeNull();
    expect(screen.getByText('The valve needs a check.')).toBeTruthy();
    expect(screen.queryByText('La válvula necesita revisión.')).toBeNull();
    // Only the incoming bubble offers to reveal an original.
    expect(screen.getAllByLabelText('chat.showOriginal')).toHaveLength(1);
  });

  test('shows a quiet translating line while a translation is pending', async () => {
    const pending = incomingMessage({ attachment: undefined, translationState: 'queued', translation: undefined });
    await render(<ConversationPane conversation={conversation()} messages={[pending]} onSend={noopSend} />);
    expect(screen.getByText('chat.translating')).toBeTruthy();
    expect(screen.queryByText(/chat\.translationQueued|chat\.translationProcessing/)).toBeNull();
  });

  test('says a pending translation is delayed once it has outlived the normal window', async () => {
    const stale = incomingMessage({
      attachment: undefined, translationState: 'queued', translation: undefined,
      createdAt: new Date(Date.now() - 2 * TRANSLATION_DELAYED_AFTER_MS).toISOString(),
    });
    await render(<ConversationPane conversation={conversation()} messages={[stale]} onSend={noopSend} />);
    expect(screen.getByText('chat.translationDelayed')).toBeTruthy();
    expect(screen.queryByText('chat.translating')).toBeNull();
    // The delayed line is quiet: no retry link, the revive path stays server-side.
    expect(screen.queryByLabelText('chat.retryTranslation')).toBeNull();
  });

  test('flips a fresh pending translation to delayed only after the window, and drops the line once it lands', async () => {
    jest.useFakeTimers();
    try {
      const fresh = incomingMessage({
        attachment: undefined, translationState: 'queued', translation: undefined,
        createdAt: new Date().toISOString(),
      });
      const view = await render(<ConversationPane conversation={conversation()} messages={[fresh]} onSend={noopSend} />);
      expect(screen.getByText('chat.translating')).toBeTruthy();
      await act(async () => { jest.advanceTimersByTime(TRANSLATION_DELAYED_AFTER_MS - 1_000); });
      expect(screen.getByText('chat.translating')).toBeTruthy();
      await act(async () => { jest.advanceTimersByTime(1_500); });
      expect(screen.getByText('chat.translationDelayed')).toBeTruthy();
      // The revive path delivered it: the translation replaces the status line.
      await view.rerender(<ConversationPane conversation={conversation()} messages={[translatedMessage({ isOwn: false })]} onSend={noopSend} />);
      expect(screen.queryByText('chat.translationDelayed')).toBeNull();
      expect(screen.getByText('Cierre la puerta norte a las 18:00.')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  test('sends on the return key when Enter-sends is on and inserts newlines when it is off', async () => {
    const onSend = jest.fn(async () => undefined);
    const view = await render(<ConversationPane conversation={conversation()} messages={[]} onSend={onSend} />);
    const input = () => screen.getByLabelText('chat.message');
    expect(input().props.returnKeyType).toBe('send');
    expect(input().props.submitBehavior).toBe('submit');
    await fireEvent.changeText(input(), 'Sent with return');
    await fireEvent(input(), 'submitEditing');
    expect(onSend).toHaveBeenCalledWith('Sent with return', undefined, []);

    mockPreferences.enterSends = false;
    await view.rerender(<ConversationPane conversation={conversation()} messages={[]} onSend={onSend} />);
    expect(input().props.returnKeyType).toBe('default');
    expect(input().props.submitBehavior).toBe('newline');
    expect(input().props.onSubmitEditing).toBeUndefined();
  });

  test('shows a spinner, not an empty list, while the first page is still on the server', async () => {
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);
    expect(screen.getByLabelText('chat.loadingMessages')).toBeTruthy();
    expect(screen.queryByText('chat.start')).toBeNull();
    await waitFor(() => expect(mockWorkspace.loadOlderMessages).toHaveBeenCalledWith('conversation-main'));
  });

  test('renders a photo as the picture with its time on top and opens the viewer', async () => {
    const photo = translatedMessage({
      id: 'photo', serverId: 'photo', originalText: '', translatedText: null, translation: undefined,
      translationState: 'not_requested', languageDetection: undefined, priority: 'normal', mentionUserIds: [],
      edited: false, pinned: false, forwarded: false, replyTo: undefined, reactions: [], receipt: undefined,
      deliveryState: 'delivered',
      attachment: {
        id: 'attachment-photo', kind: 'image', name: 'site.jpg', sizeLabel: '1.2 MB', status: 'clean',
        mimeType: 'image/jpeg', byteSize: 1_200_000, downloadUrl: 'https://example.invalid/site.jpg',
      },
    });
    await render(<ConversationPane conversation={conversation()} messages={[photo]} onSend={noopSend} />);
    expect(screen.queryByText('site.jpg')).toBeNull();
    expect(screen.queryByText(/1\.2 MB/)).toBeNull();
    expect(screen.getByText('12:00')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.imageOpen'));
    expect(screen.getByLabelText('chat.imageViewerClose')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.imageViewerDownload'));
    expect(mockWorkspace.downloadAttachment).toHaveBeenCalledWith(photo);
    await fireEvent.press(screen.getByLabelText('chat.imageViewerClose'));
    expect(screen.queryByLabelText('chat.imageViewerClose')).toBeNull();
  });

  test('plays a received video inline and keeps the download control', async () => {
    const video = incomingMessage({
      id: 'video', serverId: 'video', originalText: '',
      attachment: {
        id: 'attachment-video', kind: 'document', name: 'line-two.mp4', sizeLabel: '48 MB', status: 'clean',
        mimeType: 'video/mp4', byteSize: 48 * 1024 * 1024, downloadUrl: 'https://example.invalid/signed-video',
      },
    });
    await render(<ConversationPane conversation={conversation()} messages={[video]} onSend={noopSend} />);
    expect(screen.getByTestId('expo-video-view')).toBeTruthy();
    expect(screen.getByLabelText('chat.videoAttachment · line-two.mp4')).toBeTruthy();
    expect(screen.queryByText('chat.translationUnavailable')).toBeNull();
    await fireEvent.press(screen.getByLabelText('line-two.mp4, chat.fileClean'));
    expect(mockWorkspace.downloadAttachment).toHaveBeenCalledWith(video);
  });

  test('puts the handle, member count, and language pair on the single header line', async () => {
    mockWorkspace.people = [self, { ...colleague, username: 'ana' }, candidate];
    const direct = conversation({
      kind: 'direct', directParticipantId: colleague.id, translationPair: 'EN ↔ ES', subtitle: 'member • Denver',
    });
    const view = await render(<ConversationPane conversation={direct} messages={[]} onSend={noopSend} />);
    expect(screen.getByText('@ana')).toBeTruthy();
    expect(screen.getByText('EN ↔ ES')).toBeTruthy();
    expect(screen.queryByText('member • Denver')).toBeNull();
    expect(screen.queryByText(/chat\.translationAvailable/)).toBeNull();
    await view.rerender(<ConversationPane conversation={conversation({ participantCount: 3 })} messages={[]} onSend={noopSend} />);
    expect(screen.getByText('chat.memberCount')).toBeTruthy();
  });

  test('offers the @mention chip only in groups and only once the draft holds an @', async () => {
    // Mentionable members must carry real identities (UUIDs), as in production.
    const mentionSelf = { ...self, id: '11111111-1111-4111-8111-111111111111' };
    const mentionColleague = { ...colleague, id: '22222222-2222-4222-8222-222222222222' };
    const mentionCandidate = { ...candidate, id: '33333333-3333-4333-8333-333333333333' };
    mockWorkspace.currentUser = mentionSelf;
    mockWorkspace.people = [mentionSelf, mentionColleague, mentionCandidate];
    const memberIds = [mentionSelf.id, mentionColleague.id, mentionCandidate.id];
    const view = await render(<ConversationPane conversation={conversation({ memberIds })} messages={[]} onSend={noopSend} />);
    expect(screen.queryByText('Mention people')).toBeNull();
    expect(screen.queryByText('Up to 50 people per message')).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'Ping @');
    expect(screen.getByText('Mention people')).toBeTruthy();
    expect(screen.queryByText('Up to 50 people per message')).toBeNull();
    await view.rerender(<ConversationPane
      conversation={conversation({ kind: 'direct', directParticipantId: mentionColleague.id, memberIds: memberIds.slice(0, 2) })}
      messages={[]}
      onSend={noopSend}
    />);
    expect(screen.queryByText('Mention people')).toBeNull();
  });

  test('overlays the workspace status banner inside the pane instead of reflowing the list', async () => {
    mockWorkspace.connectivity = 'offline';
    mockWorkspace.offlineQueueAvailable = true;
    await render(<ConversationPane conversation={conversation()} messages={[translatedMessage()]} onSend={noopSend} />);
    expect(screen.getByText('status.offline')).toBeTruthy();
  });
});
