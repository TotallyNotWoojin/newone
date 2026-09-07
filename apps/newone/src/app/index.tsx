import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AppScaffold,
  MobileBrandHeader,
} from '@/components/navigation/app-scaffold';
import { ScreenErrorBoundary } from '@/components/ui/error-boundary';
import { IconButton } from '@/components/ui/primitives';
import {
  WorkspaceStatePanel,
  WorkspaceStatusBanner,
} from '@/components/workspace/workspace-state';
import { ConversationDetails } from '@/features/chat/conversation-details';
import { ConversationList } from '@/features/chat/conversation-list';
import { ConversationPane } from '@/features/chat/conversation-pane';
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
import { useWorkspace } from '@/state/workspace';
import { colors, radii, shadow, spacing } from '@/theme/tokens';
import { useI18n } from '@/i18n/provider';
import { useHydrationSafeWindowDimensions } from '@/hooks/use-hydration-safe-window-dimensions';

export default function ChatsScreen() {
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

  const listProps = {
    conversations: workspace.conversations,
    filter: workspace.inboxFilter,
    onCancelJoin: workspace.cancelConversationJoinRequest,
    onCompose: () => router.push('./new-group'),
    onFilterChange: workspace.setInboxFilter,
    onOpenSuggestion: openSuggestion,
    onRequestJoin: workspace.requestConversationJoin,
    onSearchChange: workspace.setInboxSearch,
    onSelect: openConversation,
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
                label={t('chat.compose')}
                name="create-outline"
                onPress={() => router.push('./new-group')}
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
    </AppScaffold>
  );
}

const styles = StyleSheet.create({
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
