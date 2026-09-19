import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/ui/primitives';
// Metro selects the native notification bridge or the web no-op.
// eslint-disable-next-line import/no-unresolved
import { getNotificationPermissionState, openNotificationSettings, type NotificationPermissionState } from '@/device/push-registration';
import { useI18n } from '@/i18n/provider';
import { useDevicePreferences } from '@/state/device-preferences';
import { useWorkspace } from '@/state/workspace';
import { radii, spacing } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

/**
 * How long an answer to the card holds before the question is worth asking
 * again. A week: long enough that "Not now" is respected, short enough that a
 * person who never noticed the card (owner's father, Sep 19 2026) is asked
 * again before they conclude the app is silent.
 */
export const REPROMPT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** True when the card was last answered long enough ago to ask again, or never. */
export function promptDue(promptedAt: string | null, now = Date.now()): boolean {
  if (promptedAt === null) return true;
  const answered = Date.parse(promptedAt);
  return !Number.isFinite(answered) || now - answered >= REPROMPT_AFTER_MS;
}

/**
 * A friendly ask for notification permission on the first signed-in launch,
 * and again once a week while notifications stay off. The OS prompt only
 * appears after "Turn on"; both answers record when the question was asked. A
 * device that already granted permission is registered silently by the
 * workspace and never sees the card.
 */
export function NotificationPrompt() {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { preferences, ready, setPreference } = useDevicePreferences();
  const workspace = useWorkspace();
  const { t } = useI18n();
  const enableNotifications = workspace.enableNotifications;
  const eligible = ready
    && promptDue(preferences.notificationsPromptedAt)
    && Platform.OS !== 'web'
    && Boolean(workspace.organizationId);
  const [permission, setPermission] = useState<NotificationPermissionState | null>(null);
  const [busy, setBusy] = useState(false);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (!eligible || checkedRef.current) return;
    checkedRef.current = true;
    let active = true;
    void getNotificationPermissionState()
      .then((state) => {
        if (!active) return;
        if (state === 'granted' || state === 'unavailable') {
          // Nothing to ask: registration already runs silently, or this
          // platform cannot receive pushes at all.
          setPreference('notificationsPromptedAt', new Date().toISOString());
          return;
        }
        setPermission(state);
      })
      .catch(() => {
        if (active) setPermission('undetermined');
      });
    return () => {
      active = false;
    };
  }, [eligible, setPreference]);

  if (!eligible || permission === null) return null;

  const finish = () => setPreference('notificationsPromptedAt', new Date().toISOString());

  const turnOn = async () => {
    setBusy(true);
    try {
      if (permission === 'denied') {
        await openNotificationSettings();
      } else {
        await enableNotifications();
      }
    } catch {
      // The workspace reports registration failures in its own banner; the
      // question itself has been answered either way.
    } finally {
      setBusy(false);
      finish();
    }
  };

  return (
    <View accessible={false} style={styles.card}>
      <Ionicons color={colors.mintDark} name="notifications-outline" size={22} />
      <View style={styles.copy}>
        <Text style={styles.title}>{t('settings.notificationsPromptTitle')}</Text>
        <Text style={styles.body}>{t('settings.notificationsPromptBody')}</Text>
        <View style={styles.actions}>
          <Pressable
            accessibilityLabel={t('settings.notificationsPromptDismiss')}
            accessibilityRole="button"
            disabled={busy}
            hitSlop={8}
            onPress={finish}
            style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}>
            <Text style={styles.dismissText}>{t('settings.notificationsPromptDismiss')}</Text>
          </Pressable>
          <PrimaryButton
            label={t('settings.notificationsPromptAccept')}
            loading={busy}
            onPress={() => void turnOn()}
          />
        </View>
      </View>
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginHorizontal: spacing.sm,
    marginTop: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.paper,
  },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  title: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  body: { color: colors.inkMuted, fontSize: 12, lineHeight: 16 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  dismiss: { minHeight: 36, justifyContent: 'center', paddingHorizontal: spacing.xs },
  dismissText: { color: colors.inkMuted, fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
