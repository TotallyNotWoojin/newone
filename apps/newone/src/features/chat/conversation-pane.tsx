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
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { isPersonalRealm } from '@/constants/personal-realm';
import { attachmentMimeTypes, type SelectedAttachment } from '@/data/attachments';
import { useConversationTyping } from '@/data/realtime/use-conversation-typing';
import { activeMutedUntil, temporaryMutePatch } from '@/data/notification-preferences.mjs';
import { firstUnreadMessageId } from '@/data/reconciliation/message-timeline.mjs';
import type { ConversationMemberCandidate } from '@/data/repositories/contracts';
import type { AiOutputErrorCategory, Attachment, Conversation, Message, OperationalAction, Person } from '@/domain/types';
import { Avatar, Chip, EmptyState, IconButton, PrimaryButton, SearchField, StatusBadge } from '@/components/ui/primitives';
import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
import { KeyboardAvoidingScreen } from '@/components/ui/keyboard-avoiding-screen';
import {
  MAX_MESSAGE_MENTIONS,
  mentionablePeople,
} from '@/features/chat/mention-controls.mjs';
import { mentionCopy } from '@/features/chat/mention-copy';
import { notificationCopy } from '@/features/chat/notification-copy';
import { translationPreferenceCopy } from '@/features/chat/translation-preference-copy';
import {
  conversationDepartureCopy,
  conversationDepartureRestrictionCopy,
} from '@/features/chat/conversation-departure-copy';
import {
  moderationCopy,
  moderationReportConsentNotice,
  moderationTargetReportConsentNotice,
} from '@/features/admin/moderation-copy';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { colors, radii, spacing, type } from '@/theme/tokens';

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
  const scrollRef = useRef<ScrollView>(null);
  const router = useRouter();
  const { t } = useI18n();
  const workspace = useWorkspace();
  const observeConversation = workspace.observeConversation;
  const loadMyAiOutputErrorReports = workspace.loadMyAiOutputErrorReports;
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [reportDetails, setReportDetails] = useState('');
  const [reportCategory, setReportCategory] = useState<'harassment' | 'threat' | 'spam' | 'privacy' | 'misinformation' | 'other'>('other');
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [selectedMentionUserIds, setSelectedMentionUserIds] = useState<string[]>([]);
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [conversationName, setConversationName] = useState('');
  const [conversationDescription, setConversationDescription] = useState('');
  const [showAttachmentPicker, setShowAttachmentPicker] = useState(false);
  const [selectedAttachment, setSelectedAttachment] = useState<SelectedAttachment | null>(null);
  const [attachmentCaption, setAttachmentCaption] = useState('');
  const [attachmentImageMode, setAttachmentImageMode] = useState<'optimized' | 'original'>('optimized');
  const [newMessageCount, setNewMessageCount] = useState(0);
  const scrollOffsetRef = useRef(0);
  const contentHeightRef = useRef(0);
  const nearBottomRef = useRef(true);
  const previousTailRef = useRef<string | null>(null);
  const previousConversationRef = useRef<string | null>(null);
  const unreadDividerYRef = useRef<number | null>(null);
  const messageYRef = useRef(new Map<string, number>());
  const pendingSourceRef = useRef<string | null>(null);
  const appliedSearchFocusRef = useRef('');
  const initialPositionedRef = useRef(false);
  const pendingTailScrollRef = useRef(false);
  const prependAnchorRef = useRef<{ height: number; offset: number } | null>(null);
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
  const tailKey = tail?.serverId ?? tail?.clientMessageId ?? tail?.id ?? null;
  const currentUserId = workspace.currentUser?.id ?? null;
  const { typingPeers, notifyTyping, notifyStopped } = useConversationTyping({
    enabled: Boolean(conversationId) && Boolean(currentUserId) && conversation?.managementOnly !== true,
    organizationId: workspace.organizationId,
    conversationId,
    userId: currentUserId ?? '',
    displayName: workspace.currentUser?.displayName ?? '',
    accessToken: workspace.realtimeToken ?? undefined,
  });
  // Personal-realm direct threads surface person-level message-request state
  // derived from the counterpart's connection data.
  const requestCounterpart = conversation
    && conversation.kind === 'direct'
    && conversation.directParticipantId
    && isPersonalRealm(workspace.organizationId)
    ? workspace.people.find((person) => person.id === conversation.directParticipantId) ?? null
    : null;
  const pendingRequestCounterpart = requestCounterpart?.connectionState === 'pending'
    ? requestCounterpart
    : null;
  const incomingRequest = pendingRequestCounterpart?.connectionRequestDirection === 'incoming'
    ? pendingRequestCounterpart
    : null;
  const outgoingRequest = pendingRequestCounterpart?.connectionRequestDirection === 'outgoing'
    ? pendingRequestCounterpart
    : null;
  // The requester keeps an enabled composer while the request is pending: the
  // bootstrap reports can_post=false for the not-yet-permitted pair, but the
  // service itself enforces the request message cap.
  const composerDisabled = conversation
    ? conversation.isReadOnly === true || (conversation.canPost === false && !outgoingRequest)
    : false;
  const pendingRequestCounterpartId = pendingRequestCounterpart?.id ?? null;
  const refreshWorkspace = workspace.refresh;

  // Safety net: a missed inbox invalidation must not strand this thread in its
  // pending state, so poll while a pending counterpart is on screen. The
  // interval clears on unmount and as soon as the request resolves.
  useEffect(() => {
    if (!pendingRequestCounterpartId) return;
    const interval = setInterval(() => void refreshWorkspace(), 8_000);
    return () => clearInterval(interval);
  }, [pendingRequestCounterpartId, refreshWorkspace]);

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
      unreadDividerYRef.current = null;
      messageYRef.current.clear();
      pendingSourceRef.current = null;
      setSelectedMentionUserIds([]);
      setShowMentionPicker(false);
      initialPositionedRef.current = false;
      pendingTailScrollRef.current = false;
      prependAnchorRef.current = null;
      nearBottomRef.current = !unreadDividerId;
      setNewMessageCount(0);
      return;
    }
    if (tailKey && previousTailRef.current && tailKey !== previousTailRef.current) {
      if (nearBottomRef.current || tail?.isOwn) {
        pendingTailScrollRef.current = true;
        requestAnimationFrame(() => {
          if (!pendingTailScrollRef.current) return;
          pendingTailScrollRef.current = false;
          scrollRef.current?.scrollToEnd({ animated: true });
        });
      } else {
        const previousTailIndex = messages.findIndex((message) => (
          message.serverId ?? message.clientMessageId ?? message.id
        ) === previousTailRef.current);
        const addedCount = previousTailIndex >= 0
          ? Math.max(1, messages.length - previousTailIndex - 1)
          : 1;
        setNewMessageCount((count) => count + addedCount);
      }
    }
    previousTailRef.current = tailKey;
  }, [conversationId, messages, tail?.isOwn, tailKey, unreadDividerId]);

  useEffect(() => {
    if (!unreadDividerId || !conversationId) return;
    initialPositionedRef.current = false;
  }, [conversationId, unreadDividerId]);

  const positionAtUnreadDivider = (event: LayoutChangeEvent) => {
    const y = event.nativeEvent.layout.y;
    unreadDividerYRef.current = y;
    if (!initialPositionedRef.current) {
      initialPositionedRef.current = true;
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: Math.max(0, y - 20), animated: false }));
    }
  };

  const handleContentSizeChange = (_width: number, height: number) => {
    const prependAnchor = prependAnchorRef.current;
    contentHeightRef.current = height;
    if (prependAnchor && height > prependAnchor.height) {
      prependAnchorRef.current = null;
      scrollRef.current?.scrollTo({
        y: prependAnchor.offset + height - prependAnchor.height,
        animated: false,
      });
      return;
    }
    if (!initialPositionedRef.current) {
      if (unreadDividerId && unreadDividerYRef.current !== null) {
        initialPositionedRef.current = true;
        scrollRef.current?.scrollTo({
          y: Math.max(0, unreadDividerYRef.current - 20),
          animated: false,
        });
      } else if (!unreadDividerId) {
        initialPositionedRef.current = true;
        requestAnimationFrame(() => {
          scrollRef.current?.scrollToEnd({ animated: false });
          if (conversationId) void workspace.markConversationRead(conversationId);
        });
      }
      return;
    }
    if (pendingTailScrollRef.current) {
      pendingTailScrollRef.current = false;
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    }
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    scrollOffsetRef.current = contentOffset.y;
    contentHeightRef.current = contentSize.height;
    const nearBottom = contentSize.height - contentOffset.y - layoutMeasurement.height < 72;
    nearBottomRef.current = nearBottom;
    if (nearBottom) {
      setNewMessageCount(0);
      if (conversationId) void workspace.markConversationRead(conversationId);
    }
  };

  const loadOlder = async () => {
    if (!conversationId || pagination.loading || !pagination.hasMore) return;
    prependAnchorRef.current = {
      height: contentHeightRef.current,
      offset: scrollOffsetRef.current,
    };
    const changed = await workspace.loadOlderMessages(conversationId);
    if (!changed) prependAnchorRef.current = null;
  };

  const ensureMessageLoaded = workspace.ensureMessageLoaded;
  const scrollToSourceMessage = useCallback(async (messageId: string) => {
    pendingSourceRef.current = messageId;
    const existingY = messageYRef.current.get(messageId);
    if (existingY !== undefined) {
      pendingSourceRef.current = null;
      scrollRef.current?.scrollTo({ y: Math.max(0, existingY - 88), animated: true });
      return true;
    }
    if (messages.some((message) => (message.serverId ?? message.id) === messageId)) {
      return true;
    }
    const loaded = await ensureMessageLoaded(conversationId, messageId);
    if (!loaded) {
      pendingSourceRef.current = null;
      return false;
    }
    return true;
  }, [conversationId, ensureMessageLoaded, messages]);

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

  const recordMessagePosition = (message: Message, event: LayoutChangeEvent) => {
    const messageId = message.serverId ?? message.id;
    const y = event.nativeEvent.layout.y;
    messageYRef.current.set(messageId, y);
    if (pendingSourceRef.current === messageId) {
      pendingSourceRef.current = null;
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: Math.max(0, y - 88), animated: true }));
    }
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
      />

      {typingPeers.length ? (
        <View accessibilityLiveRegion="polite" style={styles.typingBanner}>
          <Ionicons name="chatbubble-ellipses-outline" color={colors.mintDark} size={13} />
          <Text numberOfLines={1} style={styles.typingBannerText}>
            {typingPeers.length === 1
              ? t('chat.typingSingle').replace('{name}', typingPeers[0].displayName)
              : t('chat.typingSeveral')}
          </Text>
        </View>
      ) : null}

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

      {conversation.translationMode !== 'off'
        && (conversation.translationPair || messages.some((message) => message.translationState !== 'not_requested')) ? (
        <View accessibilityRole="alert" style={styles.translationBoundary}>
          <Ionicons name="shield-checkmark-outline" color={colors.amber} size={17} />
          <Text style={styles.translationBoundaryText}>{t('chat.translationBoundary')}</Text>
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={[styles.messageList, mobile && styles.messageListMobile]}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={handleContentSizeChange}
        onScroll={handleScroll}
        ref={scrollRef}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}>
        {pagination.hasMore ? (
          <Pressable
            accessibilityRole="button"
            disabled={pagination.loading}
            onPress={() => void loadOlder()}
            style={({ pressed }) => [styles.loadOlder, pressed && styles.pressed]}>
            <Ionicons name="time-outline" size={15} color={colors.mintDark} />
            <Text style={styles.loadOlderText}>
              {pagination.loading ? t('chat.loadingOlder') : t('chat.loadOlder')}
            </Text>
          </Pressable>
        ) : null}
        <ConversationBriefing
          conversation={conversation}
          messages={messages}
          onOpenSource={scrollToSourceMessage}
        />
        {messages.length ? (
          messages.map((message, index) => (
            <View
              key={message.id}
              onLayout={(event) => recordMessagePosition(message, event)}
              style={(message.serverId ?? message.id) === focusMessageId ? styles.searchTarget : undefined}>
              {message.id === unreadDividerId ? (
                <View onLayout={positionAtUnreadDivider} style={styles.unreadDivider}>
                  <View style={styles.unreadDividerLine} />
                  <Text style={styles.unreadDividerText}>{t('chat.unreadMessages')}</Text>
                  <View style={styles.unreadDividerLine} />
                </View>
              ) : null}
              {message.dayLabel && message.dayLabel !== messages[index - 1]?.dayLabel ? (
                <View style={styles.dateSeparator}>
                  <View style={styles.dateSeparatorLine} />
                  <Text style={styles.dateSeparatorText}>{message.dayLabel}</Text>
                  <View style={styles.dateSeparatorLine} />
                </View>
              ) : null}
              {message.systemEvent ? <SystemEventRow message={message} /> : (
                <MessageBubble
                  message={message}
                  showSender={
                    !message.isOwn &&
                    conversation.kind !== 'direct' &&
                    messages[index - 1]?.senderId !== message.senderId
                  }
                  onDownload={() => void workspace.downloadAttachment(message)}
                  onOpenActions={() => {
                    workspace.clearActionError();
                    setEditDraft(message.originalText);
                    setReportDetails('');
                    setSelectedMessage(message);
                  }}
                />
              )}
            </View>
          ))
        ) : (
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
        )}
      </ScrollView>

      {newMessageCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            pendingTailScrollRef.current = false;
            nearBottomRef.current = true;
            setNewMessageCount(0);
            scrollRef.current?.scrollToEnd({ animated: true });
            void workspace.markConversationRead(conversation.id);
          }}
          style={({ pressed }) => [styles.newMessageJump, pressed && styles.pressed]}>
          <Ionicons name="arrow-down" size={16} color={colors.white} />
          <Text style={styles.newMessageJumpText}>
            {newMessageCount} {t('chat.newMessages')}
          </Text>
        </Pressable>
      ) : null}

      {incomingRequest ? (
        <View accessibilityRole="alert" style={styles.requestBanner}>
          <View style={styles.requestBannerCopy}>
            <Text style={styles.requestBannerTitle}>
              {t('chat.messageRequestIncoming').replace('{name}', incomingRequest.displayName)}
            </Text>
            <Text style={styles.requestBannerText}>{t('chat.messageRequestIncomingBody')}</Text>
          </View>
          <ActionError message={workspace.actionError} />
          <View style={styles.requestBannerActions}>
            <PrimaryButton
              icon="checkmark"
              label={t('people.accept')}
              loading={workspace.actionBusy === 'connection-respond'}
              onPress={() => void workspace.respondConnection(incomingRequest.id, 'accepted')}
              tone="dark"
            />
            <PrimaryButton
              icon="close"
              label={t('people.decline')}
              loading={workspace.actionBusy === 'connection-respond'}
              onPress={() => void workspace.respondConnection(incomingRequest.id, 'declined')}
              tone="light"
            />
          </View>
        </View>
      ) : null}
      {outgoingRequest ? (
        <View accessibilityRole="alert" style={styles.requestPendingBanner}>
          <Ionicons name="time-outline" color={colors.amber} size={16} />
          <View style={styles.requestPendingCopy}>
            <Text style={styles.requestPendingText}>
              {t('chat.messageRequestPending').replace('{name}', outgoingRequest.displayName)}
            </Text>
            <ActionError message={workspace.actionError} />
          </View>
        </View>
      ) : null}
      {incomingRequest ? null : (
      <Composer
        currentUserId={currentUserId}
        disabled={composerDisabled}
        disabledLabel={conversation.isReadOnly
          ? t('chat.incidentReadOnly')
          : conversation.kind === 'direct'
            ? t('chat.directPostingUnavailable')
            : t('chat.adminsOnlyPosting')}
        draft={draft}
        memberUserIds={conversation.kind === 'direct' ? [] : conversation.memberIds ?? []}
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
        translationPair={conversation.translationPair}
      />
      )}

      <MessageActionsModal
        key={selectedMessage?.id ?? 'closed'}
        busy={workspace.actionBusy}
        editDraft={editDraft}
        error={workspace.actionError}
        message={selectedMessage}
        conversations={workspace.conversations}
        onChangeEditDraft={setEditDraft}
        onChangeReportCategory={setReportCategory}
        onChangeReportDetails={setReportDetails}
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
        onReport={async (disclosure) => {
          if (selectedMessage && await workspace.reportMessage(
            selectedMessage,
            reportCategory,
            reportDetails,
            disclosure,
          )) {
            setSelectedMessage(null);
          }
        }}
        reportCategory={reportCategory}
        reportDetails={reportDetails}
      />
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

