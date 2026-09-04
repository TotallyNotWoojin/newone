import { Ionicons } from '@expo/vector-icons';
import type { PropsWithChildren } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, shadow, spacing, type } from '@/theme/tokens';
import { useI18n } from '@/i18n/provider';

export function ActionModal({
  visible,
  title,
  description,
  onClose,
  children,
}: PropsWithChildren<{
  visible: boolean;
  title: string;
  description?: string;
  onClose: () => void;
}>) {
  const { t } = useI18n();
  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      transparent
      visible={visible}>
      <SafeAreaView style={styles.overlay}>
        <Pressable accessibilityLabel={t('common.closeDialog')} accessibilityRole="button" onPress={onClose} style={StyleSheet.absoluteFill} />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.keyboard}>
          <View accessibilityViewIsModal style={[styles.card, shadow]}>
            <View style={styles.header}>
              <View style={styles.headerCopy}>
                <Text accessibilityRole="header" style={styles.title}>{title}</Text>
                {description ? <Text style={styles.description}>{description}</Text> : null}
              </View>
              <Pressable
                accessibilityLabel={t('common.closeDialog')}
                accessibilityRole="button"
                hitSlop={8}
                onPress={onClose}
                style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
                <Ionicons name="close" color={colors.ink} size={22} />
              </Pressable>
            </View>
            <ScrollView
              contentContainerStyle={styles.content}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}>
              {children}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

export function FormField({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  keyboardType?: 'default' | 'email-address' | 'number-pad';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        keyboardType={keyboardType}
        multiline={multiline}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.inkSubtle}
        style={[styles.input, multiline && styles.multiline]}
        value={value}
      />
    </View>
  );
}

export function ActionError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <View accessibilityLiveRegion="assertive" style={styles.error}>
      <Ionicons name="alert-circle" color={colors.red} size={16} />
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.md,
    backgroundColor: 'rgba(5, 22, 18, 0.62)',
  },
  keyboard: {
    width: '100%',
    maxHeight: '94%',
    alignSelf: 'center',
    maxWidth: 620,
  },
  card: {
    maxHeight: '100%',
    overflow: 'hidden',
    borderRadius: radii.xl,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
  },
  header: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  title: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 20,
    fontWeight: '900',
  },
  description: {
    color: colors.inkMuted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  close: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.paperMuted,
  },
  // Extra bottom room so the last action can scroll fully inside the clipped card.
  content: { gap: spacing.md, padding: spacing.lg, paddingBottom: spacing.xxl },
  field: { gap: 6 },
  fieldLabel: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  input: {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.md,
    backgroundColor: colors.paperMuted,
    color: colors.ink,
    fontFamily: type.body,
    fontSize: 15,
  },
  multiline: { minHeight: 112, textAlignVertical: 'top' },
  error: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.redSoft,
  },
  errorText: { flex: 1, color: colors.red, fontSize: 12, lineHeight: 17, fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
