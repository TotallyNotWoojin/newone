import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
import { Chip, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import {
  SUMMARY_SCOPE_KINDS,
  latestSummary,
  summaryCoverageDates,
  summaryCoversLabel,
  summaryExportText,
  summaryFileName,
  summaryIsReady,
  summaryScopeLine,
} from '@/data/summary-text';
import type { Conversation, OperationalAction, SummaryScopeKind } from '@/domain/types';
// Metro selects the platform adapter (share sheet natively, a download on web).
// eslint-disable-next-line import/no-unresolved
import { saveSummaryFile } from '@/features/chat/summary-export';
import type { MessageKey } from '@/i18n/catalog';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { radii, spacing } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

const RANGE_KEYS: Record<SummaryScopeKind, MessageKey> = {
  unread: 'chat.summaryRangeUnread',
  today: 'chat.summaryRangeToday',
  yesterday: 'chat.summaryRangeYesterday',
  last_7_days: 'chat.summaryRangeWeek',
  last_30_days: 'chat.summaryRangeMonth',
  last_90_days: 'chat.summaryRangeQuarter',
  everything: 'chat.summaryRangeEverything',
};

// A range the server refused or the model could not handle is a "pick a
// shorter range" case; anything else was the service, so "try again".
const SHORTER_RANGE_FAILURE = /too_long|refused|needs_review/;

/**
 * The conversation summary, reachable from the header anywhere in the thread:
 * the reader picks a range (Today ... Everything, Everything by default) and
 * can say what the recap should cover; their own latest recap shows with a
 * header (the AI's title, the date and hours covered, who took part), short
 * numbered lines that open with a name, and Copy, PDF and Word -- the file
 * comes rendered from the service and downloads (browser) or goes to the
 * share sheet (phone). No decisions or to-do sections: the owner's father
 * asked for the lines alone (Sep 14 2026).
 * Only the reader's own requests show here (owner, Sep 14 2026). Workplace
 * organizations additionally keep their review, correction, schedule, and
 * operational-action controls here.
 */
export function SummarySheet({
  conversation,
  visible,
  onClose,
  onReportError,
}: {
  conversation: Conversation;
  visible: boolean;
  onClose: () => void;
  onReportError?: (summaryId: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const workspace = useWorkspace();
  const router = useRouter();
  const { locale, t } = useI18n();
  const currentUserId = workspace.currentUser?.id ?? null;
  const summary = latestSummary(workspace.summaries, conversation.id, currentUserId);
  const readySummary = summaryIsReady(summary) ? summary : null;
  const ranges = SUMMARY_SCOPE_KINDS;
  const [range, setRange] = useState<SummaryScopeKind>('everything');
  const [subject, setSubject] = useState('');
  const requesting = workspace.actionBusy === `summary-request:${conversation.id}`;
  const generating = summary?.status === 'queued' || summary?.status === 'generating';
  const scopeCopy = {
    ranges: {
      unread: t('chat.summaryRangeUnread'),
      today: t('chat.summaryRangeToday'),
      yesterday: t('chat.summaryRangeYesterday'),
      last_7_days: t('chat.summaryRangeWeek'),
      last_30_days: t('chat.summaryRangeMonth'),
      last_90_days: t('chat.summaryRangeQuarter'),
      everything: t('chat.summaryRangeEverything'),
    },
    lineTemplate: t('chat.summaryScopeLine'),
    lineOneTemplate: t('chat.summaryScopeLineOne'),
    aboutTemplate: t('chat.summaryScopeAbout'),
  };
  const scope = summary ? summaryScopeLine(summary, scopeCopy) : null;
  // The header the owner's father asked for (Sep 14 2026): the date and the
  // hours the recap covers, and who took part, above the AI's title and the
  // lines. The hours come from the first and last message the recap read
  // when they are on this device; otherwise the range's days stand in.
  const timeline = workspace.messages?.[conversation.id] ?? [];
  const stampOf = (serverId: string | null | undefined) => {
    const stamp = serverId ? timeline.find((message) => message.serverId === serverId)?.createdAt : undefined;
    return stamp ? new Date(stamp) : null;
  };
  const exact = readySummary
    ? summaryCoversLabel(stampOf(readySummary.sourceFirstMessageId), stampOf(readySummary.sourceLastMessageId), locale)
    : null;
  const coverage = readySummary ? summaryCoverageDates(readySummary.scopeKind, readySummary.createdAt) : null;
  const day = (value: Date) => value.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  const covers = readySummary
    ? exact
      ?? (coverage
        ? coverage.from.toDateString() === coverage.until.toDateString()
          ? day(coverage.until)
          : `${day(coverage.from)} – ${day(coverage.until)}`
        : t('chat.summaryCoversAll'))
    : null;
  const participantNames = (conversation.memberIds?.length
    ? conversation.memberIds.map((id) => (
      id === currentUserId ? workspace.currentUser?.displayName : workspace.people.find((person) => person.id === id)?.displayName
    ))
    : [workspace.currentUser?.displayName, conversation.kind === 'direct' ? conversation.title : null])
    .filter((name): name is string => Boolean(name && name.trim()));
  const participants = participantNames.length ? `${t('chat.summaryParticipants')}: ${participantNames.join(', ')}` : null;
  const exportText = readySummary
    ? summaryExportText({
      title: readySummary.primaryTopic,
      body: readySummary.summary,
      conversationTitle: conversation.title,
      scope,
      covers,
      participants,
    })
    : '';
  const summaryLines = readySummary ? readySummary.summary.split('\n').map((line) => line.trim()).filter(Boolean) : [];
  // The pane remounts the sheet on every open (see its `key`), so notices and
  // nested dialogs never carry over from one visit to the next.
  const [notice, setNotice] = useState<'copied' | 'shareFailed' | null>(null);
  const [exporting, setExporting] = useState<'pdf' | 'docx' | null>(null);

  const summaryErrorReport = summary
    ? workspace.aiOutputErrorReports.find((report) => report.summaryId === summary.id)
    : undefined;
  const [confirming, setConfirming] = useState<OperationalAction | null>(null);
  const [assigneeId, setAssigneeId] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [correcting, setCorrecting] = useState(false);
  const [correctionTopic, setCorrectionTopic] = useState('');
  const [correctionBody, setCorrectionBody] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyMode, setPolicyMode] = useState<'manual' | 'message_count' | 'shift_close'>('manual');
  const [policyThreshold, setPolicyThreshold] = useState('50');

  const statusLabel = summary ? ({
    queued: t('chat.summaryQueued'),
    generating: t('chat.summaryGenerating'),
    ready_for_review: t('chat.summaryReadyReview'),
    approved: t('chat.summaryApproved'),
    corrected: t('chat.summaryCorrected'),
    failed: t('chat.summaryFailed'),
    superseded: t('chat.summarySuperseded'),
  })[summary.status] : null;
  const failureCopy = summary && summary.status === 'failed'
    ? SHORTER_RANGE_FAILURE.test((summary.failureCode ?? '').toLowerCase())
      ? t('chat.summaryTooLong')
      : t('chat.summaryRetry')
    : statusLabel;
  const actionStatus = (status: OperationalAction['status']) => ({
    proposed: t('chat.actionProposed'),
    confirmed: t('chat.actionConfirmed'),
    in_progress: t('chat.actionInProgress'),
    completed: t('chat.actionCompleted'),
    cancelled: t('chat.actionCancelled'),
  })[status];

  const copy = async () => {
    if (!readySummary) return;
    await Clipboard.setStringAsync(exportText);
    setNotice('copied');
  };
  // PDF by default, Word on request (owner's father, Sep 14 2026). The service
  // renders the file so both platforms hand out the same page; the browser
  // drops it into downloads, the phone offers the share sheet.
  const download = async (format: 'pdf' | 'docx') => {
    if (!readySummary) return;
    setExporting(format);
    setNotice(null);
    try {
      const file = await workspace.exportConversationSummary(readySummary, format);
      if (!file) return;
      await saveSummaryFile({
        fileName: summaryFileName(conversation.title, new Date(), format),
        title: readySummary.primaryTopic,
        bytes: file.bytes,
        mimeType: file.contentType,
      });
    } catch {
      setNotice('shareFailed');
    } finally {
      setExporting(null);
    }
  };

  return (
    <ActionModal
      description={scope ?? undefined}
      onClose={onClose}
      title={t('chat.summarySheetTitle')}
      visible={visible}>
      {readySummary ? (
        <View style={styles.summary}>
          {readySummary.sourceState === 'stale' ? (
            <View style={styles.badges}>
              {readySummary.sourceState === 'stale' ? (
                <StatusBadge label={t('chat.summarySuperseded')} tone="warning" />
              ) : null}
            </View>
          ) : null}
          <Text style={styles.topic}>{readySummary.primaryTopic}</Text>
          {covers ? <Text style={styles.meta}>{covers}</Text> : null}
          {participants ? <Text style={styles.meta}>{participants}</Text> : null}
          <View style={styles.lines}>
            {summaryLines.map((line, index) => (
              <Text key={`line-${index}`} selectable style={styles.prose}>{line}</Text>
            ))}
          </View>
        </View>
      ) : generating ? (
        <View accessibilityLiveRegion="polite" style={styles.stateRow}>
          <ActivityIndicator color={colors.plum} />
          <Text style={styles.stateText}>{t('chat.summaryGenerating')}</Text>
        </View>
      ) : summary && (summary.status === 'failed' || summary.status === 'superseded') ? (
        <View accessibilityLiveRegion="polite" style={styles.state}>
          <Text style={styles.stateText}>{failureCopy}</Text>
        </View>
      ) : (
        <Text style={styles.empty}>{t('chat.summaryEmpty')}</Text>
      )}

      <View style={styles.ranges}>
        {ranges.map((kind) => (
          <Chip
            key={kind}
            label={t(RANGE_KEYS[kind])}
            onPress={() => setRange(kind)}
            selected={range === kind}
          />
        ))}
      </View>
      <FormField
        label={t('chat.summarySubject')}
        onChangeText={setSubject}
        placeholder={t('chat.summarySubjectPlaceholder')}
        value={subject}
      />
      <View style={styles.actions}>
        <PrimaryButton
          disabled={generating}
          icon="sparkles-outline"
          label={t('chat.summarizeAll')}
          loading={requesting}
          onPress={() => void workspace.requestConversationSummary(conversation.id, { kind: range, subject })}
          tone="dark"
        />
        <PrimaryButton
          disabled={!readySummary}
          icon="copy-outline"
          label={t('chat.copy')}
          onPress={() => void copy()}
          tone="light"
        />
        <PrimaryButton
          disabled={!readySummary}
          icon="document-text-outline"
          label={t('chat.summaryPdf')}
          loading={exporting === 'pdf'}
          onPress={() => void download('pdf')}
          tone="light"
        />
        <PrimaryButton
          disabled={!readySummary}
          icon="document-outline"
          label={t('chat.summaryWord')}
          loading={exporting === 'docx'}
          onPress={() => void download('docx')}
          tone="light"
        />
      </View>
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={styles.hint}>
          {notice === 'copied' ? t('chat.summaryCopied') : t('chat.summaryShareFailed')}
        </Text>
      ) : null}
      <ActionError message={workspace.actionError} />

      <ActionModal
        description={confirming?.title ?? ''}
        onClose={() => setConfirming(null)}
        title={t('chat.confirmAction')}
        visible={Boolean(confirming)}>
        <Text style={styles.modalLabel}>{t('chat.assignTo')}</Text>
        <View style={styles.actions}>
          {workspace.people.filter((person) => !person.suspended).slice(0, 30).map((person) => (
            <Chip key={person.id} label={person.displayName} onPress={() => setAssigneeId(person.id)} selected={assigneeId === person.id} />
          ))}
        </View>
        <FormField label={t('chat.dueAt')} onChangeText={setDueAt} value={dueAt} />
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          disabled={!assigneeId}
          label={t('chat.confirmAction')}
          loading={workspace.actionBusy === 'action-confirm'}
          onPress={async () => {
            if (confirming && await workspace.confirmAction(confirming.id, assigneeId, dueAt)) setConfirming(null);
          }}
          tone="dark"
        />
      </ActionModal>
      <ActionModal
        description={t('chat.summaryCorrectionDescription')}
        onClose={() => setCorrecting(false)}
        title={t('chat.correctSummary')}
        visible={correcting}>
        <FormField label={t('chat.primaryTopic')} onChangeText={setCorrectionTopic} value={correctionTopic} />
        <FormField label={t('chat.summaryBody')} multiline onChangeText={setCorrectionBody} value={correctionBody} />
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          disabled={!correctionTopic.trim() || !correctionBody.trim()}
          label={t('chat.saveCorrection')}
          loading={readySummary ? workspace.actionBusy === `summary-correct:${readySummary.id}` : false}
          onPress={async () => {
            if (readySummary && await workspace.correctConversationSummary(readySummary, correctionTopic, correctionBody)) {
              setCorrecting(false);
            }
          }}
          tone="dark"
        />
      </ActionModal>
      <ActionModal
        description={t('chat.summaryReviewDescription')}
        onClose={() => setReviewing(false)}
        title={t('chat.reviewSummary')}
        visible={reviewing}>
        <FormField label={t('chat.reviewNote')} multiline onChangeText={setReviewNote} value={reviewNote} />
        <ActionError message={workspace.actionError} />
        <View style={styles.actions}>
          <PrimaryButton
            label={t('chat.approveExactVersion')}
            loading={readySummary ? workspace.actionBusy === `summary-review:${readySummary.id}` : false}
            onPress={async () => {
              if (readySummary && await workspace.reviewConversationSummary(readySummary.id, 'approve', reviewNote)) {
                setReviewing(false);
              }
            }}
            tone="dark"
          />
          <PrimaryButton
            disabled={reviewNote.trim().length < 3}
            label={t('chat.rejectSummary')}
            loading={readySummary ? workspace.actionBusy === `summary-review:${readySummary.id}` : false}
            onPress={async () => {
              if (readySummary && await workspace.reviewConversationSummary(readySummary.id, 'reject', reviewNote)) {
                setReviewing(false);
              }
            }}
            tone="danger"
          />
        </View>
      </ActionModal>
      <ActionModal
        description={t('chat.summaryScheduleDescription')}
        onClose={() => setPolicyOpen(false)}
        title={t('chat.summarySchedule')}
        visible={policyOpen}>
        <View style={styles.actions}>
          <Chip label={t('chat.summaryManual')} onPress={() => setPolicyMode('manual')} selected={policyMode === 'manual'} />
          <Chip label={t('chat.summaryMessageCount')} onPress={() => setPolicyMode('message_count')} selected={policyMode === 'message_count'} />
          <Chip label={t('chat.summaryShiftClose')} onPress={() => setPolicyMode('shift_close')} selected={policyMode === 'shift_close'} />
        </View>
        {policyMode === 'message_count' ? (
          <FormField
            keyboardType="number-pad"
            label={t('chat.summaryThreshold')}
            onChangeText={setPolicyThreshold}
            value={policyThreshold}
          />
        ) : null}
        <Text style={styles.modalNote}>{t('chat.summaryHumanReviewRequired')}</Text>
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          disabled={policyMode === 'message_count' && (
            !Number.isInteger(Number(policyThreshold)) || Number(policyThreshold) < 10 || Number(policyThreshold) > 500
          )}
          label={t('chat.saveSummarySchedule')}
          loading={workspace.actionBusy === `summary-policy:${conversation.id}`}
          onPress={async () => {
            const threshold = policyMode === 'message_count' ? Number(policyThreshold) : null;
            if (await workspace.setConversationSummaryPolicy(conversation.id, policyMode, threshold)) setPolicyOpen(false);
          }}
          tone="dark"
        />
      </ActionModal>
    </ActionModal>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  summary: { gap: spacing.xs },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  topic: { color: colors.ink, fontSize: 14, fontWeight: '800', lineHeight: 20 },
  prose: { color: colors.ink, fontSize: 13, lineHeight: 20 },
  lines: { gap: 2, paddingTop: spacing.xs },
  stateRow: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  state: { gap: spacing.xs },
  stateText: { color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
  meta: { color: colors.inkMuted, fontSize: 12, lineHeight: 17 },
  empty: { color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
  ranges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, paddingTop: spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  hint: { color: colors.inkSubtle, fontSize: 11, lineHeight: 16 },
  label: { color: colors.plum, fontSize: 9, fontWeight: '900', letterSpacing: 0.6, textTransform: 'uppercase' },
  actionList: { gap: spacing.xs, paddingTop: spacing.xs },
  actionRow: {
    minHeight: 52,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.paperMuted,
  },
  actionCopy: { flex: 1, minWidth: 180 },
  actionTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  actionMeta: { color: colors.inkSubtle, fontSize: 9, marginTop: 2 },
  modalLabel: { color: colors.inkMuted, fontSize: 11, fontWeight: '800' },
  modalNote: { color: colors.inkMuted, fontSize: 11, lineHeight: 16 },
});