function ConversationBriefing({
  conversation,
  messages,
  onOpenSource,
}: {
  conversation: Conversation;
  messages: Message[];
  onOpenSource: (messageId: string) => Promise<boolean>;
}) {
  const workspace = useWorkspace();
  const router = useRouter();
  const { t } = useI18n();
  const currentUserId = workspace.currentUser?.id ?? null;
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState<OperationalAction | null>(null);
  const [assigneeId, setAssigneeId] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [correcting, setCorrecting] = useState(false);
  const [correctionTopic, setCorrectionTopic] = useState('');
  const [correctionBody, setCorrectionBody] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [reportingSummary, setReportingSummary] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyMode, setPolicyMode] = useState<'manual' | 'message_count' | 'shift_close'>('manual');
  const [policyThreshold, setPolicyThreshold] = useState('50');
  const [sourceError, setSourceError] = useState(false);
  const summary = workspace.summaries
    .filter((item) => item.conversationId === conversation.id)
    .sort((left, right) => right.versionNumber - left.versionNumber)[0];
  const summaryErrorReport = summary
    ? workspace.aiOutputErrorReports.find((report) => report.summaryId === summary.id)
    : undefined;
  const actions = workspace.actions.filter((item) => item.conversationId === conversation.id);
  const sourceMessageIds = messages.flatMap((message) => message.serverId ? [message.serverId] : []).slice(-500);
  const hasNewSummarySources = Boolean(
    summary && sourceMessageIds.length && sourceMessageIds.at(-1) !== summary.sourceLastMessageId,
  );
  const canManageSummary = conversation.canManage === true;
  const summaryStatus = summary ? ({
    queued: t('chat.summaryQueued'),
    generating: t('chat.summaryGenerating'),
    ready_for_review: t('chat.summaryReadyReview'),
    approved: t('chat.summaryApproved'),
    corrected: t('chat.summaryCorrected'),
    failed: t('chat.summaryFailed'),
    superseded: t('chat.summarySuperseded'),
  })[summary.status] : t('chat.summaryNotRequested');
  const summaryTone = !summary
    ? 'neutral' as const
    : summary.status === 'approved'
      ? 'success' as const
      : summary.status === 'failed' || summary.status === 'superseded'
        ? 'danger' as const
        : summary.status === 'ready_for_review' || summary.status === 'corrected'
          ? 'warning' as const
          : 'info' as const;
  const actionStatus = (status: OperationalAction['status']) => ({
    proposed: t('chat.actionProposed'),
    confirmed: t('chat.actionConfirmed'),
    in_progress: t('chat.actionInProgress'),
    completed: t('chat.actionCompleted'),
    cancelled: t('chat.actionCancelled'),
  })[status];
  const openSource = async (messageId: string) => {
    setSourceError(false);
    if (!await onOpenSource(messageId)) setSourceError(true);
  };
  return (
    <View style={styles.briefingCard}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [styles.briefingHeader, pressed && styles.pressed]}>
        <View style={styles.briefingIcon}>
          <Ionicons name="sparkles" size={16} color={colors.plum} />
        </View>
        <View style={styles.briefingHeaderCopy}>
          <View style={styles.briefingTitleRow}>
            <Text style={styles.briefingTitle}>{t('chat.briefing')}</Text>
            <StatusBadge label={summaryStatus} tone={summaryTone} />
          </View>
          <Text numberOfLines={expanded ? undefined : 1} style={styles.briefingPreview}>
            {summary?.primaryTopic || summary?.summary || (actions.length
              ? `${actions.length} ${t('chat.operationalActions')}`
              : t('chat.summaryDerivedDraft'))}
          </Text>
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.inkSubtle} />
      </Pressable>
      {expanded ? (
        <View style={styles.briefingBody}>
          <View style={styles.summaryBoundary}>
            <Ionicons name="git-compare-outline" size={15} color={colors.plum} />
            <Text style={styles.summaryBoundaryText}>{t('chat.summaryBoundary')}</Text>
          </View>
          {!summary ? (
            <View style={styles.summaryUnavailable}>
              <Text style={styles.summaryUnavailableTitle}>{t('chat.summaryNotRequested')}</Text>
              <Text style={styles.summaryUnavailableText}>{t('chat.summaryRequestDescription')}</Text>
              <PrimaryButton
                disabled={!sourceMessageIds.length}
                icon="sparkles-outline"
                label={t('chat.requestSummary')}
                loading={workspace.actionBusy === `summary-request:${conversation.id}`}
                onPress={() => void workspace.requestConversationSummary(conversation.id, sourceMessageIds)}
                tone="light"
              />
            </View>
          ) : summary.status === 'failed' || summary.status === 'superseded' ? (
            <View accessibilityLiveRegion="polite" style={styles.summaryUnavailable}>
              <Text style={styles.summaryUnavailableTitle}>{summaryStatus}</Text>
              <Text style={styles.summaryUnavailableText}>
                {summary.status === 'superseded' ? t('chat.summaryStaleBody') : t('chat.summaryFailureBody')}
              </Text>
              {summary.failureCode ? (
                <Text selectable style={styles.provenanceValue}>{t('chat.failureCode')} · {summary.failureCode}</Text>
              ) : null}
              <PrimaryButton
                icon="document-text-outline"
                label={t('chat.createManualHandoff')}
                onPress={() => router.push('/handoffs')}
                tone="light"
              />
            </View>
          ) : summary.status === 'queued' || summary.status === 'generating' ? (
            <View accessibilityLiveRegion="polite" style={styles.summaryUnavailable}>
              <Text style={styles.summaryUnavailableTitle}>{summaryStatus}</Text>
              <Text style={styles.summaryUnavailableText}>{t('chat.summaryProcessingBody')}</Text>
              <PrimaryButton
                icon="document-text-outline"
                label={t('chat.createManualHandoff')}
                onPress={() => router.push('/handoffs')}
                tone="light"
              />
            </View>
          ) : (
            <>
              {summary.sourceState === 'stale' || summary.policyState === 'stale' ? (
                <View accessibilityRole="alert" style={styles.summaryStaleWarning}>
                  <Ionicons name="warning-outline" size={16} color={colors.red} />
                  <Text style={styles.summaryStaleWarningText}>
                    {summary.sourceState === 'stale' ? t('chat.summarySourceStale') : t('chat.summaryPolicyStale')}
                  </Text>
                </View>
              ) : null}
              {summary.primaryTopic ? (
                <BriefingSection
                  label={t('chat.primaryTopic')}
                  items={[{ text: summary.primaryTopic, sourceMessageIds: [] }]}
                  onOpenSource={openSource}
                />
              ) : null}
              {summary.summary ? <Text style={styles.briefingSummary}>{summary.summary}</Text> : null}
              <BriefingSection label={t('chat.keyTopics')} items={summary.keyTopics} onOpenSource={openSource} />
              <BriefingSection label={t('chat.decisions')} items={summary.decisions} onOpenSource={openSource} />
              <BriefingSection
                label={t('chat.actionItems')}
                items={summary.actionItems.map((item) => ({
                  text: [item.title, item.owner, item.dueAt].filter(Boolean).join(' · '),
                  sourceMessageIds: item.sourceMessageIds,
                }))}
                onOpenSource={openSource}
              />
              <BriefingSection label={t('chat.ambiguities')} items={summary.ambiguities} onOpenSource={openSource} />
              <View style={styles.summarySourceSection}>
                <Text style={styles.briefingLabel}>{t('chat.sourceMessages')} · {summary.sourceMessageIds.length}</Text>
                <View style={styles.sourceLinks}>
                  {summary.sourceMessageIds.map((messageId) => (
                    <SourceMessageLink key={messageId} messageId={messageId} onOpen={openSource} />
                  ))}
                </View>
                {sourceError ? <Text accessibilityLiveRegion="assertive" style={styles.sourceError}>{t('chat.sourceUnavailable')}</Text> : null}
              </View>
              <View style={styles.provenanceCard}>
                <Text style={styles.briefingLabel}>{t('chat.provenance')}</Text>
                <Text style={styles.provenanceValue}>
                  {summary.provenance.processorType === 'ai' ? t('chat.machineDraft') : t('chat.manualCorrection')}
                  {summary.provenance.provider ? ` · ${summary.provenance.provider}` : ''}
                  {summary.provenance.model ? ` / ${summary.provenance.model}` : ''}
                </Text>
                <Text style={styles.provenanceValue}>
                  {t('chat.requestMode')} · {summary.requestMode} · v{summary.versionNumber}
                </Text>
                <Text selectable style={styles.provenanceHash}>
                  {t('chat.sourceFingerprint')} · {summary.sourceFingerprint}
                </Text>
                {summary.outputFingerprint ? (
                  <Text selectable style={styles.provenanceHash}>
                    {t('chat.outputFingerprint')} · {summary.outputFingerprint}
                  </Text>
                ) : null}
                <Text style={styles.provenanceValue}>
                  {summary.reviewedAt
                    ? `${t('chat.humanReviewed')} · ${summary.reviewedByUserId ?? t('chat.notAvailable')} · ${summary.reviewedAt}`
                    : t('chat.unapprovedDraft')}
                </Text>
                {summary.reviewNote ? <Text style={styles.provenanceValue}>{summary.reviewNote}</Text> : null}
              </View>
              {summary.outputFingerprint ? (
                summaryErrorReport ? (
                  <StatusBadge label={t('quality.reportSubmitted')} tone="info" />
                ) : (
                  <PrimaryButton
                    icon="flag-outline"
                    label={t('chat.reportSummaryError')}
                    onPress={() => {
                      workspace.clearActionError();
                      setReportingSummary(true);
                    }}
                    tone="light"
                  />
                )
              ) : null}
              {canManageSummary && summary.sourceState === 'current' ? (
                <View style={styles.summaryControls}>
                  <PrimaryButton
                    icon="create-outline"
                    label={t('chat.correctSummary')}
                    onPress={() => {
                      workspace.clearActionError();
                      setCorrectionTopic(summary.primaryTopic);
                      setCorrectionBody(summary.summary);
                      setCorrecting(true);
                    }}
                    tone="light"
                  />
                  {(summary.status === 'ready_for_review' || summary.status === 'corrected') ? (
                    <PrimaryButton
                      icon="shield-checkmark-outline"
                      label={t('chat.reviewSummary')}
                      onPress={() => {
                        workspace.clearActionError();
                        setReviewNote('');
                        setReviewing(true);
                      }}
                      tone="dark"
                    />
                  ) : null}
                </View>
              ) : null}
            </>
          )}
          {canManageSummary ? (
            <PrimaryButton
              icon="options-outline"
              label={t('chat.summarySchedule')}
              onPress={() => {
                workspace.clearActionError();
                setPolicyOpen(true);
              }}
              tone="light"
            />
          ) : null}
          {hasNewSummarySources && summary?.status !== 'queued' && summary?.status !== 'generating' ? (
            <PrimaryButton
              icon="sparkles-outline"
              label={t('chat.requestSummary')}
              loading={workspace.actionBusy === `summary-request:${conversation.id}`}
              onPress={() => void workspace.requestConversationSummary(conversation.id, sourceMessageIds)}
              tone="light"
            />
          ) : null}
          {actions.length ? (
            <View style={styles.actionList}>
              <Text style={styles.briefingLabel}>{t('chat.operationalActions')}</Text>
              {actions.map((action) => (
                <View key={action.id} style={styles.actionRow}>
                  <View style={styles.actionCopy}>
                    <Text style={styles.actionTitle}>{action.title}</Text>
                    <Text style={styles.actionMeta}>
                      {actionStatus(action.status)}
                      {action.assigneeName ? ` · ${action.assigneeName}` : ''}
                    </Text>
                  </View>
                  {action.status === 'proposed' && workspace.hasCapability('actions.confirm') ? (
                    <PrimaryButton
                      label={t('chat.confirmAction')}
                      onPress={() => {
                        workspace.clearActionError();
                        setAssigneeId('');
                        setDueAt('');
                        setConfirming(action);
                      }}
                      tone="light"
                    />
                  ) : action.status === 'confirmed' && (action.assigneeUserId === currentUserId || workspace.hasCapability('actions.confirm')) ? (
                    <PrimaryButton label={t('chat.startAction')} onPress={() => void workspace.transitionAction(action.id, 'in_progress')} tone="light" />
                  ) : action.status === 'in_progress' && (action.assigneeUserId === currentUserId || workspace.hasCapability('actions.confirm')) ? (
                    <View style={styles.modalRow}>
                      <PrimaryButton label={t('chat.completeAction')} onPress={() => void workspace.transitionAction(action.id, 'completed')} tone="dark" />
                      <PrimaryButton label={t('chat.cancelAction')} onPress={() => void workspace.transitionAction(action.id, 'cancelled')} tone="danger" />
                    </View>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
          <ActionError message={workspace.actionError} />
        </View>
      ) : null}
      <ActionModal
        description={confirming?.title ?? ''}
        onClose={() => setConfirming(null)}
        title={t('chat.confirmAction')}
        visible={Boolean(confirming)}>
        <Text style={styles.modalLabel}>{t('chat.assignTo')}</Text>
        <View style={styles.modalRow}>
          {workspace.people.filter((person) => !person.suspended).slice(0, 30).map((person) => (
            <Chip key={person.id} label={person.displayName} onPress={() => setAssigneeId(person.id)} selected={assigneeId === person.id} />
          ))}
        </View>
        <FormField label={t('chat.dueAt')} onChangeText={setDueAt} value={dueAt} />
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          disabled={!assigneeId}
          label={t('chat.confirmAction')}
          loading={workspace.actionBusy === 'action-confirm'}
          onPress={async () => {
            if (confirming && await workspace.confirmAction(confirming.id, assigneeId, dueAt)) setConfirming(null);
          }}
          tone="dark"
        />
      </ActionModal>
      <ActionModal
        description={t('chat.summaryCorrectionDescription')}
        onClose={() => setCorrecting(false)}
        title={t('chat.correctSummary')}
        visible={correcting}>
        <FormField label={t('chat.primaryTopic')} onChangeText={setCorrectionTopic} value={correctionTopic} />
        <FormField label={t('chat.summaryBody')} multiline onChangeText={setCorrectionBody} value={correctionBody} />
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          disabled={!correctionTopic.trim() || !correctionBody.trim()}
          label={t('chat.saveCorrection')}
          loading={summary ? workspace.actionBusy === `summary-correct:${summary.id}` : false}
          onPress={async () => {
            if (summary && await workspace.correctConversationSummary(summary, correctionTopic, correctionBody)) setCorrecting(false);
          }}
          tone="dark"
        />
      </ActionModal>
      <ActionModal
        description={t('chat.summaryReviewDescription')}
        onClose={() => setReviewing(false)}
        title={t('chat.reviewSummary')}
        visible={reviewing}>
        <FormField label={t('chat.reviewNote')} multiline onChangeText={setReviewNote} value={reviewNote} />
        <ActionError message={workspace.actionError} />
        <View style={styles.modalRow}>
          <PrimaryButton
            label={t('chat.approveExactVersion')}
            loading={summary ? workspace.actionBusy === `summary-review:${summary.id}` : false}
            onPress={async () => {
              if (summary && await workspace.reviewConversationSummary(summary.id, 'approve', reviewNote)) setReviewing(false);
            }}
            tone="dark"
          />
          <PrimaryButton
            disabled={reviewNote.trim().length < 3}
            label={t('chat.rejectSummary')}
            loading={summary ? workspace.actionBusy === `summary-review:${summary.id}` : false}
            onPress={async () => {
              if (summary && await workspace.reviewConversationSummary(summary.id, 'reject', reviewNote)) setReviewing(false);
            }}
            tone="danger"
          />
        </View>
      </ActionModal>
      <ActionModal
        description={t('chat.summaryScheduleDescription')}
        onClose={() => setPolicyOpen(false)}
        title={t('chat.summarySchedule')}
        visible={policyOpen}>
        <View style={styles.modalRow}>
          <Chip label={t('chat.summaryManual')} onPress={() => setPolicyMode('manual')} selected={policyMode === 'manual'} />
          <Chip label={t('chat.summaryMessageCount')} onPress={() => setPolicyMode('message_count')} selected={policyMode === 'message_count'} />
          <Chip label={t('chat.summaryShiftClose')} onPress={() => setPolicyMode('shift_close')} selected={policyMode === 'shift_close'} />
        </View>
        {policyMode === 'message_count' ? (
          <FormField
            keyboardType="number-pad"
            label={t('chat.summaryThreshold')}
            onChangeText={setPolicyThreshold}
            value={policyThreshold}
          />
        ) : null}
        <Text style={styles.modalNote}>{t('chat.summaryHumanReviewRequired')}</Text>
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          disabled={policyMode === 'message_count' && (
            !Number.isInteger(Number(policyThreshold)) || Number(policyThreshold) < 10 || Number(policyThreshold) > 500
          )}
          label={t('chat.saveSummarySchedule')}
          loading={workspace.actionBusy === `summary-policy:${conversation.id}`}
          onPress={async () => {
            const threshold = policyMode === 'message_count' ? Number(policyThreshold) : null;
            if (await workspace.setConversationSummaryPolicy(conversation.id, policyMode, threshold)) setPolicyOpen(false);
          }}
          tone="dark"
        />
      </ActionModal>
      {summary ? (
        <AiOutputErrorReportModal
          onClose={() => setReportingSummary(false)}
          outputKind="summary"
          targetId={summary.id}
          visible={reportingSummary}
        />
      ) : null}
    </View>
  );
}

function BriefingSection({
  label,
  items,
  onOpenSource,
}: {
  label: string;
  items: { text: string; sourceMessageIds: string[] }[];
  onOpenSource: (messageId: string) => void;
}) {
  if (!items.length) return null;
  return (
    <View style={styles.briefingSection}>
      <Text style={styles.briefingLabel}>{label}</Text>
      {items.map((item, index) => (
        <View key={`${label}-${index}`} style={styles.evidenceItem}>
          <Text style={styles.briefingItem}>• {item.text}</Text>
          {item.sourceMessageIds.length ? (
            <View style={styles.sourceLinks}>
              {item.sourceMessageIds.map((messageId) => (
                <SourceMessageLink key={messageId} messageId={messageId} onOpen={onOpenSource} />
              ))}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function SourceMessageLink({ messageId, onOpen }: { messageId: string; onOpen: (messageId: string) => void }) {
  const { t } = useI18n();
  return (
    <Pressable
      accessibilityLabel={`${t('chat.openSource')} ${messageId}`}
      accessibilityRole="link"
      onPress={() => onOpen(messageId)}
      style={({ pressed }) => [styles.sourceLink, pressed && styles.pressed]}>
      <Ionicons name="arrow-up-circle-outline" size={12} color={colors.plum} />
      <Text style={styles.sourceLinkText}>#{messageId}</Text>
    </Pressable>
  );
}

function ConversationHeader({
  conversation,
  onBack,
  onOpenControls,
  mobile,
}: {
  conversation: Conversation;
  onBack?: () => void;
  onOpenControls: () => void;
  mobile: boolean;
}) {
  const { t } = useI18n();
  const workspace = useWorkspace();
  return (
    <View style={[styles.header, mobile && styles.headerMobile]}>
      {mobile ? (
        <IconButton name="chevron-back" label={t('chat.back')} onPress={onBack} size={38} />
      ) : null}
      <Avatar
        color={conversation.avatarColor}
        icon={conversation.kind === 'announcement' ? 'megaphone' : undefined}
        imageUri={workspace.conversationAvatarUrls[conversation.id]}
        initials={conversation.initials}
        presence={conversation.kind === 'direct' ? conversation.presence : undefined}
        size={mobile ? 40 : 44}
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
          <Text numberOfLines={1} style={styles.headerMeta}>
            {conversation.activeNowLabel ?? conversation.subtitle}
          </Text>
          {conversation.translationPair ? (
            <>
              <View style={styles.metaDot} />
              <Ionicons name="language" size={12} color={colors.mintDark} />
              <Text style={styles.translationPair}>{conversation.translationPair}</Text>
            </>
          ) : null}
        </View>
      </View>
      <View style={styles.headerActions}>
        <IconButton
          name="ellipsis-horizontal"
          label={t('chat.conversationSettings')}
          onPress={onOpenControls}
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
  onOpenActions,
  onDownload,
}: {
  message: Message;
  showSender: boolean;
  onOpenActions: () => void;
  onDownload: () => void;
}) {
  const workspace = useWorkspace();
  const { locale, t } = useI18n();
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionText, setCorrectionText] = useState('');
  const [correctionRationale, setCorrectionRationale] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reportErrorOpen, setReportErrorOpen] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const translationConversation = workspace.conversations.find(
    (conversation) => conversation.id === message.conversationId,
  );
  const translationEnabled = translationConversation?.translationMode !== 'off';
  // Consumer threads translate automatically server-side; a manual request
  // would only duplicate that pipeline, so it stays hidden unless a row failed.
  const automaticTranslation = translationEnabled
    && isPersonalRealm(workspace.organizationId)
    && (translationConversation?.translationMode ?? 'automatic') === 'automatic';
  const translation = translationEnabled ? message.translation : undefined;
  const translationErrorReport = translation
    ? workspace.aiOutputErrorReports.find((report) => report.translationId === translation.id)
    : undefined;
  const visibleTranslationState = translationEnabled ? message.translationState : 'not_requested';
  const correction = translation?.correction;
  const hasTranslation = Boolean(message.translatedText && translation?.status === 'completed');
  const canRequestTranslation = Boolean(
    translationEnabled
      && message.serverId
      && message.languageDetection?.state === 'completed'
      && workspace.messageDisplayLanguage !== null
      && message.languageDetection.detectedLanguage !== workspace.messageDisplayLanguage
      && (!translation || translation.status === 'failed' || translation.status === 'blocked')
      && (!automaticTranslation || translation?.status === 'failed' || translation?.status === 'blocked'),
  );
  const translationStateLabel = ({
    not_requested: t('chat.translationNotRequested'),
    queued: t('chat.translationQueued'),
    translating: t('chat.translationProcessing'),
    translated: t('chat.machineTranslation'),
    corrected: t('chat.correctedTranslation'),
    human_reviewed: t('chat.humanReviewedTranslation'),
    blocked: t('chat.translationBlocked'),
    needs_review: t('chat.translationNeedsReview'),
    failed: t('chat.translationFailed'),
  })[visibleTranslationState];
  const detection = message.languageDetection;
  const detectionLabel = detection?.state === 'completed'
    ? `${t('chat.detectedLanguage')} · ${detection.detectedLanguage?.toUpperCase()}`
    : detection?.state === 'ambiguous'
      ? t('chat.languageAmbiguous')
      : detection?.state === 'failed'
        ? t('chat.languageDetectionFailed')
        : detection?.state === 'pending'
          ? t('chat.languageDetectionPending')
          : t('chat.languageNotApplicable');
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

  return (
    <View style={[styles.messageRow, message.isOwn && styles.messageRowOwn]}>
      {!message.isOwn ? (
        <View style={styles.messageAvatarSlot}>
          {showSender ? (
            <Avatar color={message.senderColor} initials={message.senderInitials} size={30} />
          ) : null}
        </View>
      ) : null}
      <View style={[styles.messageStack, message.isOwn && styles.messageStackOwn]}>
        {showSender ? <Text style={styles.senderName}>{message.senderName}</Text> : null}
        <Pressable
          accessibilityHint={t('chat.longPressActions')}
          onLongPress={onOpenActions}
          style={[
            styles.bubble,
            message.isOwn ? styles.bubbleOwn : styles.bubbleIncoming,
            mentionedMe && styles.bubbleMentioned,
            message.priority === 'safety' && styles.bubbleSafety,
          ]}>
          {message.priority !== 'normal' ? (
            <View style={styles.priorityRow}>
              <Ionicons
                name={message.priority === 'safety' ? 'warning' : 'alert-circle'}
                size={13}
                color={message.isOwn ? '#FFD4C7' : colors.red}
              />
              <Text
                style={[
                  styles.priorityText,
                  message.isOwn && styles.priorityTextOwn,
                ]}>
                {message.priority === 'safety' ? t('chat.safety') : t('chat.important')}
              </Text>
            </View>
          ) : null}

          {message.forwarded ? (
            <View style={styles.priorityRow}>
              <Ionicons
                name="arrow-redo-outline"
                size={12}
                color={message.isOwn ? 'rgba(255,255,255,0.68)' : colors.inkSubtle}
              />
              <Text style={[styles.priorityText, message.isOwn && styles.priorityTextOwn]}>
                {t('chat.forwarded')}
              </Text>
            </View>
          ) : null}

          {message.replyTo ? (
            <View style={[styles.reply, message.isOwn && styles.replyOwn]}>
              <Text style={[styles.replySender, message.isOwn && styles.replySenderOwn]}>
                {message.replyTo.senderName}
              </Text>
              <Text
                numberOfLines={1}
                style={[styles.replyPreview, message.isOwn && styles.replyPreviewOwn]}>
                {message.replyTo.preview}
              </Text>
            </View>
          ) : null}

          {mentionedNames.length ? (
            <View
              accessibilityLabel={`${mention.mentioned}: ${mentionedNames.join(', ')}`}
              style={styles.messageMentions}>
              <Ionicons
                name="at-circle-outline"
                size={13}
                color={message.isOwn ? '#78DDB8' : colors.mintDark}
              />
              <Text style={[styles.messageMentionsText, message.isOwn && styles.messageMentionsTextOwn]}>
                {mention.mentioned} · {mentionedNames.map((name) => `@${name}`).join('  ')}
              </Text>
            </View>
          ) : null}

          {message.attachment ? (
            isPlayableAudioAttachment(message.attachment) ? (
              <AudioAttachmentBubble message={message} />
            ) : (
              <AttachmentCard message={message} onDownload={onDownload} />
            )
          ) : null}

          <View style={styles.originalLabelRow}>
            <Ionicons
              name="document-text-outline"
              size={12}
              color={message.isOwn ? 'rgba(255,255,255,0.68)' : colors.inkSubtle}
            />
            <Text style={[styles.originalLabel, message.isOwn && styles.originalLabelOwn]}>
              {t('chat.originalUpper')} · {message.sourceLanguage.toUpperCase()}
            </Text>
          </View>
          <Text style={[styles.messageText, message.isOwn && styles.messageTextOwn]}>
            {message.originalText}
          </Text>

          {message.deliveryState === 'failed' ? (
            <View style={styles.translationQueued}>
              <Ionicons name="alert-circle-outline" size={12} color={message.isOwn ? '#FFD4C7' : colors.red} />
              <Text style={[styles.queuedText, message.isOwn && styles.queuedTextOwn]}>
                {message.failureReason ? `${t('chat.failed')} · ${message.failureReason}` : t('chat.failed')}
              </Text>
            </View>
          ) : null}

          {detection ? (
            <View style={[styles.detectionRow, message.isOwn && styles.detectionRowOwn]}>
              <Ionicons
                name={detection.state === 'ambiguous' || detection.state === 'failed' ? 'warning-outline' : 'language-outline'}
                size={12}
                color={message.isOwn ? 'rgba(255,255,255,0.74)' : colors.inkSubtle}
              />
              <Text style={[styles.detectionText, message.isOwn && styles.detectionTextOwn]}>{detectionLabel}</Text>
              {detection.confidence !== null ? (
                <Text style={[styles.detectionText, message.isOwn && styles.detectionTextOwn]}>
                  · {Math.round(detection.confidence * 100)}%
                </Text>
              ) : null}
              {detection.method ? (
                <Text style={[styles.detectionText, message.isOwn && styles.detectionTextOwn]}>
                  · {detection.method}
                </Text>
              ) : null}
            </View>
          ) : null}

          {hasTranslation ? (
            <View style={[styles.translationCard, message.isOwn && styles.translationCardOwn]}>
              <View style={styles.translationHeader}>
                <View style={styles.translationTitleRow}>
                  <Ionicons name="language" size={13} color={message.isOwn ? '#78DDB8' : colors.mintDark} />
                  <Text style={[styles.translationTitle, message.isOwn && styles.translationTitleOwn]}>
                    {t('chat.translationUpper')} · {translation?.targetLanguage.toUpperCase()}
                  </Text>
                </View>
                <Text style={[styles.translationStatus, message.isOwn && styles.translationStatusOwn]}>
                  {translationStateLabel}
                </Text>
              </View>
              <Text style={[styles.translatedText, message.isOwn && styles.translatedTextOwn]}>
                {message.translatedText}
              </Text>
              {correction?.status === 'approved' ? (
                <View style={styles.translationAttribution}>
                  <Ionicons name="person-circle-outline" size={13} color={message.isOwn ? '#78DDB8' : colors.mintDark} />
                  <Text style={[styles.translationAttributionText, message.isOwn && styles.translationAttributionTextOwn]}>
                    {t('chat.reviewedCorrection')}
                    {correction.reviewedByUserId ? ` · ${correction.reviewedByUserId}` : ''}
                    {correction.reviewedAt ? ` · ${correction.reviewedAt}` : ''}
                  </Text>
                </View>
              ) : correction?.status === 'pending' ? (
                <Text style={[styles.translationPendingReview, message.isOwn && styles.translationPendingReviewOwn]}>
                  {t('chat.correctionPendingReview')}
                </Text>
              ) : null}
              {translation?.policyState === 'stale' ? (
                <Text accessibilityRole="alert" style={styles.translationPolicyWarning}>{t('chat.translationPolicyStale')}</Text>
              ) : null}
              <View style={styles.translationActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: detailsExpanded }}
                  onPress={() => setDetailsExpanded((value) => !value)}
                  style={({ pressed }) => [styles.inlineAction, pressed && styles.pressed]}>
                  <Text style={[styles.inlineActionText, message.isOwn && styles.inlineActionTextOwn]}>
                    {detailsExpanded ? t('chat.hideProvenance') : t('chat.showProvenance')}
                  </Text>
                </Pressable>
                {translation?.status === 'completed' ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      workspace.clearActionError();
                      setCorrectionText(message.translatedText ?? '');
                      setCorrectionRationale('');
                      setCorrectionOpen(true);
                    }}
                    style={({ pressed }) => [styles.inlineAction, pressed && styles.pressed]}>
                    <Text style={[styles.inlineActionText, message.isOwn && styles.inlineActionTextOwn]}>{t('chat.proposeCorrection')}</Text>
                  </Pressable>
                ) : null}
                {translationErrorReport ? (
                  <Text style={[styles.translationPendingReview, message.isOwn && styles.translationPendingReviewOwn]}>
                    {t('quality.reportSubmitted')}
                  </Text>
                ) : null}
                {translation?.status === 'completed' && !translationErrorReport ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      workspace.clearActionError();
                      setReportErrorOpen(true);
                    }}
                    style={({ pressed }) => [styles.inlineAction, pressed && styles.pressed]}>
                    <Text style={[styles.inlineActionText, message.isOwn && styles.inlineActionTextOwn]}>
                      {t('chat.reportTranslationError')}
                    </Text>
                  </Pressable>
                ) : null}
                {correction?.status === 'pending' && workspace.hasCapability('language.review') ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      workspace.clearActionError();
                      setReviewNote('');
                      setReviewOpen(true);
                    }}
                    style={({ pressed }) => [styles.inlineAction, pressed && styles.pressed]}>
                    <Text style={[styles.inlineActionText, message.isOwn && styles.inlineActionTextOwn]}>{t('chat.reviewCorrection')}</Text>
                  </Pressable>
                ) : null}
              </View>
              {detailsExpanded && translation ? (
                <View style={[styles.translationDetails, message.isOwn && styles.translationDetailsOwn]}>
                  <Text style={[styles.translationDetailText, message.isOwn && styles.translationDetailTextOwn]}>
                    {t('chat.machineRoute')} · {translation.provider ?? t('chat.notAvailable')} / {translation.model ?? t('chat.notAvailable')}
                  </Text>
                  <Text style={[styles.translationDetailText, message.isOwn && styles.translationDetailTextOwn]}>
                    {t('chat.sourceLanguage')} · {translation.sourceLanguage.toUpperCase()} · {t('chat.targetLanguage')} · {translation.targetLanguage.toUpperCase()}
                  </Text>
                  <Text style={[styles.translationDetailText, message.isOwn && styles.translationDetailTextOwn]}>
                    {t('chat.detector')} · {detection?.method ?? t('chat.notAvailable')}
                  </Text>
                  <Text selectable style={[styles.translationHash, message.isOwn && styles.translationDetailTextOwn]}>
                    {t('chat.sourceFingerprint')} · {translation.sourceBodySha256}
                  </Text>
                  <Text style={[styles.translationDetailText, message.isOwn && styles.translationDetailTextOwn]}>
                    {t('chat.policyVersion')} · {translation.policyVersion ?? t('chat.notAvailable')} · {translation.createdAt}
                  </Text>
                  {translation.reviewedAt ? (
                    <Text style={[styles.translationDetailText, message.isOwn && styles.translationDetailTextOwn]}>
                      {t('chat.humanReviewed')} · {translation.reviewedByUserId ?? t('chat.notAvailable')} · {translation.reviewedAt}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : (
            <View style={[styles.translationStateCard, message.isOwn && styles.translationStateCardOwn]}>
              <View style={styles.translationTitleRow}>
                <Ionicons
                  name={visibleTranslationState === 'failed' || visibleTranslationState === 'blocked' || detection?.state === 'ambiguous'
                    ? 'warning-outline' : 'language-outline'}
                  size={13}
                  color={message.isOwn ? 'rgba(255,255,255,0.74)' : colors.inkSubtle}
                />
                <Text style={[styles.translationStateText, message.isOwn && styles.translationStateTextOwn]}>
                  {translationStateLabel}
                </Text>
              </View>
              {translation?.failureCode ? (
                <Text selectable style={[styles.translationFailure, message.isOwn && styles.translationFailureOwn]}>
                  {t('chat.failureCode')} · {translation.failureCode}
                </Text>
              ) : detection?.state === 'ambiguous' ? (
                <Text style={[styles.translationFailure, message.isOwn && styles.translationFailureOwn]}>{t('chat.ambiguousOriginalAvailable')}</Text>
              ) : null}
              {translation ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: detailsExpanded }}
                  onPress={() => setDetailsExpanded((value) => !value)}
                  style={({ pressed }) => [styles.inlineAction, pressed && styles.pressed]}>
                  <Text style={[styles.inlineActionText, message.isOwn && styles.inlineActionTextOwn]}>
                    {detailsExpanded ? t('chat.hideProvenance') : t('chat.showProvenance')}
                  </Text>
                </Pressable>
              ) : null}
              {detailsExpanded && translation ? (
                <View style={[styles.translationDetails, message.isOwn && styles.translationDetailsOwn]}>
                  <Text style={[styles.translationDetailText, message.isOwn && styles.translationDetailTextOwn]}>
                    {t('chat.sourceLanguage')} · {translation.sourceLanguage.toUpperCase()} · {t('chat.targetLanguage')} · {translation.targetLanguage.toUpperCase()}
                  </Text>
                  <Text selectable style={[styles.translationHash, message.isOwn && styles.translationDetailTextOwn]}>
                    {t('chat.sourceFingerprint')} · {translation.sourceBodySha256}
                  </Text>
                  <Text style={[styles.translationDetailText, message.isOwn && styles.translationDetailTextOwn]}>
                    {t('chat.policyVersion')} · {translation.policyVersion ?? t('chat.notAvailable')} · {translation.updatedAt}
                  </Text>
                </View>
              ) : null}
              {canRequestTranslation ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void workspace.requestTranslation(message)}
                  style={({ pressed }) => [styles.translationRequest, pressed && styles.pressed]}>
                  <Text style={styles.translationRequestText}>
                    {translation?.status === 'failed' || translation?.status === 'blocked'
                      ? t('chat.retryTranslation')
                      : t('chat.requestTranslation')}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          )}

          <View style={styles.messageMeta}>
            <Text style={[styles.canonicalLabel, message.isOwn && styles.canonicalLabelOwn]}>{t('chat.originalCanonical')}</Text>
            <View
              accessibilityLabel={message.isOwn ? aggregateLabel : undefined}
              accessible={message.isOwn}
              style={styles.timeRow}>
              {message.edited ? (
                <Text style={[styles.timeText, message.isOwn && styles.timeTextOwn]}>{t('chat.edited')}</Text>
              ) : null}
              <Text style={[styles.timeText, message.isOwn && styles.timeTextOwn]}>
                {message.sentAt}
              </Text>
              {message.isOwn && aggregateReceipt && aggregateReceipt.recipientCount > 1 ? (
                <Text style={[styles.receiptCount, styles.timeTextOwn]}>
                  {aggregateReceipt.deliveredCount}/{aggregateReceipt.recipientCount}
                  {aggregateReceipt.visibleReadEligibleCount > 0
                    ? ` · ${aggregateReceipt.visibleReadCount}/${aggregateReceipt.visibleReadEligibleCount}`
                    : ''}
                </Text>
              ) : null}
              {message.isOwn ? (
                <Ionicons
                  name={
                    message.deliveryState === 'pending'
                      ? 'time-outline'
                      : message.deliveryState === 'failed'
                        ? 'alert-circle-outline'
                        : 'checkmark-done'
                  }
                  size={14}
                  color={
                    message.deliveryState === 'failed'
                      ? '#FFD4C7'
                      : message.deliveryState === 'read'
                      ? '#7DE5BE'
                      : 'rgba(255,255,255,0.64)'
                  }
                />
              ) : null}
            </View>
          </View>
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
        {correctionOpen ? (
          <ActionModal
            description={t('chat.translationCorrectionDescription')}
            onClose={() => setCorrectionOpen(false)}
            title={t('chat.proposeCorrection')}
            visible>
            <View style={styles.canonicalOriginalModal}>
              <Text style={styles.modalLabel}>{t('chat.canonicalOriginal')}</Text>
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
                if (await workspace.proposeTranslationCorrection(message, correctionText, correctionRationale)) setCorrectionOpen(false);
              }}
              tone="dark"
            />
          </ActionModal>
        ) : null}
        {reviewOpen ? (
          <ActionModal
            description={correction?.correctedText ?? ''}
            onClose={() => setReviewOpen(false)}
            title={t('chat.reviewCorrection')}
            visible>
            {correction?.rationale ? <Text style={styles.modalNote}>{correction.rationale}</Text> : null}
            <FormField label={t('chat.reviewNote')} multiline onChangeText={setReviewNote} value={reviewNote} />
            <ActionError message={workspace.actionError} />
            <View style={styles.modalRow}>
              <PrimaryButton
                label={t('chat.approveCorrection')}
                loading={correction ? workspace.actionBusy === `translation-review:${correction.id}` : false}
                onPress={async () => {
                  if (await workspace.reviewTranslationCorrection(message, 'approved', reviewNote)) setReviewOpen(false);
                }}
                tone="dark"
              />
              <PrimaryButton
                disabled={reviewNote.trim().length < 3}
                label={t('chat.requestChanges')}
                loading={correction ? workspace.actionBusy === `translation-review:${correction.id}` : false}
                onPress={async () => {
                  if (await workspace.reviewTranslationCorrection(message, 'changes_requested', reviewNote)) setReviewOpen(false);
                }}
                tone="light"
              />
              <PrimaryButton
                disabled={reviewNote.trim().length < 3}
                label={t('chat.rejectCorrection')}
                loading={correction ? workspace.actionBusy === `translation-review:${correction.id}` : false}
                onPress={async () => {
                  if (await workspace.reviewTranslationCorrection(message, 'rejected', reviewNote)) setReviewOpen(false);
                }}
                tone="danger"
              />
            </View>
          </ActionModal>
        ) : null}
        {translation ? (
          <AiOutputErrorReportModal
            onClose={() => setReportErrorOpen(false)}
            outputKind="translation"
            targetId={translation.id}
            visible={reportErrorOpen}
          />
        ) : null}
      </View>
    </View>
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

function isPlayableAudioAttachment(attachment: Attachment) {
  return attachment.mimeType?.startsWith('audio/') === true
    && attachment.status === 'clean'
    && Boolean(attachment.downloadUrl)
    && (!attachment.transfer || attachment.transfer.state === 'uploaded');
}

function formatPlaybackTime(seconds: number) {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function AudioAttachmentBubble({ message }: { message: Message }) {
  const { t } = useI18n();
  const attachment = message.attachment;
  const player = useAudioPlayer(attachment?.downloadUrl ?? null);
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
        <Ionicons
          name={playing ? 'pause' : 'play'}
          size={18}
          color={message.isOwn ? colors.white : colors.mintDark}
        />
      </Pressable>
      <View style={styles.voiceCopy}>
        <Text numberOfLines={1} style={[styles.voiceTitle, message.isOwn && styles.voiceTitleOwn]}>
          {t('chat.voiceNote')}
        </Text>
        <Text style={[styles.voiceTime, message.isOwn && styles.voiceTimeOwn]}>
          {formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}
        </Text>
      </View>
      <Ionicons
        name="mic-outline"
        size={16}
        color={message.isOwn ? 'rgba(255,255,255,0.78)' : colors.inkMuted}
      />
    </View>
  );
}

function AttachmentCard({ message, onDownload }: { message: Message; onDownload: () => void }) {
  const workspace = useWorkspace();
  const { t } = useI18n();
  const attachment = message.attachment;
  if (!attachment) return null;
  const scanStatus = {
    clean: { label: t('chat.fileClean'), icon: 'download-outline' as const },
    scanning: { label: t('chat.fileScanning'), icon: 'hourglass-outline' as const },
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
  const canDownload = attachment.status === 'clean' && (!transfer || transfer.state === 'uploaded');
  const clientMessageId = message.clientMessageId ?? '';
  const retryBusy = workspace.actionBusy === `attachment-retry:${clientMessageId}`;
  const cancelBusy = workspace.actionBusy === `attachment-cancel:${clientMessageId}`;
  return (
    <View style={[styles.attachment, message.isOwn && styles.attachmentOwn]}>
      <Pressable
        accessibilityHint={canDownload ? t('chat.fileDownloadHint') : transferStatus.label}
        accessibilityLabel={`${attachment.name}, ${transferStatus.label}`}
        accessibilityRole={canDownload ? 'button' : undefined}
        disabled={!canDownload}
        onPress={canDownload ? onDownload : undefined}
        style={({ pressed }) => [styles.attachmentMain, pressed && canDownload && styles.pressed]}>
        <View style={[styles.attachmentIcon, message.isOwn && styles.attachmentIconOwn]}>
          <Ionicons
            name={attachment.kind === 'image'
              ? 'image-outline'
              : attachment.mimeType?.startsWith('video/')
                ? 'videocam-outline'
                : attachment.kind === 'voice'
                  ? 'mic-outline'
                  : 'document-text-outline'}
            size={19}
            color={message.isOwn ? colors.white : colors.mintDark}
          />
        </View>
        <View style={styles.attachmentCopy}>
          <Text
            numberOfLines={1}
            style={[styles.attachmentName, message.isOwn && styles.attachmentNameOwn]}>
            {attachment.name}
          </Text>
          <Text style={[styles.attachmentMeta, message.isOwn && styles.attachmentMetaOwn]}>
            {attachment.sizeLabel} · {transferStatus.label}
          </Text>
        </View>
        <Ionicons
          name={transferStatus.icon}
          size={18}
          color={message.isOwn ? 'rgba(255,255,255,0.78)' : colors.inkMuted}
        />
      </Pressable>
      {isTransferring ? (
        <View style={styles.attachmentProgressRow}>
          <View
            accessibilityLabel={`${t('chat.attachmentProgress')} ${progressPercent}%`}
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: progressPercent, text: `${progressPercent}%` }}
            style={[styles.attachmentProgressTrack, message.isOwn && styles.attachmentProgressTrackOwn]}>
            <View
              style={[
                styles.attachmentProgressFill,
                { width: `${progressPercent}%` as `${number}%` },
              ]}
            />
          </View>
          <Text style={[styles.attachmentPercent, message.isOwn && styles.attachmentMetaOwn]}>{progressPercent}%</Text>
        </View>
      ) : null}
      {transfer?.state === 'failed' ? (
        <Text accessibilityLiveRegion="assertive" style={[styles.attachmentFailure, message.isOwn && styles.attachmentFailureOwn]}>
          {message.failureReason ?? t('chat.attachmentFailureBody')}
        </Text>
      ) : transfer?.state === 'cancelled' ? (
        <Text accessibilityLiveRegion="polite" style={[styles.attachmentFailure, message.isOwn && styles.attachmentFailureOwn]}>
          {t('chat.attachmentCleanupBody')}
        </Text>
      ) : null}
      {isTransferring || transfer?.state === 'failed' || transfer?.state === 'cancelled' ? (
        <View style={styles.attachmentControls}>
          {transfer?.state === 'failed' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: retryBusy || workspace.connectivity !== 'online' }}
              disabled={retryBusy || workspace.connectivity !== 'online'}
              onPress={() => void workspace.retryAttachmentUpload(message)}
              style={({ pressed }) => [styles.attachmentControl, pressed && styles.pressed]}>
              <Ionicons name="refresh-outline" size={13} color={message.isOwn ? colors.white : colors.mintDark} />
              <Text style={[styles.attachmentControlText, message.isOwn && styles.attachmentControlTextOwn]}>
                {retryBusy ? t('chat.attachmentRetrying') : t('chat.attachmentRetry')}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: cancelBusy }}
            disabled={cancelBusy}
            onPress={() => void workspace.cancelAttachmentUpload(message)}
            style={({ pressed }) => [styles.attachmentControl, pressed && styles.pressed]}>
            <Ionicons name={transfer?.state === 'cancelled' ? 'trash-outline' : 'close-circle-outline'} size={13} color={message.isOwn ? '#FFD4C7' : colors.red} />
            <Text style={[styles.attachmentControlText, styles.attachmentControlDanger, message.isOwn && styles.attachmentFailureOwn]}>
              {cancelBusy
                ? t('chat.attachmentCancelling')
                : transfer?.state === 'cancelled'
                  ? t('chat.attachmentFinishCleanup')
                  : t('chat.attachmentCancel')}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function Composer({
  currentUserId,
  disabled,
  disabledLabel,
  draft,
  memberUserIds,
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
  translationPair,
  replyingTo,
  onCancelReply,
}: {
  currentUserId: string;
  disabled: boolean;
  disabledLabel: string;
  draft: string;
  memberUserIds: string[];
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
  translationPair?: string;
  replyingTo: Message | null;
  onCancelReply: () => void;
}) {
  const { t } = useI18n();
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

  return (
    <View style={styles.composerWrap}>
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
          <IconButton label={t('chat.cancelReply')} name="close" onPress={onCancelReply} size={34} />
        </View>
      ) : null}
      {!disabled && memberUserIds.length > 1 ? (
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
      {!disabled ? <View style={styles.composerTopLine}>
        {translationPair ? (
          <View style={styles.composerLanguage}>
            <Ionicons name="language" color={colors.mintDark} size={13} />
            <Text style={styles.composerLanguageText}>{t('chat.translationAvailable')} · {translationPair}</Text>
          </View>
        ) : (
          <View />
        )}
        <Text style={styles.composerPrivacy}>{t('chat.originalPreserved')}</Text>
      </View> : null}
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
            size={38}
            tone="danger"
          />
          <IconButton
            label={t('chat.sendVoiceNote')}
            name="arrow-up"
            onPress={() => void finishRecording(true)}
            size={40}
            tone="accent"
          />
        </View>
      ) : null}
      {!disabled && !recording ? <View style={styles.composer}>
        <IconButton name="add" label={t('chat.addAttachment')} onPress={onAddAttachment} size={38} />
        <TextInput
          accessibilityLabel={t('chat.message')}
          blurOnSubmit={false}
          multiline
          onBlur={onComposerBlur}
          onChangeText={onChangeDraft}
          onSubmitEditing={onSend}
          placeholder={t('chat.placeholder')}
          placeholderTextColor={colors.inkSubtle}
          style={styles.composerInput}
          value={draft}
        />
        {draft.trim() ? (
          <IconButton
            label={t('chat.send')}
            name="arrow-up"
            onPress={onSend}
            size={40}
            tone="accent"
          />
        ) : (
          <IconButton
            label={t('chat.recordVoiceNote')}
            name="mic"
            onPress={() => void startRecording()}
            size={40}
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
        <Text style={styles.mentionLimit}>{copy.limit}</Text>
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
          <Text style={styles.mentionDescription}>{copy.description}</Text>
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
                        <Text numberOfLines={1} style={styles.mentionCandidateMeta}>{person.department} · {person.roleLabel}</Text>
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
  reportCategory,
  reportDetails,
  error,
  busy,
  onClose,
  onChangeEditDraft,
  onChangeReportCategory,
  onChangeReportDetails,
  onEdit,
  onDelete,
  onHide,
  onForward,
  onProposeAction,
  onReact,
  onReport,
  onReply,
  onCopy,
  onPin,
}: {
  message: Message | null;
  conversations: Conversation[];
  editDraft: string;
  reportCategory: 'harassment' | 'threat' | 'spam' | 'privacy' | 'misinformation' | 'other';
  reportDetails: string;
  error: string | null;
  busy: string | null;
  onClose: () => void;
  onChangeEditDraft: (value: string) => void;
  onChangeReportCategory: (value: 'harassment' | 'threat' | 'spam' | 'privacy' | 'misinformation' | 'other') => void;
  onChangeReportDetails: (value: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onHide: () => void;
  onForward: (targetConversationId: string) => Promise<void>;
  onProposeAction: (title: string, details: string) => Promise<void>;
  onReact: (emoji: string) => void;
  onReport: (disclosure: {
    consentToShare: true;
    contextBefore: 0 | 1 | 2;
    contextAfter: 0 | 1 | 2;
    noticeVersion: 'moderation-report-v2';
  }) => void;
  onReply: () => void;
  onCopy: () => void;
  onPin: () => void;
}) {
  const workspace = useWorkspace();
  const { locale, t } = useI18n();
  // Action items are a workplace concept; the personal realm never surfaces
  // the affordance to propose one from a message.
  const personalRealm = isPersonalRealm(workspace.organizationId);
  const [forwardTargetId, setForwardTargetId] = useState('');
  const [actionTitle, setActionTitle] = useState('');
  const [actionDetails, setActionDetails] = useState('');
  const [reportConsent, setReportConsent] = useState(false);
  const [contextBefore, setContextBefore] = useState<0 | 1 | 2>(0);
  const [contextAfter, setContextAfter] = useState<0 | 1 | 2>(0);
  const safetyCopy = moderationCopy(locale);
  const categoryLabels = {
    harassment: t('chat.reportHarassment'),
    threat: t('chat.reportThreat'),
    spam: t('chat.reportSpam'),
    privacy: t('chat.reportPrivacy'),
    misinformation: t('chat.reportMisinformation'),
    other: t('chat.reportOther'),
  };
  return (
    <ActionModal
      description={t('chat.actionsDescription')}
      onClose={onClose}
      title={t('chat.actionsTitle')}
      visible={Boolean(message)}>
      {message ? (
        <View style={styles.modalRow}>
          <PrimaryButton icon="arrow-undo-outline" label={t('chat.reply')} onPress={onReply} tone="light" />
          <PrimaryButton icon="copy-outline" label={t('chat.copy')} onPress={onCopy} tone="light" />
          <PrimaryButton icon={message.pinned ? 'pin' : 'pin-outline'} label={message.pinned ? t('chat.unpin') : t('chat.pin')} loading={busy === 'message-pin'} onPress={onPin} tone="light" />
        </View>
      ) : null}
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
      {message && !message.isOwn && message.serverId && !message.deleted ? (
        <View style={styles.modalSection}>
          <Text style={styles.modalLabel}>{t('chat.reportPrivately')}</Text>
          <View style={styles.modalRow}>
            {(['harassment', 'threat', 'spam', 'privacy', 'misinformation', 'other'] as const).map((category) => (
              <Chip
                key={category}
                label={categoryLabels[category]}
                onPress={() => {
                  onChangeReportCategory(category);
                  setReportConsent(false);
                }}
                selected={reportCategory === category}
              />
            ))}
          </View>
          <FormField
            label={t('chat.reportDetails')}
            multiline
            onChangeText={(value) => {
              onChangeReportDetails(value);
              setReportConsent(false);
            }}
            value={reportDetails}
          />
          <View style={styles.reportDisclosure}>
            <View style={styles.reportDisclosureHeader}>
              <Ionicons name="shield-checkmark-outline" color={colors.amber} size={18} />
              <Text style={styles.reportDisclosureTitle}>{safetyCopy.scopedEvidence}</Text>
            </View>
            <Text style={styles.reportDisclosureText}>
              {moderationReportConsentNotice(locale, contextBefore, contextAfter)}
            </Text>
            <Text style={styles.modalLabel}>{safetyCopy.reportContextBefore}</Text>
            <View style={styles.modalRow}>
              {([0, 1, 2] as const).map((count) => (
                <Chip
                  key={`before-${count}`}
                  label={count === 0
                    ? safetyCopy.reportContextNone
                    : count === 1 ? safetyCopy.reportContextOne : safetyCopy.reportContextTwo}
                  onPress={() => {
                    setContextBefore(count);
                    setReportConsent(false);
                  }}
                  selected={contextBefore === count}
                />
              ))}
            </View>
            <Text style={styles.modalLabel}>{safetyCopy.reportContextAfter}</Text>
            <View style={styles.modalRow}>
              {([0, 1, 2] as const).map((count) => (
                <Chip
                  key={`after-${count}`}
                  label={count === 0
                    ? safetyCopy.reportContextNone
                    : count === 1 ? safetyCopy.reportContextOne : safetyCopy.reportContextTwo}
                  onPress={() => {
                    setContextAfter(count);
                    setReportConsent(false);
                  }}
                  selected={contextAfter === count}
                />
              ))}
            </View>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: reportConsent }}
              onPress={() => setReportConsent((value) => !value)}
              style={({ pressed }) => [
                styles.reportConsent,
                reportConsent && styles.reportConsentChecked,
                pressed && styles.pressed,
              ]}>
              <Ionicons
                name={reportConsent ? 'checkbox' : 'square-outline'}
                color={reportConsent ? colors.mintDark : colors.inkSubtle}
                size={22}
              />
              <Text style={styles.reportConsentText}>{safetyCopy.reportConsentLabel}</Text>
            </Pressable>
            {!reportConsent ? (
              <Text accessibilityLiveRegion="polite" style={styles.reportConsentRequired}>
                {safetyCopy.reportConsentRequired}
              </Text>
            ) : null}
          </View>
          <PrimaryButton
            disabled={!reportConsent}
            icon="flag-outline"
            label={t('chat.submitReport')}
            loading={busy === 'message-report'}
            onPress={() => onReport({
              consentToShare: true,
              contextBefore,
              contextAfter,
              noticeVersion: 'moderation-report-v2',
            })}
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
  const [groupReportCategory, setGroupReportCategory] = useState<
    'harassment' | 'threat' | 'spam' | 'privacy' | 'misinformation' | 'other'
  >('other');
  const [groupReportDetails, setGroupReportDetails] = useState('');
  const [groupReportConsent, setGroupReportConsent] = useState(false);
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
  const groupReportCategoryLabels = {
    harassment: t('chat.reportHarassment'),
    threat: t('chat.reportThreat'),
    spam: t('chat.reportSpam'),
    privacy: t('chat.reportPrivacy'),
    misinformation: t('chat.reportMisinformation'),
    other: t('chat.reportOther'),
  };
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
      {!conversation.managementOnly && conversation.kind !== 'direct' ? (
        <View style={styles.modalSection}>
          <Text style={styles.modalLabel}>{t('chat.reportGroup')}</Text>
          <Text style={styles.modalNote}>{t('chat.reportGroupDescription')}</Text>
          <View style={styles.modalRow}>
            {(['harassment', 'threat', 'spam', 'privacy', 'misinformation', 'other'] as const)
              .map((category) => (
                <Chip
                  key={`group-report-${category}`}
                  label={groupReportCategoryLabels[category]}
                  onPress={() => {
                    setGroupReportCategory(category);
                    setGroupReportConsent(false);
                  }}
                  selected={groupReportCategory === category}
                />
              ))}
          </View>
          <FormField
            label={t('chat.reportDetails')}
            multiline
            onChangeText={(value) => {
              setGroupReportDetails(value);
              setGroupReportConsent(false);
            }}
            value={groupReportDetails}
          />
          <View style={styles.reportDisclosure}>
            <View style={styles.reportDisclosureHeader}>
              <Ionicons name="shield-checkmark-outline" color={colors.amber} size={18} />
              <Text style={styles.reportDisclosureTitle}>{t('chat.reportPrivateSafety')}</Text>
            </View>
            <Text style={styles.reportDisclosureText}>
              {moderationTargetReportConsentNotice(locale, 'group')}
            </Text>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: groupReportConsent }}
              onPress={() => setGroupReportConsent((value) => !value)}
              style={({ pressed }) => [
                styles.reportConsent,
                groupReportConsent && styles.reportConsentChecked,
                pressed && styles.pressed,
              ]}>
              <Ionicons
                name={groupReportConsent ? 'checkbox' : 'square-outline'}
                color={groupReportConsent ? colors.mintDark : colors.inkSubtle}
                size={22}
              />
              <Text style={styles.reportConsentText}>{moderationCopy(locale).reportConsentLabel}</Text>
            </Pressable>
          </View>
          <PrimaryButton
            disabled={!groupReportConsent}
            icon="flag-outline"
            label={t('chat.submitReport')}
            loading={busy === 'group-report'}
            onPress={async () => {
              if (await workspace.reportGroup(
                conversation,
                groupReportCategory,
                groupReportDetails,
                { consentToShare: true, noticeVersion: 'moderation-report-v2' },
              )) onClose();
            }}
            tone="danger"
          />
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
          <Text style={styles.modalLabel}>{t('chat.accessControls')}</Text>
          <Text style={styles.modalNote}>{t('chat.accessControlsDescription')}</Text>
          <Text style={styles.modalLabel}>{t('chat.whoCanPost')}</Text>
          <View style={styles.modalRow}>
            <Chip label={t('chat.allMembers')} onPress={() => setPostingMode('all_members')} selected={postingMode === 'all_members'} />
            <Chip label={t('chat.adminsOnly')} onPress={() => setPostingMode('admins_only')} selected={postingMode === 'admins_only'} />
          </View>
          <Text style={styles.modalLabel}>{t('chat.groupDiscovery')}</Text>
          <View style={styles.modalRow}>
            <Chip label={t('chat.inviteOnly')} onPress={() => { setVisibility('invite_only'); setJoinPolicy('invite_only'); }} selected={visibility === 'invite_only'} />
            <Chip label={t('chat.organizationVisible')} onPress={() => { setVisibility('organization'); setJoinPolicy('approval_required'); }} selected={visibility === 'organization'} />
            {conversation.visibility === 'unit' ? <Chip label={t('chat.unitVisible')} onPress={() => { setVisibility('unit'); setJoinPolicy('approval_required'); }} selected={visibility === 'unit'} /> : null}
          </View>
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
            <Text style={styles.modalNote}>{t('chat.memberRoleSecurity')}</Text>
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
          <Text style={styles.modalNote}>{t('chat.memberSearchPrompt')}</Text>
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
  const { t } = useI18n();
  return (
    <ActionModal
      description={t('chat.attachmentDescription')}
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
        label={busy ? t('chat.uploading') : t('chat.sendSecurely')}
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
  header: {
    minHeight: 78,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.paper,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.lineStrong,
  },
  headerMobile: {
    minHeight: 64,
    paddingHorizontal: spacing.sm,
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
  messageList: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
    gap: 5,
  },
  briefingCard: {
    marginBottom: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: '#DED0F0',
    backgroundColor: colors.plumSoft,
    overflow: 'hidden',
  },
  briefingHeader: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
  },
  briefingIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.paper,
  },
  briefingHeaderCopy: { flex: 1, minWidth: 0 },
  briefingTitleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
  briefingTitle: { color: colors.plum, fontSize: 11, fontWeight: '900' },
  briefingPreview: { color: colors.inkMuted, fontSize: 11, marginTop: 2 },
  briefingBody: {
    gap: spacing.sm,
    padding: spacing.md,
    paddingTop: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#DED0F0',
  },
  briefingSummary: { color: colors.ink, fontSize: 12, lineHeight: 18, marginTop: spacing.sm },
  briefingSection: { gap: 3 },
  briefingLabel: { color: colors.plum, fontSize: 9, fontWeight: '900', letterSpacing: 0.6, textTransform: 'uppercase' },
  briefingItem: { color: colors.inkMuted, fontSize: 11, lineHeight: 17 },
  briefingSources: { color: colors.inkSubtle, fontSize: 9 },
  summaryBoundary: {
    marginTop: spacing.sm,
    padding: spacing.sm,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    borderRadius: radii.md,
    backgroundColor: colors.paper,
  },
  summaryBoundaryText: { flex: 1, color: colors.inkMuted, fontSize: 10, lineHeight: 15 },
  summaryUnavailable: {
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.paper,
  },
  summaryUnavailableTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  summaryUnavailableText: { color: colors.inkMuted, fontSize: 11, lineHeight: 17 },
  summaryStaleWarning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.redSoft,
  },
  summaryStaleWarningText: { flex: 1, color: colors.red, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  summarySourceSection: { gap: spacing.xs },
  sourceLinks: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  sourceLink: {
    minHeight: 30,
    maxWidth: '100%',
    paddingHorizontal: spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: '#DED0F0',
    backgroundColor: colors.paper,
  },
  sourceLinkText: { flexShrink: 1, color: colors.plum, fontFamily: type.mono, fontSize: 9, fontWeight: '700' },
  sourceError: { color: colors.red, fontSize: 10, fontWeight: '700' },
  evidenceItem: { gap: 4 },
  provenanceCard: {
    gap: 4,
    padding: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: '#DED0F0',
    backgroundColor: colors.paper,
  },
  provenanceValue: { color: colors.inkMuted, fontSize: 10, lineHeight: 15 },
  provenanceHash: { color: colors.inkSubtle, fontFamily: type.mono, fontSize: 8, lineHeight: 13 },
  summaryControls: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  actionList: { gap: spacing.xs, paddingTop: spacing.xs },
  actionRow: {
    minHeight: 52,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.paper,
  },
  actionCopy: { flex: 1, minWidth: 180 },
  actionTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  actionMeta: { color: colors.inkSubtle, fontSize: 9, marginTop: 2 },
  messageListMobile: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.lg,
  },
  loadOlder: {
    alignSelf: 'center',
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.paper,
  },
  loadOlderText: { color: colors.mintDark, fontSize: 11, fontWeight: '800' },
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
  messageRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    marginVertical: 3,
  },
  messageRowOwn: {
    justifyContent: 'flex-end',
  },
  messageAvatarSlot: {
    width: 30,
    minHeight: 1,
  },
  messageStack: {
    maxWidth: '76%',
    alignItems: 'flex-start',
  },
  messageStackOwn: {
    alignItems: 'flex-end',
  },
  senderName: {
    color: colors.inkMuted,
    fontSize: 11,
    fontWeight: '800',
    marginLeft: 5,
    marginBottom: 4,
  },
  bubble: {
    minWidth: 132,
    paddingHorizontal: 13,
    paddingTop: 11,
    paddingBottom: 8,
    borderRadius: 17,
  },
  bubbleIncoming: {
    backgroundColor: colors.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineStrong,
    borderTopLeftRadius: 6,
  },
  bubbleOwn: {
    backgroundColor: colors.forest,
    borderTopRightRadius: 6,
  },
  bubbleMentioned: {
    borderWidth: 2,
    borderColor: colors.mint,
    backgroundColor: colors.mintSoft,
  },
  bubbleSafety: {
    borderTopWidth: 3,
    borderTopColor: colors.red,
  },
  priorityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: spacing.xs,
  },
  priorityText: {
    color: colors.red,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  priorityTextOwn: {
    color: '#FFD4C7',
  },
  reply: {
    borderLeftWidth: 3,
    borderLeftColor: colors.mint,
    backgroundColor: colors.paperMuted,
    borderRadius: radii.xs,
    paddingHorizontal: spacing.xs,
    paddingVertical: 6,
    marginBottom: spacing.xs,
  },
  replyOwn: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  replySender: {
    color: colors.mintDark,
    fontSize: 10,
    fontWeight: '900',
  },
  replySenderOwn: {
    color: '#76E0B7',
  },
  replyPreview: {
    color: colors.inkSubtle,
    fontSize: 11,
    marginTop: 2,
  },
  replyPreviewOwn: {
    color: 'rgba(255,255,255,0.67)',
  },
  messageMentions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
    marginBottom: spacing.xs,
  },
  messageMentionsText: {
    flexShrink: 1,
    color: colors.mintDark,
    fontSize: 9,
    lineHeight: 13,
    fontWeight: '900',
  },
  messageMentionsTextOwn: { color: '#78DDB8' },
  messageText: {
    color: colors.ink,
    fontSize: 14,
    lineHeight: 20,
  },
  messageTextOwn: {
    color: colors.white,
  },
  detectionRow: {
    marginTop: spacing.xs,
    paddingTop: 5,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 3,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  detectionRowOwn: { borderTopColor: 'rgba(255,255,255,0.16)' },
  detectionText: { color: colors.inkSubtle, fontSize: 9 },
  detectionTextOwn: { color: 'rgba(255,255,255,0.7)' },
  translationCard: {
    marginTop: spacing.xs,
    gap: 6,
    padding: spacing.xs,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: '#BFE9D9',
    backgroundColor: colors.mintSoft,
  },
  translationCardOwn: { borderColor: 'rgba(120,221,184,0.35)', backgroundColor: 'rgba(255,255,255,0.09)' },
  translationHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 5 },
  translationTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  translationTitle: { color: colors.mintDark, fontSize: 8, fontWeight: '900', letterSpacing: 0.6 },
  translationTitleOwn: { color: '#78DDB8' },
  translationStatus: { color: colors.mintDark, fontSize: 8, fontWeight: '700' },
  translationStatusOwn: { color: 'rgba(255,255,255,0.76)' },
  translatedText: { color: colors.ink, fontSize: 13, lineHeight: 19 },
  translatedTextOwn: { color: colors.white },
  translationAttribution: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  translationAttributionText: { color: colors.mintDark, fontSize: 9, fontWeight: '800' },
  translationAttributionTextOwn: { color: '#78DDB8' },
  translationPendingReview: { color: colors.amber, fontSize: 9, fontWeight: '700' },
  translationPendingReviewOwn: { color: '#FFD7A3' },
  translationPolicyWarning: { color: colors.red, fontSize: 9, fontWeight: '800' },
  translationActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  inlineAction: { minHeight: 30, justifyContent: 'center', paddingHorizontal: 2 },
  inlineActionText: { color: colors.mintDark, fontSize: 9, fontWeight: '900' },
  inlineActionTextOwn: { color: '#78DDB8' },
  translationDetails: {
    gap: 3,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#BFE9D9',
  },
  translationDetailsOwn: { borderTopColor: 'rgba(255,255,255,0.16)' },
  translationDetailText: { color: colors.inkMuted, fontSize: 8, lineHeight: 12 },
  translationDetailTextOwn: { color: 'rgba(255,255,255,0.72)' },
  translationHash: { color: colors.inkSubtle, fontFamily: type.mono, fontSize: 7, lineHeight: 11 },
  translationStateCard: {
    marginTop: spacing.xs,
    gap: 5,
    padding: spacing.xs,
    borderRadius: radii.sm,
    backgroundColor: colors.paperMuted,
  },
  translationStateCardOwn: { backgroundColor: 'rgba(255,255,255,0.08)' },
  translationStateText: { color: colors.inkMuted, fontSize: 9, fontWeight: '800' },
  translationStateTextOwn: { color: 'rgba(255,255,255,0.74)' },
  translationFailure: { color: colors.red, fontSize: 9, lineHeight: 13 },
  translationFailureOwn: { color: '#FFD4C7' },
  translationRequest: {
    minHeight: 32,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.mint,
  },
  translationRequestText: { color: colors.forest, fontSize: 9, fontWeight: '900' },
  canonicalLabel: { color: colors.inkSubtle, fontSize: 8, fontWeight: '800' },
  canonicalLabelOwn: { color: 'rgba(255,255,255,0.6)' },
  canonicalOriginalModal: { gap: spacing.xs, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.paperMuted },
  canonicalOriginalText: { color: colors.ink, fontSize: 13, lineHeight: 19 },
  originalBlock: {
    marginTop: spacing.xs,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  originalBlockOwn: {
    borderTopColor: 'rgba(255,255,255,0.16)',
  },
  originalLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 3,
  },
  originalLabel: {
    color: colors.inkSubtle,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  originalLabelOwn: {
    color: 'rgba(255,255,255,0.68)',
  },
  originalText: {
    color: colors.inkMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  originalTextOwn: {
    color: 'rgba(255,255,255,0.74)',
  },
  translationQueued: {
    marginTop: spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  queuedText: {
    color: colors.inkSubtle,
    fontSize: 10,
    fontStyle: 'italic',
  },
  queuedTextOwn: {
    color: 'rgba(255,255,255,0.7)',
  },
  messageMeta: {
    minHeight: 17,
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  toggleText: {
    color: colors.mintDark,
    fontSize: 9,
    fontWeight: '800',
  },
  toggleTextOwn: {
    color: '#78DDB8',
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 3,
  },
  timeText: {
    color: colors.inkSubtle,
    fontSize: 9,
  },
  timeTextOwn: {
    color: 'rgba(255,255,255,0.58)',
  },
  receiptCount: { fontSize: 8, fontWeight: '800' },
  reactions: {
    flexDirection: 'row',
    marginTop: -5,
    marginLeft: 10,
  },
  reactionsOwn: {
    marginLeft: 0,
    marginRight: 10,
  },
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
  attachment: {
    minWidth: 230,
    marginBottom: spacing.xs,
    padding: spacing.xs,
    gap: spacing.xs,
    borderRadius: radii.sm,
    backgroundColor: colors.paperMuted,
  },
  attachmentMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  attachmentOwn: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  attachmentIcon: {
    width: 34,
    height: 34,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.mintSoft,
  },
  attachmentIconOwn: {
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  attachmentCopy: {
    flex: 1,
    minWidth: 0,
  },
  attachmentName: {
    color: colors.ink,
    fontSize: 11,
    fontWeight: '800',
  },
  attachmentNameOwn: {
    color: colors.white,
  },
  attachmentMeta: {
    color: colors.inkSubtle,
    fontSize: 9,
    marginTop: 2,
  },
  attachmentMetaOwn: {
    color: 'rgba(255,255,255,0.64)',
  },
  attachmentProgressRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  attachmentProgressTrack: {
    flex: 1,
    height: 7,
    overflow: 'hidden',
    borderRadius: radii.pill,
    backgroundColor: colors.lineStrong,
  },
  attachmentProgressTrackOwn: { backgroundColor: 'rgba(255,255,255,0.18)' },
  attachmentProgressFill: { height: '100%', borderRadius: radii.pill, backgroundColor: colors.mint },
  attachmentPercent: { minWidth: 32, color: colors.inkMuted, fontSize: 9, fontWeight: '900', textAlign: 'right' },
  attachmentFailure: { color: colors.red, fontSize: 9, lineHeight: 13, fontWeight: '700' },
  attachmentFailureOwn: { color: '#FFD4C7' },
  attachmentControls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  attachmentControl: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  attachmentControlText: { color: colors.mintDark, fontSize: 9, fontWeight: '900' },
  attachmentControlTextOwn: { color: colors.white },
  attachmentControlDanger: { color: colors.red },
  requestBanner: {
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.paper,
  },
  requestBannerCopy: { gap: 3 },
  requestBannerTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  requestBannerText: { color: colors.inkMuted, fontSize: 11, lineHeight: 16 },
  requestBannerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  requestPendingBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.amberSoft,
  },
  requestPendingCopy: { flex: 1, gap: spacing.xs },
  requestPendingText: { color: colors.amber, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  composerWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
    backgroundColor: colors.paper,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.lineStrong,
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
  mentionLimit: { color: colors.inkSubtle, fontSize: 9 },
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
  mentionDescription: { color: colors.inkMuted, fontSize: 10, lineHeight: 15 },
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
  newMessageJump: {
    position: 'absolute',
    right: spacing.lg,
    bottom: 104,
    zIndex: 20,
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.mintDark,
  },
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
  composerTopLine: {
    minHeight: 25,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  composerLanguage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  composerLanguageText: {
    color: colors.mintDark,
    fontSize: 10,
    fontWeight: '700',
  },
  composerPrivacy: {
    color: colors.inkSubtle,
    fontSize: 9,
  },
  composer: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.xs,
    padding: 6,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.paperMuted,
  },
  composerInput: {
    flex: 1,
    minWidth: 0,
    maxHeight: 130,
    minHeight: 38,
    paddingHorizontal: spacing.xs,
    paddingTop: 9,
    paddingBottom: 8,
    color: colors.ink,
    fontSize: 14,
    lineHeight: 20,
  },
  typingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    backgroundColor: colors.mintSoft,
  },
  typingBannerText: {
    flex: 1,
    minWidth: 0,
    color: colors.mintDark,
    fontSize: 11,
    fontWeight: '700',
    fontStyle: 'italic',
  },
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
  voiceBubbleOwn: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  voicePlayButton: {
    width: 34,
    height: 34,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.mintSoft,
  },
  voicePlayButtonOwn: {
    backgroundColor: 'rgba(255,255,255,0.14)',
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
  voiceTitleOwn: {
    color: colors.white,
  },
  voiceTime: {
    color: colors.inkSubtle,
    fontSize: 9,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  voiceTimeOwn: {
    color: 'rgba(255,255,255,0.64)',
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
  pressed: {
    opacity: 0.72,
  },
});
