import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
import { Chip, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import { isPersonalRealm } from '@/constants/personal-realm';
import {
  coveringSummary,
  formatSummaryScope,
  latestSummary,
  newSummarySourceIds,
  summaryExportText,
  summaryFileName,
  summaryIsReady,
  summaryScope,
} from '@/data/summary-text';
import type { Conversation, Message, OperationalAction } from '@/domain/types';
// Metro selects the platform adapter (file + share sheet natively, Web Share or clipboard on web).
// eslint-disable-next-line import/no-unresolved
import { shareSummary } from '@/features/chat/summary-export';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { colors, radii, spacing } from '@/theme/tokens';

/**
 * The conversation summary, reachable from the header anywhere in the thread:
 * the latest recap as plain prose, one line saying what it covers, a button
 * that summarizes only what arrived since the reader's last recap, and copy
 * and share actions. Workplace organizations additionally keep their review,
 * correction, schedule, and operational-action controls here.
 */
export function SummarySheet({
  conversation,
  messages,
  visible,
  onClose,
  onReportError,
}: {
  conversation: Conversation;
  messages: Message[];
  visible: boolean;
  onClose: () => void;
  onReportError?: (summaryId: string) => void;
}) {
  const workspace = useWorkspace();
  const router = useRouter();
  const { locale, t } = useI18n();
  const consumer = isPersonalRealm(workspace.organizationId);
  const currentUserId = workspace.currentUser?.id ?? null;
  const summary = latestSummary(workspace.summaries, conversation.id);
  const readySummary = summaryIsReady(summary) ? summary : null;
  const boundary = coveringSummary(workspace.summaries, conversation.id, currentUserId);
  const newSourceIds = newSummarySourceIds(messages, boundary);
  const requesting = workspace.actionBusy === `summary-request:${conversation.id}`;
  const generating = summary?.status === 'queued' || summary?.status === 'generating';
  const scope = summary
    ? formatSummaryScope(summaryScope(summary, messages), {
      locale,
      sinceTemplate: t('chat.summaryScope'),
      countTemplate: t('chat.summaryScopeCount'),
      today: t('chat.summaryScopeToday'),
      yesterday: t('chat.summaryScopeYesterday'),
    })
    : null;
  const exportText = readySummary
    ? summaryExportText({
      title: readySummary.primaryTopic,
      body: readySummary.summary,
      conversationTitle: conversation.title,
      scope,
    })
    : '';
  // The pane remounts the sheet on every open (see its `key`), so notices and
  // nested dialogs never carry over from one visit to the next.
  const [notice, setNotice] = useState<'copied' | 'shareFailed' | null>(null);
  const [sharing, setSharing] = useState(false);

  // Workplace-only state: review, correction, schedule, operational actions.
  const canManage = !consumer && conversation.canManage === true;
  const actions = consumer ? [] : workspace.actions.filter((item) => item.conversationId === conversation.id);
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

  const canSummarize = !generating && newSourceIds.length > 0;
  return (
    <ActionModal
      description={scope ?? undefined}
      onClose={onClose}
      title={t('chat.summarySheetTitle')}
      visible={visible}>
      {readySummary ? (
        <View style={styles.summary}>
          {!consumer || readySummary.sourceState === 'stale' ? (
            <View style={styles.badges}>
              {!consumer && statusLabel ? (
                <StatusBadge
                  label={statusLabel}
                  tone={readySummary.status === 'approved' ? 'success' : 'warning'}
                />
              ) : null}
              {readySummary.sourceState === 'stale' ? (
                <StatusBadge label={t('chat.summarySuperseded')} tone="warning" />
              ) : null}
            </View>
          ) : null}
          <Text style={styles.topic}>{readySummary.primaryTopic}</Text>
          <Text selectable style={styles.prose}>{readySummary.summary}</Text>
        </View>
      ) : generating ? (
        <View accessibilityLiveRegion="polite" style={styles.stateRow}>
          <ActivityIndicator color={colors.plum} />
          <Text style={styles.stateText}>{t('chat.summaryGenerating')}</Text>
        </View>
      ) : summary && (summary.status === 'failed' || summary.status === 'superseded') ? (
        <View accessibilityLiveRegion="polite" style={styles.state}>
          <Text style={styles.stateText}>{statusLabel}</Text>
          {!consumer && summary.failureCode ? (
            <Text selectable style={styles.meta}>{t('chat.failureCode')} · {summary.failureCode}</Text>
          ) : null}
          {!consumer ? (
            <PrimaryButton
              icon="document-text-outline"
              label={t('chat.createManualHandoff')}
              onPress={() => router.push('/handoffs')}
              tone="light"
            />
          ) : null}
        </View>
      ) : (
        <Text style={styles.empty}>{t('chat.summaryEmpty')}</Text>
      )}

      <View style={styles.actions}>
        <PrimaryButton
          disabled={!canSummarize}
          icon="sparkles-outline"
          label={boundary ? t('chat.summarizeNew') : t('chat.summarizeAll')}
          loading={requesting}
          onPress={() => void workspace.requestConversationSummary(conversation.id, newSourceIds)}
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
      {boundary && !generating && newSourceIds.length === 0 ? (
        <Text style={styles.hint}>{t('chat.summaryNoNewMessages')}</Text>
      ) : null}
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={styles.hint}>
          {notice === 'copied' ? t('chat.summaryCopied') : t('chat.summaryShareFailed')}
        </Text>
      ) : null}
      <ActionError message={workspace.actionError} />

      {!consumer && readySummary ? (
        <View style={styles.actions}>
          {readySummary.outputFingerprint ? (
            summaryErrorReport ? (
              <StatusBadge label={t('quality.reportSubmitted')} tone="info" />
            ) : (
              <PrimaryButton
                icon="flag-outline"
                label={t('chat.reportSummaryError')}
                onPress={() => {
                  workspace.clearActionError();
                  onReportError?.(readySummary.id);
                }}
                tone="light"
              />
            )
          ) : null}
          {canManage && readySummary.sourceState === 'current' ? (
            <PrimaryButton
              icon="create-outline"
              label={t('chat.correctSummary')}
              onPress={() => {
                workspace.clearActionError();
                setCorrectionTopic(readySummary.primaryTopic);
                setCorrectionBody(readySummary.summary);
                setCorrecting(true);
              }}
              tone="light"
            />
          ) : null}
          {canManage
            && readySummary.sourceState === 'current'
            && (readySummary.status === 'ready_for_review' || readySummary.status === 'corrected') ? (
            <PrimaryButton
              icon="shield-checkmark-outline"
              label={t('chat.reviewSummary')}
              onPress={() => {
                workspace.clearActionError();
                setReviewNote('');
                setReviewing(true);
              }}
              tone="light"
            />
          ) : null}
        </View>
      ) : null}
      {canManage ? (
        <PrimaryButton
          icon="options-outline"
          label={t('chat.summarySchedule')}
          onPress={() => {
            workspace.clearActionError();
            setPolicyOpen(true);
          }}
          tone="light"
        />
      ) : null}
      {actions.length ? (
        <View style={styles.actionList}>
          <Text style={styles.label}>{t('chat.operationalActions')}</Text>
          {actions.map((action) => (
            <View key={action.id} style={styles.actionRow}>
              <View style={styles.actionCopy}>
                <Text style={styles.actionTitle}>{action.title}</Text>
                <Text style={styles.actionMeta}>
                  {actionStatus(action.status)}
                  {action.assigneeName ? ` · ${action.assigneeName}` : ''}
                </Text>
              </View>
              {action.status === 'proposed' && workspace.hasCapability('actions.confirm') ? (
                <PrimaryButton
                  label={t('chat.confirmAction')}
                  onPress={() => {
                    workspace.clearActionError();
                    setAssigneeId('');
                    setDueAt('');
                    setConfirming(action);
                  }}
                  tone="light"
                />
              ) : action.status === 'confirmed' && (action.assigneeUserId === currentUserId || workspace.hasCapability('actions.confirm')) ? (
                <PrimaryButton label={t('chat.startAction')} onPress={() => void workspace.transitionAction(action.id, 'in_progress')} tone="light" />
              ) : action.status === 'in_progress' && (action.assigneeUserId === currentUserId || workspace.hasCapability('actions.confirm')) ? (
                <View style={styles.actions}>
                  <PrimaryButton label={t('chat.completeAction')} onPress={() => void workspace.transitionAction(action.id, 'completed')} tone="dark" />
                  <PrimaryButton label={t('chat.cancelAction')} onPress={() => void workspace.transitionAction(action.id, 'cancelled')} tone="danger" />
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

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

const styles = StyleSheet.create({
  summary: { gap: spacing.xs },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  topic: { color: colors.ink, fontSize: 14, fontWeight: '800', lineHeight: 20 },
  prose: { color: colors.ink, fontSize: 13, lineHeight: 20 },
  stateRow: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  state: { gap: spacing.xs },
  stateText: { color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
  meta: { color: colors.inkSubtle, fontSize: 10, lineHeight: 15 },
  empty: { color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
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
