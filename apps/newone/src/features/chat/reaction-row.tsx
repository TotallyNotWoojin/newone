import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { quickReactionEmojis, normalizeReactionEmoji } from '@/features/chat/message-reactions';
import { useI18n } from '@/i18n/provider';
import { radii, spacing } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

/**
 * The six reactions in one compact row, plus a "+" for anything else.
 *
 * The row scrolls sideways rather than wrapping, so the sheet keeps its height
 * whatever the phone's width. "+" opens a one-character field: no phone lets an
 * app raise the emoji keyboard on its own, so the field takes focus and the
 * person switches to emoji with the key their keyboard already has. Whatever
 * they type is checked before it is sent.
 */
export function ReactionRow({
  onReact,
  disabled = false,
}: {
  onReact: (emoji: string) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [rejected, setRejected] = useState(false);

  const submitCustom = (value: string) => {
    const emoji = normalizeReactionEmoji(value);
    if (!emoji) {
      setRejected(true);
      return;
    }
    setRejected(false);
    setDraft('');
    setPickerOpen(false);
    onReact(emoji);
  };

  return (
    <View>
      <ScrollView
        contentContainerStyle={styles.rowContent}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
        style={styles.row}
        testID="reaction-row">
        {quickReactionEmojis.map((emoji) => (
          <Pressable
            accessibilityLabel={`${t('chat.react')} ${emoji}`}
            accessibilityRole="button"
            disabled={disabled}
            key={emoji}
            onPress={() => onReact(emoji)}
            style={({ pressed }) => [styles.emojiButton, pressed && styles.pressed]}>
            <Text style={styles.emojiText}>{emoji}</Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityLabel={t('chat.reactMore')}
          accessibilityRole="button"
          accessibilityState={{ expanded: pickerOpen }}
          disabled={disabled}
          onPress={() => {
            setRejected(false);
            setPickerOpen((open) => !open);
          }}
          style={({ pressed }) => [styles.emojiButton, styles.moreButton, pressed && styles.pressed]}>
          <Text style={styles.moreText}>+</Text>
        </Pressable>
      </ScrollView>
      {pickerOpen ? (
        <View style={styles.picker}>
          <TextInput
            accessibilityLabel={t('chat.reactAnyEmoji')}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onChangeText={(value) => {
              setRejected(false);
              setDraft(value);
            }}
            onSubmitEditing={() => submitCustom(draft)}
            placeholder={t('chat.reactAnyEmoji')}
            placeholderTextColor={colors.inkSubtle}
            returnKeyType="send"
            style={styles.pickerInput}
            value={draft}
          />
          <Pressable
            accessibilityLabel={t('chat.reactSendEmoji')}
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => submitCustom(draft)}
            style={({ pressed }) => [styles.pickerSend, pressed && styles.pressed]}>
            <Text style={styles.pickerSendText}>{t('chat.reactSendEmoji')}</Text>
          </Pressable>
        </View>
      ) : null}
      {rejected ? <Text style={styles.rejected}>{t('chat.reactOneEmojiOnly')}</Text> : null}
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  row: { marginTop: 2 },
  rowContent: { alignItems: 'center', gap: spacing.xs, paddingRight: spacing.sm },
  emojiButton: {
    alignItems: 'center',
    backgroundColor: colors.paperMuted,
    borderColor: colors.line,
    borderRadius: radii.md,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  moreButton: { backgroundColor: colors.mintSoft, borderColor: colors.mint },
  moreText: { color: colors.forest, fontSize: 22, fontWeight: '600' },
  emojiText: { fontSize: 22 },
  pressed: { opacity: 0.7 },
  picker: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs, marginTop: spacing.xs },
  pickerInput: {
    backgroundColor: colors.paperMuted,
    borderRadius: radii.md,
    color: colors.ink,
    flex: 1,
    fontSize: 15,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  pickerSend: {
    backgroundColor: colors.mint,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  pickerSendText: { color: colors.forest, fontSize: 12, fontWeight: '700' },
  rejected: { color: colors.red, fontSize: 12, marginTop: spacing.xs },
});
