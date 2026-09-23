import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import type { Conversation, DiscoverableConversation, InboxFilter } from '@/domain/types';
import type { MessageKey } from '@/i18n/catalog';
import { Avatar, Chip, IconButton, StatusBadge } from '@/components/ui/primitives';
import { KeyboardDismissArea } from '@/components/keyboard-dismiss-area';
import { ChatSearchField } from '@/features/search/chat-search-field';
import {
  addPersonToSearch,
  conversationMatchesSearch,
  parseSearch,
  removeChipFromSearch,
  type SearchPersonRef,
  type SearchSuggestion,
} from '@/features/search/chat-search';
import { radii, spacing, type } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';
import { ProjectsPanel } from '@/features/projects/projects-panel';
import { useI18n } from '@/i18n/provider';
import { useProfileAvatar } from '@/state/profile-avatar';
import { useWorkspace } from '@/state/workspace';

// Bookmarked sits next to Unread because both answer "what did I set aside".
// Each chip carries the icon of the action that feeds it -- the same mark the
// row's swipe and hover and the chat's controls use -- so a bookmark set in
// one place is found again under the same symbol (owner, Sep 14 2026).
// Archive went the same day: nobody used it, and every archived chat came
// back into the list.
const filters: InboxFilter[] = ['all', 'unread', 'favorites', 'direct', 'groups', 'announcements'];
const filterIcons: Partial<Record<InboxFilter, ComponentProps<typeof Ionicons>['name']>> = {
  unread: 'mail-unread-outline',
  favorites: 'bookmark-outline',
  direct: 'person-outline',
  groups: 'people-outline',
  announcements: 'megaphone-outline',
};

/** A row is dragged this far before its actions stay open. */
const REVEAL_DISTANCE = 56;
// How far back an open row has to be dragged before it closes, as a share of
// the panel. A third is roughly what the phone's own lists ask for.
const CLOSE_FRACTION = 1 / 3;
// Past this, the flick decides and distance does not matter.
const FLICK_VELOCITY = 500;
/** One action's target: a full-height column, not a 34px circle on the time. */
const ACTION_WIDTH = 54;
const SNAP = { duration: 160 };

export type ConversationRowActionKey =
  | 'bookmark'
  | 'unbookmark'
  | 'markUnread'
  | 'markRead'
  | 'mute'
  | 'unmute'
  | 'delete'
  | 'leave';

export interface ConversationRowAction {
  key: ConversationRowActionKey;
  labelKey: MessageKey;
  icon: ComponentProps<typeof Ionicons>['name'];
  destructive: boolean;
}

/**
 * What a chat row offers, whether it is swiped on a phone, hovered with a
 * mouse or right-clicked. Leaving a group is the same gesture as deleting a
 * one-to-one chat, because that is what it means to be done with it — but it
 * is named for what it does, never "delete".
 */
export function conversationRowActions(conversation: {
  kind?: string;
  unreadCount?: number;
  muted?: boolean;
  favorite?: boolean;
}): ConversationRowAction[] {
  const group = conversation.kind !== 'direct';
  return [
    conversation.unreadCount
      ? { key: 'markRead', labelKey: 'chat.markRead', icon: 'mail-open-outline', destructive: false }
      : { key: 'markUnread', labelKey: 'chat.markUnread', icon: 'mail-unread-outline', destructive: false },
    conversation.muted
      ? { key: 'unmute', labelKey: 'chat.unmute', icon: 'notifications-outline', destructive: false }
      : { key: 'mute', labelKey: 'chat.mute', icon: 'notifications-off-outline', destructive: false },
    // Bookmarking rides the same swipe and hover as the rest (owner request,
    // Sep 14 2026); before, the only way was inside the chat's details. After
    // mute so the first two, which answer the row's current state, stay put.
    conversation.favorite
      ? { key: 'unbookmark', labelKey: 'chat.unbookmark', icon: 'bookmark', destructive: false }
      : { key: 'bookmark', labelKey: 'chat.bookmark', icon: 'bookmark-outline', destructive: false },
    group
      ? { key: 'leave', labelKey: 'chat.leaveGroup', icon: 'exit-outline', destructive: true }
      : { key: 'delete', labelKey: 'chat.deleteChat', icon: 'trash-outline', destructive: true },
  ];
}

