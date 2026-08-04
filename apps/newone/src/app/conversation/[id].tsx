import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';

import { AppScaffold } from '@/components/navigation/app-scaffold';
import { ConversationPane } from '@/features/chat/conversation-pane';
import {
  WorkspaceStatePanel,
  WorkspaceStatusBanner,
} from '@/components/workspace/workspace-state';
import { useWorkspace } from '@/state/workspace';

export default function ConversationScreen() {
  const { id, messageId } = useLocalSearchParams<{ id: string; messageId?: string }>();
  const router = useRouter();
  const workspace = useWorkspace();
  const selectConversation = workspace.selectConversation;
  const conversation = workspace.conversations.find((item) => item.id === id);

  useEffect(() => {
    if (id) selectConversation(id);
  }, [id, selectConversation]);

  return (
    <AppScaffold current="chats" hideMobileTabs>
      <WorkspaceStatusBanner />
      {workspace.status === 'loading' || workspace.status === 'error' ? (
        <WorkspaceStatePanel resource="chats" />
      ) : (
      <ConversationPane
        conversation={conversation}
        focusMessageId={messageId}
        messages={workspace.messages[id] ?? []}
        mobile
        onBack={() => router.back()}
        onSend={(text, replyTo, mentionUserIds) => workspace.sendMessage(id, text, replyTo, mentionUserIds)}
      />
      )}
    </AppScaffold>
  );
}
