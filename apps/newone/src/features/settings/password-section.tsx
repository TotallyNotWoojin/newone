import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionError, ActionModal } from '@/components/ui/action-modal';
import { PASSWORD_MIN_LENGTH, PasswordField } from '@/components/ui/password-field';
import { PrimaryButton } from '@/components/ui/primitives';
import { errorMessageKey } from '@/i18n/errors';
import { useI18n } from '@/i18n/provider';
import { useAuth } from '@/state/auth';
import { colors, radii, spacing } from '@/theme/tokens';

/**
 * One settings row, styled like the list rows around it: set a password when
 * the account has none, change it otherwise. Codes stay the recovery route, so
 * there is no "forgot" path here.
 */
export function PasswordSection() {
  const auth = useAuth();
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState(false);
  const hasPassword = auth.hasPassword === true;
  const hint = updated
    ? t('settings.passwordUpdated')
    : t(hasPassword ? 'settings.passwordSetNote' : 'settings.passwordNoneNote');

  const open = () => {
    setPassword('');
    setError('');
    setVisible(true);
  };

  const close = () => {
    if (!busy) setVisible(false);
  };

  const save = async () => {
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(t('auth.passwordTooShort'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await auth.setPassword(password);
      setVisible(false);
      setUpdated(true);
    } catch (saveError) {
      setError(t(errorMessageKey(saveError)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.group}>
      <View style={styles.card}>
        <Pressable
          accessibilityHint={hint}
          accessibilityLabel={t('settings.passwordTitle')}
          accessibilityRole="button"
          onPress={open}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
          <Ionicons color={colors.inkMuted} name="key-outline" size={20} style={styles.icon} />
          <View style={styles.copy}>
            <Text numberOfLines={1} style={styles.label}>{t('settings.passwordTitle')}</Text>
            <Text numberOfLines={1} style={styles.hint}>{hint}</Text>
          </View>
          <Text numberOfLines={1} style={styles.value}>
            {t(hasPassword ? 'settings.passwordChangeAction' : 'settings.passwordSetAction')}
          </Text>
          <Ionicons color={colors.inkSubtle} name="chevron-forward" size={16} />
        </Pressable>
      </View>
      <ActionModal
        description={t('auth.passwordRule')}
        onClose={close}
        title={t('settings.passwordTitle')}
        visible={visible}>
        <PasswordField
          autoComplete="new-password"
          label={t('auth.newPasswordLabel')}
          onChangeText={setPassword}
          onSubmitEditing={save}
          returnKeyType="go"
          value={password}
        />
        <ActionError message={error} />
        <PrimaryButton icon="checkmark" label={t('auth.savePassword')} loading={busy} onPress={save} />
      </ActionModal>
    </View>
  );
}

// Mirrors the settings screen's group/row metrics so this reads as one list.
const styles = StyleSheet.create({
  group: { marginTop: spacing.md },
  card: {
    marginHorizontal: spacing.sm,
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: colors.paper,
  },
  row: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  icon: { width: 20, textAlign: 'center' },
  copy: { flex: 1, minWidth: 0 },
  label: { color: colors.ink, fontSize: 15 },
  hint: { color: colors.inkSubtle, fontSize: 12, marginTop: 1 },
  value: { color: colors.inkSubtle, fontSize: 14, maxWidth: '45%' },
  pressed: { opacity: 0.7 },
});
