import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
import { Chip, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import {
  SUMMARY_SCOPE_KINDS,
  latestSummary,
  summaryExportText,
  summaryFileName,
  summaryIsReady,
  summaryScopeLine,
  summaryTodoText,
} from '@/data/summary-text';
import type { Conversation, OperationalAction, SummaryScopeKind } from '@/domain/types';
// Metro selects the platform adapter (file + share sheet natively, Web Share or clipboard on web).
// eslint-disable-next-line import/no-unresolved
import { shareSummary } from '@/features/chat/summary-export';
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
  everything: 'chat.summaryRangeEverything',
};

// A range the server refused or the model could not handle is a "pick a
// shorter range" case; anything else was the service, so "try again".
const SHORTER_RANGE_FAILURE = /too_long|refused|needs_review/;

/**
 * The conversation summary, reachable from the header anywhere in the thread:
 * the reader picks a range (Unread, Today, Yesterday, Last 7 days, Everything)
 * and can say what the recap should cover; the latest recap shows as plain
 * prose with its decisions and to-dos, one scope line, and copy and share
 * actions. Workplace organizations additionally keep their review,
 * correction, schedule, and operational-action controls here.
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
  const { t } = useI18n();
  const currentUserId = workspace.currentUser?.id ?? null;
  const summary = latestSummary(workspace.summaries, conversation.id, currentUserId);
  const readySummary = summaryIsReady(summary) ? summary : null;
  // The pane marks the chat read as it opens; the unread divider it keeps is
  // what "Unread" means here.
  const hasUnread = Boolean(workspace.unreadDividerIds?.[conversation.id]) || conversation.unreadCount > 0;
  const ranges = hasUnread ? SUMMARY_SCOPE_KINDS : SUMMARY_SCOPE_KINDS.filter((kind) => kind !== 'unread');
  const [range, setRange] = useState<SummaryScopeKind>(hasUnread ? 'unread' : 'today');
  const [subject, setSubject] = useState('');
  const requesting = workspace.actionBusy === `summary-request:${conversation.id}`;
  const generating = summary?.status === 'queued' || summary?.status === 'generating';
  const scopeCopy = {
    ranges: {
      unread: t('chat.summaryRangeUnread'),
      today: t('chat.summaryRangeToday'),
      yesterday: t('chat.summaryRangeYesterday'),
      last_7_days: t('chat.summaryRangeWeek'),
      everything: t('chat.summaryRangeEverything'),
    },
    lineTemplate: t('chat.summaryScopeLine'),
    lineOneTemplate: t('chat.summaryScopeLineOne'),
    aboutTemplate: t('chat.summaryScopeAbout'),
  };
  const scope = summary ? summaryScopeLine(summary, scopeCopy) : null;
  const decisions = readySummary ? readySummary.decisions.map((item) => item.text.trim()).filter(Boolean) : [];
  const todos = readySummary ? readySummary.actionItems.map(summaryTodoText).filter(Boolean) : [];
  const exportText = readySummary
    ? summaryExportText({
      title: readySummary.primaryTopic,
      body: readySummary.summary,
      conversationTitle: conversation.title,
      scope,
      decisions,
      todos,
      headings: { decisions: t('chat.summaryDecisions'), todo: t('chat.summaryTodo') },
    })
    : '';
  // The pane remounts the sheet on every open (see its `key`), so notices and
  // nested dialogs never carry over from one visit to the next.
  const [notice, setNotice] = useState<'copied' | 'shareFailed' | null>(null);
  const [sharing, setSharing] = useState(false);

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
  const share = async () => {
    if (!readySummary) return;
    setSharing(true);
    setNotice(null);
    try {
      const outcome = await shareSummary({
        fileName: summaryFileName(conversation.title),
        title: readySummary.primaryTopic,
        text: exportText,
      });
      if (outcome === 'copied') setNotice('copied');
    } catch {
      setNotice('shareFailed');
    } finally {
      setSharing(false);
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
          <Text selectable style={styles.prose}>{readySummary.summary}</Text>
          {decisions.length ? (
            <View style={styles.list}>
              <Text style={styles.listTitle}>{t('chat.summaryDecisions')}</Text>
              {decisions.map((text, index) => (
                <Text key={`decision-${index}`} selectable style={styles.listItem}>• {text}</Text>
              ))}
            </View>
          ) : null}
          {todos.length ? (
            <View style={styles.list}>
              <Text style={styles.listTitle}>{t('chat.summaryTodo')}</Text>
              {todos.map((text, index) => (
                <Text key={`todo-${index}`} selectable style={styles.listItem}>• {text}</Text>
              ))}
            </View>
          ) : null}
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
          icon="share-outline"
          label={t('chat.summaryShare')}
          loading={sharing}
          onPress={() => void share()}
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
  list: { gap: 2, paddingTop: spacing.xs },
  listTitle: { color: colors.inkMuted, fontSize: 11, fontWeight: '800', lineHeight: 16 },
  listItem: { color: colors.ink, fontSize: 13, lineHeight: 20 },
  stateRow: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  state: { gap: spacing.xs },
  stateText: { color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
  meta: { color: colors.inkSubtle, fontSize: 10, lineHeight: 15 },
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
