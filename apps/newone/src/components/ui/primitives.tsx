import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';

import type { Presence } from '@/domain/types';
import { colors, radii, spacing, type } from '@/theme/tokens';
import { useI18n } from '@/i18n/provider';

type IconName = ComponentProps<typeof Ionicons>['name'];

export function Avatar({
  initials,
  color,
  size = 44,
  presence,
  icon,
  imageUri,
}: {
  initials: string;
  color: string;
  size?: number;
  presence?: Presence;
  icon?: IconName;
  imageUri?: string;
}) {
  const dotSize = Math.max(10, Math.round(size * 0.25));
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          styles.avatar,
          {
            width: size,
            height: size,
            borderRadius: Math.round(size * 0.34),
            backgroundColor: color,
          },
        ]}>
        {imageUri ? (
          <Image
            resizeMode="cover"
            source={{ uri: imageUri }}
            style={{ width: size, height: size, borderRadius: Math.round(size * 0.34) }}
          />
        ) : icon ? (
          <Ionicons name={icon} color={colors.white} size={Math.round(size * 0.46)} />
        ) : (
          <Text style={[styles.avatarText, { fontSize: Math.max(12, Math.round(size * 0.34)) }]}>
            {initials}
          </Text>
        )}
      </View>
      {presence && presence !== 'offline' ? (
        <View
          style={[
            styles.presenceDot,
            {
              width: dotSize,
              height: dotSize,
              borderRadius: dotSize / 2,
              backgroundColor: presence === 'online' ? colors.mint : '#E8A648',
            },
          ]}
        />
      ) : null}
    </View>
  );
}

export function IconButton({
  name,
  label,
  onPress,
  size = 40,
  tone = 'neutral',
  disabled,
}: {
  name: IconName;
  label: string;
  onPress?: () => void;
  size?: number;
  tone?: 'neutral' | 'inverse' | 'accent' | 'danger';
  disabled?: boolean;
}) {
  const palette = {
    neutral: { background: colors.paperMuted, foreground: colors.ink },
    inverse: { background: 'rgba(255,255,255,0.1)', foreground: colors.white },
    accent: { background: colors.mint, foreground: colors.forest },
    danger: { background: colors.redSoft, foreground: colors.red },
  }[tone];
  const isDisabled = disabled || !onPress;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={isDisabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.34),
          backgroundColor: palette.background,
          opacity: isDisabled ? 0.45 : pressed ? 0.72 : 1,
        },
      ]}>
      <Ionicons name={name} color={palette.foreground} size={Math.round(size * 0.5)} />
    </Pressable>
  );
}

