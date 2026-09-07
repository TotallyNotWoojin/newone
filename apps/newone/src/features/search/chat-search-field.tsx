import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { SearchChip, SearchSuggestion } from '@/features/search/chat-search';
import { useI18n } from '@/i18n/provider';
import { radii, spacing } from '@/theme/tokens';
import { useKeyboardAppearance, useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

/**
 * One field for the whole of Chats. Finished names sit in it as chips, the
 * tail is still editable, and the suggestions under it are ordered the way the
 * phone orders them: people, then chats and groups, then messages.
 *
 * A chip's remove affordance is always drawn, never only on hover, because on
 * a phone there is no hover to reveal it.
 */
export function ChatSearchField({
  value,
  onChangeText,
  chips,
  onRemoveChip,
  suggestions,
  onSelectSuggestion,
  loading = false,
  trailing,
}: {
  value: string;
  onChangeText: (value: string) => void;
  chips: SearchChip[];
  onRemoveChip: (index: number) => void;
  suggestions: SearchSuggestion[];
  onSelectSuggestion: (suggestion: SearchSuggestion) => void;
  loading?: boolean;
  trailing?: React.ReactNode;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const keyboardAppearance = useKeyboardAppearance();
  const { t } = useI18n();
  // The visible text is only the unfinished tail; the finished parts are chips.
  const draft = value.includes(',') ? value.slice(value.lastIndexOf(',') + 1).trimStart() : value;
  const searched = chips.length > 0 || draft.trim().length > 0;
  const sections: { key: SearchSuggestion['kind']; label: string }[] = [
    { key: 'person', label: t('search.sectionPeople') },
    { key: 'conversation', label: t('search.sectionChats') },
    { key: 'message', label: t('search.sectionMessages') },
  ];

  const onDraftChange = (next: string) => {
    if (!value.includes(',')) {
      onChangeText(next);
      return;
    }
    onChangeText(`${value.slice(0, value.lastIndexOf(',') + 1)} ${next.trimStart()}`);
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.field}>
        <Ionicons color={colors.inkSubtle} name="search-outline" size={18} />
        <View style={styles.entry}>
          {chips.map((chip) => (
            <Pressable
              accessibilityLabel={t('search.chipRemove').replace('{name}', chip.label)}
              accessibilityRole="button"
              key={`${chip.index}-${chip.label}`}
              onPress={() => onRemoveChip(chip.index)}
              style={({ pressed }) => [styles.chip, pressed && styles.pressed]}>
              <Text numberOfLines={1} style={styles.chipLabel}>{chip.label}</Text>
              <Ionicons color={colors.mintDark} name="close" size={13} />
            </Pressable>
          ))}
          <TextInput
            keyboardAppearance={keyboardAppearance}
            accessibilityLabel={t('search.fieldPlaceholder')}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={onDraftChange}
            placeholder={chips.length ? '' : t('search.fieldPlaceholder')}
            placeholderTextColor={colors.inkSubtle}
            style={styles.input}
            testID="chat-search-field"
            value={draft}
          />
        </View>
        {loading ? <ActivityIndicator color={colors.mintDark} size="small" /> : null}
        {searched ? (
          <Pressable
            accessibilityLabel={t('common.clearSearch')}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => onChangeText('')}>
            <Ionicons color={colors.inkSubtle} name="close-circle" size={18} />
          </Pressable>
        ) : null}
        {trailing}
      </View>

      {searched ? (
        <View accessibilityRole="list" style={styles.suggestions}>
          {sections.map((section) => {
            const items = suggestions.filter((item) => item.kind === section.key);
            if (!items.length) return null;
            return (
              <View key={section.key} style={styles.section}>
                <Text style={styles.sectionLabel}>{section.label}</Text>
                {items.map((item) => (
                  <Pressable
                    accessibilityLabel={item.subtitle ? `${item.title} · ${item.subtitle}` : item.title}
                    accessibilityRole="button"
                    key={item.key}
                    onPress={() => onSelectSuggestion(item)}
                    style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}>
                    <View style={styles.suggestionIcon}>
                      <Ionicons
                        color={colors.mintDark}
                        name={item.kind === 'person'
                          ? 'person-outline'
                          : item.kind === 'message'
                            ? 'chatbubble-outline'
                            : item.group ? 'people-outline' : 'chatbubbles-outline'}
                        size={16}
                      />
                    </View>
                    <View style={styles.suggestionCopy}>
                      <Text numberOfLines={1} style={styles.suggestionTitle}>{item.title}</Text>
                      {item.subtitle ? (
                        <Text numberOfLines={1} style={styles.suggestionSubtitle}>{item.subtitle}</Text>
                      ) : null}
                    </View>
                  </Pressable>
                ))}
              </View>
            );
          })}
          {!suggestions.length && !loading ? (
            <Text style={styles.empty}>{t('search.nothingFound')}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  wrap: { gap: spacing.xs },
  field: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radii.pill,
    backgroundColor: colors.paperMuted,
    borderWidth: 1,
    borderColor: colors.line,
  },
  entry: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    maxWidth: 168,
    paddingLeft: spacing.xs,
    paddingRight: 5,
    paddingVertical: 3,
    borderRadius: radii.pill,
    backgroundColor: colors.mintSoft,
  },
  chipLabel: { color: colors.mintDark, fontSize: 12, fontWeight: '800', flexShrink: 1 },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 90,
    minHeight: 28,
    color: colors.ink,
    fontSize: 15,
  },
  suggestions: {
    gap: spacing.xs,
    paddingBottom: spacing.xs,
  },
  section: { gap: 2 },
  sectionLabel: {
    color: colors.mintDark,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.9,
    paddingHorizontal: spacing.xs,
  },
  suggestion: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 5,
    borderRadius: radii.md,
  },
  suggestionIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.mintSoft,
  },
  suggestionCopy: { flex: 1, minWidth: 0 },
  suggestionTitle: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  suggestionSubtitle: { color: colors.inkSubtle, fontSize: 12, marginTop: 1 },
  empty: { color: colors.inkMuted, fontSize: 12, paddingHorizontal: spacing.xs, paddingVertical: spacing.xs },
  pressed: { opacity: 0.7 },
});
