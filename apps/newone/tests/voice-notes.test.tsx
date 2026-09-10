import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { Message } from '@/domain/types';
import { ConversationPane } from '@/features/chat/conversation-pane';

const mockRequestRecordingPermissions = jest.fn(async () => ({ granted: true }));
const mockSetAudioMode = jest.fn<(_mode: unknown) => Promise<void>>(async () => undefined);
const mockUseAudioPlayer = jest.fn<(_source: unknown) => void>();

const mockRecorder = {
  uri: 'file://controlled-voice-note.m4a' as string | null,
  prepareToRecordAsync: jest.fn(async () => undefined),
  record: jest.fn(),
  stop: jest.fn(async () => undefined),
};

const mockPlayer = {
  play: jest.fn(),
  pause: jest.fn(),
  seekTo: jest.fn(async () => undefined),
};

let mockPlayerStatus: { playing: boolean; currentTime: number; duration: number };

jest.mock('expo-audio', () => ({
  AudioModule: {
    requestRecordingPermissionsAsync: () => mockRequestRecordingPermissions(),
  },
  RecordingPresets: { HIGH_QUALITY: { extension: '.m4a' } },
  setAudioModeAsync: (mode: unknown) => mockSetAudioMode(mode),
  useAudioRecorder: () => mockRecorder,
  useAudioPlayer: (source: unknown) => {
    mockUseAudioPlayer(source);
    return mockPlayer;
  },
  useAudioPlayerStatus: () => mockPlayerStatus,
}));

jest.mock('@/lib/supabase', () => ({
  getRealtimeClient: () => null,
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(async () => ({ canceled: true, assets: [] })),
}));

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: false })),
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: false })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: [] })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: [] })),
}));

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string) => key,
  }),
}));

let mockWorkspace: Record<string, any>;

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

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conversation-main',
    organizationId: 'organization-a',
    title: 'Plant Operations',
    initials: 'PO',
    avatarColor: '#225544',
    kind: 'group',
    subtitle: 'Live shift coordination',
    participantCount: 2,
    unreadCount: 0,
    pinned: false,
    favorite: false,
    muted: false,
    notificationLevel: 'all',
    translationMode: 'off',
    priority: 'normal',
    myRole: 'member',
    canManage: false,
    canManageConversation: false,
    memberIds: [self.id, colleague.id],
    historyPolicy: 'all',
    postingMode: 'all_members',
    canPost: true,
    ...overrides,
  } as any;
}

function voiceMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'message-voice',
    serverId: 'message-voice',
    conversationId: 'conversation-main',
    senderId: colleague.id,
    senderName: colleague.displayName,
    senderInitials: colleague.initials,
    senderColor: colleague.avatarColor,
    originalText: '',
    sourceLanguage: 'es',
    translationState: 'not_requested',
    sentAt: '12:04',
    dayLabel: 'Today',
    isOwn: false,
    deliveryState: 'delivered',
    priority: 'normal',
    attachment: {
      id: 'attachment-voice',
      kind: 'voice',
      name: 'voice-note.m4a',
      sizeLabel: '120 KB',
      status: 'clean',
      mimeType: 'audio/mp4',
      byteSize: 122880,
      downloadUrl: 'https://example.invalid/signed-voice',
    },
    ...overrides,
  } as any;
}

async function noopSend(
  _text: string,
  _replyTo?: Message,
  _mentionUserIds?: string[],
): Promise<void> {}

