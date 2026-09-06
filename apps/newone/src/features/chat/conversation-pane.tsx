import { Ionicons } from '@expo/vector-icons';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
} from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { type EdgeInsets, SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { isPersonalRealm } from '@/constants/personal-realm';
import { attachmentMimeTypes, type SelectedAttachment } from '@/data/attachments';
import { useConversationTyping } from '@/data/realtime/use-conversation-typing';
import { activeMutedUntil, temporaryMutePatch } from '@/data/notification-preferences.mjs';
import { firstUnreadMessageId } from '@/data/reconciliation/message-timeline.mjs';
import type { ConversationMemberCandidate } from '@/data/repositories/contracts';
import type { AiOutputErrorCategory, Attachment, Conversation, Message, Person } from '@/domain/types';
import { Avatar, Chip, EmptyState, IconButton, PrimaryButton, SearchField, StatusBadge } from '@/components/ui/primitives';
import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
import { KeyboardAvoidingScreen } from '@/components/ui/keyboard-avoiding-screen';
import { WorkspaceStatusBanner } from '@/components/workspace/workspace-state';
import {
  MAX_MESSAGE_MENTIONS,
  mentionablePeople,
} from '@/features/chat/mention-controls.mjs';
import { shouldSendOnEnter } from '@/features/chat/composer-keys';
import { mentionCopy } from '@/features/chat/mention-copy';
import {
  attachmentReady,
  ImageAttachment,
  isVideoAttachment,
  TransferControls,
  VideoMessageAttachment,
} from '@/features/chat/media-attachment';
import { notificationCopy } from '@/features/chat/notification-copy';
import { SummarySheet } from '@/features/chat/summary-sheet';
import {
  appendedMessageCount,
  buildTimelineRows,
  mediaMaxWidth,
  messageKey,
  type TimelineRow,
} from '@/features/chat/timeline-layout';
import { translationPreferenceCopy } from '@/features/chat/translation-preference-copy';
import {
  conversationDepartureCopy,
  conversationDepartureRestrictionCopy,
} from '@/features/chat/conversation-departure-copy';
import { useI18n } from '@/i18n/provider';
import { useDevicePreferences } from '@/state/device-preferences';
import { useWorkspace } from '@/state/workspace';
import { colors, radii, spacing, type } from '@/theme/tokens';

const rowKey = (row: TimelineRow) => row.key;

export function ConversationPane({
  conversation,
  messages,
  onSend,
  onBack,
  mobile = false,
  focusMessageId,
}: {
  conversation?: Conversation;
  messages: Message[];
  onSend: (text: string, replyTo?: Message, mentionUserIds?: string[]) => void | Promise<void>;
  onBack?: () => void;
  mobile?: boolean;
  focusMessageId?: string;
}) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList<TimelineRow>>(null);
  const router = useRouter();
  const { t } = useI18n();
  const workspace = useWorkspace();
  const { preferences } = useDevicePreferences();
  const observeConversation = workspace.observeConversation;
  const loadMyAiOutputErrorReports = workspace.loadMyAiOutputErrorReports;
  const markConversationRead = workspace.markConversationRead;
  const loadOlderMessages = workspace.loadOlderMessages;
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [correctingMessage, setCorrectingMessage] = useState<Message | null>(null);
  const [reviewingMessage, setReviewingMessage] = useState<Message | null>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [selectedMentionUserIds, setSelectedMentionUserIds] = useState<string[]>([]);
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [reportingSummaryId, setReportingSummaryId] = useState<string | null>(null);
  const [conversationName, setConversationName] = useState('');
  const [conversationDescription, setConversationDescription] = useState('');
  const [showAttachmentPicker, setShowAttachmentPicker] = useState(false);
  const [selectedAttachment, setSelectedAttachment] = useState<SelectedAttachment | null>(null);
  const [attachmentCaption, setAttachmentCaption] = useState('');
  const [attachmentImageMode, setAttachmentImageMode] = useState<'optimized' | 'original'>('optimized');
  const [newMessageCount, setNewMessageCount] = useState(0);
  // The timeline is an inverted list: offset 0 is the newest message, so the
  // thread opens at the bottom and stays there with no scroll-to-end logic.
  const nearBottomRef = useRef(true);
  const previousTailRef = useRef<string | null>(null);
  const previousConversationRef = useRef<string | null>(null);
  const pendingSourceRef = useRef<string | null>(null);
  const appliedSearchFocusRef = useRef('');
  const firstPageRequestedRef = useRef<string | null>(null);
  const scrollRetryRef = useRef<string | null>(null);
  const conversationId = conversation?.id ?? '';
  const pagination = workspace.messagePagination[conversationId] ?? { hasMore: false, loading: false };
  const unreadDividerId = conversation
    ? workspace.unreadDividerIds[conversation.id]
      ?? firstUnreadMessageId(
        messages,
        conversation.lastReadMessageId ?? null,
        conversation.unreadCount,
      )
    : null;
  const tail = messages.at(-1);
  const tailKey = tail ? messageKey(tail) : null;
  const currentUserId = workspace.currentUser?.id ?? null;
  const groupConversation = conversation?.kind !== 'direct';
  const rows = useMemo(
    () => buildTimelineRows(messages, { unreadDividerId, groupConversation }),
    [groupConversation, messages, unreadDividerId],
  );
  // Nothing loaded while the server still holds history: show a spinner, never
  // an empty list that fills in and jumps (owner report, Z Flip).
  const awaitingFirstPage = messages.length === 0 && (pagination.loading || pagination.hasMore);
  const { typingPeers, notifyTyping, notifyStopped } = useConversationTyping({
    enabled: Boolean(conversationId) && Boolean(currentUserId) && conversation?.managementOnly !== true,
    organizationId: workspace.organizationId,
    conversationId,
    userId: currentUserId ?? '',
    displayName: workspace.currentUser?.displayName ?? '',
    accessToken: workspace.realtimeToken ?? undefined,
  });
  // Typing shows in the header's single meta line (like WhatsApp), so the list
  // never reflows when a peer starts or stops typing.
  const typingLabel = typingPeers.length === 1
    ? t('chat.typingSingle').replace('{name}', typingPeers[0].displayName)
    : typingPeers.length > 1
      ? t('chat.typingSeveral')
      : undefined;
  // Message requests no longer exist for consumers (the server accepts any
  // direct thread), so the composer renders for every active member.
  const composerDisabled = conversation
    ? conversation.isReadOnly === true || conversation.canPost === false
    : false;

  useEffect(() => {
    if (!conversationId || conversation?.managementOnly) return;
    void observeConversation(conversationId);
  }, [conversation?.managementOnly, conversationId, messages, observeConversation]);

  useEffect(() => {
    if (workspace.organizationId) void loadMyAiOutputErrorReports();
  }, [loadMyAiOutputErrorReports, workspace.organizationId]);

  useEffect(() => {
    if (previousConversationRef.current !== conversationId) {
      previousConversationRef.current = conversationId;
      previousTailRef.current = tailKey;
      pendingSourceRef.current = null;
      nearBottomRef.current = true;
      setSelectedMentionUserIds([]);
      setShowMentionPicker(false);
      setNewMessageCount(0);
      // The list opens at its newest message, so what is on screen is read.
      if (conversationId && tailKey) void markConversationRead(conversationId);
      return;
    }
    if (tailKey && tailKey !== previousTailRef.current) {
      if (tail?.isOwn) {
        nearBottomRef.current = true;
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
      }
      if (nearBottomRef.current) {
        if (conversationId) void markConversationRead(conversationId);
      } else {
        setNewMessageCount((count) => count + appendedMessageCount(messages, previousTailRef.current));
      }
    }
    previousTailRef.current = tailKey;
  }, [conversationId, markConversationRead, messages, tail?.isOwn, tailKey]);

  useEffect(() => {
    if (!conversationId || !awaitingFirstPage || pagination.loading) return;
    if (firstPageRequestedRef.current === conversationId) return;
    firstPageRequestedRef.current = conversationId;
    void loadOlderMessages(conversationId);
  }, [awaitingFirstPage, conversationId, loadOlderMessages, pagination.loading]);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const nearBottom = event.nativeEvent.contentOffset.y < 72;
    nearBottomRef.current = nearBottom;
    if (nearBottom) {
      setNewMessageCount(0);
      if (conversationId) void markConversationRead(conversationId);
    }
  };

  const loadOlder = () => {
    if (!conversationId || pagination.loading || !pagination.hasMore) return;
    void loadOlderMessages(conversationId);
  };

  const jumpToLatest = () => {
    nearBottomRef.current = true;
    setNewMessageCount(0);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    if (conversationId) void markConversationRead(conversationId);
  };

  const scrollToRow = useCallback((messageId: string) => {
    const index = rows.findIndex((row) => (row.message.serverId ?? row.message.id) === messageId);
    if (index < 0) return false;
    scrollRetryRef.current = null;
    listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
    return true;
  }, [rows]);

  const ensureMessageLoaded = workspace.ensureMessageLoaded;
  const scrollToSourceMessage = useCallback(async (messageId: string) => {
    if (scrollToRow(messageId)) return true;
    pendingSourceRef.current = messageId;
    const loaded = await ensureMessageLoaded(conversationId, messageId);
    if (!loaded) {
      pendingSourceRef.current = null;
      return false;
    }
    return true;
  }, [conversationId, ensureMessageLoaded, scrollToRow]);

  useEffect(() => {
    const pending = pendingSourceRef.current;
    if (pending && scrollToRow(pending)) pendingSourceRef.current = null;
  }, [rows, scrollToRow]);

  useEffect(() => {
    if (conversation?.managementOnly || !focusMessageId || !conversationId) return;
    const focusKey = `${conversationId}:${focusMessageId}`;
    if (appliedSearchFocusRef.current === focusKey) return;
    appliedSearchFocusRef.current = focusKey;
    void scrollToSourceMessage(focusMessageId).then((found) => {
      if (!found && appliedSearchFocusRef.current === focusKey) {
        appliedSearchFocusRef.current = '';
      }
    });
  }, [conversation?.managementOnly, conversationId, focusMessageId, scrollToSourceMessage]);

  const handleScrollToIndexFailed = (info: { index: number; averageItemLength: number }) => {
    // The row is not laid out yet: land near it, then retry once.
    const key = `${conversationId}:${info.index}`;
    if (scrollRetryRef.current === key) return;
    scrollRetryRef.current = key;
    listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
    setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 }), 120);
  };

  if (!currentUserId) {
    return (
      <View style={styles.emptyPane}>
        <EmptyState
          body={t('auth.securityNote')}
          icon="shield-checkmark-outline"
          title={t('status.loading')}
        />
      </View>
    );
  }

  if (!conversation) {
    return (
      <View style={styles.emptyPane}>
        <EmptyState
          body={t(isPersonalRealm(workspace.organizationId) ? 'chat.chooseBodyConsumer' : 'chat.chooseBody')}
          icon="chatbubbles-outline"
          title={t('chat.choose')}
        />
      </View>
    );
  }

  const submit = () => {
    if (!draft.trim() || composerDisabled) return;
    // A rejected send must never become a silent unhandled rejection.
    void Promise.resolve(onSend(draft, replyingTo ?? undefined, selectedMentionUserIds)).catch(() => undefined);
    notifyStopped();
    setDraft('');
    setReplyingTo(null);
    setSelectedMentionUserIds([]);
    setShowMentionPicker(false);
  };

  const handleChangeDraft = (value: string) => {
    setDraft(value);
    if (value.trim()) notifyTyping();
    else notifyStopped();
  };

  if (conversation.managementOnly) {
    const openManagement = () => {
      if (!conversation.canManageConversation) {
        router.push('/admin');
        return;
      }
      workspace.clearActionError();
      setConversationName(conversation.title);
      setConversationDescription(conversation.description ?? '');
      setShowControls(true);
    };
    return (
      <View style={styles.container}>
        <ConversationHeader
          conversation={conversation}
          mobile={mobile}
          onBack={onBack}
          onOpenControls={openManagement}
        />
        <View style={styles.managementOnlyPane}>
          <View style={styles.managementOnlyCard}>
            <StatusBadge label={t('chat.managementOnlyBadge')} tone="info" />
            <View style={styles.managementOnlyIcon}>
              <Ionicons name="shield-checkmark-outline" color={colors.mintDark} size={28} />
            </View>
            <Text style={styles.managementOnlyTitle}>{t('chat.managementOnlyTitle')}</Text>
            <Text style={styles.managementOnlyBody}>
              {t(conversation.canManageConversation
                ? 'chat.managementOnlyBody'
                : 'chat.managementOnlyDynamicBody')}
            </Text>
            <PrimaryButton
              icon="settings-outline"
              label={t(conversation.canManageConversation
                ? 'chat.managementOnlyOpen'
                : 'chat.managementOnlyOpenAdmin')}
              onPress={openManagement}
              tone="dark"
            />
          </View>
        </View>
        {conversation.canManageConversation ? (
          <ConversationControlsModal
            key={`${conversation.id}:${showControls ? 'open' : 'closed'}`}
            busy={workspace.actionBusy}
            conversation={conversation}
            currentUserId={currentUserId}
            description={conversationDescription}
            error={workspace.actionError}
            name={conversationName}
            onAddMember={workspace.addConversationMember}
            onArchive={async () => {
              if (await workspace.updateConversation(conversation.id, { isArchived: true })) setShowControls(false);
            }}
            onChangeDescription={setConversationDescription}
            onChangeName={setConversationName}
            onClose={() => setShowControls(false)}
            onCloseIncident={async (reason) => {
              if (await workspace.closeIncident(conversation.id, reason)) setShowControls(false);
            }}
            onRemoveMember={workspace.removeConversationMember}
            onUpdateMemberRole={workspace.updateConversationMemberRole}
            onLeave={async (replacementOwnerPersonId) => {
              if (await workspace.leaveConversation(conversation.id, replacementOwnerPersonId)) {
                setShowControls(false);
              }
            }}
            onSave={async () => {
              if (await workspace.updateConversation(conversation.id, {
                name: conversationName.trim(),
                description: conversationDescription.trim() || null,
              })) setShowControls(false);
            }}
            people={workspace.people}
            onToggleFavorite={() => void workspace.updateConversationPreferences(conversation.id, { isFavorite: !conversation.favorite })}
            onUpdateNotificationSettings={(notificationLevel, mutedUntil) =>
              workspace.updateConversationPreferences(conversation.id, { notificationLevel, mutedUntil })}
            onUpdateTranslationMode={(translationMode) =>
              workspace.updateConversationPreferences(conversation.id, { translationMode })}
            visible={showControls}
          />
        ) : null}
      </View>
    );
  }

  const openActions = (message: Message) => {
    workspace.clearActionError();
    setEditDraft(message.originalText);
    setSelectedMessage(message);
  };

  const renderRow = ({ item }: { item: TimelineRow }) => {
    const { message } = item;
    return (
      <View style={(message.serverId ?? message.id) === focusMessageId ? styles.searchTarget : undefined}>
        {item.showUnreadDivider ? (
          <View style={styles.unreadDivider}>
            <View style={styles.unreadDividerLine} />
            <Text style={styles.unreadDividerText}>{t('chat.unreadMessages')}</Text>
            <View style={styles.unreadDividerLine} />
          </View>
        ) : null}
        {item.showDateSeparator ? (
          <View style={styles.dateSeparator}>
            <View style={styles.dateSeparatorLine} />
            <Text style={styles.dateSeparatorText}>{message.dayLabel}</Text>
            <View style={styles.dateSeparatorLine} />
          </View>
        ) : null}
        {message.systemEvent ? <SystemEventRow message={message} /> : (
          <MessageBubble
            message={message}
            onDownload={() => void workspace.downloadAttachment(message)}
            onOpenActions={() => openActions(message)}
            showSender={item.showSender}
            translatedOnly={preferences.translatedOnly}
          />
        )}
      </View>
    );
  };

  return (
    <KeyboardAvoidingScreen extraOffset={mobile ? 0 : 24} style={styles.container}>
      <ConversationHeader
        conversation={conversation}
        mobile={mobile}
        onBack={onBack}
        onOpenControls={() => {
          workspace.clearActionError();
          setConversationName(conversation.title);
          setConversationDescription(conversation.description ?? '');
          setShowControls(true);
        }}
        onOpenSummary={() => {
          workspace.clearActionError();
          setShowSummary(true);
        }}
        typingLabel={typingLabel}
      />

      {conversation.priority === 'safety' ? (
        <View style={styles.safetyBanner}>
          <View style={styles.safetyIcon}>
            <Ionicons name="warning" color={colors.red} size={18} />
          </View>
          <View style={styles.safetyCopy}>
            <Text style={styles.safetyTitle}>{t('chat.safetyAcknowledgement')}</Text>
            <Text style={styles.safetyText}>
              {t('chat.safetyNoticeBody')}
            </Text>
          </View>
          <Pressable
            onPress={() => router.push('/updates')}
            style={({ pressed }) => [styles.acknowledge, pressed && styles.pressed]}>
            <Text style={styles.acknowledgeText}>{t('chat.openNotice')}</Text>
          </Pressable>
        </View>
      ) : null}

      {conversation.kind === 'incident' ? (
        <View style={[styles.incidentBanner, conversation.isReadOnly && styles.incidentBannerClosed]}>
          <Ionicons
            name={conversation.isReadOnly ? 'lock-closed-outline' : 'warning-outline'}
            color={conversation.isReadOnly ? colors.inkMuted : colors.red}
            size={18}
          />
          <View style={styles.incidentBannerCopy}>
            <Text style={styles.incidentBannerTitle}>
              {conversation.isReadOnly ? t('chat.incidentClosed') : t('chat.incidentActive')} · {conversation.incidentSeverity ?? t('chat.incidentUnclassified')}
            </Text>
            <Text style={styles.incidentBannerText}>
              {conversation.isReadOnly
                ? conversation.closureReason ?? t('chat.incidentClosedBody')
                : conversation.incidentClassification ?? t('chat.incidentActiveBody')}
            </Text>
          </View>
        </View>
      ) : null}

      {/* The workplace disclaimer stays for organizations; consumer threads do
          not carry it (owner request, Sep 4 2026). */}
      {conversation.translationMode !== 'off'
        && !isPersonalRealm(workspace.organizationId)
        && (conversation.translationPair || messages.some((message) => message.translationState !== 'not_requested')) ? (
        <View accessibilityRole="alert" style={styles.translationBoundary}>
          <Ionicons name="shield-checkmark-outline" color={colors.amber} size={17} />
          <Text style={styles.translationBoundaryText}>{t('chat.translationBoundary')}</Text>
        </View>
      ) : null}

      <View style={styles.timeline}>
        {awaitingFirstPage ? (
          <View accessibilityLabel={t('chat.loadingMessages')} accessibilityRole="progressbar" style={styles.timelineLoading}>
            <ActivityIndicator color={colors.mintDark} />
          </View>
        ) : rows.length ? (
          <FlatList
            contentContainerStyle={[styles.messageList, mobile && styles.messageListMobile]}
            data={rows}
            initialNumToRender={24}
            inverted
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            keyExtractor={rowKey}
            ListFooterComponent={pagination.hasMore ? (
              <Pressable
                accessibilityRole="button"
                disabled={pagination.loading}
                onPress={loadOlder}
                style={({ pressed }) => [styles.loadOlder, pressed && styles.pressed]}>
                {pagination.loading
                  ? <ActivityIndicator color={colors.mintDark} size="small" />
                  : <Ionicons name="time-outline" size={14} color={colors.mintDark} />}
                <Text style={styles.loadOlderText}>
                  {pagination.loading ? t('chat.loadingOlder') : t('chat.loadOlder')}
                </Text>
              </Pressable>
            ) : null}
            maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }}
            maxToRenderPerBatch={12}
            onEndReached={loadOlder}
            onEndReachedThreshold={0.6}
            onScroll={handleScroll}
            onScrollToIndexFailed={handleScrollToIndexFailed}
            ref={listRef}
            renderItem={renderRow}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
            windowSize={9}
          />
        ) : (
          <View style={styles.timelineEmpty}>
            <EmptyState
              action={(
                <StatusBadge
                  icon="lock-closed"
                  label={t(isPersonalRealm(workspace.organizationId) ? 'chat.privateConsumer' : 'chat.private')}
                />
              )}
              body={t('chat.startBody')}
              icon="sparkles-outline"
              title={t('chat.start')}
            />
          </View>
        )}
        <WorkspaceStatusBanner />
        {newMessageCount > 0 ? (
          <Pressable
            accessibilityRole="button"
            onPress={jumpToLatest}
            style={({ pressed }) => [styles.newMessageJump, pressed && styles.pressed]}>
            <Ionicons name="arrow-down" size={16} color={colors.white} />
            <Text style={styles.newMessageJumpText}>
              {newMessageCount} {t('chat.newMessages')}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <Composer
      currentUserId={currentUserId}
      disabled={composerDisabled}
      disabledLabel={conversation.isReadOnly
        ? t('chat.incidentReadOnly')
        : conversation.kind === 'direct'
          ? t('chat.directPostingUnavailable')
          : t('chat.adminsOnlyPosting')}
      draft={draft}
      enterSends={preferences.enterSends}
      memberUserIds={conversation.kind === 'direct' ? [] : conversation.memberIds ?? []}
      mobile={mobile}
      people={workspace.people}
      replyingTo={replyingTo}
      selectedMentionUserIds={selectedMentionUserIds}
      showMentionPicker={showMentionPicker}
      onChangeDraft={handleChangeDraft}
      onChangeMentionUserIds={setSelectedMentionUserIds}
      onChangeShowMentionPicker={setShowMentionPicker}
      onComposerBlur={notifyStopped}
      onSend={submit}
      onSendVoiceNote={(attachment) => {
        void workspace.sendAttachment(conversation.id, attachment, '');
      }}
      onCancelReply={() => setReplyingTo(null)}
      onAddAttachment={() => {
        if (composerDisabled) return;
        workspace.clearActionError();
        setSelectedAttachment(null);
        setAttachmentCaption('');
        setAttachmentImageMode('optimized');
        setShowAttachmentPicker(true);
      }}
      />

      <MessageActionsModal
        key={selectedMessage?.id ?? 'closed'}
        busy={workspace.actionBusy}
        editDraft={editDraft}
        error={workspace.actionError}
        message={selectedMessage}
        conversations={workspace.conversations}
        onChangeEditDraft={setEditDraft}
        onClose={() => setSelectedMessage(null)}
        onDelete={async () => {
          if (selectedMessage && await workspace.deleteMessage(selectedMessage)) setSelectedMessage(null);
        }}
        onHide={async () => {
          if (selectedMessage && await workspace.hideMessageForMe(selectedMessage)) setSelectedMessage(null);
        }}
        onForward={async (targetConversationId) => {
          if (selectedMessage && await workspace.forwardMessage(selectedMessage, targetConversationId)) {
            setSelectedMessage(null);
          }
        }}
        onProposeAction={async (actionTitle, actionDetails) => {
          if (selectedMessage && await workspace.proposeAction(selectedMessage, actionTitle, actionDetails)) {
            setSelectedMessage(null);
          }
        }}
        onEdit={async () => {
          if (selectedMessage && await workspace.editMessage(selectedMessage, editDraft)) setSelectedMessage(null);
        }}
        onReact={async (emoji) => {
          if (selectedMessage && await workspace.toggleReaction(selectedMessage, emoji)) setSelectedMessage(null);
        }}
        onReply={() => {
          if (selectedMessage) setReplyingTo(selectedMessage);
          setSelectedMessage(null);
        }}
        onCopy={async () => {
          if (!selectedMessage) return;
          await Clipboard.setStringAsync(selectedMessage.originalText);
          setSelectedMessage(null);
        }}
        onPin={async () => {
          if (selectedMessage && await workspace.setMessagePinned(selectedMessage, !selectedMessage.pinned)) {
            setSelectedMessage(null);
          }
        }}
        onProposeCorrection={() => {
          if (!selectedMessage) return;
          workspace.clearActionError();
          setCorrectingMessage(selectedMessage);
          setSelectedMessage(null);
        }}
        onReviewCorrection={() => {
          if (!selectedMessage) return;
          workspace.clearActionError();
          setReviewingMessage(selectedMessage);
          setSelectedMessage(null);
        }}
        onTranslate={selectedMessage && selectedMessage.isOwn && selectedMessage.serverId
          && workspace.messageDisplayLanguage
          && selectedMessage.languageDetection?.state === 'completed'
          && (selectedMessage.languageDetection.detectedLanguage !== workspace.messageDisplayLanguage
            || Boolean(selectedMessage.languageDetection.method?.endsWith(':sender-language')))
          && !(selectedMessage.translatedText && selectedMessage.translation?.status === 'completed')
          ? () => {
            // Owner request: a sender can ask for their own message in their
            // display language from the actions sheet (long-press).
            void workspace.requestTranslation(selectedMessage);
            setSelectedMessage(null);
          }
          : null}
      />
      {correctingMessage ? (
        <TranslationCorrectionModal message={correctingMessage} onClose={() => setCorrectingMessage(null)} />
      ) : null}
      {reviewingMessage ? (
        <TranslationReviewModal message={reviewingMessage} onClose={() => setReviewingMessage(null)} />
      ) : null}
      <ConversationControlsModal
        key={`${conversation.id}:${showControls ? 'open' : 'closed'}`}
        busy={workspace.actionBusy}
        conversation={conversation}
        currentUserId={currentUserId}
        description={conversationDescription}
        error={workspace.actionError}
        name={conversationName}
        onAddMember={workspace.addConversationMember}
        onArchive={async () => {
          if (await workspace.updateConversation(conversation.id, { isArchived: true })) setShowControls(false);
        }}
        onChangeDescription={setConversationDescription}
        onChangeName={setConversationName}
        onClose={() => setShowControls(false)}
        onOpenSummary={() => {
          setShowControls(false);
          setShowSummary(true);
        }}
        onCloseIncident={async (reason) => {
          if (await workspace.closeIncident(conversation.id, reason)) setShowControls(false);
        }}
        onRemoveMember={workspace.removeConversationMember}
        onUpdateMemberRole={workspace.updateConversationMemberRole}
        onLeave={async (replacementOwnerPersonId) => {
          if (await workspace.leaveConversation(conversation.id, replacementOwnerPersonId)) {
            setShowControls(false);
          }
        }}
        onSave={async () => {
          if (await workspace.updateConversation(conversation.id, {
            name: conversationName.trim(),
            description: conversationDescription.trim() || null,
          })) setShowControls(false);
        }}
        people={workspace.people}
        onToggleFavorite={() => void workspace.updateConversationPreferences(conversation.id, { isFavorite: !conversation.favorite })}
        onUpdateNotificationSettings={(notificationLevel, mutedUntil) =>
          workspace.updateConversationPreferences(conversation.id, { notificationLevel, mutedUntil })}
        onUpdateTranslationMode={(translationMode) =>
          workspace.updateConversationPreferences(conversation.id, { translationMode })}
        visible={showControls}
      />
      <SummarySheet
        key={`${conversation.id}:${showSummary ? 'open' : 'closed'}`}
        conversation={conversation}
        messages={messages}
        onClose={() => setShowSummary(false)}
        onReportError={(summaryId) => {
          // One system modal at a time: the sheet yields to the report form.
          setShowSummary(false);
          setReportingSummaryId(summaryId);
        }}
        visible={showSummary}
      />
      {reportingSummaryId ? (
        <AiOutputErrorReportModal
          onClose={() => setReportingSummaryId(null)}
          outputKind="summary"
          targetId={reportingSummaryId}
          visible
        />
      ) : null}
      <AttachmentPickerModal
        busy={workspace.actionBusy === 'attachment-upload'}
        caption={attachmentCaption}
        error={workspace.actionError}
        onChangeCaption={setAttachmentCaption}
        onClose={() => setShowAttachmentPicker(false)}
        onPickCamera={async () => {
          const permission = await ImagePicker.requestCameraPermissionsAsync();
          if (!permission.granted) return;
          const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 0.9 });
          const asset = result.assets?.[0];
          if (asset) {
            const video = asset.type === 'video' || asset.mimeType?.startsWith('video/') === true;
            setSelectedAttachment({
              uri: asset.uri,
              name: asset.fileName ?? (video ? `video-${Date.now()}.mp4` : `photo-${Date.now()}.jpg`),
              mimeType: asset.mimeType ?? (video ? 'video/mp4' : 'image/jpeg'),
              size: asset.fileSize,
              width: asset.width,
              height: asset.height,
            });
          }
        }}
        onPickFile={async () => {
          const result = await DocumentPicker.getDocumentAsync({
            type: [...attachmentMimeTypes],
            copyToCacheDirectory: true,
            multiple: false,
          });
          const asset = result.assets?.[0];
          if (asset) setSelectedAttachment({
            uri: asset.uri,
            name: asset.name,
            mimeType: asset.mimeType ?? 'application/octet-stream',
            size: asset.size,
          });
        }}
        onPickLibrary={async () => {
          const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!permission.granted) return;
          const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.9 });
          const asset = result.assets?.[0];
          if (asset) {
            const video = asset.type === 'video' || asset.mimeType?.startsWith('video/') === true;
            setSelectedAttachment({
              uri: asset.uri,
              name: asset.fileName ?? (video ? `video-${Date.now()}.mp4` : `media-${Date.now()}`),
              mimeType: asset.mimeType ?? (video ? 'video/mp4' : 'image/jpeg'),
              size: asset.fileSize,
              width: asset.width,
              height: asset.height,
            });
          }
        }}
        onSend={async () => {
          if (!selectedAttachment) return;
          if (await workspace.sendAttachment(conversation.id, { ...selectedAttachment, imageMode: attachmentImageMode }, attachmentCaption)) {
            setShowAttachmentPicker(false);
          }
        }}
        selected={selectedAttachment}
        imageMode={attachmentImageMode}
        onChangeImageMode={setAttachmentImageMode}
        visible={showAttachmentPicker}
      />
    </KeyboardAvoidingScreen>
  );
}