/**
 * A mouse has no swipe. On web the same actions open with a right-click; the
 * listener is attached to the row's own DOM node, and on a phone the ref is
 * not a DOM node at all, so this quietly does nothing.
 */
export function attachContextMenu(node: unknown, open: () => void) {
  const target = node as { addEventListener?: Function; removeEventListener?: Function } | null;
  if (!target || typeof target.addEventListener !== 'function') return undefined;
  const handler = (event: { preventDefault?: () => void }) => {
    event.preventDefault?.();
    open();
  };
  target.addEventListener('contextmenu', handler);
  return () => target.removeEventListener?.('contextmenu', handler);
}

/**
 * What the row says when the newest message is a photo or a file and carries
 * no caption. Its own name if it has one worth reading, otherwise the kind —
 * anything but "No messages yet", which is what the row used to claim (v3.4).
 */
export function attachmentPreviewLine(
  conversation: Pick<Conversation, 'lastMessageAttachment' | 'lastMessageAwaitingAttachment'>,
  t: (key: 'chat.previewPhoto' | 'chat.previewVideo' | 'chat.previewVoice' | 'chat.previewFile' | 'chat.previewAttachment') => string,
): string {
  const attachment = conversation.lastMessageAttachment;
  // A photo or file whose upload has not finished has no kind or name yet.
  if (!attachment) return conversation.lastMessageAwaitingAttachment ? t('chat.previewAttachment') : '';
  const kindLabel = t(attachment.kind === 'image'
    ? 'chat.previewPhoto'
    : attachment.kind === 'video'
      ? 'chat.previewVideo'
      : attachment.kind === 'audio'
        ? 'chat.previewVoice'
        : 'chat.previewFile');
  const name = attachment.fileName?.trim();
  return name && attachment.kind === 'file' ? name : kindLabel;
}

export function filterConversations(
  conversations: Conversation[],
  filter: InboxFilter,
  search: string,
  people: readonly SearchPersonRef[] = [],
  messageConversationIds?: ReadonlySet<string>,
  // A chat put back to unread from its row carries no server-side unread
  // count, so the Unread filter has to be told about it or the chat the row
  // just marked would not be there when the filter is opened.
  markedUnreadIds: readonly string[] = [],
) {
  const parsed = parseSearch(search, people);
  const markedUnread = new Set(markedUnreadIds);
  const matched = conversations.filter((conversation) => {
    if (conversation.managementOnly) return false;
    if (!conversationMatchesSearch(conversation, parsed, messageConversationIds)) return false;
    if (filter === 'favorites') return conversation.favorite;
    if (filter === 'unread') return conversation.unreadCount > 0 || markedUnread.has(conversation.id);
    if (filter === 'direct') return conversation.kind === 'direct';
    if (filter === 'groups') {
      return ['group', 'team', 'shift'].includes(conversation.kind);
    }
    if (filter === 'announcements') return conversation.kind === 'announcement';
    return true;
  });
  // Ask for a person and the chat with that person is what you meant; the
  // groups you also share with them come after (owner, Sep 10 2026). Sort is
  // stable, so within each half the server's newest-first order survives.
  const byPerson = parsed.chips.some((chip) => chip.personId)
    ? [...matched].sort((left, right) =>
      (left.kind === 'direct' ? 0 : 1) - (right.kind === 'direct' ? 0 : 1))
    : matched;
  // Unread chats first (owner, Sep 14 2026): the list used to keep the
  // server's newest-first order only, so a chat waiting to be read could sit
  // under three you had already seen. Stable again, so the newest-first order
  // -- and the person ordering above -- survive inside each half.
  const unread = (conversation: Conversation) =>
    conversation.unreadCount > 0 || markedUnread.has(conversation.id);
  return [...byPerson].sort((left, right) => (unread(left) ? 0 : 1) - (unread(right) ? 0 : 1));
}

