import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { EmptyState, PrimaryButton } from '@/components/ui/primitives';
import { isPersonalRealm } from '@/constants/personal-realm';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { radii, shadow, spacing } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

/** A degraded realtime connection self-heals in the background (resubscribe
 * with backoff); only surface the disruptive-looking indicator once the
 * degraded state has actually persisted for a while. */
const DEGRADED_INDICATOR_DELAY_MS = 10_000;

function useDegradedRealtimeIndicator(realtimeState: string): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (realtimeState !== 'degraded') return undefined;
    const timer = setTimeout(() => setVisible(true), DEGRADED_INDICATOR_DELAY_MS);
    // Reset on cleanup (leaving 'degraded', or unmounting) rather than in the
    // effect body, so a later degraded spell always waits out the delay again.
    return () => {
      clearTimeout(timer);
      setVisible(false);
    };
  }, [realtimeState]);
  return visible;
}

export function WorkspaceStatusBanner() {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const workspace = useWorkspace();
  const { t } = useI18n();
  const degradedIndicatorVisible = useDegradedRealtimeIndicator(workspace.realtimeState);
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
  } else if (
    workspace.realtimeState === 'connecting'
    || workspace.realtimeState === 'error'
    || degradedIndicatorVisible
  ) {
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
  // A pill floating over the list: the rows never move when it appears or
  // clears, so a tap aimed at a row lands on that row (a shifting list once
  // declined a request, run-2026-09-04T20-41-40). Taps beside the pill reach the list.
  return (
    <View pointerEvents="box-none" style={styles.bannerLayer}>
      <View
        accessibilityLiveRegion="polite"
        accessibilityRole={tone === 'danger' ? 'alert' : undefined}
        style={[styles.banner, shadow, { backgroundColor: palette.background }]}>
        <Ionicons color={palette.foreground} name={icon} size={15} />
        <Text style={[styles.bannerText, { color: palette.foreground }]}>{label}</Text>
      </View>
    </View>
  );
}

export function WorkspaceStatePanel({
  resource,
}: {
  resource: 'chats' | 'people' | 'updates' | 'handoffs';
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const workspace = useWorkspace();
  const { t } = useI18n();
  // Consumer accounts never see workplace directory wording in empty states.
  const personalRealm = isPersonalRealm(workspace.organizationId);
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
        body={t(personalRealm ? 'status.emptyChatsBodyConsumer' : 'status.emptyChatsBody')}
        icon="chatbubbles-outline"
        title={t('status.emptyChats')}
      />
    );
  }
  if (resource === 'people' && workspace.people.filter((person) => person.connectionState !== 'self').length === 0) {
    return (
      <EmptyState
        body={t(personalRealm ? 'status.emptyPeopleBodyConsumer' : 'status.emptyPeopleBody')}
        icon="people-outline"
        title={t(personalRealm ? 'status.emptyPeopleConsumer' : 'status.emptyPeople')}
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

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  bannerLayer: {
    position: 'absolute',
    top: spacing.xs,
    left: 0,
    right: 0,
    zIndex: 20,
    alignItems: 'center',
    paddingHorizontal: spacing.md,
  },
  banner: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.pill,
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