function ConversationHeader({
  conversation,
  onBack,
  onOpenControls,
  onOpenSummary,
  mobile,
  typingLabel,
}: {
  conversation: Conversation;
  onBack?: () => void;
  onOpenControls: () => void;
  onOpenSummary?: () => void;
  mobile: boolean;
  typingLabel?: string;
}) {
  const { t } = useI18n();
  const workspace = useWorkspace();
  // One meta line: the @handle for a direct chat, the member count for a
  // group, the typing peer while someone types; the language pair rides at the
  // end as a tiny tag (owner review: no roles, no translation bar).
  const counterpart = conversation.kind === 'direct' && conversation.directParticipantId
    ? workspace.people.find((person) => person.id === conversation.directParticipantId)
    : undefined;
  const handle = counterpart?.username?.trim();
  const memberCount = conversation.kind !== 'direct'
    ? conversation.participantCount ?? conversation.memberIds?.length
    : undefined;
  const meta = typingLabel
    ?? (conversation.kind === 'direct'
      ? handle ? `@${handle}` : conversation.presence === 'online' ? t('chat.activeNow') : conversation.subtitle
      : memberCount
        ? t('chat.memberCount').replace('{count}', String(memberCount))
        : conversation.subtitle);
  return (
    <View style={[styles.header, mobile && styles.headerMobile]}>
      {mobile ? (
        <IconButton name="chevron-back" label={t('chat.back')} onPress={onBack} size={36} />
      ) : null}
      <Avatar
        color={conversation.avatarColor}
        icon={conversation.kind === 'announcement' ? 'megaphone' : undefined}
        imageUri={workspace.conversationAvatarUrls[conversation.id]}
        initials={conversation.initials}
        presence={conversation.kind === 'direct' ? conversation.presence : undefined}
        size={mobile ? 36 : 40}
      />
      <View style={styles.headerCopy}>
        <View style={styles.headerTitleRow}>
          <Text numberOfLines={1} style={styles.headerTitle}>
            {conversation.title}
          </Text>
          {conversation.kind === 'announcement' ? (
            <Ionicons name="checkmark-circle" size={15} color={colors.blue} />
          ) : null}
        </View>
        <View style={styles.headerMetaRow}>
          <Text numberOfLines={1} style={[styles.headerMeta, typingLabel && styles.headerMetaTyping]}>
            {meta}
          </Text>
          {conversation.translationPair ? (
            <>
              <View style={styles.metaDot} />
              <Text style={styles.translationPair}>{conversation.translationPair}</Text>
            </>
          ) : null}
        </View>
      </View>
      <View style={styles.headerActions}>
        {onOpenSummary ? (
          <IconButton name="sparkles-outline" label={t('chat.summarize')} onPress={onOpenSummary} size={36} />
        ) : null}
        <IconButton
          name="ellipsis-horizontal"
          label={t('chat.conversationSettings')}
          onPress={onOpenControls}
          size={36}
        />
      </View>
    </View>
  );
}

