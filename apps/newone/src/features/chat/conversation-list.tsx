import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import type { Conversation, DiscoverableConversation, InboxFilter } from '@/domain/types';
import type { MessageKey } from '@/i18n/catalog';
import { Avatar, Chip, IconButton, StatusBadge } from '@/components/ui/primitives';
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
import { useI18n } from '@/i18n/provider';
import { useProfileAvatar } from '@/state/profile-avatar';
import { useWorkspace } from '@/state/workspace';

const filters: InboxFilter[] = ['all', 'unread', 'direct', 'groups', 'announcements'];

/** A row is dragged this far before its actions stay open. */
const REVEAL_DISTANCE = 56;

export type ConversationRowActionKey =
  | 'markUnread'
  | 'markRead'
  | 'mute'
  | 'unmute'
  | 'archive'
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
}): ConversationRowAction[] {
  const group = conversation.kind !== 'direct';
  return [
    conversation.unreadCount
      ? { key: 'markRead', labelKey: 'chat.markRead', icon: 'mail-open-outline', destructive: false }
      : { key: 'markUnread', labelKey: 'chat.markUnread', icon: 'mail-unread-outline', destructive: false },
    conversation.muted
      ? { key: 'unmute', labelKey: 'chat.unmute', icon: 'notifications-outline', destructive: false }
      : { key: 'mute', labelKey: 'chat.mute', icon: 'notifications-off-outline', destructive: false },
    { key: 'archive', labelKey: 'chat.archive', icon: 'archive-outline', destructive: false },
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

export function filterConversations(
  conversations: Conversation[],
  filter: InboxFilter,
  search: string,
  people: readonly SearchPersonRef[] = [],
  messageConversationIds?: ReadonlySet<string>,
) {
  const parsed = parseSearch(search, people);
  return conversations.filter((conversation) => {
    if (conversation.managementOnly) return false;
    if (!conversationMatchesSearch(conversation, parsed, messageConversationIds)) return false;
    if (filter === 'unread') return conversation.unreadCount > 0;
    if (filter === 'direct') return conversation.kind === 'direct';
    if (filter === 'groups') {
      return ['group', 'team', 'shift'].includes(conversation.kind);
    }
    if (filter === 'announcements') return conversation.kind === 'announcement';
    return true;
  });
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
  onOpenAdvancedSearch,
  onRowAction,
  onOpenPinned,
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
  onOpenAdvancedSearch?: () => void;
  onRowAction?: (action: ConversationRowActionKey, conversation: Conversation) => void;
  /** Opens the pins gathered from every chat. */
  onOpenPinned?: () => void;
  /** Chats the reader put back to unread by hand. */
  markedUnreadIds?: readonly string[];
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const listRef = useRef<ScrollView>(null);
  const [scrolledAway, setScrolledAway] = useState(false);
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const parsedSearch = useMemo(() => parseSearch(search, people), [people, search]);
  const messageConversationIds = useMemo(
    () => new Set(suggestions
      .filter((item) => item.kind === 'message')
      .map((item) => item.conversationId)),
    [suggestions],
  );
  const visible = useMemo(
    () => filterConversations(conversations, filter, search, people, messageConversationIds),
    [conversations, filter, messageConversationIds, people, search],
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
    <View style={[styles.container, desktop && styles.containerDesktop]}>
      {desktop ? (
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>{organizationName ?? t('chat.workspace')}</Text>
            <View style={styles.titleRow}>
              <Text style={styles.title}>{t('nav.chats')}</Text>
              {unread ? <StatusBadge label={`${unread} ${t('chat.unreadCount')}`} tone="success" /> : null}
            </View>
          </View>
          <IconButton name="add" label={t('chat.newMenu')} onPress={onCompose} />
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
          trailing={onOpenAdvancedSearch ? (
            <Pressable
              accessibilityLabel={t('search.moreFilters')}
              accessibilityRole="button"
              hitSlop={6}
              onPress={onOpenAdvancedSearch}
              style={({ pressed }) => [styles.moreFilters, pressed && styles.rowPressed]}>
              <Ionicons color={colors.mintDark} name="options-outline" size={17} />
            </Pressable>
          ) : null}
          value={search}
        />
      </View>

      <ScrollView
        horizontal
        contentContainerStyle={styles.filterRow}
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}>
        {visibleFilters.map((item) => (
          <Chip
            count={
              item === 'unread'
                ? conversations.filter((conversation) => (
                    !conversation.managementOnly && conversation.unreadCount > 0
                  )).length
                : undefined
            }
            key={item}
            label={filterLabels[item]}
            onPress={() => onFilterChange(item)}
            selected={filter === item}
          />
        ))}
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
        keyboardShouldPersistTaps="handled"
        onScroll={(event) => setScrolledAway(event.nativeEvent.contentOffset.y > 240)}
        ref={listRef}
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
          visible.map((conversation, index) => (
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
            />
          ))
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
    </View>
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
  const rowRef = useRef<View>(null);
  const openActions = useCallback(() => onToggleActions?.(true), [onToggleActions]);
  const actionable = Boolean(onAction);
  const showActions = actionable && (actionsOpen || hovered);
  const unreadCount = markedUnread && !conversation.unreadCount ? 1 : conversation.unreadCount;
  const actions = useMemo(
    () => conversationRowActions({ ...conversation, unreadCount }),
    [conversation, unreadCount],
  );

  useEffect(() => {
    if (!actionable || Platform.OS !== 'web') return undefined;
    return attachContextMenu(rowRef.current, openActions);
  }, [actionable, openActions]);

  // A short drag opens the same actions; released early it simply snaps back.
  const swipe = useMemo(
    () => Gesture.Pan()
      .activeOffsetX([-12, 12])
      .failOffsetY([-8, 8])
      .onEnd((event) => {
        if (event.translationX <= -REVEAL_DISTANCE) onToggleActions?.(true);
        else if (event.translationX >= REVEAL_DISTANCE) onToggleActions?.(false);
      })
      .runOnJS(true),
    [onToggleActions],
  );

  const row = (
    <View accessible={false} ref={rowRef} style={styles.rowShell}>
      <Pressable
        accessibilityLabel={conversation.title}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onHoverIn={actionable ? () => setHovered(true) : undefined}
        onHoverOut={actionable ? () => setHovered(false) : undefined}
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
            </View>
            <Text
              style={[
                styles.rowTime,
                unreadCount > 0 && styles.rowTimeUnread,
              ]}>
              {conversation.lastActivity}
            </Text>
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
                {conversation.lastMessage || t(conversation.archived ? 'chat.archivedChat' : 'chat.noMessagesYet')}
              </Text>
            </View>
            {unreadCount ? (
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
      {showActions ? (
        <View
          accessibilityLabel={t('chat.rowActions')}
          accessible={false}
          style={styles.rowActions}>
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
                action.destructive && styles.rowActionDestructive,
                pressed && styles.rowPressed,
              ]}>
              <Ionicons
                color={action.destructive ? colors.red : colors.mintDark}
                name={action.icon}
                size={17}
              />
            </Pressable>
          ))}
        </View>
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
      {actionable ? <GestureDetector gesture={swipe}>{row}</GestureDetector> : row}
    </>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  rowShell: {
    position: 'relative',
  },
  rowActions: {
    position: 'absolute',
    right: spacing.sm,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  rowAction: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
  },
  rowActionDestructive: {
    borderColor: colors.red,
  },
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
  unreadBadgeText: {
    color: colors.white,
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
