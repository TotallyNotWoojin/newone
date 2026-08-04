import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { EmptyState, PrimaryButton } from '@/components/ui/primitives';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { colors, spacing } from '@/theme/tokens';

export function WorkspaceStatusBanner() {
  const workspace = useWorkspace();
  const { t } = useI18n();
  let label = '';
  let icon: keyof typeof Ionicons.glyphMap = 'information-circle-outline';
  let tone: 'neutral' | 'warning' | 'danger' = 'neutral';

  if (workspace.connectivity === 'offline') {
    label = workspace.offlineQueueAvailable
      ? t('status.offline')
      : t('status.guestOffline');
    icon = 'cloud-offline-outline';
    tone = 'warning';
  } else if (workspace.actionError) {
    label = workspace.actionError;
    icon = 'alert-circle-outline';
    tone = 'danger';
  } else if (workspace.failedOutboxCount > 0) {
    label = `${workspace.failedOutboxCount} · ${t('chat.failed')}`;
    icon = 'alert-circle-outline';
    tone = 'danger';
  } else if (workspace.realtimeState === 'connecting' || workspace.realtimeState === 'error') {
    label = t('status.reconnecting');
    icon = 'sync-outline';
    tone = 'warning';
  } else if (workspace.outboxCount > 0) {
    label = `${workspace.outboxCount} ${t('chat.queued').toLocaleLowerCase()}`;
    icon = 'time-outline';
  }

  if (!label) return null;
  const palette = {
    neutral: { background: colors.blueSoft, foreground: colors.blue },
    warning: { background: colors.amberSoft, foreground: colors.amber },
    danger: { background: colors.redSoft, foreground: colors.red },
  }[tone];
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole={tone === 'danger' ? 'alert' : undefined}
      style={[styles.banner, { backgroundColor: palette.background }]}>
      <Ionicons color={palette.foreground} name={icon} size={15} />
      <Text style={[styles.bannerText, { color: palette.foreground }]}>{label}</Text>
    </View>
  );
}

export function WorkspaceStatePanel({
  resource,
}: {
  resource: 'chats' | 'people' | 'updates' | 'handoffs';
}) {
  const workspace = useWorkspace();
  const { t } = useI18n();
  if (workspace.status === 'loading') {
    return (
      <View accessibilityLiveRegion="polite" style={styles.loading}>
        <ActivityIndicator color={colors.mintDark} />
        <Text style={styles.loadingText}>{t('status.loading')}</Text>
      </View>
    );
  }
  if (workspace.status === 'error') {
    return (
      <EmptyState
        action={
          <PrimaryButton
            icon="refresh-outline"
            label={t('status.retry')}
            onPress={() => void workspace.refresh()}
            tone="dark"
          />
        }
        body={workspace.error ?? t('status.error')}
        icon="cloud-offline-outline"
        title={t('status.error')}
      />
    );
  }
  if (resource === 'chats' && !workspace.conversations.some(
    (conversation) => !conversation.managementOnly,
  )) {
    return (
      <EmptyState
        body={t('status.emptyChatsBody')}
        icon="chatbubbles-outline"
        title={t('status.emptyChats')}
      />
    );
  }
  if (resource === 'people' && workspace.people.filter((person) => person.connectionState !== 'self').length === 0) {
    return (
      <EmptyState
        body={t('status.emptyPeopleBody')}
        icon="people-outline"
        title={t('status.emptyPeople')}
      />
    );
  }
  if (resource === 'updates' && workspace.updates.length === 0) {
    return (
      <EmptyState
        body={t('status.emptyUpdatesBody')}
        icon="megaphone-outline"
        title={t('status.emptyUpdates')}
      />
    );
  }
  if (resource === 'handoffs' && workspace.handoffs.length === 0) {
    return (
      <EmptyState
        body={t('status.emptyHandoffsBody')}
        icon="swap-horizontal-outline"
        title={t('status.emptyHandoffs')}
      />
    );
  }
  return null;
}

const styles = StyleSheet.create({
  banner: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  bannerText: {
    flexShrink: 1,
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '800',
    textAlign: 'center',
  },
  loading: {
    flex: 1,
    minHeight: 280,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.xl,
  },
  loadingText: {
    color: colors.inkMuted,
    fontSize: 12,
    textAlign: 'center',
  },
});
