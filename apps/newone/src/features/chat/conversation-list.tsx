import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { Conversation, DiscoverableConversation, InboxFilter, Person } from '@/domain/types';
import { Avatar, Chip, IconButton, SearchField, StatusBadge } from '@/components/ui/primitives';
import { colors, radii, spacing, type } from '@/theme/tokens';
import { useI18n } from '@/i18n/provider';
import { useProfileAvatar } from '@/state/profile-avatar';
import { useWorkspace } from '@/state/workspace';

const filters: InboxFilter[] = ['all', 'unread', 'direct', 'groups', 'announcements'];

function filterConversations(
  conversations: Conversation[],
  filter: InboxFilter,
  search: string,
) {
  const query = search.trim().toLocaleLowerCase();
  return conversations.filter((conversation) => {
    if (conversation.managementOnly) return false;
    const matchesQuery =
      !query ||
      conversation.title.toLocaleLowerCase().includes(query) ||
      conversation.lastMessage.toLocaleLowerCase().includes(query) ||
      conversation.subtitle.toLocaleLowerCase().includes(query);
    if (!matchesQuery) return false;
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
}) {
  const workspace = useWorkspace();
  const people = workspace.people;
  // Incoming message requests are direct threads whose counterpart is waiting
  // on this member's decision. They get their own section so a request is
  // never mistaken for an ordinary chat and is never hidden by the inbox
  // filter or search; the request thread itself opens like any conversation.
  const incomingRequests = useMemo(
    () => conversations.flatMap((conversation) => {
      if (conversation.managementOnly || conversation.kind !== 'direct' || !conversation.directParticipantId) {
        return [];
      }
      const counterpart = people.find((person) => person.id === conversation.directParticipantId);
      return counterpart?.connectionState === 'pending'
        && counterpart.connectionRequestDirection === 'incoming'
        ? [{ conversation, counterpart }]
        : [];
    }),
    [conversations, people],
  );
  const visible = useMemo(() => {
    const requestIds = new Set(incomingRequests.map((request) => request.conversation.id));
    return filterConversations(conversations, filter, search)
      .filter((conversation) => !requestIds.has(conversation.id));
  }, [conversations, filter, incomingRequests, search]);
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
          <IconButton name="create-outline" label={t('chat.compose')} onPress={onCompose} />
        </View>
      ) : null}

      <View style={[styles.searchWrap, !desktop && styles.searchWrapMobile]}>
        <SearchField
          value={search}
          onChangeText={onSearchChange}
          placeholder={t('chat.search')}
        />
      </View>

      <ScrollView
        horizontal
        contentContainerStyle={styles.filterRow}
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}>
        {filters.map((item) => (
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
      </ScrollView>

      <ScrollView
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        {incomingRequests.length ? (
          <View style={styles.requestSection}>
            <View style={styles.sectionDivider}>
              <Text style={styles.sectionDividerText}>{t('chat.requests')}</Text>
              <View style={styles.sectionDividerLine} />
            </View>
            <Text style={styles.requestHint}>{t('chat.requestsHint')}</Text>
            {incomingRequests.map(({ conversation, counterpart }) => (
              <MessageRequestRow
                busy={workspace.actionBusy === 'connection-respond'}
                conversation={conversation}
                counterpart={counterpart}
                key={conversation.id}
                onAccept={() => void workspace.respondConnection(counterpart.id, 'accepted')}
                onDecline={() => void workspace.respondConnection(counterpart.id, 'declined')}
                onPress={() => onSelect(conversation.id)}
                selected={desktop && selectedId === conversation.id}
              />
            ))}
          </View>
        ) : null}
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
              conversation={conversation}
              key={conversation.id}
              onPress={() => onSelect(conversation.id)}
              selected={desktop && selectedId === conversation.id}
              showPinnedDivider={
                index > 0 && !conversation.pinned && visible[index - 1]?.pinned === true
              }
            />
          ))
        ) : incomingRequests.length ? null : (
          <View style={styles.noResults}>
            <View style={styles.noResultsIcon}>
              <Ionicons name="search" size={21} color={colors.mintDark} />
            </View>
            <Text style={styles.noResultsTitle}>{t('chat.noResults')}</Text>
            <Text style={styles.noResultsBody}>{t('chat.noResultsBody')}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function MessageRequestRow({
  conversation,
  counterpart,
  selected,
  busy,
  onPress,
  onAccept,
  onDecline,
}: {
  conversation: Conversation;
  counterpart: Person;
  selected: boolean;
  busy: boolean;
  onPress: () => void;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const counterpartAvatarUrl = useProfileAvatar(counterpart.id);
  const { t } = useI18n();
  return (
    <View style={[styles.requestRow, selected && styles.rowSelected]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={onPress}
        style={({ pressed }) => [styles.requestRowBody, pressed && styles.rowPressed]}>
        <Avatar
          color={conversation.avatarColor}
          imageUri={counterpartAvatarUrl}
          initials={conversation.initials}
          presence={conversation.presence}
          size={44}
        />
        <View style={styles.rowBody}>
          <Text numberOfLines={1} style={styles.rowTitle}>{counterpart.displayName}</Text>
          <Text numberOfLines={2} style={styles.rowPreview}>{conversation.lastMessage}</Text>
        </View>
      </Pressable>
      <View style={styles.requestActions}>
        <Pressable
          accessibilityLabel={t('people.accept')}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onAccept}
          style={({ pressed }) => [styles.requestButton, styles.requestButtonAccept, pressed && styles.rowPressed]}>
          <Ionicons name="checkmark" size={14} color={colors.white} />
          <Text style={styles.requestButtonAcceptText}>{t('people.accept')}</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={t('people.decline')}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onDecline}
          style={({ pressed }) => [styles.requestButton, pressed && styles.rowPressed]}>
          <Ionicons name="close" size={14} color={colors.ink} />
          <Text style={styles.requestButtonText}>{t('people.decline')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ConversationRow({
  conversation,
  selected,
  onPress,
  showPinnedDivider,
}: {
  conversation: Conversation;
  selected: boolean;
  onPress: () => void;
  showPinnedDivider: boolean;
}) {
  const directAvatarUrl = useProfileAvatar(conversation.kind === 'direct' ? conversation.directParticipantId ?? null : null);
  const { t } = useI18n();
  const workspace = useWorkspace();
  const official = conversation.kind === 'announcement';
  return (
    <>
      {showPinnedDivider ? (
        <View style={styles.sectionDivider}>
          <Text style={styles.sectionDividerText}>{t('chat.recent')}</Text>
          <View style={styles.sectionDividerLine} />
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={onPress}
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
                conversation.unreadCount > 0 && styles.rowTimeUnread,
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
                  conversation.unreadCount > 0 && styles.rowPreviewUnread,
                ]}>
                {conversation.lastMessage}
              </Text>
            </View>
            {conversation.unreadCount ? (
              <View
                style={[
                  styles.unreadBadge,
                  conversation.priority === 'safety' && styles.unreadBadgeSafety,
                ]}>
                <Text style={styles.unreadBadgeText}>{conversation.unreadCount}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  requestSection: {
    gap: spacing.xs,
    paddingBottom: spacing.md,
  },
  requestHint: {
    color: colors.inkMuted,
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: spacing.sm,
  },
  requestRow: {
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.amberSoft,
  },
  requestRowBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
  },
  requestActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  requestButton: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.paper,
  },
  requestButtonAccept: {
    borderColor: colors.forest,
    backgroundColor: colors.forest,
  },
  requestButtonText: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '800',
  },
  requestButtonAcceptText: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '800',
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
    backgroundColor: colors.ink,
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
    backgroundColor: colors.red,
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
