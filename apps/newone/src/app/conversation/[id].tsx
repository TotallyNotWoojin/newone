import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';

import { AppScaffold } from '@/components/navigation/app-scaffold';
import { ConversationPane } from '@/features/chat/conversation-pane';
import { setVisibleConversation } from '@/device/visible-conversation';
import { WorkspaceStatePanel } from '@/components/workspace/workspace-state';
import { ScreenErrorBoundary } from '@/components/ui/error-boundary';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';

export default function ConversationScreen() {
  const { id, messageId } = useLocalSearchParams<{ id: string; messageId?: string }>();
  const router = useRouter();
  const workspace = useWorkspace();
  const { t } = useI18n();
  const selectConversation = workspace.selectConversation;
  const conversation = workspace.conversations.find((item) => item.id === id);

  useEffect(() => {
    if (id) selectConversation(id);
  }, [id, selectConversation]);

  // While this chat is on screen it announces nothing: a push for the
  // conversation the reader is already reading is noise.
  useFocusEffect(useCallback(() => {
    setVisibleConversation(id ?? null);
    return () => setVisibleConversation(null);
  }, [id]));

  return (
    <AppScaffold current="chats" hideMobileTabs>
      {workspace.status === 'loading' || workspace.status === 'error' ? (
        <WorkspaceStatePanel resource="chats" />
      ) : (
      <ScreenErrorBoundary
        labels={{ title: t('errors.screenCrashed'), retry: t('errors.tryAgain') }}
        scope="conversation">
        <ConversationPane
          conversation={conversation}
          focusMessageId={messageId}
          messages={workspace.messages[id] ?? []}
          mobile
          onBack={() => router.back()}
          onSend={(text, replyTo, mentionUserIds) => workspace.sendMessage(id, text, replyTo, mentionUserIds)}
        />
      </ScreenErrorBoundary>
      )}
    </AppScaffold>
  );
}
