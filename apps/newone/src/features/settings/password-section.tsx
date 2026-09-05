import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ActionError, ActionModal } from '@/components/ui/action-modal';
import { PASSWORD_MIN_LENGTH, PasswordField } from '@/components/ui/password-field';
import { PrimaryButton } from '@/components/ui/primitives';
import { errorMessageKey } from '@/i18n/errors';
import { useI18n } from '@/i18n/provider';
import { useAuth } from '@/state/auth';
import { colors, radii, shadow, spacing } from '@/theme/tokens';

/**
 * One settings row: set a password when the account has none, change it
 * otherwise. Codes stay the recovery route, so there is no "forgot" path here.
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
  const actionLabel = t(hasPassword ? 'settings.passwordChangeAction' : 'settings.passwordSetAction');

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
    <View style={[styles.card, shadow]}>
      <View style={styles.row}>
        <View style={styles.icon}>
          <Ionicons name="key-outline" size={19} color={colors.mintDark} />
        </View>
        <View style={styles.copy}>
          <Text accessibilityRole="header" style={styles.title}>{t('settings.passwordTitle')}</Text>
          <Text style={styles.note}>
            {updated
              ? t('settings.passwordUpdated')
              : t(hasPassword ? 'settings.passwordSetNote' : 'settings.passwordNoneNote')}
          </Text>
        </View>
        <PrimaryButton label={actionLabel} onPress={open} tone="light" />
      </View>
      <ActionModal
        description={t('auth.passwordRule')}
        onClose={close}
        title={actionLabel}
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

const styles = StyleSheet.create({
  card: {
    overflow: 'hidden',
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paper,
  },
  row: {
    minHeight: 62,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
  },
  icon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.mintSoft,
  },
  copy: { flex: 1, minWidth: 150 },
  title: { color: colors.ink, fontSize: 14, fontWeight: '900' },
  note: { color: colors.inkSubtle, fontSize: 10, lineHeight: 15, marginTop: 3 },
});
