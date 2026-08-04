import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import type { Conversation } from '@/domain/types';
import { Avatar, StatusBadge } from '@/components/ui/primitives';
import { activeMutedUntil } from '@/data/notification-preferences.mjs';
import { notificationCopy } from '@/features/chat/notification-copy';
import { colors, radii, spacing, type } from '@/theme/tokens';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';

export function ConversationDetails({ conversation }: { conversation: Conversation }) {
  const { locale, t } = useI18n();
  const workspace = useWorkspace();
  const notification = notificationCopy(locale);
  const mutedUntil = activeMutedUntil(conversation.mutedUntil);
  const notificationValue = mutedUntil
    ? `${notification.mutedUntil} · ${new Date(mutedUntil).toLocaleString()}`
    : conversation.notificationLevel === 'mentions'
      ? notification.mentions
      : conversation.notificationLevel === 'none' || conversation.muted
        ? notification.none
        : notification.all;
  const items = [
    { icon: 'notifications-outline' as const, label: t('chat.notifications'), value: notificationValue },
    { icon: 'language-outline' as const, label: t('chat.translation'), value: conversation.translationPair ?? t('chat.off') },
  ];
  return (
    <View style={styles.container}>
      <View style={styles.profile}>
        <Avatar
          color={conversation.avatarColor}
          icon={conversation.kind === 'announcement' ? 'megaphone' : undefined}
          imageUri={workspace.conversationAvatarUrls[conversation.id]}
          initials={conversation.initials}
          presence={conversation.presence}
          size={62}
        />
        <Text style={styles.title}>{conversation.title}</Text>
        <Text style={styles.subtitle}>{conversation.subtitle}</Text>
        <View style={styles.badges}>
          <StatusBadge icon="lock-closed" label={t('nav.private')} tone="success" />
          {conversation.kind !== 'direct' ? (
            <StatusBadge label={`${conversation.participantCount ?? 0} ${t('chat.membersLower')}`} />
          ) : null}
        </View>
      </View>

      <View style={styles.settings}>
        {items.map((item) => (
          <View key={item.label} style={styles.settingRow}>
            <View style={styles.settingIcon}>
              <Ionicons name={item.icon} size={17} color={colors.inkMuted} />
            </View>
            <View style={styles.settingCopy}>
              <Text style={styles.settingLabel}>{item.label}</Text>
              <Text style={styles.settingValue}>{item.value}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 278,
    padding: spacing.lg,
    backgroundColor: colors.paper,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.lineStrong,
  },
  profile: {
    alignItems: 'center',
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
  },
  title: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  subtitle: {
    color: colors.inkSubtle,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 3,
  },
  badges: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  settings: {
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  settingRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  settingIcon: {
    width: 34,
    height: 34,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.paperMuted,
  },
  settingCopy: {
    flex: 1,
    minWidth: 0,
  },
  settingLabel: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '800',
  },
  settingValue: {
    color: colors.inkSubtle,
    fontSize: 10,
    marginTop: 2,
  },
});