function SystemEventRow({ message }: { message: Message }) {
  const workspace = useWorkspace();
  const { t } = useI18n();
  const event = message.systemEvent;
  if (!event) return null;
  const targetName = event.targetUserId
    ? workspace.people.find((person) => person.id === event.targetUserId)?.displayName
      ?? t(isPersonalRealm(workspace.organizationId) ? 'chat.companyMemberConsumer' : 'chat.companyMember')
    : '';
  const label = event.eventType === 'conversation.posting.admins_only'
    ? t('chat.systemPostingAdminsOnly')
    : event.eventType === 'conversation.posting.all_members'
      ? t('chat.systemPostingAllMembers')
      : event.eventType === 'conversation.join.approved'
        ? `${targetName} ${t('chat.systemJoinApproved')}`
        : event.eventType === 'conversation.created'
          ? t('chat.systemConversationCreated')
          : event.eventType === 'conversation.member.added'
            ? `${targetName} ${t('chat.systemMemberAdded')}`
            : event.eventType === 'conversation.member.removed'
              ? `${targetName} ${t('chat.systemMemberRemoved')}`
              : event.eventType === 'conversation.member.role_changed'
                ? `${targetName} ${t('chat.systemMemberRoleChanged')}`
                : event.eventType === 'conversation.avatar.changed'
                  ? t('chat.systemAvatarChanged')
                  : t('chat.systemAvatarRemoved');
  return (
    <View accessibilityRole="text" style={styles.systemEventRow}>
      <View style={styles.systemEventLine} />
      <View style={styles.systemEventPill}>
        <Ionicons name="information-circle-outline" size={14} color={colors.inkMuted} />
        <Text style={styles.systemEventText}>{label}</Text>
      </View>
      <View style={styles.systemEventLine} />
    </View>
  );
}

