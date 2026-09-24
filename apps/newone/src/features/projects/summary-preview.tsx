import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionError, ActionModal } from '@/components/ui/action-modal';
import type { ProjectItem, SummaryView } from '@/data/repositories/contracts';
import { projectItemLabel } from '@/features/projects/project-names';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { spacing } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

/**
 * A summary saved in a project, to read where it is: it could only be taken
 * out as a PDF or Word file before (owner, Sep 24 2026: "I shouldn't have to
 * download to view the summaries"). The files are still one tap away.
 */
export function SummaryPreview({
  conversationId,
  item,
  onClose,
  onDownload,
}: {
  conversationId: string;
  item: ProjectItem;
  onClose: () => void;
  onDownload: (item: ProjectItem, format: 'pdf' | 'docx') => Promise<void>;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const workspace = useWorkspace();
  const viewSummary = workspace.viewSummary;
  const summaryId = item.summary?.summaryId ?? null;
  const [view, setView] = useState<SummaryView | null>(null);
  const [failed, setFailed] = useState(false);
  const [exporting, setExporting] = useState<'pdf' | 'docx' | null>(null);

  useEffect(() => {
    if (!summaryId) return undefined;
    let cancelled = false;
    void viewSummary(conversationId, summaryId).then((result) => {
      if (cancelled) return;
      if (result) setView(result);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId, summaryId, viewSummary]);

  const exportAs = async (format: 'pdf' | 'docx') => {
    setExporting(format);
    try {
      await onDownload(item, format);
    } finally {
      setExporting(null);
    }
  };

  const label = projectItemLabel(item);
  // The date is the part that must never be broken up (owner's father, Sep
  // 23 2026); a long name wrapped the title inside it, "(2026-" over
  // "09-24)". Non-breaking hyphens keep it whole.
  const title = label.replace(/\((\d{4})-(\d{2})-(\d{2})\)$/, (_match, year: string, month: string, day: string) =>
    `(${year}\u2011${month}\u2011${day})`);
  return (
    <ActionModal
      footer={(
        <View style={styles.formats}>
          {(['pdf', 'docx'] as const).map((format) => {
            const name = format === 'pdf' ? 'PDF' : 'Word';
            return (
              <Pressable
                accessibilityLabel={`${name}: ${label}`}
                accessibilityRole="button"
                disabled={exporting !== null}
                key={format}
                onPress={() => void exportAs(format)}
                style={({ pressed }) => [styles.format, pressed && styles.pressed]}>
                {exporting === format
                  ? <ActivityIndicator accessibilityLabel={name} color={colors.ink} size="small" />
                  : (
                    <>
                      <Ionicons color={colors.ink} name="download-outline" size={15} />
                      <Text style={styles.formatText}>{name}</Text>
                    </>
                  )}
              </Pressable>
            );
          })}
        </View>
      )}
      onClose={onClose}
      title={title}
      visible>
      <View style={styles.body} testID="summary-preview">
        {view ? (
          <>
            {view.covers || view.participants.length ? (
              <View style={styles.facts}>
                {view.covers ? (
                  <View style={styles.fact}>
                    <Ionicons color={colors.inkSubtle} name="calendar-outline" size={14} />
                    <Text selectable style={styles.factText}>{view.covers}</Text>
                  </View>
                ) : null}
                {view.participants.length ? (
                  <View style={styles.fact}>
                    <Ionicons color={colors.inkSubtle} name="people-outline" size={14} />
                    <Text selectable style={styles.factText}>{view.participants.join(', ')}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {view.lines.map((line, index) => (
              <Text
                key={`${index}:${line.slice(0, 24)}`}
                selectable
                style={styles.line}
                testID="summary-preview-line">
                {line}
              </Text>
            ))}
          </>
        ) : failed ? (
          <>
            <Text style={styles.unavailable}>{t('projects.summaryUnavailable')}</Text>
            <ActionError message={workspace.actionError} />
          </>
        ) : (
          <View style={styles.loading}>
            <ActivityIndicator accessibilityLabel={t('projects.summaryOpening')} color={colors.plum} />
            <Text style={styles.factText}>{t('projects.summaryOpening')}</Text>
          </View>
        )}
      </View>
    </ActionModal>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  body: { gap: spacing.sm, paddingBottom: spacing.sm },
  facts: { gap: 4, paddingBottom: spacing.xs },
  fact: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  factText: { color: colors.inkMuted, fontSize: 13, lineHeight: 18, flexShrink: 1 },
  line: { color: colors.ink, fontSize: 15, lineHeight: 22 },
  unavailable: { color: colors.inkMuted, fontSize: 14, lineHeight: 20 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  formats: { flexDirection: 'row', gap: spacing.sm },
  format: {
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 10,
    backgroundColor: colors.paper,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineStrong,
  },
  formatText: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  pressed: { opacity: 0.6 },
});
