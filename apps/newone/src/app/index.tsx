import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  AppScaffold,
  MobileBrandHeader,
} from '@/components/navigation/app-scaffold';
import { ActionModal } from '@/components/ui/action-modal';
import { ScreenErrorBoundary } from '@/components/ui/error-boundary';
import { IconButton, PrimaryButton } from '@/components/ui/primitives';
import {
  WorkspaceStatePanel,
  WorkspaceStatusBanner,
} from '@/components/workspace/workspace-state';
import { ConversationDetails } from '@/features/chat/conversation-details';
import {
  ConversationList,
  type ConversationRowActionKey,
} from '@/features/chat/conversation-list';
import { ConversationPane } from '@/features/chat/conversation-pane';
import { PinnedMessagesModal } from '@/features/chat/pinned-messages';
import { NotificationPrompt } from '@/features/notifications/notification-prompt';
import {
  buildSearchSuggestions,
  parseSearch,
  type SearchPersonRef,
  type SearchSuggestion,
} from '@/features/search/chat-search';
import { useChatSearch } from '@/features/search/use-chat-search';
import { WorkspaceSearchPanel } from '@/features/search/workspace-search-panel';
import { isPersonalRealm } from '@/constants/personal-realm';
import type { Conversation } from '@/domain/types';
import { useWorkspace } from '@/state/workspace';
import { radii, shadow, spacing } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';
import { useI18n } from '@/i18n/provider';
import { useHydrationSafeWindowDimensions } from '@/hooks/use-hydration-safe-window-dimensions';

/**
 * Marking a chat unread has no home on the server: read receipts only ever
 * move forward, and there is no per-reader "unread again" flag to write. The
 * mark therefore lives on the device for as long as the app is open, which is
 * as far as this stream can honestly take it.
 */
const markedUnread = new Set<string>();

