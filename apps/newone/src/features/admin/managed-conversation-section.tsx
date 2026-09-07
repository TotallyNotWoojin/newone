import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { radii, shadow, spacing, type } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

export function ManagedConversationSection({
  onOpen,
}: {
  onOpen: (conversationId: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const workspace = useWorkspace();
  const conversations = workspace.conversations
    .filter((conversation) => (
      conversation.managementOnly === true
      && (
        conversation.canManageConversation === true
        || conversation.canManageDynamicGroup === true
      )
    ))
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));

  if (!conversations.length) return null;

  return (
    <View style={[styles.section, shadow]}>
      <View style={styles.headingRow}>
        <View style={styles.headingIcon}>
          <Ionicons color={colors.mintDark} name="shield-checkmark-outline" size={21} />
        </View>
        <View style={styles.headingCopy}>
          <Text accessibilityRole="header" style={styles.title}>
            {t('chat.managementOnlyTitle')}
          </Text>
          <Text style={styles.description}>{t('chat.managementOnlyBody')}</Text>
        </View>
        <StatusBadge label={`${conversations.length}`} tone="info" />
      </View>

      <View style={styles.list}>
        {conversations.map((conversation) => {
          const conversationManagement = conversation.canManageConversation === true;
          return (
            <View key={conversation.id} style={styles.row}>
              <Avatar
                color={conversation.avatarColor}
                icon={conversation.kind === 'announcement' ? 'megaphone' : undefined}
                initials={conversation.initials}
                size={44}
              />
              <View style={styles.rowCopy}>
                <Text numberOfLines={1} style={styles.rowTitle}>{conversation.title}</Text>
                <Text numberOfLines={2} style={styles.rowDescription}>
                  {t(conversationManagement
                    ? 'chat.managementOnlyBody'
                    : 'chat.managementOnlyDynamicBody')}
                </Text>
              </View>
              <PrimaryButton
                icon="settings-outline"
                label={t(conversationManagement
                  ? 'chat.managementOnlyOpen'
                  : 'chat.managementOnlyOpenAdmin')}
                onPress={() => onOpen(conversation.id)}
                tone="light"
              />
            </View>
          );
        })}
      </View>
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  section: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineStrong,
    borderRadius: radii.lg,
    backgroundColor: colors.paper,
    padding: spacing.lg,
    gap: spacing.md,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headingIcon: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.mintSoft,
  },
  headingCopy: { flex: 1, minWidth: 0 },
  title: { color: colors.ink, fontFamily: type.display, fontSize: 18, fontWeight: '800' },
  description: { color: colors.inkSubtle, fontSize: 11, lineHeight: 16, marginTop: 3 },
  list: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    borderRadius: radii.md,
    backgroundColor: colors.paperMuted,
    padding: spacing.sm,
  },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  rowDescription: { color: colors.inkSubtle, fontSize: 10, lineHeight: 14, marginTop: 2 },
});