function buildWorkspace() {
  return {
    actionBusy: null,
    actionError: null,
    actions: [],
    aiOutputErrorReports: [],
    connectivity: 'online',
    conversationAvatarUrls: {},
    conversations: [conversation()],
    currentUser: self,
    messageDisplayLanguage: 'en',
    messagePagination: {},
    organizationId: 'organization-a',
    people: [self, colleague],
    realtimeToken: null,
    summaries: [],
    unreadDividerIds: {},
    hasCapability: jest.fn(() => false),
    clearActionError: jest.fn(),
    downloadAttachment: jest.fn(async () => true),
    ensureMessageLoaded: jest.fn(async () => true),
    loadMyAiOutputErrorReports: jest.fn(async () => true),
    loadOlderMessages: jest.fn(async () => true),
    markConversationRead: jest.fn(async () => true),
    observeConversation: jest.fn(async () => true),
    requestConversationSummary: jest.fn(async () => true),
    sendAttachment: jest.fn(async () => true),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockPlayerStatus = { playing: false, currentTime: 0, duration: 10 };
  mockRecorder.uri = 'file://controlled-voice-note.m4a';
  mockRecorder.prepareToRecordAsync.mockImplementation(async () => undefined);
  mockRecorder.stop.mockImplementation(async () => undefined);
  mockRequestRecordingPermissions.mockImplementation(async () => ({ granted: true }));
  mockSetAudioMode.mockImplementation(async () => undefined);
  mockPlayer.seekTo.mockImplementation(async () => undefined);
  mockWorkspace = buildWorkspace();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('voice note recording through the secure attachment pipeline', () => {
  test('records with an elapsed timer and sends audio/mp4 with no caption', async () => {
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);

    // With an empty input the mic replaces the send action.
    expect(screen.queryByLabelText('chat.send')).toBeNull();
    await fireEvent.press(screen.getByLabelText('chat.recordVoiceNote'));

    expect(mockRequestRecordingPermissions).toHaveBeenCalledTimes(1);
    expect(mockSetAudioMode).toHaveBeenCalledWith({ allowsRecording: true, playsInSilentMode: true });
    expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalledTimes(1);
    expect(mockRecorder.record).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('chat.recordingVoiceNote')).toBeTruthy();
    expect(screen.getByText('0:00')).toBeTruthy();
    expect(screen.queryByLabelText('chat.message')).toBeNull();

    await act(async () => jest.advanceTimersByTime(65000));
    expect(screen.getByText('1:05')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('chat.sendVoiceNote'));
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    expect(mockSetAudioMode).toHaveBeenLastCalledWith({ allowsRecording: false, playsInSilentMode: true });
    expect(mockWorkspace.sendAttachment).toHaveBeenCalledWith(
      'conversation-main',
      expect.objectContaining({
        uri: 'file://controlled-voice-note.m4a',
        mimeType: 'audio/mp4',
        name: expect.stringMatching(/^voice-note-\d+\.m4a$/),
        temporary: true,
      }),
      '',
    );
    // The composer returns to text mode after sending.
    expect(screen.getByLabelText('chat.message')).toBeTruthy();
  });

  test('cancelling a recording stops the recorder and sends nothing', async () => {
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} mobile />);

    await fireEvent.press(screen.getByLabelText('chat.recordVoiceNote'));
    expect(mockRecorder.record).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(4000));
    expect(screen.getByText('0:04')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('chat.cancelVoiceNote'));
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    expect(mockWorkspace.sendAttachment).not.toHaveBeenCalled();
    expect(screen.getByLabelText('chat.recordVoiceNote')).toBeTruthy();
  });

  test('does not record without microphone permission or send without a recorded file', async () => {
    mockRequestRecordingPermissions.mockImplementationOnce(async () => ({ granted: false }));
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);

    await fireEvent.press(screen.getByLabelText('chat.recordVoiceNote'));
    expect(mockRecorder.record).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('chat.sendVoiceNote')).toBeNull();

    // A recorder that produced no file must not enter the pipeline.
    mockRecorder.uri = null;
    await fireEvent.press(screen.getByLabelText('chat.recordVoiceNote'));
    expect(mockRecorder.record).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByLabelText('chat.sendVoiceNote'));
    expect(mockWorkspace.sendAttachment).not.toHaveBeenCalled();
  });

  test('typing text swaps the mic for the send action', async () => {
    await render(<ConversationPane conversation={conversation()} messages={[]} onSend={noopSend} />);

    expect(screen.getByLabelText('chat.recordVoiceNote')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('chat.message'), 'written instead');
    expect(screen.queryByLabelText('chat.recordVoiceNote')).toBeNull();
    expect(screen.getByLabelText('chat.send')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('chat.message'), '');
    expect(screen.getByLabelText('chat.recordVoiceNote')).toBeTruthy();
  });
});

