import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ReturnKeyTypeOptions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useI18n } from '@/i18n/provider';
import { colors, radii, spacing } from '@/theme/tokens';

// The only password rule (owner decision, Sep 2026). The gateway enforces the
// same bounds; GoTrue's minimum_password_length must be set to match.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Labelled password input with a show/hide toggle; the label doubles as the accessibility name. */
export function PasswordField({
  label,
  value,
  onChangeText,
  onSubmitEditing,
  autoComplete = 'current-password',
  placeholder,
  testID,
  returnKeyType = 'done',
  style,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  onSubmitEditing?: () => void;
  autoComplete?: 'current-password' | 'new-password';
  placeholder?: string;
  /** Stable identifier for UI drivers (the label text also names the field's caption). */
  testID?: string;
  returnKeyType?: ReturnKeyTypeOptions;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.inputWrap}>
        <Ionicons name="lock-closed-outline" size={18} color={colors.inkSubtle} />
        <TextInput
          accessibilityLabel={label}
          autoCapitalize="none"
          autoComplete={autoComplete === 'new-password' ? 'off' : autoComplete}
          importantForAutofill={autoComplete === 'new-password' ? 'no' : 'auto'}
          autoCorrect={false}
          maxLength={PASSWORD_MAX_LENGTH}
          onChangeText={onChangeText}
          onSubmitEditing={onSubmitEditing}
          placeholder={placeholder}
          placeholderTextColor={colors.inkSubtle}
          returnKeyType={returnKeyType}
          secureTextEntry={!visible}
          style={styles.input}
          testID={testID}
          // iOS presents a blocking "Use Strong Password?" sheet the moment a
          // field it takes for a new-password field is focused; it swallowed the
          // typed characters for the first users. Fields that create a password
          // opt out of AutoFill heuristics entirely (oneTimeCode is the accepted
          // way to say "no password suggestions here"); the sign-in field keeps
          // AutoFill so saved passwords still fill.
          textContentType={autoComplete === 'new-password' ? 'oneTimeCode' : 'password'}
          value={value}
        />
        <Pressable
          accessibilityLabel={t(visible ? 'auth.hidePassword' : 'auth.showPassword')}
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => setVisible((current) => !current)}
          style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}>
          <Ionicons name={visible ? 'eye-off-outline' : 'eye-outline'} size={18} color={colors.inkSubtle} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { color: colors.ink, fontSize: 11, fontWeight: '900' },
  inputWrap: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.paperMuted,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  input: {
    flex: 1,
    minWidth: 0,
    color: colors.ink,
    fontSize: 14,
    paddingVertical: spacing.sm,
  },
  toggle: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
  },
  pressed: { opacity: 0.72 },
});
