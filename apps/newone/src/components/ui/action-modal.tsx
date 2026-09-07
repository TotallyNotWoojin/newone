import { Ionicons } from '@expo/vector-icons';
import { type PropsWithChildren, useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
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

import { radii, shadow, spacing, type } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';
import { useI18n } from '@/i18n/provider';

/** A sheet settles in one quick beat; closing is immediate. The system
 * cross-dissolve (about 350 ms plus presentation lag) made every sheet feel
 * slow to open. */
export const SHEET_OPEN_MS = 140;

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
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible) {
      progress.setValue(0);
      return undefined;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: SHEET_OPEN_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, visible]);
  const cardMotion = {
    opacity: progress,
    transform: [
      { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
      { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1] }) },
    ],
  };
  return (
    <Modal
      animationType="none"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      transparent
      visible={visible}>
      <Animated.View pointerEvents="none" style={[styles.dim, { opacity: progress }]} />
      <SafeAreaView style={styles.overlay}>
        <Pressable accessibilityLabel={t('common.closeDialog')} accessibilityRole="button" onPress={onClose} style={StyleSheet.absoluteFill} />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.keyboard}>
          <Animated.View accessibilityViewIsModal style={[styles.card, shadow, cardMotion]}>
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
          </Animated.View>
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
  testID,
  multiline = false,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  /** Stable identifier for UI drivers. */
  testID?: string;
  multiline?: boolean;
  keyboardType?: 'default' | 'email-address' | 'number-pad';
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        keyboardType={keyboardType}
        multiline={multiline}
        onChangeText={onChangeText}
        placeholder={placeholder}
        testID={testID}
        placeholderTextColor={colors.inkSubtle}
        style={[styles.input, multiline && styles.multiline]}
        value={value}
      />
    </View>
  );
}

export function ActionError({ message }: { message?: string | null }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  if (!message) return null;
  return (
    <View accessibilityLiveRegion="assertive" style={styles.error}>
      <Ionicons name="alert-circle" color={colors.red} size={16} />
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  dim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(5, 22, 18, 0.62)',
  },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.md,
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