describe('audio attachment playback bubble', () => {
  test('plays, pauses, and restarts a clean audio attachment with elapsed and total time', async () => {
    const message = voiceMessage();
    const view = await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} />);

    expect(mockUseAudioPlayer).toHaveBeenCalledWith('https://example.invalid/signed-voice');
    expect(screen.getByText('chat.voiceNote')).toBeTruthy();
    expect(screen.getByText('0:00 / 0:10')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('chat.playVoiceNote'));
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
    expect(mockPlayer.seekTo).not.toHaveBeenCalled();

    // Bubbles are memoized (v3.1); a status change re-renders through the
    // player hook in the app, so here the message object changes instead.
    mockPlayerStatus = { playing: true, currentTime: 3, duration: 10 };
    await view.rerender(<ConversationPane conversation={conversation()} messages={[{ ...message }]} onSend={noopSend} />);
    expect(screen.getByText('0:03 / 0:10')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.pauseVoiceNote'));
    expect(mockPlayer.pause).toHaveBeenCalledTimes(1);

    mockPlayerStatus = { playing: false, currentTime: 10, duration: 10 };
    await view.rerender(<ConversationPane conversation={conversation()} messages={[{ ...message }]} onSend={noopSend} />);
    await fireEvent.press(screen.getByLabelText('chat.playVoiceNote'));
    expect(mockPlayer.seekTo).toHaveBeenCalledWith(0);
    expect(mockPlayer.play).toHaveBeenCalledTimes(2);
  });

  test('renders own-message styling and tolerates a missing playback status', async () => {
    mockPlayerStatus = undefined as any;
    const message = voiceMessage({ id: 'message-own-voice', serverId: 'message-own-voice', isOwn: true, senderId: self.id });
    await render(<ConversationPane conversation={conversation()} messages={[message]} onSend={noopSend} mobile />);

    expect(screen.getByText('0:00 / 0:00')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('chat.playVoiceNote'));
    expect(mockPlayer.seekTo).not.toHaveBeenCalled();
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
  });

  test('keeps the quarantined attachment card for audio that is not yet playable', async () => {
    const scanning = voiceMessage({
      id: 'message-scanning-voice',
      serverId: 'message-scanning-voice',
      attachment: {
        id: 'attachment-scanning',
        kind: 'voice',
        name: 'voice-scan.m4a',
        sizeLabel: '90 KB',
        status: 'scanning',
        mimeType: 'audio/mp4',
        byteSize: 92160,
        downloadUrl: null,
      },
    });
    const uploading = voiceMessage({
      id: 'message-uploading-voice',
      serverId: 'message-uploading-voice',
      isOwn: true,
      senderId: self.id,
      attachment: {
        id: 'attachment-uploading',
        kind: 'voice',
        name: 'voice-upload.m4a',
        sizeLabel: '90 KB',
        status: 'clean',
        mimeType: 'audio/mp4',
        byteSize: 92160,
        downloadUrl: 'https://example.invalid/signed-upload',
        transfer: { state: 'uploading', progress: 0.5 },
      },
    });
    await render(<ConversationPane conversation={conversation()} messages={[scanning, uploading]} onSend={noopSend} />);

    expect(screen.queryByLabelText('chat.playVoiceNote')).toBeNull();
    expect(screen.getByLabelText('voice-scan.m4a, chat.attachmentUploading')).toBeTruthy();
    expect(screen.getByLabelText('voice-upload.m4a, chat.attachmentUploading')).toBeTruthy();
  });
});