export default function ChatsScreen() {
  const styles = useThemedStyles(buildStyles);
  const router = useRouter();
  const { width } = useHydrationSafeWindowDimensions();
  const desktop = width >= 920;
  const showDetails = width >= 1420;
  const workspace = useWorkspace();
  const { t } = useI18n();
  const selectedConversation = workspace.conversations.find(
    (conversation) => conversation.id === workspace.selectedConversationId,
  );
  const ordinaryConversations = workspace.conversations.filter(
    (conversation) => !conversation.managementOnly,
  );
  const firstOrdinaryConversationId = ordinaryConversations[0]?.id ?? '';
  const selectConversation = workspace.selectConversation;
  // Consumer accounts see their own handle (when known) instead of the
  // workspace organization-and-shift subtitle. The realm is unknown until the
  // bootstrap fills organizationId, so nothing renders before then: a consumer
  // must never see the workplace line flash on first launch.
  const realmKnown = Boolean(workspace.organizationId);
  const personalRealm = isPersonalRealm(workspace.organizationId);
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [unreadMarks, setUnreadMarks] = useState<string[]>(() => [...markedUnread]);
  const [departing, setDeparting] = useState<{ id: string; title: string; group: boolean } | null>(null);
  const search = workspace.inboxSearch;
  const knownPeople = useMemo<SearchPersonRef[]>(
    () => workspace.people
      .filter((person) => person.connectionState !== 'self')
      .map((person) => ({
        id: person.id,
        displayName: person.displayName,
        username: person.username ?? null,
      })),
    [workspace.people],
  );
  // The query only needs the people already on the device; the strangers the
  // server finds are folded back in so tapping one still makes a chip.
  const queryParsed = useMemo(() => parseSearch(search, knownPeople), [knownPeople, search]);
  const { strangers, messages, loading: searchLoading } = useChatSearch(queryParsed);
  const searchPeople = useMemo(() => {
    const known = new Set(knownPeople.map((person) => person.id));
    return [...knownPeople, ...strangers.filter((person) => !known.has(person.id))];
  }, [knownPeople, strangers]);
  const parsedSearch = useMemo(() => parseSearch(search, searchPeople), [search, searchPeople]);
  const suggestions = useMemo(
    () => buildSearchSuggestions({
      parsed: parsedSearch,
      people: knownPeople,
      strangers,
      conversations: workspace.conversations,
      messages,
    }),
    [knownPeople, messages, parsedSearch, strangers, workspace.conversations],
  );
  const searching = !parsedSearch.empty;
  const consumerUsername = workspace.currentUser?.username?.trim() || null;
  const headerSubtitle = !realmKnown
    ? undefined
    : personalRealm
      ? consumerUsername ? `@${consumerUsername}` : undefined
      : `${workspace.organizationName} · ${t('chat.onShift')}`;

  useEffect(() => {
    if (!selectedConversation?.managementOnly) return;
    selectConversation(firstOrdinaryConversationId);
  }, [firstOrdinaryConversationId, selectConversation, selectedConversation?.managementOnly]);

  const openConversation = (conversationId: string) => {
    workspace.selectConversation(conversationId);
    if (!desktop) {
      router.push({ pathname: '/conversation/[id]', params: { id: conversationId } });
    }
  };

  const openSuggestion = (suggestion: SearchSuggestion) => {
    if (suggestion.kind === 'person') return;
    workspace.selectConversation(suggestion.conversationId);
    if (desktop && suggestion.kind === 'conversation') return;
    router.push({
      pathname: '/conversation/[id]',
      params: suggestion.kind === 'message'
        ? { id: suggestion.conversationId, messageId: suggestion.messageId }
        : { id: suggestion.conversationId },
    });
  };

  const setMarkedUnread = (conversationId: string, unread: boolean) => {
    if (unread) markedUnread.add(conversationId);
    else markedUnread.delete(conversationId);
    setUnreadMarks([...markedUnread]);
  };

  const runRowAction = (action: ConversationRowActionKey, conversation: Conversation) => {
    if (action === 'markUnread') {
      setMarkedUnread(conversation.id, true);
      return;
    }
    if (action === 'markRead') {
      setMarkedUnread(conversation.id, false);
      void workspace.markConversationRead(conversation.id);
      return;
    }
    if (action === 'mute' || action === 'unmute') {
      void workspace.updateConversationPreferences(conversation.id, action === 'mute'
        ? { notificationLevel: 'none' }
        : { notificationLevel: 'all', mutedUntil: null });
      return;
    }
    if (action === 'archive' || action === 'unarchive') {
      void workspace.updateConversationPreferences(conversation.id, {
        isArchived: action === 'archive',
      });
      return;
    }
    // Leaving a group and being done with a one-to-one chat are different
    // things, so they are asked differently.
    setDeparting({
      id: conversation.id,
      title: conversation.title,
      group: action === 'leave',
    });
  };

  const confirmDeparture = () => {
    if (!departing) return;
    const { id, group } = departing;
    setDeparting(null);
    setMarkedUnread(id, false);
    if (group) void workspace.leaveConversation(id);
    // Being done with a one-to-one chat hides it for this person only. That is
    // a different flag from archiving, which merely moves it out of the way
    // (v3.4): before, both wrote the same one and neither could be undone.
    else void workspace.updateConversationPreferences(id, { isHidden: true });
  };

  const listProps = {
    conversations: workspace.conversations,
    filter: workspace.inboxFilter,
    onCancelJoin: workspace.cancelConversationJoinRequest,
    onCompose: () => setNewMenuOpen(true),
    onFilterChange: workspace.setInboxFilter,
    onOpenSuggestion: openSuggestion,
    onRequestJoin: workspace.requestConversationJoin,
    onSearchChange: workspace.setInboxSearch,
    onSelect: openConversation,
    markedUnreadIds: unreadMarks,
    onRowAction: runRowAction,
    onOpenPinned: () => setPinnedOpen(true),
    organizationName: workspace.organizationName,
    people: searchPeople,
    search,
    searchLoading,
    selectedId: workspace.selectedConversationId,
    suggestions,
    discoverableConversations: workspace.discoverableConversations,
    // The full filter panel is a workplace tool; consumers never see it.
    onOpenAdvancedSearch: personalRealm ? undefined : () => setAdvancedSearchOpen(true),
  };

  return (
    <AppScaffold
      current="chats"
      mobileHeader={
        <MobileBrandHeader
          right={
            <View style={styles.mobileHeaderActions}>
              <IconButton
                label={t('chat.newMenu')}
                name="add"
                onPress={() => setNewMenuOpen(true)}
                size={38}
                tone="accent"
              />
            </View>
          }
          subtitle={headerSubtitle}
          title={t('nav.chats')}
        />
      }>
      {!desktop ? <WorkspaceStatusBanner /> : null}
      <NotificationPrompt />
      {advancedSearchOpen ? (
        <WorkspaceSearchPanel initialQuery={search} onClose={() => setAdvancedSearchOpen(false)} />
      ) : workspace.status === 'loading' || workspace.status === 'error'
        || (ordinaryConversations.length === 0 && !searching) ? (
        <WorkspaceStatePanel resource="chats" />
      ) : desktop ? (
        <View style={styles.desktopCanvas}>
          <View style={[styles.messengerFrame, shadow]}>
            <ConversationList {...listProps} desktop />
            <ScreenErrorBoundary
              labels={{ title: t('errors.screenCrashed'), retry: t('errors.tryAgain') }}
              scope="conversation">
              <ConversationPane
                conversation={selectedConversation}
                messages={workspace.messages[workspace.selectedConversationId] ?? []}
                onSend={(text, replyTo, mentionUserIds) =>
                  workspace.sendMessage(workspace.selectedConversationId, text, replyTo, mentionUserIds)}
              />
            </ScreenErrorBoundary>
            {showDetails && selectedConversation && !selectedConversation.managementOnly ? (
              <ConversationDetails conversation={selectedConversation} />
            ) : null}
          </View>
        </View>
      ) : (
        <ConversationList {...listProps} />
      )}
      <ActionModal
        description={departing ? t(departing.group ? 'chat.leaveGroupBody' : 'chat.deleteChatBody')
          .replace('{name}', departing.title) : undefined}
        onClose={() => setDeparting(null)}
        title={departing
          ? t(departing.group ? 'chat.leaveGroupTitle' : 'chat.deleteChatTitle')
            .replace('{name}', departing.title)
          : ''}
        visible={Boolean(departing)}>
        <PrimaryButton
          icon={departing?.group ? 'exit-outline' : 'trash-outline'}
          label={t(departing?.group ? 'chat.leaveGroup' : 'chat.deleteChat')}
          onPress={confirmDeparture}
          tone="danger"
        />
        <PrimaryButton label={t('chat.keepChat')} onPress={() => setDeparting(null)} tone="light" />
      </ActionModal>
      {pinnedOpen ? (
        <PinnedMessagesModal
          onClose={() => setPinnedOpen(false)}
          onOpenMessage={(conversationId, messageId) => {
            workspace.selectConversation(conversationId);
            router.push({
              pathname: '/conversation/[id]',
              params: { id: conversationId, messageId },
            });
          }}
          visible
        />
      ) : null}
      <ActionModal
        onClose={() => setNewMenuOpen(false)}
        title={t('chat.newMenu')}
        visible={newMenuOpen}>
        <NewMenuRow
          icon="person-add-outline"
          label={t('people.addFriendTitle')}
          onPress={() => {
            setNewMenuOpen(false);
            router.push({ pathname: '/people', params: { add: '1' } });
          }}
        />
        <NewMenuRow
          icon="people-outline"
          label={t('chat.newGroup')}
          onPress={() => {
            setNewMenuOpen(false);
            router.push('./new-group');
          }}
        />
      </ActionModal>
    </AppScaffold>
  );
}

/** Two rows and nothing else: the whole of the "+" menu. */
function NewMenuRow({
  icon,
  label,
  onPress,
}: {
  icon: 'person-add-outline' | 'people-outline';
  label: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.newMenuRow, pressed && styles.newMenuRowPressed]}>
      <View style={styles.newMenuIcon}>
        <Ionicons color={colors.mintDark} name={icon} size={18} />
      </View>
      <Text style={styles.newMenuLabel}>{label}</Text>
      <Ionicons color={colors.inkSubtle} name="chevron-forward" size={17} />
    </Pressable>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  newMenuRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
  },
  newMenuRowPressed: { opacity: 0.7 },
  newMenuIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.mintSoft,
  },
  newMenuLabel: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '700' },
  desktopCanvas: {
    flex: 1,
    padding: spacing.md,
    backgroundColor: colors.canvas,
  },
  messengerFrame: {
    flex: 1,
    minWidth: 0,
    // Wide desktop monitors: keep the messenger at a readable width and
    // centre it instead of stretching the panes edge to edge.
    width: '100%',
    maxWidth: 1560,
    alignSelf: 'center',
    flexDirection: 'row',
    borderRadius: radii.lg,
    overflow: 'hidden',
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
  },
  mobileHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
});