function MessageBubble({
  message,
  showSender,
  translatedOnly,
  onOpenActions,
  onDownload,
}: {
  message: Message;
  showSender: boolean;
  translatedOnly: boolean;
  onOpenActions: () => void;
  onDownload: () => void;
}) {
  const workspace = useWorkspace();
  const { locale, t } = useI18n();
  const { width: windowWidth } = useWindowDimensions();
  const [originalOpen, setOriginalOpen] = useState(false);
  const translationConversation = workspace.conversations.find(
    (conversation) => conversation.id === message.conversationId,
  );
  const group = translationConversation?.kind !== 'direct';
  const translationEnabled = translationConversation?.translationMode !== 'off';
  const translation = translationEnabled ? message.translation : undefined;
  const visibleTranslationState = translationEnabled ? message.translationState : 'not_requested';
  const hasTranslation = Boolean(message.translatedText && translation?.status === 'completed');
  // A reader can ask for (or retry) a translation when there is none to show:
  // detection failed (the server re-runs it), the row failed or was blocked,
  // or nothing was ever queued (received while translation was off). Own
  // messages and messages already in the display language never qualify.
  // Automatic mode does not backfill, so the link stays available there.
  const detectionState = message.languageDetection?.state;
  // A message whose language could not be determined completed as the
  // sender's language (method suffixed ':sender-language'); it may hold other
  // languages, so a reader who shares that language can still ask for it in
  // their own (owner request, mixed-language messages).
  const mixedLanguage = detectionState === 'completed'
    && Boolean(message.languageDetection?.method?.endsWith(':sender-language'));
  const canRequestTranslation = Boolean(
    translationEnabled
      && message.serverId
      && !message.isOwn
      && workspace.messageDisplayLanguage !== null
      && (
        detectionState === 'failed'
        || mixedLanguage
        || (detectionState === 'completed'
          && message.languageDetection?.detectedLanguage !== workspace.messageDisplayLanguage)
      )
      && (!translation || translation.status === 'failed' || translation.status === 'blocked'),
  );
  // No spamming: 30 seconds between taps on one message, three taps at most
  // while this bubble is mounted; the server rate-limits on top of this.
  const [retryGate, setRetryGate] = useState({ count: 0, until: 0 });
  const [retryNow, setRetryNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryGate.until <= Date.now()) return undefined;
    const timer = setInterval(() => setRetryNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryGate.until]);
  const retryExhausted = retryGate.count >= 3;
  const retryCooling = retryGate.until > retryNow;
  const retryBlocked = retryExhausted || retryCooling;
  const requestTranslationGated = () => {
    if (retryBlocked) return;
    setRetryGate((gate) => ({ count: gate.count + 1, until: Date.now() + 30_000 }));
    setRetryNow(Date.now());
    void workspace.requestTranslation(message);
  };
  const gatedLabel = (idle: string) => (retryExhausted
    ? t('chat.retryTranslationLimit')
    : retryCooling
      ? t('chat.retryTranslationWait').replace('{seconds}', String(Math.max(1, Math.ceil((retryGate.until - retryNow) / 1000))))
      : idle);
  const translationPending = translationEnabled && !hasTranslation
    && (visibleTranslationState === 'queued' || visibleTranslationState === 'translating');
  const translationUnavailable = translationEnabled && !hasTranslation && !translationPending
    && (visibleTranslationState === 'failed'
      || visibleTranslationState === 'blocked'
      || visibleTranslationState === 'needs_review'
      || translation?.status === 'failed'
      || translation?.status === 'blocked');
  const aggregateReceipt = message.receipt?.scope === 'aggregate' ? message.receipt : null;
  const receiptStateLabel = message.deliveryState === 'pending'
    ? t('chat.receiptPending')
    : message.deliveryState === 'failed'
      ? t('chat.failed')
      : message.deliveryState === 'read'
        ? t('chat.receiptRead')
        : message.deliveryState === 'delivered'
          ? t('chat.receiptDelivered')
          : t('chat.receiptSent');
  const aggregateLabel = aggregateReceipt
    ? `${aggregateReceipt.deliveredCount}/${aggregateReceipt.recipientCount} ${t('chat.receiptDelivered')}`
      + (aggregateReceipt.visibleReadEligibleCount > 0
        ? ` · ${aggregateReceipt.visibleReadCount}/${aggregateReceipt.visibleReadEligibleCount} ${t('chat.receiptReadVisible')}`
        : ` · ${t('chat.receiptReadPrivate')}`)
    : receiptStateLabel;
  const mention = mentionCopy(locale);
  const currentUserId = workspace.currentUser?.id ?? null;
  const mentionedMe = currentUserId !== null && message.mentionUserIds?.includes(currentUserId) === true;
  const mentionedNames = (message.mentionUserIds ?? []).map((userId) => {
    if (currentUserId !== null && userId === currentUserId) return mention.you;
    return workspace.people.find((person) => person.id === userId)?.displayName ?? mention.member;
  });
  const attachment = message.attachment;
  const caption = message.originalText.trim();
  const imageAttachment = attachment?.kind === 'image';
  const inlineVideo = attachment ? isVideoAttachment(attachment) && attachmentReady(attachment) : false;
  // A photo without a caption is just the photo; its time rides on the image.
  const mediaOnly = imageAttachment && !caption;
  const maxMedia = mediaMaxWidth(windowWidth, !message.isOwn);
  const showTranslationOnly = translatedOnly && hasTranslation;
  const tickName = message.deliveryState === 'pending'
    ? 'time-outline'
    : message.deliveryState === 'failed'
      ? 'alert-circle-outline'
      : message.deliveryState === 'sent'
        ? 'checkmark'
        : 'checkmark-done';
  const tickColor = message.deliveryState === 'failed'
    ? colors.red
    : message.deliveryState === 'read'
      ? colors.blue
      : colors.inkSubtle;

  const meta = (overlay: boolean) => (
    <View style={[styles.metaRow, overlay && styles.metaRowOverlay]}>
      {showTranslationOnly ? (
        <Pressable
          accessibilityLabel={t(originalOpen ? 'chat.hideOriginal' : 'chat.showOriginal')}
          accessibilityRole="button"
          accessibilityState={{ expanded: originalOpen }}
          hitSlop={6}
          onPress={() => setOriginalOpen((value) => !value)}
          style={({ pressed }) => [styles.metaAction, pressed && styles.pressed]}>
          <Text style={styles.metaActionText}>{t('chat.originalToggle')}</Text>
        </Pressable>
      ) : null}
      <View
        accessibilityLabel={message.isOwn ? aggregateLabel : undefined}
        accessible={message.isOwn}
        style={styles.timeRow}>
        {message.edited ? (
          <Text style={[styles.timeText, overlay && styles.timeTextOverlay]}>{t('chat.edited')}</Text>
        ) : null}
        <Text style={[styles.timeText, overlay && styles.timeTextOverlay]}>{message.sentAt}</Text>
        {message.isOwn ? (
          <Ionicons name={tickName} size={14} color={overlay ? colors.white : tickColor} />
        ) : null}
      </View>
    </View>
  );

  const translationLine = translationPending ? (
    <Text style={styles.quietLine}>{t('chat.translating')}</Text>
  ) : translationUnavailable ? (
    <View style={styles.quietRow}>
      <Text style={styles.quietLine}>{t('chat.translationUnavailable')}</Text>
      {canRequestTranslation ? (
        <>
          <Text style={styles.quietLine}>·</Text>
          <Pressable
            accessibilityLabel={t('chat.retryTranslation')}
            accessibilityRole="button"
            accessibilityState={{ disabled: retryBlocked }}
            disabled={retryBlocked}
            hitSlop={6}
            onPress={requestTranslationGated}
            style={({ pressed }) => [styles.quietActionHit, pressed && styles.pressed]}>
            <Text style={[styles.quietAction, retryBlocked && styles.quietActionDisabled]}>
              {gatedLabel(t('chat.retry'))}
            </Text>
          </Pressable>
        </>
      ) : null}
    </View>
  ) : canRequestTranslation ? (
    <Pressable
      accessibilityLabel={t('chat.requestTranslation')}
      accessibilityRole="button"
      accessibilityState={{ disabled: retryBlocked }}
      disabled={retryBlocked}
      hitSlop={6}
      onPress={requestTranslationGated}
      style={({ pressed }) => [styles.quietRow, styles.quietActionHit, pressed && styles.pressed]}>
      <Text style={[styles.quietAction, retryBlocked && styles.quietActionDisabled]}>
        {gatedLabel(t('chat.requestTranslation'))}
      </Text>
    </Pressable>
  ) : null;

  return (
    <View style={[styles.messageRow, message.isOwn && styles.messageRowOwn]}>
      {!message.isOwn && group ? (
        <View style={styles.messageAvatarSlot}>
          {showSender ? (
            <Avatar color={message.senderColor} initials={message.senderInitials} size={28} />
          ) : null}
        </View>
      ) : null}
      <View style={[styles.messageStack, message.isOwn && styles.messageStackOwn]}>
        {showSender ? <Text style={styles.senderName}>{message.senderName}</Text> : null}
        <Pressable
          // Not an accessibility element itself: iOS would otherwise flatten the whole
          // bubble into one node and hide the controls inside it from VoiceOver.
          accessible={false}
          onLongPress={onOpenActions}
          style={[
            styles.bubble,
            message.isOwn ? styles.bubbleOwn : styles.bubbleIncoming,
            mediaOnly && styles.bubbleMedia,
            mentionedMe && styles.bubbleMentioned,
            message.priority === 'safety' && styles.bubbleSafety,
          ]}>
          {message.priority !== 'normal' ? (
            <View style={[styles.priorityRow, mediaOnly && styles.mediaTrailer]}>
              <Ionicons
                name={message.priority === 'safety' ? 'warning' : 'alert-circle'}
                size={12}
                color={colors.red}
              />
              <Text style={styles.priorityText}>
                {message.priority === 'safety' ? t('chat.safety') : t('chat.important')}
              </Text>
            </View>
          ) : null}

          {message.forwarded ? (
            <View style={[styles.priorityRow, mediaOnly && styles.mediaTrailer]}>
              <Ionicons name="arrow-redo-outline" size={12} color={colors.inkSubtle} />
              <Text style={[styles.priorityText, styles.forwardedText]}>{t('chat.forwarded')}</Text>
            </View>
          ) : null}

          {message.replyTo ? (
            <View style={styles.reply}>
              <Text style={styles.replySender}>{message.replyTo.senderName}</Text>
              <Text numberOfLines={1} style={styles.replyPreview}>{message.replyTo.preview}</Text>
            </View>
          ) : null}

          {mentionedNames.length ? (
            <View
              accessibilityLabel={`${mention.mentioned}: ${mentionedNames.join(', ')}`}
              style={[styles.messageMentions, mediaOnly && styles.mediaTrailer]}>
              <Ionicons name="at-circle-outline" size={12} color={colors.mintDark} />
              <Text style={styles.messageMentionsText}>
                {mentionedNames.map((name) => `@${name}`).join('  ')}
              </Text>
            </View>
          ) : null}

          {attachment ? (
            isPlayableAudioAttachment(attachment) ? (
              <AudioAttachmentBubble message={message} />
            ) : imageAttachment ? (
              <ImageAttachment
                footer={mediaOnly ? meta(true) : undefined}
                maxWidth={maxMedia}
                message={message}
                onDownload={onDownload}
              />
            ) : inlineVideo ? (
              <VideoMessageAttachment maxWidth={maxMedia} message={message} onDownload={onDownload} />
            ) : (
              <AttachmentCard message={message} onDownload={onDownload} />
            )
          ) : null}

          {showTranslationOnly ? (
            <>
              <Text accessibilityHint={t('chat.longPressActions')} style={styles.messageText}>
                {message.translatedText}
              </Text>
              {originalOpen ? (
                <View style={styles.translationBlock}>
                  <Text style={styles.secondaryText}>{message.originalText}</Text>
                </View>
              ) : null}
            </>
          ) : (
            <>
              {caption ? (
                <Text accessibilityHint={t('chat.longPressActions')} style={styles.messageText}>
                  {message.originalText}
                </Text>
              ) : null}
              {hasTranslation ? (
                <View style={styles.translationBlock}>
                  <Text style={styles.messageText}>{message.translatedText}</Text>
                </View>
              ) : caption ? translationLine : null}
            </>
          )}

          {message.deliveryState === 'failed' ? (
            <View style={[styles.quietRow, mediaOnly && styles.mediaTrailer]}>
              <Ionicons name="alert-circle-outline" size={12} color={colors.red} />
              <Text style={styles.failedLine}>
                {message.failureReason ? `${t('chat.failed')} · ${message.failureReason}` : t('chat.failed')}
              </Text>
            </View>
          ) : null}

          {mediaOnly ? null : meta(false)}
        </Pressable>

        {message.reactions?.length ? (
          <View style={[styles.reactions, message.isOwn && styles.reactionsOwn]}>
            {message.reactions.map((reaction) => (
              <View
                key={reaction.emoji}
                style={[styles.reaction, reaction.reactedByMe && styles.reactionMine]}>
                <Text style={styles.reactionEmoji}>{reaction.emoji}</Text>
                <Text style={styles.reactionCount}>{reaction.count}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Language and translation provenance, reachable from the actions sheet. */
function TranslationDetails({ message }: { message: Message }) {
  const workspace = useWorkspace();
  const { t } = useI18n();
  const conversation = workspace.conversations.find((item) => item.id === message.conversationId);
  const translationEnabled = conversation?.translationMode !== 'off';
  const translation = translationEnabled ? message.translation : undefined;
  const state = translationEnabled ? message.translationState : 'not_requested';
  const detection = message.languageDetection;
  const correction = translation?.correction;
  const notAvailable = t('chat.notAvailable');
  const stateLabel = ({
    not_requested: t('chat.translationNotRequested'),
    queued: t('chat.translationQueued'),
    translating: t('chat.translationProcessing'),
    translated: t('chat.machineTranslation'),
    corrected: t('chat.correctedTranslation'),
    human_reviewed: t('chat.humanReviewedTranslation'),
    blocked: t('chat.translationBlocked'),
    needs_review: t('chat.translationNeedsReview'),
    failed: t('chat.translationFailed'),
  })[state];
  const detectionLabel = detection?.state === 'completed'
    ? `${t('chat.detectedLanguage')} · ${detection.detectedLanguage?.toUpperCase()}`
    : detection?.state === 'ambiguous'
      ? t('chat.languageAmbiguous')
      : detection?.state === 'failed'
        ? t('chat.languageDetectionFailed')
        : detection?.state === 'pending'
          ? t('chat.languageDetectionPending')
          : t('chat.languageNotApplicable');
  return (
    <View style={styles.detailsBlock}>
      <Text style={styles.detailText}>
        {detectionLabel}
        {detection?.confidence !== null && detection?.confidence !== undefined ? ` · ${Math.round(detection.confidence * 100)}%` : ''}
        {detection?.method ? ` · ${detection.method}` : ''}
      </Text>
      <Text style={styles.detailText}>{stateLabel}</Text>
      {translation ? (
        <>
          <Text style={styles.detailText}>
            {t('chat.sourceLanguage')} · {translation.sourceLanguage.toUpperCase()} · {t('chat.targetLanguage')} · {translation.targetLanguage.toUpperCase()}
          </Text>
          <Text style={styles.detailText}>
            {t('chat.machineRoute')} · {translation.provider ?? notAvailable} / {translation.model ?? notAvailable}
          </Text>
          <Text style={styles.detailText}>{t('chat.detector')} · {detection?.method ?? notAvailable}</Text>
          <Text selectable style={styles.detailHash}>
            {t('chat.sourceFingerprint')} · {translation.sourceBodySha256}
          </Text>
          <Text style={styles.detailText}>
            {t('chat.policyVersion')} · {translation.policyVersion ?? notAvailable} · {translation.updatedAt}
          </Text>
          {translation.reviewedAt ? (
            <Text style={styles.detailText}>
              {t('chat.humanReviewed')} · {translation.reviewedByUserId ?? notAvailable} · {translation.reviewedAt}
            </Text>
          ) : null}
          {translation.failureCode ? (
            <Text selectable style={styles.detailText}>{t('chat.failureCode')} · {translation.failureCode}</Text>
          ) : null}
          {translation.policyState === 'stale' ? (
            <Text style={styles.detailWarning}>{t('chat.translationPolicyStale')}</Text>
          ) : null}
          {correction?.status === 'approved' ? (
            <Text style={styles.detailText}>
              {t('chat.reviewedCorrection')}
              {correction.reviewedByUserId ? ` · ${correction.reviewedByUserId}` : ''}
              {correction.reviewedAt ? ` · ${correction.reviewedAt}` : ''}
            </Text>
          ) : correction?.status === 'pending' ? (
            <Text style={styles.detailText}>{t('chat.correctionPendingReview')}</Text>
          ) : null}
        </>
      ) : detection?.state === 'ambiguous' ? (
        <Text style={styles.detailText}>{t('chat.ambiguousOriginalAvailable')}</Text>
      ) : null}
    </View>
  );
}

function TranslationCorrectionModal({ message, onClose }: { message: Message; onClose: () => void }) {
  const workspace = useWorkspace();
  const { t } = useI18n();
  const [correctionText, setCorrectionText] = useState(message.translatedText ?? '');
  const [correctionRationale, setCorrectionRationale] = useState('');
  return (
    <ActionModal onClose={onClose} title={t('chat.proposeCorrection')} visible>
      <View style={styles.canonicalOriginalModal}>
        <Text style={styles.modalLabel}>{t('chat.originalToggle')}</Text>
        <Text selectable style={styles.canonicalOriginalText}>{message.originalText}</Text>
      </View>
      <FormField label={t('chat.correctedTranslation')} multiline onChangeText={setCorrectionText} value={correctionText} />
      <FormField label={t('chat.correctionRationale')} multiline onChangeText={setCorrectionRationale} value={correctionRationale} />
      <ActionError message={workspace.actionError} />
      <PrimaryButton
        disabled={!correctionText.trim() || correctionText.trim() === message.translatedText?.trim()}
        label={t('chat.submitCorrection')}
        loading={message.serverId ? workspace.actionBusy === `translation-correction:${message.serverId}` : false}
        onPress={async () => {
          if (await workspace.proposeTranslationCorrection(message, correctionText, correctionRationale)) onClose();
        }}
        tone="dark"
      />
    </ActionModal>
  );
}

function TranslationReviewModal({ message, onClose }: { message: Message; onClose: () => void }) {
  const workspace = useWorkspace();
  const { t } = useI18n();
  const [reviewNote, setReviewNote] = useState('');
  const correction = message.translation?.correction;
  const loading = correction ? workspace.actionBusy === `translation-review:${correction.id}` : false;
  return (
    <ActionModal description={correction?.correctedText ?? ''} onClose={onClose} title={t('chat.reviewCorrection')} visible>
      {correction?.rationale ? <Text style={styles.modalNote}>{correction.rationale}</Text> : null}
      <FormField label={t('chat.reviewNote')} multiline onChangeText={setReviewNote} value={reviewNote} />
      <ActionError message={workspace.actionError} />
      <View style={styles.modalRow}>
        <PrimaryButton
          label={t('chat.approveCorrection')}
          loading={loading}
          onPress={async () => {
            if (await workspace.reviewTranslationCorrection(message, 'approved', reviewNote)) onClose();
          }}
          tone="dark"
        />
        <PrimaryButton
          disabled={reviewNote.trim().length < 3}
          label={t('chat.requestChanges')}
          loading={loading}
          onPress={async () => {
            if (await workspace.reviewTranslationCorrection(message, 'changes_requested', reviewNote)) onClose();
          }}
          tone="light"
        />
        <PrimaryButton
          disabled={reviewNote.trim().length < 3}
          label={t('chat.rejectCorrection')}
          loading={loading}
          onPress={async () => {
            if (await workspace.reviewTranslationCorrection(message, 'rejected', reviewNote)) onClose();
          }}
          tone="danger"
        />
      </View>
    </ActionModal>
  );
}

function AiOutputErrorReportModal({
  outputKind,
  targetId,
  visible,
  onClose,
}: {
  outputKind: 'translation' | 'summary';
  targetId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const workspace = useWorkspace();
  const { t } = useI18n();
  const categories: AiOutputErrorCategory[] = outputKind === 'translation'
    ? ['incorrect_meaning', 'omitted_context', 'terminology', 'unsafe_wording', 'wrong_language', 'other']
    : ['unsupported_claim', 'missing_source', 'incorrect_action', 'omitted_context', 'unsafe_wording', 'other'];
  const [category, setCategory] = useState<AiOutputErrorCategory>(categories[0]);
  const [details, setDetails] = useState('');
  const [highConsequence, setHighConsequence] = useState(false);
  const [qualityUseConsent, setQualityUseConsent] = useState(false);
  const categoryLabels: Record<AiOutputErrorCategory, string> = {
    incorrect_meaning: t('quality.categoryIncorrectMeaning'),
    omitted_context: t('quality.categoryOmittedContext'),
    terminology: t('quality.categoryTerminology'),
    unsafe_wording: t('quality.categoryUnsafeWording'),
    wrong_language: t('quality.categoryWrongLanguage'),
    unsupported_claim: t('quality.categoryUnsupportedClaim'),
    missing_source: t('quality.categoryMissingSource'),
    incorrect_action: t('quality.categoryIncorrectAction'),
    other: t('quality.categoryOther'),
  };
  return (
    <ActionModal
      description={t('quality.reportDescription')}
      onClose={onClose}
      title={outputKind === 'translation' ? t('chat.reportTranslationError') : t('chat.reportSummaryError')}
      visible={visible}>
      <View style={styles.reportDisclosure}>
        <View style={styles.reportDisclosureHeader}>
          <Ionicons name="shield-checkmark-outline" size={16} color={colors.amber} />
          <Text style={styles.reportDisclosureTitle}>{t('quality.separateWorkflow')}</Text>
        </View>
        <Text style={styles.reportDisclosureText}>{t('quality.originalsUnchanged')}</Text>
      </View>
      <Text style={styles.modalLabel}>{t('quality.category')}</Text>
      <View style={styles.modalRow}>
        {categories.map((value) => (
          <Chip key={value} label={categoryLabels[value]} onPress={() => setCategory(value)} selected={category === value} />
        ))}
      </View>
      <FormField label={t('quality.whatWentWrong')} multiline onChangeText={setDetails} value={details} />
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: highConsequence }}
        onPress={() => setHighConsequence((value) => !value)}
        style={[styles.reportConsent, highConsequence && styles.reportConsentChecked]}>
        <Ionicons name={highConsequence ? 'checkbox' : 'square-outline'} size={20} color={colors.mintDark} />
        <Text style={styles.reportConsentText}>{t('quality.highConsequence')}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: qualityUseConsent }}
        onPress={() => setQualityUseConsent((value) => !value)}
        style={[styles.reportConsent, qualityUseConsent && styles.reportConsentChecked]}>
        <Ionicons name={qualityUseConsent ? 'checkbox' : 'square-outline'} size={20} color={colors.mintDark} />
        <Text style={styles.reportConsentText}>{t('quality.consentOptional')}</Text>
      </Pressable>
      <Text style={styles.modalNote}>{t('quality.consentExplanation')}</Text>
      <ActionError message={workspace.actionError} />
      <PrimaryButton
        disabled={details.trim().length < 3}
        label={t('quality.submitReport')}
        loading={workspace.actionBusy === `ai-output-report:${outputKind}`}
        onPress={async () => {
          const submitted = await workspace.reportAiOutputError({
            outputKind,
            translationId: outputKind === 'translation' ? targetId : null,
            summaryId: outputKind === 'summary' ? targetId : null,
            category,
            details,
            highConsequence,
            qualityUseConsent,
          });
          if (submitted) {
            setDetails('');
            setHighConsequence(false);
            setQualityUseConsent(false);
            onClose();
          }
        }}
        tone="dark"
      />
    </ActionModal>
  );
}

// Consumer attachments carry no download URL of their own (a signed URL is
// granted on demand, like image previews), so playability depends on the
// audio type and the clean state only (media-03/04: voice notes rendered as a
// plain file card with no play button).
function isPlayableAudioAttachment(attachment: Attachment) {
  return attachment.mimeType?.startsWith('audio/') === true
    && attachment.status === 'clean'
    && (!attachment.transfer || attachment.transfer.state === 'uploaded');
}

function formatPlaybackTime(seconds: number) {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function AudioAttachmentBubble({ message }: { message: Message }) {
  const { t } = useI18n();
  const workspace = useWorkspace();
  const attachment = message.attachment;
  const grantedUrl = attachment ? workspace.attachmentPreviewUrls?.[attachment.id] : undefined;
  const loadPreview = workspace.loadAttachmentPreview;
  useEffect(() => {
    if (attachment && !attachment.downloadUrl && !grantedUrl) void loadPreview?.(message);
  }, [attachment, grantedUrl, loadPreview, message]);
  const player = useAudioPlayer(attachment?.downloadUrl ?? grantedUrl ?? null);
  const status = useAudioPlayerStatus(player);
  const playing = status?.playing === true;
  const duration = status?.duration ?? 0;
  const currentTime = status?.currentTime ?? 0;
  if (!attachment) return null;
  const togglePlayback = () => {
    if (playing) {
      player.pause();
      return;
    }
    if (duration > 0 && currentTime >= duration) void player.seekTo(0);
    player.play();
  };
  return (
    <View style={[styles.voiceBubble, message.isOwn && styles.voiceBubbleOwn]}>
      <Pressable
        accessibilityLabel={playing ? t('chat.pauseVoiceNote') : t('chat.playVoiceNote')}
        accessibilityRole="button"
        onPress={togglePlayback}
        style={({ pressed }) => [
          styles.voicePlayButton,
          message.isOwn && styles.voicePlayButtonOwn,
          pressed && styles.pressed,
        ]}>
        <Ionicons name={playing ? 'pause' : 'play'} size={18} color={colors.mintDark} />
      </Pressable>
      <View style={styles.voiceCopy}>
        <Text numberOfLines={1} style={styles.voiceTitle}>{t('chat.voiceNote')}</Text>
        <Text style={styles.voiceTime}>
          {formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}
        </Text>
      </View>
      <Ionicons name="mic-outline" size={16} color={colors.inkMuted} />
    </View>
  );
}

/** Compact one-line card for files that are not shown inline: icon, name, size, download. */
function AttachmentCard({ message, onDownload }: { message: Message; onDownload: () => void }) {
  const workspace = useWorkspace();
  const { t } = useI18n();
  const attachment = message.attachment;
  if (!attachment) return null;
  // Consumer uploads are not scanned (owner request): the card says "Ready"
  // and "Uploading" instead of the workplace scan wording.
  const consumer = isPersonalRealm(workspace.organizationId);
  const scanStatus = {
    clean: { label: consumer ? t('chat.fileReady') : t('chat.fileClean'), icon: 'download-outline' as const },
    scanning: { label: consumer ? t('chat.attachmentUploading') : t('chat.fileScanning'), icon: 'hourglass-outline' as const },
    quarantined: { label: t('chat.fileQuarantined'), icon: 'lock-closed-outline' as const },
    blocked: { label: t('chat.fileBlocked'), icon: 'warning-outline' as const },
  }[attachment.status];
  const transfer = attachment.transfer;
  const transferStatus = transfer ? ({
    preparing: { label: t('chat.attachmentPreparing'), icon: 'construct-outline' as const },
    uploading: { label: t('chat.attachmentUploading'), icon: 'cloud-upload-outline' as const },
    failed: { label: t('chat.attachmentFailed'), icon: 'alert-circle-outline' as const },
    cancelled: { label: t('chat.attachmentCancelledCleanup'), icon: 'trash-outline' as const },
    uploaded: scanStatus,
  })[transfer.state] : scanStatus;
  const progress = Math.max(0, Math.min(1, transfer?.progress ?? 0));
  const progressPercent = Math.round(progress * 100);
  const isTransferring = transfer?.state === 'preparing' || transfer?.state === 'uploading';
  const canDownload = attachmentReady(attachment);
  const icon = attachment.kind === 'image'
    ? 'image-outline'
    : isVideoAttachment(attachment)
      ? 'videocam-outline'
      : attachment.kind === 'voice'
        ? 'mic-outline'
        : 'document-text-outline';
  return (
    <View style={[styles.fileCard, message.isOwn && styles.fileCardOwn]}>
      <Pressable
        accessibilityHint={canDownload ? t('chat.fileDownloadHint') : transferStatus.label}
        accessibilityLabel={`${attachment.name}, ${transferStatus.label}`}
        accessibilityRole={canDownload ? 'button' : undefined}
        disabled={!canDownload}
        onPress={canDownload ? onDownload : undefined}
        style={({ pressed }) => [styles.fileRow, pressed && canDownload && styles.pressed]}>
        <Ionicons name={icon} size={20} color={colors.mintDark} />
        <View style={styles.fileCopy}>
          <Text numberOfLines={1} style={styles.fileName}>
            {attachment.kind === 'voice' ? t('chat.voiceNote') : attachment.name}
          </Text>
          <Text numberOfLines={1} style={styles.fileMeta}>
            {[attachment.sizeLabel, canDownload ? null : transferStatus.label].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <Ionicons name={canDownload ? 'download-outline' : transferStatus.icon} size={16} color={colors.inkMuted} />
      </Pressable>
      {isTransferring ? (
        <View style={styles.fileProgressRow}>
          <View
            accessibilityLabel={`${t('chat.attachmentProgress')} ${progressPercent}%`}
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: progressPercent, text: `${progressPercent}%` }}
            style={styles.fileProgressTrack}>
            <View style={[styles.fileProgressFill, { width: `${progressPercent}%` as `${number}%` }]} />
          </View>
        </View>
      ) : null}
      {isTransferring || transfer?.state === 'failed' || transfer?.state === 'cancelled' ? (
        <View style={styles.fileControls}>
          <TransferControls message={message} tone="default" />
        </View>
      ) : null}
    </View>
  );
}

function useKeyboardVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => setVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

// The safe-area hook throws outside its provider (tests, some modals) and some
// test doubles omit the context entirely; read it defensively instead.
const NoInsetsContext = createContext<EdgeInsets | null>(null);

/**
 * Bottom padding that keeps the composer above the Android navigation bar and
 * the iOS home indicator (owner report, Z Flip: the composer sat on the
 * system bar). While the keyboard is up the keyboard itself covers that
 * area, so the inset is dropped and the composer hugs the keys.
 */
function useComposerBottomInset(enabled: boolean) {
  const insets = useContext(SafeAreaInsetsContext ?? NoInsetsContext);
  const keyboardVisible = useKeyboardVisible();
  return enabled && !keyboardVisible ? insets?.bottom ?? 0 : 0;
}

function Composer({
  currentUserId,
  disabled,
  disabledLabel,
  draft,
  enterSends,
  memberUserIds,
  mobile,
  people,
  selectedMentionUserIds,
  showMentionPicker,
  onChangeDraft,
  onChangeMentionUserIds,
  onChangeShowMentionPicker,
  onComposerBlur,
  onSend,
  onSendVoiceNote,
  onAddAttachment,
  replyingTo,
  onCancelReply,
}: {
  currentUserId: string;
  disabled: boolean;
  disabledLabel: string;
  draft: string;
  enterSends: boolean;
  memberUserIds: string[];
  mobile: boolean;
  people: Person[];
  selectedMentionUserIds: string[];
  showMentionPicker: boolean;
  onChangeDraft: (value: string) => void;
  onChangeMentionUserIds: (value: string[]) => void;
  onChangeShowMentionPicker: (value: boolean) => void;
  onComposerBlur: () => void;
  onSend: () => void;
  onSendVoiceNote: (attachment: SelectedAttachment) => void;
  onAddAttachment: () => void;
  replyingTo: Message | null;
  onCancelReply: () => void;
}) {
  const { t } = useI18n();
  const bottomInset = useComposerBottomInset(mobile);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  useEffect(() => {
    if (!recording) return;
    const interval = setInterval(() => setRecordSeconds((value) => value + 1), 1000);
    return () => clearInterval(interval);
  }, [recording]);

  const startRecording = async () => {
    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) return;
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    setRecordSeconds(0);
    setRecording(true);
  };

  const finishRecording = async (send: boolean) => {
    setRecording(false);
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    const uri = recorder.uri;
    if (send && uri) {
      // Voice notes ride the existing quarantined attachment pipeline with no
      // caption; audio/mp4 (AAC m4a) is already on the server allowlist.
      onSendVoiceNote({
        uri,
        name: `voice-note-${Date.now()}.m4a`,
        mimeType: 'audio/mp4',
        temporary: true,
      });
    }
  };

  // The @mention chip appears only in groups and only once the draft holds an
  // '@' (or a mention is already attached), never as a standing toolbar.
  const mentionsActive = !disabled
    && memberUserIds.length > 1
    && (draft.includes('@') || selectedMentionUserIds.length > 0);

  return (
    <View style={[styles.composerWrap, { paddingBottom: 6 + bottomInset }]}>
      {disabled ? (
        <View style={styles.readOnlyComposer}>
          <Ionicons name="lock-closed-outline" color={colors.inkMuted} size={16} />
          <Text style={styles.readOnlyComposerText}>{disabledLabel}</Text>
        </View>
      ) : null}
      {replyingTo ? (
        <View style={styles.replyComposer}>
          <View style={styles.replyComposerCopy}>
            <Text style={styles.replyComposerLabel}>{t('chat.replyingTo')} {replyingTo.senderName}</Text>
            <Text numberOfLines={1} style={styles.replyComposerText}>{replyingTo.originalText}</Text>
          </View>
          <IconButton label={t('chat.cancelReply')} name="close" onPress={onCancelReply} size={32} />
        </View>
      ) : null}
      {mentionsActive ? (
        <MentionSelector
          currentUserId={currentUserId}
          memberUserIds={memberUserIds}
          onChange={onChangeMentionUserIds}
          onChangeOpen={onChangeShowMentionPicker}
          open={showMentionPicker}
          people={people}
          selectedUserIds={selectedMentionUserIds}
        />
      ) : null}
      {!disabled && recording ? (
        <View style={styles.composer}>
          <View
            accessibilityLabel={t('chat.recordingVoiceNote')}
            accessibilityLiveRegion="polite"
            style={styles.recordingIndicator}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingTime}>{formatPlaybackTime(recordSeconds)}</Text>
            <Text numberOfLines={1} style={styles.recordingLabel}>{t('chat.recordingVoiceNote')}</Text>
          </View>
          <IconButton
            label={t('chat.cancelVoiceNote')}
            name="trash-outline"
            onPress={() => void finishRecording(false)}
            size={36}
            tone="danger"
          />
          <IconButton
            label={t('chat.sendVoiceNote')}
            name="arrow-up"
            onPress={() => void finishRecording(true)}
            size={38}
            tone="accent"
          />
        </View>
      ) : null}
      {!disabled && !recording ? <View style={styles.composer}>
        <IconButton name="add" label={t('chat.addAttachment')} onPress={onAddAttachment} size={36} />
        <TextInput
          accessibilityLabel={t('chat.message')}
          testID="composer-input"
          multiline
          onBlur={onComposerBlur}
          onChangeText={onChangeDraft}
          onKeyPress={(event) => {
            // Web: Enter sends, Shift+Enter breaks the line; preventDefault
            // stops the browser from inserting the newline first. Native
            // keyboards route the return key through onSubmitEditing below.
            if (shouldSendOnEnter(event.nativeEvent, { enterSends })) {
              event.preventDefault();
              onSend();
            }
          }}
          onSubmitEditing={enterSends ? onSend : undefined}
          placeholder={t('chat.placeholder')}
          placeholderTextColor={colors.inkSubtle}
          returnKeyType={enterSends ? 'send' : 'default'}
          style={styles.composerInput}
          submitBehavior={enterSends ? 'submit' : 'newline'}
          value={draft}
        />
        {draft.trim() ? (
          <IconButton
            label={t('chat.send')}
            name="arrow-up"
            onPress={onSend}
            size={38}
            tone="accent"
          />
        ) : (
          <IconButton
            label={t('chat.recordVoiceNote')}
            name="mic"
            onPress={() => void startRecording()}
            size={38}
            tone="accent"
          />
        )}
      </View> : null}
    </View>
  );
}

function MentionSelector({
  currentUserId,
  memberUserIds,
  people,
  selectedUserIds,
  open,
  onChange,
  onChangeOpen,
}: {
  currentUserId: string;
  memberUserIds: string[];
  people: Person[];
  selectedUserIds: string[];
  open: boolean;
  onChange: (value: string[]) => void;
  onChangeOpen: (value: boolean) => void;
}) {
  const { locale } = useI18n();
  const copy = mentionCopy(locale);
  const [query, setQuery] = useState('');
  const candidates = mentionablePeople(people, memberUserIds, currentUserId);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = candidates
    .filter((person) => !normalizedQuery
      || person.displayName.toLocaleLowerCase().includes(normalizedQuery)
      || person.department.toLocaleLowerCase().includes(normalizedQuery))
    .slice(0, 30);
  const selectedPeople = selectedUserIds.map(
    (userId) => candidates.find((person) => person.id === userId),
  ).filter((person): person is Person => Boolean(person));
  const toggle = (userId: string) => {
    if (selectedUserIds.includes(userId)) {
      onChange(selectedUserIds.filter((selected) => selected !== userId));
      return;
    }
    if (selectedUserIds.length < MAX_MESSAGE_MENTIONS) onChange([...selectedUserIds, userId]);
  };
  if (!candidates.length && !selectedPeople.length) return null;
  return (
    <View style={styles.mentionSelector}>
      <View style={styles.mentionSelectorHeader}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => {
            if (open) setQuery('');
            onChangeOpen(!open);
          }}
          style={({ pressed }) => [styles.mentionToggle, pressed && styles.pressed]}>
          <Ionicons name="at-outline" color={colors.mintDark} size={15} />
          <Text style={styles.mentionToggleText}>{open ? copy.close : copy.button}</Text>
          {selectedUserIds.length ? (
            <View style={styles.mentionCount}><Text style={styles.mentionCountText}>{selectedUserIds.length}</Text></View>
          ) : null}
        </Pressable>
      </View>
      {selectedPeople.length ? (
        <View
          accessibilityLabel={`${copy.selected}: ${selectedPeople.map((person) => person.displayName).join(', ')}`}
          style={styles.selectedMentions}>
          {selectedPeople.map((person) => (
            <Pressable
              accessibilityLabel={`${copy.remove}: ${person.displayName}`}
              accessibilityRole="button"
              key={person.id}
              onPress={() => toggle(person.id)}
              style={({ pressed }) => [styles.selectedMention, pressed && styles.pressed]}>
              <Text numberOfLines={1} style={styles.selectedMentionText}>@{person.displayName}</Text>
              <Ionicons name="close" color={colors.mintDark} size={13} />
            </Pressable>
          ))}
        </View>
      ) : null}
      {open ? (
        <View style={styles.mentionPanel}>
          <Text style={styles.mentionTitle}>{copy.title}</Text>
          <TextInput
            accessibilityLabel={copy.searchLabel}
            autoCapitalize="none"
            onChangeText={setQuery}
            placeholder={copy.searchPlaceholder}
            placeholderTextColor={colors.inkSubtle}
            style={styles.mentionSearch}
            value={query}
          />
          <Text style={styles.mentionAvailable}>{copy.available}</Text>
          {filtered.length ? (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              style={styles.mentionCandidatesScroll}>
              <View style={styles.mentionCandidates}>
                {filtered.map((person) => {
                  const selected = selectedUserIds.includes(person.id);
                  const disabled = !selected && selectedUserIds.length >= MAX_MESSAGE_MENTIONS;
                  // Consumers are identified by @handle; the workplace shows department · role.
                  const meta = person.username
                    ? `@${person.username}`
                    : [person.department, person.roleLabel].filter(Boolean).join(' · ');
                  return (
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: selected, disabled }}
                      disabled={disabled}
                      key={person.id}
                      onPress={() => toggle(person.id)}
                      style={({ pressed }) => [
                        styles.mentionCandidate,
                        selected && styles.mentionCandidateSelected,
                        disabled && styles.mentionCandidateDisabled,
                        pressed && styles.pressed,
                      ]}>
                      <Avatar color={person.avatarColor} initials={person.initials} size={30} />
                      <View style={styles.mentionCandidateCopy}>
                        <Text numberOfLines={1} style={styles.mentionCandidateName}>{person.displayName}</Text>
                        {meta ? <Text numberOfLines={1} style={styles.mentionCandidateMeta}>{meta}</Text> : null}
                      </View>
                      <Ionicons
                        name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                        color={selected ? colors.mintDark : colors.inkSubtle}
                        size={19}
                      />
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          ) : <Text style={styles.mentionEmpty}>{copy.noMatches}</Text>}
        </View>
      ) : null}
    </View>
  );
}

function MessageActionsModal({
  message,
  conversations,
  editDraft,
  error,
  busy,
  onClose,
  onChangeEditDraft,
  onEdit,
  onDelete,
  onHide,
  onForward,
  onProposeAction,
  onReact,
  onReply,
  onCopy,
  onPin,
  onTranslate,
  onProposeCorrection,
  onReviewCorrection,
}: {
  message: Message | null;
  conversations: Conversation[];
  editDraft: string;
  error: string | null;
  busy: string | null;
  onClose: () => void;
  onChangeEditDraft: (value: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onHide: () => void;
  onForward: (targetConversationId: string) => Promise<void>;
  onProposeAction: (title: string, details: string) => Promise<void>;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  onPin: () => void;
  onTranslate?: (() => void) | null;
  onProposeCorrection?: () => void;
  onReviewCorrection?: () => void;
}) {
  const workspace = useWorkspace();
  const { t } = useI18n();
  // Action items are a workplace concept; the personal realm never surfaces
  // the affordance to propose one from a message.
  const personalRealm = isPersonalRealm(workspace.organizationId);
  const [forwardTargetId, setForwardTargetId] = useState('');
  const [actionTitle, setActionTitle] = useState('');
  const [actionDetails, setActionDetails] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Language details, corrections, and review moved here from the bubble so
  // the bubble stays quiet; they still exist one long-press away.
  const conversation = message
    ? workspace.conversations.find((item) => item.id === message.conversationId)
    : undefined;
  const translationEnabled = conversation?.translationMode !== 'off';
  const translation = message && translationEnabled ? message.translation : undefined;
  const hasDetails = Boolean(message && translationEnabled && (translation || message.languageDetection));
  const canCorrect = Boolean(message?.translatedText && translation?.status === 'completed');
  const canReview = translation?.correction?.status === 'pending' && workspace.hasCapability('language.review');
  return (
    <ActionModal
      onClose={onClose}
      title={t('chat.actionsTitle')}
      visible={Boolean(message)}>
      {message ? (
        <View style={styles.modalRow}>
          <PrimaryButton icon="arrow-undo-outline" label={t('chat.reply')} onPress={onReply} tone="light" />
          <PrimaryButton icon="copy-outline" label={t('chat.copy')} onPress={onCopy} tone="light" />
          <PrimaryButton icon={message.pinned ? 'pin' : 'pin-outline'} label={message.pinned ? t('chat.unpin') : t('chat.pin')} loading={busy === 'message-pin'} onPress={onPin} tone="light" />
          {onTranslate ? (
            <PrimaryButton icon="language-outline" label={t('chat.translateForMe')} onPress={onTranslate} tone="light" />
          ) : null}
          {hasDetails ? (
            <PrimaryButton
              icon="information-circle-outline"
              label={t(detailsOpen ? 'chat.hideProvenance' : 'chat.showProvenance')}
              onPress={() => setDetailsOpen((value) => !value)}
              tone="light"
            />
          ) : null}
          {canCorrect && onProposeCorrection ? (
            <PrimaryButton icon="create-outline" label={t('chat.proposeCorrection')} onPress={onProposeCorrection} tone="light" />
          ) : null}
          {canReview && onReviewCorrection ? (
            <PrimaryButton icon="shield-checkmark-outline" label={t('chat.reviewCorrection')} onPress={onReviewCorrection} tone="light" />
          ) : null}
        </View>
      ) : null}
      {message && detailsOpen ? <TranslationDetails message={message} /> : null}
      {message?.serverId && !message.deleted ? (
        <View style={styles.modalSection}>
          <Text style={styles.modalLabel}>{t('chat.react')}</Text>
          <View style={styles.modalRow}>
            {['👍', '❤️', '✅', '👀'].map((emoji) => (
              <Pressable
                accessibilityLabel={`${t('chat.react')} ${emoji}`}
                accessibilityRole="button"
                key={emoji}
                onPress={() => onReact(emoji)}
                style={({ pressed }) => [styles.emojiButton, pressed && styles.pressed]}>
                <Text style={styles.emojiText}>{emoji}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      {message?.isOwn && message.serverId && !message.deleted ? (
        <View style={styles.modalSection}>
          <FormField label={t('chat.editMessage')} multiline onChangeText={onChangeEditDraft} value={editDraft} />
          <PrimaryButton
            disabled={!editDraft.trim()}
            label={t('chat.saveEdit')}
            loading={busy === 'message-edit'}
            onPress={onEdit}
            tone="dark"
          />
          <PrimaryButton
            icon="trash-outline"
            label={t('chat.deleteEveryone')}
            loading={busy === 'message-delete'}
            onPress={onDelete}
            tone="danger"
          />
        </View>
      ) : null}
      {!message?.serverId ? (
        <Text style={styles.modalNote}>{t('chat.queuedEdit')}</Text>
      ) : null}
      {message?.serverId && !message.deleted ? (
        <>
          {message.attachment ? (
            <View style={styles.modalSection}>
              <Text style={styles.modalLabel}>{t('chat.forwardUnavailable')}</Text>
              <Text style={styles.modalNote}>{t('chat.attachmentForwardUnavailable')}</Text>
            </View>
          ) : (
            <View style={styles.modalSection}>
              <Text style={styles.modalLabel}>{t('chat.forwardTo')}</Text>
              <View style={styles.modalRow}>
                {conversations
                  .filter((conversation) => (
                    !conversation.archived
                    && !conversation.managementOnly
                    && conversation.id !== message.conversationId
                  ))
                  .slice(0, 20)
                  .map((conversation) => (
                    <Chip
                      key={conversation.id}
                      label={conversation.title}
                      onPress={() => setForwardTargetId(conversation.id)}
                      selected={forwardTargetId === conversation.id}
                    />
                  ))}
              </View>
              <PrimaryButton
                disabled={!forwardTargetId}
                icon="arrow-redo-outline"
                label={t('chat.forwardConfirm')}
                loading={busy === 'message-forward'}
                onPress={() => void onForward(forwardTargetId)}
                tone="light"
              />
            </View>
          )}
          {!personalRealm ? (
            <View style={styles.modalSection}>
              <Text style={styles.modalLabel}>{t('chat.createAction')}</Text>
              <FormField label={t('chat.actionTitle')} onChangeText={setActionTitle} value={actionTitle} />
              <FormField label={t('chat.actionDetails')} multiline onChangeText={setActionDetails} value={actionDetails} />
              <PrimaryButton
                disabled={!actionTitle.trim()}
                icon="checkbox-outline"
                label={t('chat.actionCreate')}
                loading={busy === 'action-propose'}
                onPress={() => void onProposeAction(actionTitle, actionDetails)}
                tone="dark"
              />
            </View>
          ) : null}
          <View style={styles.modalSection}>
            <Text style={styles.modalNote}>{t('chat.deleteMeHint')}</Text>
            <PrimaryButton
              icon="eye-off-outline"
              label={t('chat.deleteMe')}
              loading={busy === 'message-hide'}
              onPress={onHide}
              tone="danger"
            />
          </View>
        </>
      ) : null}
      <ActionError message={error} />
    </ActionModal>
  );
}

function ConversationControlsModal({
  visible,
  conversation,
  currentUserId,
  name,
  description,
  people,
  error,
  busy,
  onClose,
  onChangeName,
  onChangeDescription,
  onSave,
  onArchive,
  onAddMember,
  onRemoveMember,
  onUpdateMemberRole,
  onLeave,
  onToggleFavorite,
  onOpenSummary,
  onUpdateNotificationSettings,
  onUpdateTranslationMode,
  onCloseIncident,
}: {
  visible: boolean;
  conversation: Conversation;
  currentUserId: string;
  name: string;
  description: string;
  people: Person[];
  error: string | null;
  busy: string | null;
  onClose: () => void;
  onChangeName: (value: string) => void;
  onChangeDescription: (value: string) => void;
  onSave: () => void;
  onArchive: () => void;
  onAddMember: (conversationId: string, personId: string, role: 'member' | 'admin') => Promise<boolean>;
  onRemoveMember: (conversationId: string, personId: string) => Promise<boolean>;
  onUpdateMemberRole: (
    conversationId: string,
    personId: string,
    expectedRole: 'owner' | 'admin' | 'member',
    newRole: 'owner' | 'admin' | 'member',
  ) => Promise<boolean>;
  onLeave: (replacementOwnerPersonId?: string) => Promise<void>;
  onToggleFavorite: () => void;
  onOpenSummary?: () => void;
  onUpdateNotificationSettings: (
    notificationLevel: NonNullable<Conversation['notificationLevel']>,
    mutedUntil: string | null,
  ) => Promise<boolean>;
  onUpdateTranslationMode: (
    translationMode: NonNullable<Conversation['translationMode']>,
  ) => Promise<boolean>;
  onCloseIncident: (reason: string) => Promise<void>;
}) {
  const { locale, t } = useI18n();
  const workspace = useWorkspace();
  // Workplace-only notes and discovery controls stay out of the personal realm.
  const personalRealm = isPersonalRealm(workspace.organizationId);
  const notification = notificationCopy(locale);
  const translationPreference = translationPreferenceCopy(locale);
  const departureCopy = conversationDepartureCopy(locale);
  const [candidateId, setCandidateId] = useState('');
  const [candidateRole, setCandidateRole] = useState<'member' | 'admin'>('member');
  const [candidateQuery, setCandidateQuery] = useState('');
  const [memberCandidates, setMemberCandidates] = useState<ConversationMemberCandidate[]>([]);
  const [memberCandidateCursor, setMemberCandidateCursor] = useState<string | null>(null);
  const [memberCandidateScope, setMemberCandidateScope] = useState<{
    conversationId: string;
    query: string;
  } | null>(null);
  const [memberCandidateLoading, setMemberCandidateLoading] = useState(false);
  const memberCandidateRequestRef = useRef(0);
  const [selectedConversationAvatar, setSelectedConversationAvatar] = useState<SelectedAttachment | null>(null);
  const [incidentCloseReason, setIncidentCloseReason] = useState('');
  const [replacementOwnerId, setReplacementOwnerId] = useState('');
  const [departureConfirmed, setDepartureConfirmed] = useState(false);
  const [postingMode, setPostingMode] = useState(conversation.postingMode ?? 'all_members');
  const [joinPolicy, setJoinPolicy] = useState(conversation.configuredJoinPolicy ?? 'inherit');
  const [visibility, setVisibility] = useState(conversation.visibility ?? 'invite_only');
  const [controlReason, setControlReason] = useState('');
  const [joinRequests, setJoinRequests] = useState<import('@/domain/types').ConversationJoinRequest[]>([]);
  const [decisionReason, setDecisionReason] = useState('');
  const scopedMemberProfiles = new Map(
    (conversation.memberProfiles ?? []).map((profile) => [profile.id, profile]),
  );
  const members = (conversation.memberIds ?? [])
    .map((id) => {
      const directoryPerson = people.find((person) => person.id === id);
      if (directoryPerson) return directoryPerson;
      if (!conversation.managementOnly) return null;
      const profile = scopedMemberProfiles.get(id);
      return profile ? {
        id: profile.id,
        membershipId: profile.id,
        displayName: profile.displayName,
        initials: profile.initials,
        avatarColor: profile.avatarColor,
        suspended: false,
      } : null;
    })
    .filter((person) => person !== null);
  const candidateScopeMatches = memberCandidateScope?.conversationId === conversation.id;
  const candidates = candidateScopeMatches && !conversation.policyManaged
    ? memberCandidates
    : [];
  const selectedCandidateId = candidates.some((candidate) => candidate.userId === candidateId)
    ? candidateId
    : '';
  const replacementCandidates = members.filter(
    (person) => person.id !== currentUserId && !person.suspended,
  );
  const notificationLevel = conversation.notificationLevel
    ?? (conversation.muted && !conversation.mutedUntil ? 'none' : 'all');
  const mutedUntil = activeMutedUntil(conversation.mutedUntil);
  const preferencesBusy = busy === 'conversation-preferences';
  const muteFor = (seconds: number) => {
    if (preferencesBusy) return;
    const patch = temporaryMutePatch(notificationLevel, seconds);
    if (patch) void onUpdateNotificationSettings(patch.notificationLevel, patch.mutedUntil);
  };
  const loadMemberCandidates = async (append: boolean) => {
    if (
      memberCandidateLoading
      || !conversation.canManageConversation
      || conversation.kind === 'direct'
      || conversation.policyManaged
    ) return;
    const query = candidateQuery.trim().slice(0, 120);
    const canAppend = append
      && memberCandidateScope?.conversationId === conversation.id
      && memberCandidateScope.query === query
      && Boolean(memberCandidateCursor);
    if (append && !canAppend) return;
    const requestId = ++memberCandidateRequestRef.current;
    if (!canAppend) {
      setMemberCandidateScope({ conversationId: conversation.id, query });
      setMemberCandidates([]);
      setMemberCandidateCursor(null);
      setCandidateId('');
    }
    setMemberCandidateLoading(true);
    const page = await workspace.queryConversationMemberCandidates(
      conversation.id,
      query,
      canAppend ? memberCandidateCursor : null,
    );
    if (requestId !== memberCandidateRequestRef.current) return;
    if (page) {
      setMemberCandidateScope({ conversationId: conversation.id, query });
      setMemberCandidates((current) => {
        if (!canAppend) return page.candidates;
        const byId = new Map(current.map((candidate) => [candidate.userId, candidate]));
        for (const candidate of page.candidates) byId.set(candidate.userId, candidate);
        return [...byId.values()];
      });
      setMemberCandidateCursor(page.nextCursor);
    }
    setMemberCandidateLoading(false);
  };
  const chooseConversationAvatar = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.86,
    });
    const asset = result.assets?.[0];
    if (!asset) return;
    setSelectedConversationAvatar({
      uri: asset.uri,
      name: asset.fileName ?? `group-${Date.now()}.jpg`,
      mimeType: asset.mimeType ?? 'image/jpeg',
      size: asset.fileSize,
      width: asset.width,
      height: asset.height,
      imageMode: 'optimized',
    });
  };
  return (
    <ActionModal
      description={conversation.managementOnly
        ? t('chat.managementOnlyBody')
        : conversation.kind === 'direct'
          ? t('chat.privateDirect')
          : `${conversation.participantCount ?? members.length} ${t('chat.currentMembers')}`}
      onClose={onClose}
      title={t('chat.controlsTitle')}
      visible={visible}>
      {!conversation.managementOnly ? (
        <View style={styles.modalRow}>
          <PrimaryButton icon={conversation.favorite ? 'star' : 'star-outline'} label={conversation.favorite ? t('chat.removeFavorite') : t('chat.addFavorite')} onPress={onToggleFavorite} tone="light" />
          {onOpenSummary ? (
            <PrimaryButton icon="sparkles-outline" label={t('chat.summarize')} onPress={onOpenSummary} tone="light" />
          ) : null}
        </View>
      ) : null}
      {conversation.canManage && ['group', 'team', 'shift', 'incident'].includes(conversation.kind) ? (
        <View style={styles.modalSection}>
          <Text style={styles.modalLabel}>{t('group.avatarTitle')}</Text>
          <Text style={styles.modalNote}>{t('group.avatarRequirements')}</Text>
          <View style={styles.conversationAvatarControls}>
            {selectedConversationAvatar || workspace.conversationAvatarUrls[conversation.id] ? (
              <Image
                accessibilityLabel={t('group.avatarSelected')}
                resizeMode="cover"
                source={{
                  uri: selectedConversationAvatar?.uri
                    ?? workspace.conversationAvatarUrls[conversation.id],
                }}
                style={styles.conversationAvatarPreview}
              />
            ) : (
              <Avatar
                color={conversation.avatarColor}
                initials={conversation.initials}
                size={72}
              />
            )}
            <View style={styles.conversationAvatarActions}>
              <PrimaryButton
                label={conversation.avatarPath || selectedConversationAvatar
                  ? t('group.changeAvatar')
                  : t('group.chooseAvatar')}
                onPress={() => void chooseConversationAvatar()}
                tone="light"
              />
              {selectedConversationAvatar ? (
                <PrimaryButton
                  label={t('group.saveAvatar')}
                  loading={busy === 'conversation-avatar-upload'}
                  onPress={() => void workspace.uploadConversationAvatar(
                    conversation.id,
                    selectedConversationAvatar,
                  ).then((done) => {
                    if (done) setSelectedConversationAvatar(null);
                  })}
                  tone="dark"
                />
              ) : null}
              {conversation.avatarPath && !selectedConversationAvatar ? (
                <PrimaryButton
                  label={t('group.removeAvatar')}
                  loading={busy === 'conversation-avatar-remove'}
                  onPress={() => void workspace.removeConversationAvatar(conversation.id)}
                  tone="danger"
                />
              ) : null}
            </View>
          </View>
        </View>
      ) : null}
      {!conversation.managementOnly ? <View style={styles.modalSection}>
        <Text style={styles.modalLabel}>{notification.title}</Text>
        <Text style={styles.modalNote}>{notification.description}</Text>
        <View style={styles.modalRow}>
          {([
            ['all', notification.all],
            ['mentions', notification.mentions],
            ['none', notification.none],
          ] as [NonNullable<Conversation['notificationLevel']>, string][]).map(([level, label]) => (
            <Chip
              key={level}
              label={label}
              onPress={preferencesBusy ? undefined : () => {
                void onUpdateNotificationSettings(level, null);
              }}
              selected={notificationLevel === level && !mutedUntil}
            />
          ))}
        </View>
        <Text style={styles.modalLabel}>{notification.temporary}</Text>
        <View style={styles.modalRow}>
          <PrimaryButton
            disabled={preferencesBusy}
            label={notification.oneHour}
            onPress={() => muteFor(60 * 60)}
            tone="light"
          />
          <PrimaryButton
            disabled={preferencesBusy}
            label={notification.eightHours}
            onPress={() => muteFor(8 * 60 * 60)}
            tone="light"
          />
          <PrimaryButton
            disabled={preferencesBusy}
            label={notification.oneWeek}
            onPress={() => muteFor(7 * 24 * 60 * 60)}
            tone="light"
          />
        </View>
        {mutedUntil ? (
          <View style={styles.notificationMuteStatus}>
            <Ionicons name="time-outline" color={colors.amber} size={16} />
            <Text style={styles.notificationMuteText}>
              {notification.mutedUntil} · {new Date(mutedUntil).toLocaleString()}
            </Text>
            <PrimaryButton
              disabled={preferencesBusy}
              label={notification.unmute}
              onPress={() => void onUpdateNotificationSettings(notificationLevel, null)}
              tone="light"
            />
          </View>
        ) : null}
      </View> : null}
      {!conversation.managementOnly ? <View style={styles.modalSection}>
        <Text style={styles.modalLabel}>{translationPreference.title}</Text>
        <Text style={styles.modalNote}>{translationPreference.description}</Text>
        <View style={styles.modalRow}>
          <Chip
            label={translationPreference.automatic}
            onPress={preferencesBusy ? undefined : () => void onUpdateTranslationMode('automatic')}
            selected={(conversation.translationMode ?? 'automatic') === 'automatic'}
          />
          <Chip
            label={translationPreference.off}
            onPress={preferencesBusy ? undefined : () => void onUpdateTranslationMode('off')}
            selected={conversation.translationMode === 'off'}
          />
        </View>
        <Text style={styles.modalNote}>
          {conversation.translationMode === 'off'
            ? translationPreference.offHint
            : translationPreference.automaticHint}
        </Text>
      </View> : null}
      {!conversation.managementOnly && conversation.kind !== 'direct' && conversation.historyDisclosure ? (
        <View style={styles.historyDisclosure}>
          <Ionicons name="time-outline" color={colors.mintDark} size={17} />
          <View style={styles.historyDisclosureCopy}>
            <Text style={styles.historyDisclosureTitle}>{t('chat.historyAccess')}</Text>
            <Text style={styles.historyDisclosureText}>
              {t(conversation.historyDisclosure.labelKey)}
              {conversation.historyDisclosure.visibleFrom
                ? ` · ${new Date(conversation.historyDisclosure.visibleFrom).toLocaleString()}`
                : ''}
            </Text>
          </View>
        </View>
      ) : null}
      {conversation.canManageConversation && conversation.kind !== 'direct' ? (
        <View style={styles.modalSection}>
          <FormField label={t('chat.name')} onChangeText={onChangeName} value={name} />
          <FormField label={t('chat.description')} multiline onChangeText={onChangeDescription} value={description} />
          <PrimaryButton
            disabled={name.trim().length < 2}
            label={t('chat.saveConversation')}
            loading={busy === 'conversation-update'}
            onPress={onSave}
            tone="dark"
          />
        </View>
      ) : null}
      {conversation.canManageConversation
        && !conversation.policyManaged
        && ['group', 'team'].includes(conversation.kind) ? (
        <View style={styles.modalSection}>
          {personalRealm ? null : (
            <>
              <Text style={styles.modalLabel}>{t('chat.accessControls')}</Text>
              <Text style={styles.modalNote}>{t('chat.accessControlsDescription')}</Text>
            </>
          )}
          <Text style={styles.modalLabel}>{t('chat.whoCanPost')}</Text>
          <View style={styles.modalRow}>
            <Chip label={t('chat.allMembers')} onPress={() => setPostingMode('all_members')} selected={postingMode === 'all_members'} />
            <Chip label={t('chat.adminsOnly')} onPress={() => setPostingMode('admins_only')} selected={postingMode === 'admins_only'} />
          </View>
          {personalRealm ? null : (
            <>
              <Text style={styles.modalLabel}>{t('chat.groupDiscovery')}</Text>
              <View style={styles.modalRow}>
                <Chip label={t('chat.inviteOnly')} onPress={() => { setVisibility('invite_only'); setJoinPolicy('invite_only'); }} selected={visibility === 'invite_only'} />
                <Chip label={t('chat.organizationVisible')} onPress={() => { setVisibility('organization'); setJoinPolicy('approval_required'); }} selected={visibility === 'organization'} />
                {conversation.visibility === 'unit' ? <Chip label={t('chat.unitVisible')} onPress={() => { setVisibility('unit'); setJoinPolicy('approval_required'); }} selected={visibility === 'unit'} /> : null}
              </View>
            </>
          )}
          <FormField label={t('chat.changeReason')} multiline onChangeText={setControlReason} placeholder={t('chat.changeReasonPlaceholder')} value={controlReason} />
          <PrimaryButton
            disabled={controlReason.trim().length < 3}
            label={t('chat.saveAccessControls')}
            loading={busy === 'conversation-controls'}
            onPress={() => void workspace.updateConversationControls(conversation.id, {
              postingMode,
              joinPolicy,
              visibility,
              reason: controlReason,
            })}
            tone="dark"
          />
          <PrimaryButton
            label={t('chat.reviewJoinRequests')}
            onPress={() => void workspace.loadConversationJoinRequests(conversation.id).then(setJoinRequests)}
            tone="light"
          />
          {joinRequests.length ? (
            <>
              <FormField label={t('chat.decisionReason')} multiline onChangeText={setDecisionReason} placeholder={t('chat.decisionReasonPlaceholder')} value={decisionReason} />
              {joinRequests.map((request) => (
                <View key={request.requestId} style={styles.memberControlRow}>
                  <View style={styles.memberControlCopy}>
                    <Text style={styles.memberControlName}>{request.requesterDisplayName ?? t('chat.companyMember')}</Text>
                    <Text style={styles.memberControlRole}>{new Date(request.requestedAt).toLocaleString()}</Text>
                  </View>
                  <PrimaryButton
                    disabled={decisionReason.trim().length < 3}
                    label={t('chat.approveJoin')}
                    onPress={() => void workspace.decideConversationJoinRequest(request, 'approved', decisionReason).then((done) => {
                      if (done) setJoinRequests((items) => items.filter((item) => item.requestId !== request.requestId));
                    })}
                    tone="dark"
                  />
                  <PrimaryButton
                    disabled={decisionReason.trim().length < 3}
                    label={t('chat.rejectJoin')}
                    onPress={() => void workspace.decideConversationJoinRequest(request, 'rejected', decisionReason).then((done) => {
                      if (done) setJoinRequests((items) => items.filter((item) => item.requestId !== request.requestId));
                    })}
                    tone="danger"
                  />
                </View>
              ))}
            </>
          ) : null}
        </View>
      ) : null}
      {conversation.canManage && conversation.kind === 'incident' && !conversation.isReadOnly ? (
        <View style={styles.modalSection}>
          <Text style={styles.modalLabel}>{t('chat.closeIncident')}</Text>
          <Text style={styles.modalNote}>{t('chat.closeIncidentBody')}</Text>
          <FormField label={t('chat.closeReason')} multiline onChangeText={setIncidentCloseReason} value={incidentCloseReason} />
          <PrimaryButton
            disabled={incidentCloseReason.trim().length < 3}
            icon="lock-closed-outline"
            label={t('chat.closeIncidentConfirm')}
            loading={busy === 'incident-close'}
            onPress={() => void onCloseIncident(incidentCloseReason)}
            tone="danger"
          />
        </View>
      ) : null}

      {conversation.kind !== 'direct' ? (
        <View style={styles.modalSection}>
          <Text style={styles.modalLabel}>{t('chat.members')}</Text>
          {conversation.policyManaged ? (
            <Text style={styles.modalNote}>{t('chat.policyManagedMembers')}</Text>
          ) : conversation.canManage ? (
            personalRealm ? null : <Text style={styles.modalNote}>{t('chat.memberRoleSecurity')}</Text>
          ) : conversation.canManageConversation ? (
            <Text style={styles.modalNote}>{t('chat.delegatedMemberSecurity')}</Text>
          ) : null}
          {members.map((person) => (
            <View key={person.id} style={styles.memberControlRow}>
              <Avatar color={person.avatarColor} initials={person.initials} size={38} />
              <View style={styles.memberControlCopy}>
                <Text style={styles.memberControlName}>{person.displayName}</Text>
                <Text style={styles.memberControlRole}>{
                  t(`chat.${conversation.memberRoles?.[person.id] ?? 'member'}Role`)
                }</Text>
                {!conversation.policyManaged && conversation.canManage && person.id !== currentUserId ? (
                  <View style={styles.memberRoleChoices}>
                    {(['member', 'admin', 'owner'] as const).map((role) => {
                      const currentRole = conversation.memberRoles?.[person.id] ?? 'member';
                      return (
                        <Chip
                          accessibilityLabel={`${t(`chat.${role}Role`)} · ${person.displayName}`}
                          key={role}
                          label={t(`chat.${role}Role`)}
                          onPress={busy === 'conversation-member-role' || currentRole === role
                            ? undefined
                            : () => void onUpdateMemberRole(
                              conversation.id,
                              person.id,
                              currentRole,
                              role,
                            )}
                          selected={currentRole === role}
                        />
                      );
                    })}
                  </View>
                ) : null}
              </View>
              {!conversation.policyManaged && (conversation.canManage
                ? conversation.memberRoles?.[person.id] !== 'owner'
                : conversation.canManageConversation
                  && ['group', 'team', 'shift', 'incident'].includes(conversation.kind)
                  && conversation.memberRoles?.[person.id] === 'member') ? (
                <IconButton
                  label={`${t('chat.removeMember')} ${person.displayName}`}
                  name="person-remove-outline"
                  onPress={() => void onRemoveMember(conversation.id, person.id)}
                  size={40}
                  tone="danger"
                />
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {conversation.canManageConversation
        && ['group', 'team', 'shift', 'incident'].includes(conversation.kind)
        && !conversation.policyManaged
        && !conversation.archived
        && !conversation.isReadOnly ? (
        <View style={styles.modalSection}>
          <Text style={styles.modalLabel}>{t('chat.addMember')}</Text>
          {personalRealm ? null : <Text style={styles.modalNote}>{t('chat.memberSearchPrompt')}</Text>}
          <SearchField
            onChangeText={setCandidateQuery}
            onSubmitEditing={() => void loadMemberCandidates(false)}
            placeholder={t('chat.memberSearchLabel')}
            value={candidateQuery}
          />
          <PrimaryButton
            disabled={memberCandidateLoading}
            icon="search-outline"
            label={t('chat.memberSearchAction')}
            loading={memberCandidateLoading && !memberCandidateCursor}
            onPress={() => void loadMemberCandidates(false)}
            tone="light"
          />
          {candidateScopeMatches && !memberCandidateLoading && candidates.length === 0 ? (
            <Text style={styles.modalNote}>{t('chat.memberSearchEmpty')}</Text>
          ) : null}
          {candidates.length ? <View style={styles.candidateList}>
            {candidates.map((person) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: selectedCandidateId === person.userId }}
                key={person.userId}
                onPress={() => setCandidateId(person.userId)}
                style={[styles.candidateRow, selectedCandidateId === person.userId && styles.candidateRowSelected]}>
                <Avatar
                  color={colors.blue}
                  initials={person.displayName
                    .trim()
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((part) => part[0]?.toUpperCase() ?? '')
                    .join('') || 'M'}
                  size={34}
                />
                <Text style={styles.candidateName}>{person.displayName}</Text>
                {person.roleLabel ? <Text style={styles.memberControlRole}>{person.roleLabel}</Text> : null}
                {selectedCandidateId === person.userId ? <Ionicons name="checkmark-circle" color={colors.mintDark} size={18} /> : null}
              </Pressable>
            ))}
          </View> : null}
          {candidateScopeMatches && memberCandidateCursor ? (
            <PrimaryButton
              disabled={memberCandidateLoading}
              label={t('chat.loadMoreMembers')}
              loading={memberCandidateLoading}
              onPress={() => void loadMemberCandidates(true)}
              tone="light"
            />
          ) : null}
          {conversation.canManage ? (
            <View style={styles.modalRow}>
              <Chip label={t('chat.memberRole')} onPress={() => setCandidateRole('member')} selected={candidateRole === 'member'} />
              <Chip label={t('chat.adminRole')} onPress={() => setCandidateRole('admin')} selected={candidateRole === 'admin'} />
            </View>
          ) : (
            <Text style={styles.modalNote}>{t('chat.delegatedAddsMembersOnly')}</Text>
          )}
          <PrimaryButton
            disabled={!selectedCandidateId}
            label={t('chat.addSelectedMember')}
            loading={busy === 'conversation-add-member'}
            onPress={async () => {
              if (await onAddMember(
                conversation.id,
                selectedCandidateId,
                conversation.canManage ? candidateRole : 'member',
              )) {
                setCandidateId('');
                setMemberCandidates((current) => current.filter(
                  (candidate) => candidate.userId !== selectedCandidateId,
                ));
              }
            }}
          />
        </View>
      ) : null}

      {!conversation.managementOnly && conversation.departure ? (
        <View style={styles.modalSection}>
          <Text style={styles.modalLabel}>{departureCopy.title}</Text>
          <Text style={styles.modalNote}>
            {conversation.departure.eligible
              ? departureCopy.disclosure
              : `${departureCopy.unavailable} ${conversationDepartureRestrictionCopy(
                  locale,
                  conversation.departure.restriction,
                )}`}
          </Text>
          {conversation.departure.eligible ? (
            <>
              {conversation.departure.requiresOwnershipTransfer ? (
                <>
                  <Text style={styles.modalNote}>{departureCopy.transfer}</Text>
                  <Text style={styles.modalLabel}>{departureCopy.replacement}</Text>
                  {replacementCandidates.length ? (
                    <View style={styles.candidateList}>
                      {replacementCandidates.map((person) => (
                        <Pressable
                          accessibilityRole="radio"
                          accessibilityState={{ selected: replacementOwnerId === person.id }}
                          key={person.id}
                          onPress={() => setReplacementOwnerId(person.id)}
                          style={[
                            styles.candidateRow,
                            replacementOwnerId === person.id && styles.candidateRowSelected,
                          ]}>
                          <Avatar color={person.avatarColor} initials={person.initials} size={34} />
                          <Text style={styles.candidateName}>{person.displayName}</Text>
                          {replacementOwnerId === person.id ? (
                            <Ionicons name="checkmark-circle" color={colors.mintDark} size={18} />
                          ) : null}
                        </Pressable>
                      ))}
                    </View>
                  ) : <Text style={styles.modalNote}>{departureCopy.noReplacement}</Text>}
                </>
              ) : null}
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: departureConfirmed }}
                onPress={() => setDepartureConfirmed((current) => !current)}
                style={styles.candidateRow}>
                <Ionicons
                  name={departureConfirmed ? 'checkbox' : 'square-outline'}
                  color={departureConfirmed ? colors.mintDark : colors.inkMuted}
                  size={20}
                />
                <Text style={styles.candidateName}>{departureCopy.confirmation}</Text>
              </Pressable>
              <PrimaryButton
                disabled={!departureConfirmed || (
                  conversation.departure.requiresOwnershipTransfer && !replacementOwnerId
                )}
                icon="exit-outline"
                label={departureCopy.confirm}
                loading={busy === 'conversation-leave'}
                onPress={() => void onLeave(replacementOwnerId || undefined)}
                tone="danger"
              />
            </>
          ) : null}
        </View>
      ) : null}

      {conversation.canManageConversation
        && conversation.kind !== 'direct'
        && !conversation.archived
        && !conversation.isReadOnly ? (
        <PrimaryButton
          icon="archive-outline"
          label={t('chat.archiveConversation')}
          loading={busy === 'conversation-update'}
          onPress={onArchive}
          tone="danger"
        />
      ) : null}
      <ActionError message={error} />
    </ActionModal>
  );
}

function AttachmentPickerModal({
  visible,
  selected,
  caption,
  error,
  busy,
  onClose,
  onPickLibrary,
  onPickCamera,
  onPickFile,
  onChangeCaption,
  onSend,
  imageMode,
  onChangeImageMode,
}: {
  visible: boolean;
  selected: SelectedAttachment | null;
  caption: string;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onPickLibrary: () => void;
  onPickCamera: () => void;
  onPickFile: () => void;
  onChangeCaption: (value: string) => void;
  onSend: () => void;
  imageMode: 'optimized' | 'original';
  onChangeImageMode: (value: 'optimized' | 'original') => void;
}) {
  const workspace = useWorkspace();
  const { t } = useI18n();
  return (
    <ActionModal
      description={isPersonalRealm(workspace.organizationId) ? undefined : t('chat.attachmentDescription')}
      onClose={onClose}
      title={t('chat.addAttachment')}
      visible={visible}>
      <Text style={styles.modalNote}>{t('chat.fileLimit')} · {t('chat.videoFileLimit')}</Text>
      <View style={styles.attachmentChoices}>
        <PrimaryButton icon="images-outline" label={t('chat.photoLibrary')} onPress={onPickLibrary} tone="light" />
        <PrimaryButton icon="camera-outline" label={t('chat.camera')} onPress={onPickCamera} tone="light" />
        <PrimaryButton icon="document-outline" label={t('chat.chooseFile')} onPress={onPickFile} tone="light" />
      </View>
      {selected ? (
        <View style={styles.selectedFile}>
          {selected.mimeType.startsWith('image/') ? (
            <Image accessibilityLabel={t('chat.imagePreview')} resizeMode="cover" source={{ uri: selected.uri }} style={styles.imagePreview} />
          ) : (
          <Ionicons
            name={selected.mimeType.startsWith('video/') ? 'videocam-outline' : 'document-attach-outline'}
            color={colors.mintDark}
            size={22}
          />
          )}
          <View style={styles.selectedFileCopy}>
            <Text numberOfLines={1} style={styles.selectedFileName}>{selected.name}</Text>
            <Text style={styles.selectedFileMeta}>
              {selected.mimeType} · {selected.mimeType.startsWith('video/') ? t('chat.videoFileLimit') : t('chat.fileLimit')}
            </Text>
          </View>
        </View>
      ) : null}
      {selected?.mimeType.startsWith('image/') ? (
        <View style={styles.modalSection}>
          <Text style={styles.modalLabel}>{t('chat.imageQuality')}</Text>
          <View style={styles.modalRow}>
            <Chip label={t('chat.imageOptimized')} onPress={() => onChangeImageMode('optimized')} selected={imageMode === 'optimized'} />
            <Chip label={t('chat.imageOriginal')} onPress={() => onChangeImageMode('original')} selected={imageMode === 'original'} />
          </View>
          <Text style={styles.modalNote}>{imageMode === 'original' ? t('chat.imageOriginalNote') : t('chat.imageOptimizedNote')}</Text>
        </View>
      ) : null}
      <FormField label={t('chat.captionOptional')} multiline onChangeText={onChangeCaption} value={caption} />
      <ActionError message={error} />
      <PrimaryButton
        disabled={!selected}
        icon="shield-checkmark-outline"
        label={busy ? t('chat.uploading') : isPersonalRealm(workspace.organizationId) ? t('chat.sendAttachment') : t('chat.sendSecurely')}
        loading={busy}
        onPress={onSend}
      />
    </ActionModal>
  );
}

const styles = StyleSheet.create({
  systemEventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  systemEventLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.lineStrong,
  },
  systemEventPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.paperMuted,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  systemEventText: {
    color: colors.inkMuted,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  container: {
    flex: 1,
    minWidth: 0,
    backgroundColor: colors.paperMuted,
  },
  emptyPane: {
    flex: 1,
    minWidth: 0,
    backgroundColor: colors.paperMuted,
  },
  managementOnlyPane: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  managementOnlyCard: {
    width: '100%',
    maxWidth: 520,
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.xl,
    backgroundColor: colors.paper,
    padding: spacing.xl,
  },
  managementOnlyIcon: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 58,
    height: 58,
    borderRadius: radii.pill,
    backgroundColor: colors.mintSoft,
  },
  managementOnlyTitle: {
    color: colors.ink,
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
  },
  managementOnlyBody: {
    maxWidth: 440,
    color: colors.inkMuted,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  headerTitle: {
    flexShrink: 1,
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.25,
  },
  headerMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 3,
  },
  headerMeta: {
    flexShrink: 1,
    color: colors.inkSubtle,
    fontSize: 11,
  },
  metaDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.lineStrong,
  },
  translationPair: {
    color: colors.mintDark,
    fontSize: 10,
    fontWeight: '700',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  safetyBanner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: '#F4C5BC',
    backgroundColor: colors.redSoft,
  },
  safetyIcon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    backgroundColor: colors.paper,
  },
  safetyCopy: {
    flex: 1,
  },
  safetyTitle: {
    color: colors.red,
    fontSize: 13,
    fontWeight: '900',
  },
  safetyText: {
    color: '#7E4A44',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
  },
  translationBoundary: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: '#E7C998',
    backgroundColor: colors.amberSoft,
  },
  translationBoundaryText: {
    flex: 1,
    color: colors.amber,
    fontSize: 10,
    lineHeight: 15,
    fontWeight: '700',
  },
  incidentBanner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    padding: spacing.sm,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: '#F4C5BC',
    backgroundColor: colors.redSoft,
  },
  incidentBannerClosed: { borderColor: colors.lineStrong, backgroundColor: colors.paperMuted },
  incidentBannerCopy: { flex: 1, minWidth: 0 },
  incidentBannerTitle: { color: colors.ink, fontSize: 11, fontWeight: '900', textTransform: 'capitalize' },
  incidentBannerText: { color: colors.inkMuted, fontSize: 10, lineHeight: 15, marginTop: 2 },
  acknowledge: {
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    backgroundColor: colors.red,
  },
  acknowledgeText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: '900',
  },
  dateSeparator: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginVertical: spacing.md },
  dateSeparatorLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.lineStrong },
  dateSeparatorText: { color: colors.inkSubtle, fontSize: 10, fontWeight: '800' },
  unreadDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginVertical: spacing.md,
  },
  unreadDividerLine: { flex: 1, height: 1, backgroundColor: colors.mint },
  unreadDividerText: { color: colors.mintDark, fontSize: 10, fontWeight: '900' },
  searchTarget: {
    padding: 2,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.mint,
    backgroundColor: colors.mintSoft,
  },
  canonicalOriginalModal: { gap: spacing.xs, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.paperMuted },
  canonicalOriginalText: { color: colors.ink, fontSize: 13, lineHeight: 19 },
  reaction: {
    minHeight: 25,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    borderRadius: radii.pill,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  reactionMine: {
    backgroundColor: colors.mintSoft,
    borderColor: '#B4E8D4',
  },
  reactionEmoji: {
    fontSize: 12,
  },
  reactionCount: {
    color: colors.inkMuted,
    fontSize: 10,
    fontWeight: '800',
  },
  mentionSelector: { gap: spacing.xs, marginBottom: spacing.xs },
  mentionSelectorHeader: {
    minHeight: 30,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xs,
  },
  mentionToggle: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.paperMuted,
  },
  mentionToggleText: { color: colors.mintDark, fontSize: 10, fontWeight: '900' },
  mentionCount: {
    minWidth: 19,
    height: 19,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
    backgroundColor: colors.mint,
  },
  mentionCountText: { color: colors.forest, fontSize: 9, fontWeight: '900' },
  selectedMentions: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  selectedMention: {
    minHeight: 30,
    maxWidth: 220,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: '#B4E8D4',
    backgroundColor: colors.mintSoft,
  },
  selectedMentionText: { flexShrink: 1, color: colors.mintDark, fontSize: 10, fontWeight: '900' },
  mentionPanel: {
    gap: spacing.xs,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.md,
    backgroundColor: colors.paper,
  },
  mentionTitle: { color: colors.ink, fontSize: 11, fontWeight: '900' },
  mentionSearch: {
    minHeight: 42,
    paddingHorizontal: spacing.sm,
    color: colors.ink,
    fontSize: 12,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.sm,
    backgroundColor: colors.paperMuted,
  },
  mentionAvailable: { color: colors.inkSubtle, fontSize: 9, fontWeight: '900', textTransform: 'uppercase' },
  mentionCandidatesScroll: { maxHeight: 230 },
  mentionCandidates: { gap: 5 },
  mentionCandidate: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.sm,
    backgroundColor: colors.paper,
  },
  mentionCandidateSelected: { borderColor: colors.mint, backgroundColor: colors.mintSoft },
  mentionCandidateDisabled: { opacity: 0.45 },
  mentionCandidateCopy: { flex: 1, minWidth: 0 },
  mentionCandidateName: { color: colors.ink, fontSize: 11, fontWeight: '900' },
  mentionCandidateMeta: { color: colors.inkSubtle, fontSize: 9, marginTop: 2 },
  mentionEmpty: { color: colors.inkMuted, fontSize: 10, paddingVertical: spacing.sm },
  newMessageJumpText: { color: colors.white, fontSize: 11, fontWeight: '900' },
  readOnlyComposer: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  readOnlyComposerText: { color: colors.inkMuted, fontSize: 11, fontWeight: '800' },
  replyComposer: {
    minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    padding: spacing.xs, borderLeftWidth: 3, borderLeftColor: colors.mintDark,
    backgroundColor: colors.mintSoft, borderRadius: radii.sm, marginBottom: spacing.xs,
  },
  replyComposerCopy: { flex: 1, minWidth: 0 },
  replyComposerLabel: { color: colors.mintDark, fontSize: 10, fontWeight: '900' },
  replyComposerText: { color: colors.inkMuted, fontSize: 11, marginTop: 2 },
  recordingIndicator: {
    flex: 1,
    minWidth: 0,
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: radii.pill,
    backgroundColor: colors.red,
  },
  recordingTime: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  recordingLabel: {
    flex: 1,
    minWidth: 0,
    color: colors.inkMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  voiceBubble: {
    minWidth: 210,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
    padding: spacing.xs,
    borderRadius: radii.sm,
    backgroundColor: colors.paperMuted,
  },
  voicePlayButton: {
    width: 34,
    height: 34,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.mintSoft,
  },
  voiceCopy: {
    flex: 1,
    minWidth: 0,
  },
  voiceTitle: {
    color: colors.ink,
    fontSize: 11,
    fontWeight: '800',
  },
  voiceTime: {
    color: colors.inkSubtle,
    fontSize: 9,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  modalSection: {
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  historyDisclosure: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.mintSoft },
  historyDisclosureCopy: { flex: 1, minWidth: 0 },
  historyDisclosureTitle: { color: colors.mintDark, fontSize: 10, fontWeight: '900' },
  historyDisclosureText: { color: colors.inkMuted, fontSize: 11, lineHeight: 16, marginTop: 2 },
  modalLabel: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  modalRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  modalNote: {
    color: colors.inkMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  reportDisclosure: {
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.amber,
    backgroundColor: colors.amberSoft,
  },
  reportDisclosureHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  reportDisclosureTitle: { color: colors.amber, fontSize: 12, fontWeight: '900' },
  reportDisclosureText: { color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
  reportConsent: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  reportConsentChecked: { borderColor: colors.mintDark, backgroundColor: colors.mintSoft },
  reportConsentText: { flex: 1, color: colors.ink, fontSize: 12, lineHeight: 17, fontWeight: '700' },
  reportConsentRequired: { color: colors.red, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  notificationMuteStatus: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.amberSoft,
  },
  notificationMuteText: {
    flex: 1,
    minWidth: 180,
    color: colors.amber,
    fontSize: 10,
    lineHeight: 15,
    fontWeight: '800',
  },
  unavailableActions: { gap: spacing.xs, paddingTop: spacing.xs },
  emojiButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.paperMuted,
    borderWidth: 1,
    borderColor: colors.line,
  },
  emojiText: { fontSize: 22 },
  memberControlRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  memberControlCopy: { flex: 1, minWidth: 0 },
  memberControlName: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  memberControlRole: { color: colors.inkSubtle, fontSize: 10, marginTop: 2, textTransform: 'capitalize' },
  memberRoleChoices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  conversationAvatarControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  conversationAvatarPreview: {
    width: 72,
    height: 72,
    borderRadius: radii.lg,
    backgroundColor: colors.paperMuted,
  },
  conversationAvatarActions: { flex: 1, gap: spacing.xs },
  candidateList: { gap: spacing.xs },
  candidateRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  candidateRowSelected: { borderColor: colors.mint, backgroundColor: colors.mintSoft },
  candidateName: { flex: 1, color: colors.ink, fontSize: 12, fontWeight: '800' },
  attachmentChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  selectedFile: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.mintSoft,
  },
  selectedFileCopy: { flex: 1, minWidth: 0 },
  imagePreview: { width: 72, height: 72, borderRadius: radii.sm, backgroundColor: colors.paperMuted },
  selectedFileName: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  selectedFileMeta: { color: colors.inkMuted, fontSize: 10, marginTop: 2 },
  header: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.paper,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.lineStrong,
  },
  headerMobile: {
    minHeight: 56,
    paddingHorizontal: spacing.xs,
  },
  headerMetaTyping: { color: colors.mintDark, fontStyle: 'italic' },
  timeline: { flex: 1, minHeight: 0 },
  timelineLoading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  timelineEmpty: { flex: 1, paddingHorizontal: spacing.sm, paddingTop: spacing.sm, justifyContent: 'center' },
  messageList: { paddingHorizontal: spacing.sm, paddingVertical: spacing.sm },
  messageListMobile: { paddingHorizontal: spacing.xs },
  loadOlder: {
    alignSelf: 'center',
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.paper,
  },
  loadOlderText: { color: colors.mintDark, fontSize: 11, fontWeight: '700' },
  messageRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    marginVertical: 2,
  },
  messageRowOwn: { justifyContent: 'flex-end' },
  messageAvatarSlot: { width: 28, minHeight: 1 },
  messageStack: { maxWidth: '80%', alignItems: 'flex-start' },
  messageStackOwn: { alignItems: 'flex-end' },
  senderName: { color: colors.mintDark, fontSize: 11, fontWeight: '700', marginLeft: 6, marginBottom: 2 },
  bubble: { minWidth: 72, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 14 },
  bubbleIncoming: { backgroundColor: colors.paper, borderBottomLeftRadius: 4 },
  bubbleOwn: { backgroundColor: colors.mintSoft, borderBottomRightRadius: 4 },
  bubbleMedia: { padding: 3, minWidth: 0 },
  bubbleMentioned: { borderWidth: 1, borderColor: colors.mint },
  bubbleSafety: { borderLeftWidth: 3, borderLeftColor: colors.red },
  priorityRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 3 },
  priorityText: { color: colors.red, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  forwardedText: { color: colors.inkSubtle },
  reply: {
    borderLeftWidth: 3,
    borderLeftColor: colors.mint,
    backgroundColor: 'rgba(16,46,39,0.05)',
    borderRadius: radii.xs,
    paddingHorizontal: spacing.xs,
    paddingVertical: 5,
    marginBottom: 6,
  },
  replySender: { color: colors.mintDark, fontSize: 11, fontWeight: '800' },
  replyPreview: { color: colors.inkMuted, fontSize: 12, marginTop: 1 },
  messageMentions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginBottom: 3 },
  messageMentionsText: { flexShrink: 1, color: colors.mintDark, fontSize: 11, lineHeight: 15, fontWeight: '700' },
  messageText: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  secondaryText: { color: colors.inkMuted, fontSize: 14, lineHeight: 20 },
  translationBlock: {
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(16,46,39,0.2)',
  },
  quietRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  quietLine: { color: colors.inkSubtle, fontSize: 12, lineHeight: 16, marginTop: 4 },
  quietAction: { color: colors.mintDark, fontSize: 12, lineHeight: 16, fontWeight: '700' },
  quietActionHit: { minHeight: 24, justifyContent: 'center' },
  quietActionDisabled: { opacity: 0.55 },
  failedLine: { color: colors.red, fontSize: 12, lineHeight: 16 },
  mediaTrailer: { paddingHorizontal: 8, paddingTop: 4 },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.xs, marginTop: 2 },
  metaRowOverlay: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    marginTop: 0,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  metaAction: { marginRight: 'auto', minHeight: 24, justifyContent: 'center' },
  metaActionText: { color: colors.mintDark, fontSize: 11, fontWeight: '700' },
  timeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 3 },
  timeText: { color: colors.inkSubtle, fontSize: 10 },
  timeTextOverlay: { color: colors.white },
  reactions: { flexDirection: 'row', marginTop: -6, marginLeft: 8, gap: 4 },
  reactionsOwn: { marginLeft: 0, marginRight: 8 },
  fileCard: { minWidth: 210, marginBottom: 4, borderRadius: radii.sm, backgroundColor: 'rgba(16,46,39,0.05)' },
  fileCardOwn: { backgroundColor: 'rgba(16,46,39,0.07)' },
  fileRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.xs },
  fileCopy: { flex: 1, minWidth: 0 },
  fileName: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  fileMeta: { color: colors.inkSubtle, fontSize: 11, marginTop: 1 },
  fileProgressRow: { paddingHorizontal: spacing.xs, paddingBottom: 6 },
  fileProgressTrack: { height: 3, overflow: 'hidden', borderRadius: radii.pill, backgroundColor: 'rgba(16,46,39,0.12)' },
  fileProgressFill: { height: '100%', borderRadius: radii.pill, backgroundColor: colors.mint },
  fileControls: { paddingHorizontal: spacing.xs, paddingBottom: 6 },
  detailsBlock: { gap: 4, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.paperMuted },
  detailText: { color: colors.inkMuted, fontSize: 11, lineHeight: 16 },
  detailHash: { color: colors.inkSubtle, fontFamily: type.mono, fontSize: 9, lineHeight: 13 },
  detailWarning: { color: colors.red, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  newMessageJump: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.md,
    zIndex: 20,
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.mintDark,
  },
  composerWrap: {
    paddingHorizontal: spacing.sm,
    paddingTop: 6,
    backgroundColor: colors.paper,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.lineStrong,
  },
  composer: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    padding: 4,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.paperMuted,
  },
  composerInput: {
    flex: 1,
    minWidth: 0,
    maxHeight: 130,
    minHeight: 36,
    paddingHorizontal: spacing.xs,
    paddingTop: 8,
    paddingBottom: 8,
    color: colors.ink,
    fontSize: 15,
    lineHeight: 20,
  },
  voiceBubbleOwn: { backgroundColor: 'rgba(16,46,39,0.07)' },
  voicePlayButtonOwn: { backgroundColor: 'rgba(16,46,39,0.12)' },
  pressed: {
    opacity: 0.72,
  },
});