export function SearchField({
  value,
  onChangeText,
  placeholder,
  compact = false,
  clearLabel,
  onSubmitEditing,
  testID,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  compact?: boolean;
  clearLabel?: string;
  onSubmitEditing?: () => void;
  /** Stable identifier for UI drivers. */
  testID?: string;
}) {
  const { t } = useI18n();
  return (
    <View style={[styles.search, compact && styles.searchCompact]}>
      <Ionicons name="search-outline" size={18} color={colors.inkSubtle} />
      <TextInput
        accessibilityLabel={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmitEditing}
        placeholder={placeholder}
        placeholderTextColor={colors.inkSubtle}
        style={styles.searchInput}
        testID={testID}
        value={value}
      />
      {value ? (
        <Pressable accessibilityLabel={clearLabel ?? t('common.clearSearch')} hitSlop={8} onPress={() => onChangeText('')}>
          <Ionicons name="close-circle" size={18} color={colors.inkSubtle} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function Chip({
  label,
  accessibilityLabel,
  selected = false,
  onPress,
  count,
  icon,
}: {
  label: string;
  accessibilityLabel?: string;
  selected?: boolean;
  onPress?: () => void;
  count?: number;
  icon?: IconName;
}) {
  return (
    <Pressable
      // The count badge is part of the chip's meaning ("Unread 1"), so it is read
      // with the label instead of being flattened away.
      accessibilityLabel={accessibilityLabel ?? (typeof count === 'number' && count > 0 ? `${label} ${count}` : label)}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && styles.pressed,
      ]}>
      {icon ? (
        <Ionicons
          accessible={false}
          name={icon}
          size={14}
          color={selected ? colors.white : colors.inkMuted}
        />
      ) : null}
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
      {typeof count === 'number' && count > 0 ? (
        <View style={[styles.chipCount, selected && styles.chipCountSelected]}>
          <Text style={[styles.chipCountText, selected && styles.chipCountTextSelected]}>
            {count}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function StatusBadge({
  label,
  tone = 'neutral',
  icon,
}: {
  label: string;
  tone?: 'neutral' | 'success' | 'info' | 'warning' | 'danger' | 'purple';
  icon?: IconName;
}) {
  const palette = {
    neutral: { background: colors.paperMuted, foreground: colors.inkMuted },
    success: { background: colors.mintSoft, foreground: colors.mintDark },
    info: { background: colors.blueSoft, foreground: colors.blue },
    warning: { background: colors.amberSoft, foreground: colors.amber },
    danger: { background: colors.redSoft, foreground: colors.red },
    purple: { background: colors.plumSoft, foreground: colors.plum },
  }[tone];

  return (
    <View style={[styles.badge, { backgroundColor: palette.background }]}>
      {icon ? <Ionicons name={icon} size={13} color={palette.foreground} /> : null}
      <Text style={[styles.badgeText, { color: palette.foreground }]}>{label}</Text>
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  icon,
  disabled,
  loading,
  tone = 'accent',
  style,
}: {
  label: string;
  onPress?: () => void;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  tone?: 'accent' | 'dark' | 'light' | 'danger';
  style?: StyleProp<ViewStyle>;
}) {
  const palette = {
    accent: { background: colors.mint, foreground: colors.forest },
    dark: { background: colors.forest, foreground: colors.white },
    light: { background: colors.paperMuted, foreground: colors.ink },
    danger: { background: colors.red, foreground: colors.white },
  }[tone];
  const isDisabled = disabled || loading || !onPress;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        { backgroundColor: palette.background },
        style,
        isDisabled && styles.disabled,
        pressed && styles.pressed,
      ]}>
      {loading ? (
        <ActivityIndicator color={palette.foreground} />
      ) : icon ? (
        <Ionicons accessible={false} name={icon} size={17} color={palette.foreground} />
      ) : null}
      <Text style={[styles.primaryButtonText, { color: palette.foreground }]}>{label}</Text>
    </Pressable>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={24} color={colors.mintDark} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
      {action}
    </View>
  );
}

export function SectionEyebrow({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.eyebrow, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: colors.white,
    fontFamily: type.body,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  presenceDot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    borderColor: colors.paper,
    borderWidth: 2.5,
  },
  iconButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  search: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.paperMuted,
    borderWidth: 1,
    borderColor: colors.line,
  },
  searchCompact: {
    minHeight: 44,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 15,
    fontFamily: type.body,
  },
  chip: {
    minHeight: 44,
    paddingHorizontal: 13,
    borderRadius: radii.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.paperMuted,
    borderWidth: 1,
    borderColor: colors.line,
  },
  chipSelected: {
    backgroundColor: colors.forest,
    borderColor: colors.forest,
  },
  chipText: {
    color: colors.inkMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  chipTextSelected: {
    color: colors.white,
  },
  chipCount: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.line,
    borderRadius: radii.pill,
  },
  chipCountSelected: {
    backgroundColor: 'rgba(255,255,255,0.17)',
  },
  chipCountText: {
    color: colors.inkMuted,
    fontSize: 10,
    fontWeight: '800',
  },
  chipCountTextSelected: {
    color: colors.white,
  },
  badge: {
    alignSelf: 'flex-start',
    minHeight: 24,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  badgeText: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '800',
    letterSpacing: 0.1,
  },
  primaryButton: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  primaryButtonText: {
    fontSize: 14,
    fontWeight: '800',
  },
  disabled: {
    opacity: 0.48,
  },
  pressed: {
    opacity: 0.72,
  },
  emptyState: {
    flex: 1,
    minHeight: 280,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.xl,
  },
  emptyIcon: {
    width: 52,
    height: 52,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.mintSoft,
    marginBottom: spacing.xs,
  },
  emptyTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
  },
  emptyBody: {
    maxWidth: 360,
    color: colors.inkMuted,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  eyebrow: {
    color: colors.inkSubtle,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
});
