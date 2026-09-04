import { useRouter } from 'expo-router';
import { useEffect } from 'react';
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
  // workspace organization-and-shift subtitle.
  const personalRealm = isPersonalRealm(workspace.organizationId);
  const consumerUsername = workspace.currentUser?.username?.trim() || null;
  const headerSubtitle = personalRealm
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
      <WorkspaceStatusBanner />
      {workspace.status === 'loading' || workspace.status === 'error' || ordinaryConversations.length === 0 ? (
        <WorkspaceStatePanel resource="chats" />
      ) : desktop ? (
        <View style={styles.desktopCanvas}>
          <View style={[styles.messengerFrame, shadow]}>
            <ConversationList
              conversations={workspace.conversations}
              desktop
              filter={workspace.inboxFilter}
              onCompose={() => router.push('./new-group')}
              onFilterChange={workspace.setInboxFilter}
              onSearchChange={workspace.setInboxSearch}
              onSelect={openConversation}
              search={workspace.inboxSearch}
              selectedId={workspace.selectedConversationId}
              organizationName={workspace.organizationName}
              discoverableConversations={workspace.discoverableConversations}
              onRequestJoin={workspace.requestConversationJoin}
              onCancelJoin={workspace.cancelConversationJoinRequest}
            />
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
        <ConversationList
          conversations={workspace.conversations}
          filter={workspace.inboxFilter}
          onCompose={() => router.push('./new-group')}
          onFilterChange={workspace.setInboxFilter}
          onSearchChange={workspace.setInboxSearch}
          onSelect={openConversation}
          search={workspace.inboxSearch}
          selectedId={workspace.selectedConversationId}
          organizationName={workspace.organizationName}
          discoverableConversations={workspace.discoverableConversations}
          onRequestJoin={workspace.requestConversationJoin}
          onCancelJoin={workspace.cancelConversationJoinRequest}
        />
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