export function ConversationList({
  conversations,
  selectedId,
  filter,
  search,
  onFilterChange,
  onSearchChange,
  onSelect,
  onCompose,
  desktop = false,
  organizationName,
  discoverableConversations = [],
  onRequestJoin,
  onCancelJoin,
  people = [],
  suggestions = [],
  searchLoading = false,
  onOpenSuggestion,
  onRowAction,
  onOpenPinned,
  onOpenFind,
  onRefresh,
  markedUnreadIds = [],
}: {
  conversations: Conversation[];
  selectedId?: string;
  filter: InboxFilter;
  search: string;
  onFilterChange: (filter: InboxFilter) => void;
  onSearchChange: (value: string) => void;
  onSelect: (conversationId: string) => void;
  onCompose: () => void;
  desktop?: boolean;
  organizationName?: string;
  discoverableConversations?: DiscoverableConversation[];
  onRequestJoin?: (conversationId: string) => Promise<boolean>;
  onCancelJoin?: (request: NonNullable<DiscoverableConversation['myJoinRequest']>) => Promise<boolean>;
  /** Everybody a typed or tapped name can resolve to. */
  people?: readonly SearchPersonRef[];
  suggestions?: readonly SearchSuggestion[];
  searchLoading?: boolean;
  onOpenSuggestion?: (suggestion: SearchSuggestion) => void;
  onRowAction?: (action: ConversationRowActionKey, conversation: Conversation) => void;
  /** Opens the pins gathered from every chat. */
  onOpenPinned?: () => void;
  /** Opens 찾기: which chats a keyword or a project came up in. */
  onOpenFind?: () => void;
  /** Pull the list down to ask the server again. */
  onRefresh?: () => Promise<void>;
  /** Chats the reader put back to unread by hand. */
  markedUnreadIds?: readonly string[];
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const listRef = useRef<ScrollView>(null);
  const [scrolledAway, setScrolledAway] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const parsedSearch = useMemo(() => parseSearch(search, people), [people, search]);
  const messageConversationIds = useMemo(
    () => new Set(suggestions
      .filter((item) => item.kind === 'message')
      .map((item) => item.conversationId)),
    [suggestions],
  );
  const visible = useMemo(
    () => filterConversations(conversations, filter, search, people, messageConversationIds, markedUnreadIds),
    [conversations, filter, markedUnreadIds, messageConversationIds, people, search],
  );
  const visibleDiscoverableConversations = useMemo(() => {
    const managementOnlyIds = new Set(
      conversations.filter((conversation) => conversation.managementOnly).map((conversation) => conversation.id),
    );
    return discoverableConversations.filter(
      (conversation) => !managementOnlyIds.has(conversation.conversationId),
    );
  }, [conversations, discoverableConversations]);
  const unread = conversations.reduce((sum, conversation) => (
    conversation.managementOnly ? sum : sum + conversation.unreadCount
  ), 0);
  const { t } = useI18n();
  // The "Official" chip only earns its place when there is something official
  // to filter; a texting inbox with no announcements shows four chips.
  const visibleFilters = conversations.some((conversation) => conversation.kind === 'announcement')
    ? filters
    : filters.filter((item) => item !== 'announcements');
  const filterLabels: Record<InboxFilter, string> = {
    all: t('chat.filterAll'),
    unread: t('chat.filterUnread'),
    direct: t('chat.filterDirect'),
    groups: t('chat.filterGroups'),
    announcements: t('chat.filterOfficial'),
    favorites: t('chat.filterFavorites'),
  };

  return (
    // Tapping anywhere that is not itself a control puts the keyboard away,
    // which is the gesture people already use. The search field with nothing
    // typed in it had no other way out (owner, Sep 10 2026); accessible={false}
    // keeps this wrapper out of the accessibility tree.
    <KeyboardDismissArea style={[styles.container, desktop && styles.containerDesktop]}>
      {desktop ? (
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>{organizationName ?? t('chat.workspace')}</Text>
            <View style={styles.titleRow}>
              <Text style={styles.title}>{t('nav.chats')}</Text>
              {unread ? <StatusBadge label={`${unread} ${t('chat.unreadCount')}`} tone="success" /> : null}
            </View>
          </View>
          <IconButton name="add" label={t('chat.newMenu')} onPress={onCompose} tone="accent" />
        </View>
      ) : null}

      <View style={[styles.searchWrap, !desktop && styles.searchWrapMobile]}>
        <ChatSearchField
          chips={parsedSearch.chips}
          loading={searchLoading}
          onChangeText={onSearchChange}
          onRemoveChip={(index) => onSearchChange(removeChipFromSearch(search, index))}
          onSelectSuggestion={(suggestion) => {
            // A person becomes a chip so the next name can follow; a chat or a
            // message is somewhere to go.
            if (suggestion.kind === 'person') {
              onSearchChange(addPersonToSearch(search, suggestion.title));
              return;
            }
            onOpenSuggestion?.(suggestion);
          }}
          suggestions={[...suggestions]}
          value={search}
        />
      </View>

      <ScrollView
        horizontal
        contentContainerStyle={styles.filterRow}
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}>
        {visibleFilters.map((item, index) => [
          <Chip
            count={
              item === 'unread'
                ? conversations.filter((conversation) => (
                    !conversation.managementOnly && conversation.unreadCount > 0
                  )).length
                : undefined
            }
            key={item}
            icon={filterIcons[item]}
            label={filterLabels[item]}
            onPress={() => onFilterChange(item)}
            selected={filter === item}
          />,
          // 찾기 sits right after All, where the owner's father drew it (Sep
          // 23 2026) and where a phone shows it without scrolling the row.
          index === 0 && onOpenFind ? (
            <Chip
              accessibilityLabel={t('find.title')}
              icon="search-outline"
              key="find"
              label={t('chat.filterFind')}
              onPress={onOpenFind}
            />
          ) : null,
        ])}
        {onOpenPinned ? (
          <Chip
            accessibilityLabel={t('chat.pinnedOpen')}
            icon="pin-outline"
            label={t('chat.pinnedTitle')}
            onPress={onOpenPinned}
          />
        ) : null}
      </ScrollView>

      <ScrollView
        contentContainerStyle={styles.listContent}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onScroll={(event) => setScrolledAway(event.nativeEvent.contentOffset.y > 240)}
        ref={listRef}
        refreshControl={onRefresh ? (
          // Pulling the list down asks the server again, the way the phone's
          // other messaging apps do it (owner, Sep 10 2026). The spinner is
          // cleared in a finally, so a refresh that fails cannot leave it
          // turning for ever.
          <RefreshControl
            onRefresh={() => {
              setRefreshing(true);
              void onRefresh().finally(() => setRefreshing(false));
            }}
            refreshing={refreshing}
            tintColor={colors.inkSubtle}
          />
        ) : undefined}
        scrollEventThrottle={64}
        showsVerticalScrollIndicator={false}
        testID="conversation-list">
        {visibleDiscoverableConversations.length ? (
          <View style={styles.discoverySection}>
            <View style={styles.sectionDivider}>
              <Text style={styles.sectionDividerText}>{t('chat.discoverGroups')}</Text>
              <View style={styles.sectionDividerLine} />
            </View>
            {visibleDiscoverableConversations.map((item) => (
              <View key={item.conversationId} style={styles.discoveryRow}>
                <View style={styles.rowBody}>
                  <Text style={styles.rowTitle}>{item.name}</Text>
                  <Text numberOfLines={2} style={styles.rowPreview}>
                    {item.description ?? `${item.memberCount} ${t('chat.currentMembers')}`}
                  </Text>
                  <Text style={styles.discoveryDisclosure}>
                    {t(item.historyDisclosure.labelKey)}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => item.myJoinRequest?.status === 'pending'
                    ? void onCancelJoin?.(item.myJoinRequest)
                    : void onRequestJoin?.(item.conversationId)}
                  style={({ pressed }) => [styles.discoveryButton, pressed && styles.rowPressed]}>
                  <Text style={styles.discoveryButtonText}>
                    {item.myJoinRequest?.status === 'pending'
                      ? t('chat.cancelJoinRequest')
                      : t('chat.requestToJoin')}
                  </Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        {visible.length ? (
          visible.map((conversation, index) => [
            <ConversationRow
              actionsOpen={openRowId === conversation.id}
              conversation={conversation}
              key={conversation.id}
              markedUnread={markedUnreadIds.includes(conversation.id)}
              onAction={onRowAction}
              onPress={() => onSelect(conversation.id)}
              onToggleActions={(open) => setOpenRowId(open ? conversation.id : null)}
              selected={desktop && selectedId === conversation.id}
              showPinnedDivider={
                index > 0 && !conversation.pinned && visible[index - 1]?.pinned === true
              }
            />,
            // The open chat's projects hang under its row on a wide screen,
            // as the owner's father drew them (Sep 23 2026).
            desktop && selectedId === conversation.id && !conversation.managementOnly ? (
              <ProjectsPanel conversation={conversation} key={`${conversation.id}:projects`} variant="sidebar" />
            ) : null,
          ])
        ) : (
          <View style={styles.noResults}>
            <View style={styles.noResultsIcon}>
              <Ionicons name="search" size={21} color={colors.mintDark} />
            </View>
            <Text style={styles.noResultsTitle}>{t('chat.noResults')}</Text>
            <Text style={styles.noResultsBody}>{t('chat.noResultsBody')}</Text>
          </View>
        )}
      </ScrollView>
      {scrolledAway ? (
        <Pressable
          accessibilityLabel={t('chat.jumpToLatest')}
          accessibilityRole="button"
          onPress={() => {
            listRef.current?.scrollTo({ y: 0, animated: true });
            setScrolledAway(false);
          }}
          style={({ pressed }) => [styles.jumpToLatest, pressed && styles.rowPressed]}>
          <Ionicons color={colors.white} name="arrow-up" size={17} />
        </Pressable>
      ) : null}
    </KeyboardDismissArea>
  );
}

function ConversationRow({
  conversation,
  selected,
  onPress,
  showPinnedDivider,
  actionsOpen = false,
  markedUnread = false,
  onAction,
  onToggleActions,
}: {
  conversation: Conversation;
  selected: boolean;
  onPress: () => void;
  showPinnedDivider: boolean;
  actionsOpen?: boolean;
  markedUnread?: boolean;
  onAction?: (action: ConversationRowActionKey, conversation: Conversation) => void;
  onToggleActions?: (open: boolean) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const directAvatarUrl = useProfileAvatar(conversation.kind === 'direct' ? conversation.directParticipantId ?? null : null);
  const { t } = useI18n();
  const workspace = useWorkspace();
  const official = conversation.kind === 'announcement';
  const [hovered, setHovered] = useState(false);
  // The actions are only in the tree while they can be seen: closed, they are
  // not something a screen reader should walk past on every row.
  const [dragging, setDragging] = useState(false);
  const rowRef = useRef<View>(null);
  const openActions = useCallback(() => onToggleActions?.(true), [onToggleActions]);
  const actionable = Boolean(onAction);
  const slides = Platform.OS !== 'web';
  const showActions = actionable && (actionsOpen || hovered);
  // A mouse hovering gets one small ⋯, not the whole strip: five circles
  // over the row made clicking the chat a gamble (owner, Sep 14 2026). The
  // strip itself appears once the ⋯ is clicked or the row is right-clicked.
  const compactHover = !slides && hovered && !actionsOpen;
  const stripOpen = actionable && (slides ? showActions : actionsOpen);
  const unreadCount = markedUnread && !conversation.unreadCount ? 1 : conversation.unreadCount;
  // The row is one element to VoiceOver, so its label has to carry the preview
  // line as well as the name — otherwise the newest message, which is the whole
  // point of the row, is read out by nobody and seen by no test driver.
  const previewLine = conversation.lastMessage
    || attachmentPreviewLine(conversation, t)
    || t('chat.noMessagesYet');
  const actions = useMemo(
    () => conversationRowActions({ ...conversation, unreadCount }),
    [conversation, unreadCount],
  );

  useEffect(() => {
    if (!actionable || Platform.OS !== 'web') return undefined;
    return attachContextMenu(rowRef.current, openActions);
  }, [actionable, openActions]);

  // The actions used to appear all at once, on top of the time, as small
  // circles. Now the row slides under the finger and uncovers them, so nothing
  // is hidden and each one is a full-height column (owner, Sep 8 2026).
  const panelWidth = actions.length * ACTION_WIDTH;
  const dragX = useSharedValue(0);
  const openOffset = useSharedValue(0);
  // A finger uncovers the actions by moving the row; a mouse just hovers, and
  // sliding the row out from under the cursor made the click miss the chat it
  // was aimed at (live browser suite, Sep 8 2026). On the web the panel stays
  // an overlay at the right edge, which is what it has always been there.
  useEffect(() => {
    openOffset.value = withTiming(slides && showActions ? -panelWidth : 0, SNAP);
  }, [openOffset, panelWidth, showActions, slides]);
  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: openOffset.value + dragX.value }],
  }));
  const panelStyle = useAnimatedStyle(() => {
    if (!slides) return { opacity: 1 };
    const revealed = Math.min(1, Math.abs(openOffset.value + dragX.value) / Math.max(1, panelWidth));
    return { opacity: revealed };
  });
  const swipe = useMemo(
    () => Gesture.Pan()
      .activeOffsetX([-12, 12])
      .failOffsetY([-8, 8])
      .onBegin(() => setDragging(true))
      .onFinalize(() => setDragging(false))
      .onUpdate((event) => {
        // Only ever between closed and fully open, so a row cannot be dragged
        // off its own list.
        const base = showActions ? -panelWidth : 0;
        dragX.value = Math.max(-panelWidth - base, Math.min(-base, event.translationX));
      })
      .onEnd((event) => {
        const travelled = dragX.value;
        const settled = (showActions ? -panelWidth : 0) + travelled;
        dragX.value = withTiming(0, SNAP);
        // A flick decides on its own, in either direction. Closing had no
        // velocity shortcut at all, so a quick swipe right snapped back open.
        if (event.velocityX < -FLICK_VELOCITY) { onToggleActions?.(true); return; }
        if (event.velocityX > FLICK_VELOCITY) { onToggleActions?.(false); return; }
        // Otherwise it is distance, measured from where the row started rather
        // than from the closed position. Closing used to be judged against the
        // same absolute REVEAL_DISTANCE as opening, which with three actions
        // meant dragging back two thirds of the panel before it would shut.
        if (showActions) onToggleActions?.(travelled < panelWidth * CLOSE_FRACTION);
        else onToggleActions?.(settled <= -REVEAL_DISTANCE);
      })
      .runOnJS(true),
    [dragX, onToggleActions, panelWidth, showActions],
  );

  const row = (
    // Hover belongs to the whole row, panel included. While it sat on the
    // Pressable, moving the mouse onto the actions left the Pressable, which
    // unmounted them, which put the mouse back over the row — so the strip
    // flickered in and out and could not be clicked (owner, Sep 11 2026).
    // pointerleave does not fire for a move onto a descendant, so the panel
    // now holds its own hover.
    <View
      accessible={false}
      onPointerEnter={actionable ? () => setHovered(true) : undefined}
      onPointerLeave={actionable ? () => {
        setHovered(false);
        // A strip opened from the ⋯ is still a hover affordance: leaving the
        // row puts it away, as the hover-only strip always did.
        if (!slides && actionsOpen) onToggleActions?.(false);
      } : undefined}
      ref={rowRef}
      style={styles.rowShell}>
      <Animated.View style={[styles.rowSlide, rowStyle]}>
      <Pressable
        accessibilityLabel={`${conversation.title}: ${previewLine}`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onLongPress={actionable ? openActions : undefined}
        onPress={() => (actionsOpen ? onToggleActions?.(false) : onPress())}
        style={({ pressed }) => [
          styles.row,
          selected && styles.rowSelected,
          pressed && styles.rowPressed,
        ]}>
        <Avatar
          color={conversation.avatarColor}
          icon={official ? 'megaphone' : undefined}
          imageUri={conversation.kind === 'direct' ? directAvatarUrl : workspace.conversationAvatarUrls[conversation.id]}
          initials={conversation.initials}
          presence={conversation.kind === 'direct' ? conversation.presence : undefined}
          size={48}
        />
        <View style={styles.rowBody}>
          <View style={styles.rowTitleLine}>
            <View style={styles.rowTitleWrap}>
              <Text numberOfLines={1} style={styles.rowTitle}>
                {conversation.title}
              </Text>
              {conversation.pinned ? (
                <Ionicons name="pin" size={12} color={colors.inkSubtle} />
              ) : null}
              {/* Bookmarked chats carry a bookmark, not a star: the star
                  belongs to a favourite person in Contacts, and the two were
                  being read as the same thing (owner, Sep 10 2026). They sort
                  above the rest either way. */}
              {conversation.favorite ? (
                <Ionicons name="bookmark" size={12} color={colors.amber} />
              ) : null}
            </View>
            {/* On the web the actions appear where the time and badge sit, so
                the time yields while they show instead of being covered
                (owner, Sep 14 2026: "the overlap looks clunky"). */}
            {!(actionsOpen && !slides) ? (
              <Text
                style={[
                  styles.rowTime,
                  unreadCount > 0 && styles.rowTimeUnread,
                ]}>
                {conversation.lastActivity}
              </Text>
            ) : null}
          </View>
          <View style={styles.rowPreviewLine}>
            <View style={styles.rowPreviewWrap}>
              {conversation.priority === 'safety' ? (
                <Ionicons name="warning" size={13} color={colors.red} />
              ) : conversation.muted ? (
                <Ionicons name="notifications-off" size={12} color={colors.inkSubtle} />
              ) : null}
              <Text
                numberOfLines={1}
                style={[
                  styles.rowPreview,
                  unreadCount > 0 && styles.rowPreviewUnread,
                ]}>
                {previewLine}
              </Text>
            </View>
            {unreadCount && !(actionsOpen && !slides) ? (
              <View
                style={[
                  styles.unreadBadge,
                  conversation.priority === 'safety' && styles.unreadBadgeSafety,
                ]}>
                <Text style={styles.unreadBadgeText}>{unreadCount}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </Pressable>
      </Animated.View>
      {/* A mouse gets a compact strip at the right edge; it must not cover the
          row, or a click aimed at the chat lands on an action instead (live
          browser suite, Sep 8 2026). A finger gets full-height columns, which
          the row slides aside to uncover. */}
      {actionable && compactHover ? (
        <Pressable
          accessibilityLabel={t('chat.rowActions')}
          accessibilityRole="button"
          onPress={openActions}
          style={({ pressed }) => [styles.rowActionsHint, pressed && styles.rowActionPressed]}>
          <Ionicons color={colors.ink} name="ellipsis-horizontal" size={16} />
        </Pressable>
      ) : null}
      {actionable && (stripOpen || dragging) ? (
        <Animated.View
          accessibilityLabel={t('chat.rowActions')}
          accessible={false}
          pointerEvents={showActions ? 'auto' : 'none'}
          style={[
            styles.rowActions,
            slides ? { width: panelWidth } : styles.rowActionsOverlay,
            panelStyle,
          ]}>
          {actions.map((action) => (
            <Pressable
              accessibilityLabel={t(action.labelKey)}
              accessibilityRole="button"
              key={action.key}
              onPress={() => {
                onToggleActions?.(false);
                onAction?.(action.key, conversation);
              }}
              style={({ pressed }) => [
                styles.rowAction,
                slides ? null : styles.rowActionCompact,
                action.destructive && styles.rowActionDestructive,
                pressed && styles.rowActionPressed,
              ]}>
              <Ionicons
                color={action.destructive ? colors.white : colors.ink}
                name={action.icon}
                size={slides ? 19 : 16}
              />
              {slides ? (
                <Text
                  numberOfLines={1}
                  style={[styles.rowActionLabel, action.destructive && styles.rowActionLabelDestructive]}>
                  {t(action.labelKey)}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </Animated.View>
      ) : null}
    </View>
  );

  return (
    <>
      {showPinnedDivider ? (
        <View style={styles.sectionDivider}>
          <Text style={styles.sectionDividerText}>{t('chat.recent')}</Text>
          <View style={styles.sectionDividerLine} />
        </View>
      ) : null}
      {/* No swipe on the web: there is nothing to swipe with, and the pan
          handler begins on press, which swallowed the click that opens a chat
          (live browser suite, Sep 8 2026). A mouse gets the same actions from
          hover and right-click. */}
      {actionable && Platform.OS !== 'web'
        ? <GestureDetector gesture={swipe}>{row}</GestureDetector>
        : row}
    </>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  rowShell: {
    position: 'relative',
  },
  rowSlide: { backgroundColor: colors.paper },
  rowActions: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  rowAction: {
    width: ACTION_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    backgroundColor: colors.paperMuted,
  },
  rowActionsOverlay: { right: spacing.sm, top: 0, bottom: 0, alignItems: 'center', gap: 4 },
  rowActionsHint: {
    position: 'absolute',
    right: spacing.sm,
    top: 0,
    bottom: 0,
    marginVertical: 'auto',
    alignSelf: 'center',
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.paper,
  },
  rowActionCompact: {
    width: 30,
    height: 30,
    borderRadius: radii.pill,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
  },
  rowActionPressed: { opacity: 0.7 },
  rowActionDestructive: {
    backgroundColor: colors.red,
  },
  rowActionLabel: { color: colors.inkSubtle, fontSize: 9, fontWeight: '700' },
  rowActionLabelDestructive: { color: colors.white },
  jumpToLatest: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.lg,
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
    backgroundColor: colors.forest,
  },
  moreFilters: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
  },
  discoverySection: {
    gap: spacing.xs,
    paddingBottom: spacing.md,
  },
  discoveryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.mintSoft,
    borderRadius: radii.md,
  },
  discoveryDisclosure: {
    color: colors.inkMuted,
    fontSize: 11,
  },
  discoveryButton: {
    backgroundColor: colors.inkStrong,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  discoveryButtonText: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '700',
  },
  container: {
    flex: 1,
    minWidth: 0,
    backgroundColor: colors.paper,
  },
  containerDesktop: {
    width: 374,
    flexBasis: 374,
    flexGrow: 0,
    flexShrink: 0,
    borderTopLeftRadius: radii.lg,
    borderBottomLeftRadius: radii.lg,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.lineStrong,
    overflow: 'hidden',
  },
  header: {
    minHeight: 92,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  eyebrow: {
    color: colors.inkSubtle,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    marginBottom: 3,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 27,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  searchWrap: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  searchWrapMobile: {
    paddingTop: spacing.md,
    paddingHorizontal: spacing.md,
  },
  // A horizontal ScrollView grows like any ScrollView; without this the chip
  // row took half the screen and the conversations started mid-screen
  // (owner report, Sep 4 2026).
  filterScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  filterRow: {
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.xs,
    alignItems: 'flex-start',
  },
  listContent: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.xl,
  },
  row: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 9,
    borderRadius: radii.md,
  },
  rowSelected: {
    backgroundColor: colors.mintSoft,
  },
  rowPressed: {
    backgroundColor: colors.paperMuted,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: 5,
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  rowTitleWrap: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  rowTitle: {
    flexShrink: 1,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  rowTime: {
    color: colors.inkSubtle,
    fontSize: 11,
    fontWeight: '600',
  },
  rowTimeUnread: {
    color: colors.mintDark,
    fontWeight: '800',
  },
  rowPreviewLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  rowPreviewWrap: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  rowPreview: {
    flex: 1,
    color: colors.inkSubtle,
    fontSize: 13,
    lineHeight: 18,
  },
  rowPreviewUnread: {
    color: colors.inkMuted,
    fontWeight: '700',
  },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
    backgroundColor: colors.mint,
  },
  unreadBadgeSafety: {
    backgroundColor: colors.redStrong,
  },
  unreadBadgeSafetyText: {
    color: colors.white,
  },
  unreadBadgeText: {
    // White on mint is 2.2:1, which is not readable at 10pt; the count sits on
    // a bright badge, so it takes the dark ink both palettes use on accent.
    color: colors.onAccent,
    fontSize: 10,
    fontWeight: '900',
  },
  sectionDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  sectionDividerText: {
    color: colors.inkSubtle,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.9,
  },
  sectionDividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.line,
  },
  noResults: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxxl,
  },
  noResultsIcon: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.lg,
    backgroundColor: colors.mintSoft,
    marginBottom: spacing.sm,
  },
  noResultsTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  noResultsBody: {
    color: colors.inkSubtle,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 4,
  },
});
