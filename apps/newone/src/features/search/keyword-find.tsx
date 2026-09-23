import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionModal, FormField } from '@/components/ui/action-modal';
import { Avatar } from '@/components/ui/primitives';
import type { KeywordFindResult } from '@/data/repositories/contracts';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { radii, spacing } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

const TYPING_PAUSE_MS = 350;

/** The snippet with every place the keyword appears set in bold. */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [{ text, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  const haystack = text.toLocaleLowerCase();
  let from = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts;
}

/**
 * 찾기 (제시어): type a word or a project's name and see which chats it came
 * up in, newest first, with how often and where (owner's father, Sep 23
 * 2026). Tapping a chat opens it at the newest message that matched.
 */
export function KeywordFindModal({
  visible,
  onClose,
  onOpen,
}: {
  visible: boolean;
  onClose: () => void;
  onOpen: (conversationId: string, messageId: string | null) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const workspace = useWorkspace();
  const findKeyword = workspace.findKeyword;
  const [query, setQuery] = useState('');
  // The answer and the keyword it answers travel together, so typing on
  // shows the spinner until the answer for what is in the field arrives, and
  // a slower answer to an older keyword never replaces a newer one.
  const [answer, setAnswer] = useState<{ query: string; results: KeywordFindResult[] | null } | null>(null);
  const latest = useRef('');
  const wanted = query.replace(/\s+/g, ' ').trim();

  useEffect(() => {
    latest.current = wanted;
    if (!wanted) return undefined;
    const timer = setTimeout(() => {
      void findKeyword(wanted).then((found) => {
        if (latest.current === wanted) setAnswer({ query: wanted, results: found });
      });
    }, TYPING_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [findKeyword, wanted]);

  const current = answer && answer.query === wanted ? answer : null;
  const results = current?.results ?? null;
  const state: 'idle' | 'loading' | 'done' | 'failed' = !wanted
    ? 'idle'
    : !current
      ? 'loading'
      : current.results
        ? 'done'
        : 'failed';
  return (
    <ActionModal onClose={onClose} title={t('find.title')} visible={visible}>
      <FormField
        label={t('find.label')}
        onChangeText={setQuery}
        placeholder={t('find.placeholder')}
        testID="keyword-find-input"
        value={query}
      />
      {state === 'idle' ? (
        <Text style={styles.hint}>{t('find.hint')}</Text>
      ) : state === 'loading' ? (
        <ActivityIndicator accessibilityLabel={t('find.title')} color={colors.mintDark} style={styles.loading} />
      ) : state === 'failed' ? (
        <Text accessibilityLiveRegion="polite" style={styles.hint}>{t('find.failed')}</Text>
      ) : results && results.length === 0 ? (
        <Text accessibilityLiveRegion="polite" style={styles.hint}>{t('find.none').replace('{query}', wanted)}</Text>
      ) : (
        <View style={styles.results} testID="keyword-find-results">
          {(results ?? []).map((result) => {
            const conversation = workspace.conversations.find((item) => item.id === result.conversationId);
            const title = conversation?.title ?? '';
            const meta = [
              result.messageCount === 1
                ? t('find.messagesOne')
                : result.messageCount > 1
                  ? t('find.messagesMany').replace('{count}', String(result.messageCount))
                  : null,
              ...result.projects.map((project) => t('find.project').replace('{name}', project.name)),
            ].filter((part): part is string => Boolean(part));
            return (
              <Pressable
                accessibilityLabel={`${t('find.openChat').replace('{name}', title)}. ${meta.join(', ')}`}
                accessibilityRole="button"
                key={result.conversationId}
                onPress={() => onOpen(result.conversationId, result.latestMessageId)}
                style={({ pressed }) => [styles.result, pressed && styles.pressed]}>
                <Avatar
                  color={conversation?.avatarColor ?? colors.mintDark}
                  imageUri={workspace.conversationAvatarUrls[result.conversationId]}
                  initials={conversation?.initials ?? '?'}
                  size={38}
                />
                <View style={styles.resultCopy}>
                  <Text numberOfLines={1} style={styles.resultTitle}>{title}</Text>
                  {meta.length ? <Text numberOfLines={1} style={styles.resultMeta}>{meta.join(' · ')}</Text> : null}
                  {result.snippet ? (
                    <Text numberOfLines={2} style={styles.snippet}>
                      {highlightParts(result.snippet, wanted).map((part, index) => (
                        <Text key={index} style={part.match ? styles.snippetMatch : undefined}>{part.text}</Text>
                      ))}
                    </Text>
                  ) : null}
                  {result.items.slice(0, 3).map((item, index) => (
                    <View key={`${item.projectId}:${index}`} style={styles.itemLine}>
                      <Ionicons color={colors.plum} name="folder-outline" size={12} />
                      <Text numberOfLines={1} style={styles.itemText}>
                        {t('find.inProject').replace('{project}', item.projectName).replace('{title}', item.title)}
                      </Text>
                    </View>
                  ))}
                </View>
                <Ionicons color={colors.inkSubtle} name="chevron-forward" size={16} />
              </Pressable>
            );
          })}
        </View>
      )}
    </ActionModal>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  hint: { color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
  loading: { paddingVertical: spacing.md },
  results: { gap: spacing.xs },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.paperMuted,
  },
  resultCopy: { flex: 1, minWidth: 0, gap: 2 },
  resultTitle: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  resultMeta: { color: colors.mintDark, fontSize: 11, fontWeight: '800' },
  snippet: { color: colors.inkMuted, fontSize: 12, lineHeight: 17 },
  snippetMatch: { color: colors.ink, fontWeight: '900', backgroundColor: colors.mintSoft },
  itemLine: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  itemText: { flexShrink: 1, color: colors.plum, fontSize: 11, fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
