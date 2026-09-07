import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionError, FormField } from '@/components/ui/action-modal';
import { Chip, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import type { AiOutputErrorReport } from '@/domain/types';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { radii, shadow, spacing, type } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

export function AiQualityReviewSection({
  privilegedReady,
  onVerifyNow,
}: {
  privilegedReady: boolean;
  onVerifyNow: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const workspace = useWorkspace();
  const { t } = useI18n();
  const loadAiOutputReviewQueue = workspace.loadAiOutputReviewQueue;
  const [reviewOutcome, setReviewOutcome] = useState<'confirmed_error' | 'not_an_error' | 'needs_context'>('confirmed_error');
  const [reviewNote, setReviewNote] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState('en');
  const [sourceText, setSourceText] = useState('');
  const [observedOutput, setObservedOutput] = useState('');
  const [expectedOutput, setExpectedOutput] = useState('');
  const [attested, setAttested] = useState(false);
  const [decisionNote, setDecisionNote] = useState('');
  const detail = workspace.selectedAiOutputReport;

  useEffect(() => {
    if (privilegedReady) void loadAiOutputReviewQueue();
  }, [loadAiOutputReviewQueue, privilegedReady]);

  const preservedOutput = useMemo(() => {
    const snapshot = detail?.report.targetSnapshot;
    if (!snapshot) return '';
    const output = detail.report.outputKind === 'translation'
      ? snapshot.translatedBody
      : snapshot.summaryBody;
    return typeof output === 'string' ? output : JSON.stringify(snapshot, null, 2);
  }, [detail]);
  const categoryLabel = (category: AiOutputErrorReport['category']) => ({
    incorrect_meaning: t('quality.categoryIncorrectMeaning'),
    omitted_context: t('quality.categoryOmittedContext'),
    terminology: t('quality.categoryTerminology'),
    unsafe_wording: t('quality.categoryUnsafeWording'),
    wrong_language: t('quality.categoryWrongLanguage'),
    unsupported_claim: t('quality.categoryUnsupportedClaim'),
    missing_source: t('quality.categoryMissingSource'),
    incorrect_action: t('quality.categoryIncorrectAction'),
    other: t('quality.categoryOther'),
  })[category];
  const statusLabel = (status: AiOutputErrorReport['status']) => ({
    open: t('quality.statusOpen'),
    reviewing: t('quality.statusReviewing'),
    resolved: t('quality.statusResolved'),
    dismissed: t('quality.statusDismissed'),
  })[status];
  const exampleStatusLabel = (status: 'pending' | 'approved' | 'rejected' | 'exported') => ({
    pending: t('quality.statusPending'),
    approved: t('quality.statusApproved'),
    rejected: t('quality.statusRejected'),
    exported: t('quality.statusExported'),
  })[status];

  const openReport = async (report: AiOutputErrorReport) => {
    workspace.clearActionError();
    setReviewNote('');
    setSourceText('');
    setObservedOutput('');
    setExpectedOutput('');
    setAttested(false);
    setDecisionNote('');
    await workspace.readAiOutputErrorReport(report.reportId);
  };

  return (
    <View style={[styles.section, shadow]}>
      <View style={styles.header}>
        <View style={styles.icon}>
          <Ionicons name="analytics-outline" size={21} color={colors.plum} />
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>TR-03 · SUM-02</Text>
          <Text accessibilityRole="header" style={styles.title}>{t('quality.title')}</Text>
          <Text style={styles.description}>{t('quality.subtitle')}</Text>
        </View>
        <StatusBadge
          label={privilegedReady ? t('admin.aal2Ready') : t('admin.aal2Locked')}
          tone={privilegedReady ? 'success' : 'warning'}
        />
      </View>

      {!privilegedReady ? (
        <PrimaryButton icon="shield-outline" label={t('admin.verifyNow')} onPress={onVerifyNow} tone="light" />
      ) : (
        <>
          <PrimaryButton
            icon="refresh-outline"
            label={t('quality.refresh')}
            loading={workspace.actionBusy === 'ai-output-reports:review'}
            onPress={() => void workspace.loadAiOutputReviewQueue()}
            tone="light"
          />
          <View style={styles.layout}>
            <View style={styles.queue}>
              {workspace.aiOutputReviewQueue.length ? workspace.aiOutputReviewQueue.map((report) => (
                <Pressable
                  accessibilityRole="button"
                  key={report.reportId}
                  onPress={() => void openReport(report)}
                  style={({ pressed }) => [
                    styles.queueRow,
                    detail?.report.reportId === report.reportId && styles.queueRowSelected,
                    pressed && styles.pressed,
                  ]}>
                  <View style={styles.queueCopy}>
                    <Text style={styles.queueTitle}>
                      {report.outputKind === 'translation' ? t('quality.outputTranslation') : t('quality.outputSummary')}
                      {' · '}{categoryLabel(report.category)}
                    </Text>
                    <Text numberOfLines={2} style={styles.queueDetails}>{report.details}</Text>
                    <Text style={styles.meta}>{report.createdAt} · v{report.version}</Text>
                  </View>
                  <StatusBadge
                    label={report.highConsequence ? t('quality.highImpact') : statusLabel(report.status)}
                    tone={report.highConsequence ? 'danger' : 'warning'}
                  />
                </Pressable>
              )) : <Text style={styles.empty}>{t('quality.empty')}</Text>}
            </View>

            <View style={styles.detail}>
              {!detail ? <Text style={styles.empty}>{t('quality.selectReport')}</Text> : (
                <>
                  <View style={styles.boundary}>
                    <Ionicons name="lock-closed-outline" size={16} color={colors.plum} />
                    <Text style={styles.boundaryText}>{t('quality.originalsUnchanged')}</Text>
                  </View>
                  <Text style={styles.label}>{t('quality.exactSnapshot')}</Text>
                  <Text selectable style={styles.snapshot}>{preservedOutput}</Text>
                  <Text style={styles.meta}>
                    {detail.report.targetLanguage.toUpperCase()} · {detail.report.targetOutputFingerprint}
                  </Text>
                  <Text style={styles.label}>{categoryLabel(detail.report.category)}</Text>
                  <Text style={styles.body}>{detail.report.details}</Text>
                  <View style={styles.chips}>
                    <Chip label={t('quality.confirmedError')} onPress={() => setReviewOutcome('confirmed_error')} selected={reviewOutcome === 'confirmed_error'} />
                    <Chip label={t('quality.notAnError')} onPress={() => setReviewOutcome('not_an_error')} selected={reviewOutcome === 'not_an_error'} />
                    <Chip label={t('quality.needsContext')} onPress={() => setReviewOutcome('needs_context')} selected={reviewOutcome === 'needs_context'} />
                  </View>
                  <FormField label={t('quality.reviewNote')} multiline onChangeText={setReviewNote} value={reviewNote} />
                  <PrimaryButton
                    disabled={reviewNote.trim().length < 3 || !['open', 'reviewing'].includes(detail.report.status)}
                    label={t('quality.submitReview')}
                    loading={workspace.actionBusy === `ai-output-report:review:${detail.report.reportId}`}
                    onPress={() => void workspace.reviewAiOutputErrorReport(
                      detail.report.reportId,
                      detail.report.version,
                      reviewOutcome,
                      reviewNote,
                    )}
                    tone="dark"
                  />

                  {detail.report.outcome === 'confirmed_error' ? (
                    <View style={styles.subsection}>
                      <Text style={styles.subsectionTitle}>{t('quality.regressionProposal')}</Text>
                      <Text style={styles.description}>{t('quality.regressionDescription')}</Text>
                      {!detail.report.qualityUseConsent ? (
                        <Text style={styles.warning}>{t('quality.consentMissing')}</Text>
                      ) : detail.regressionExample ? (
                        <>
                          <Text style={styles.body}>{detail.regressionExample.deidentifiedExpectedOutput}</Text>
                          <StatusBadge label={exampleStatusLabel(detail.regressionExample.status)} tone={detail.regressionExample.status === 'approved' || detail.regressionExample.status === 'exported' ? 'success' : 'warning'} />
                          {detail.regressionExample.status === 'pending' ? (
                            <>
                              <Text style={styles.subsectionTitle}>{t('quality.secondReview')}</Text>
                              {detail.regressionExample.proposedByUserId === workspace.currentUser?.id ? (
                                <Text style={styles.warning}>{t('quality.secondReviewerRequired')}</Text>
                              ) : null}
                              <FormField label={t('quality.decisionNote')} multiline onChangeText={setDecisionNote} value={decisionNote} />
                              <View style={styles.chips}>
                                <PrimaryButton
                                  disabled={decisionNote.trim().length < 3 || detail.regressionExample.proposedByUserId === workspace.currentUser?.id}
                                  label={t('quality.approveExample')}
                                  onPress={() => void workspace.decideAiRegressionExample(
                                    detail.regressionExample!.exampleId,
                                    detail.regressionExample!.version,
                                    'approved',
                                    decisionNote,
                                  )}
                                  tone="dark"
                                />
                                <PrimaryButton
                                  disabled={decisionNote.trim().length < 3 || detail.regressionExample.proposedByUserId === workspace.currentUser?.id}
                                  label={t('quality.rejectExample')}
                                  onPress={() => void workspace.decideAiRegressionExample(
                                    detail.regressionExample!.exampleId,
                                    detail.regressionExample!.version,
                                    'rejected',
                                    decisionNote,
                                  )}
                                  tone="danger"
                                />
                              </View>
                            </>
                          ) : <Text style={styles.description}>{t('quality.serviceExport')}</Text>}
                        </>
                      ) : (
                        <>
                          <FormField label={t('quality.sourceLanguage')} onChangeText={setSourceLanguage} value={sourceLanguage} />
                          <FormField label={t('quality.deidentifiedSource')} multiline onChangeText={setSourceText} value={sourceText} />
                          <FormField label={t('quality.observedOutput')} multiline onChangeText={setObservedOutput} value={observedOutput} />
                          <FormField label={t('quality.expectedOutput')} multiline onChangeText={setExpectedOutput} value={expectedOutput} />
                          <Pressable
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: attested }}
                            onPress={() => setAttested((value) => !value)}
                            style={[styles.attestation, attested && styles.attestationChecked]}>
                            <Ionicons name={attested ? 'checkbox' : 'square-outline'} size={21} color={colors.mintDark} />
                            <Text style={styles.attestationText}>{t('quality.deidentificationAttestation')}</Text>
                          </Pressable>
                          <PrimaryButton
                            disabled={!attested || !sourceText.trim() || !observedOutput.trim() || !expectedOutput.trim() || observedOutput.trim() === expectedOutput.trim()}
                            label={t('quality.proposeExample')}
                            loading={workspace.actionBusy === `ai-regression:propose:${detail.report.reportId}`}
                            onPress={() => void workspace.proposeAiRegressionExample({
                              reportId: detail.report.reportId,
                              expectedReportVersion: detail.report.version,
                              sourceLanguage,
                              deidentifiedSourceText: sourceText,
                              deidentifiedObservedOutput: observedOutput,
                              deidentifiedExpectedOutput: expectedOutput,
                            })}
                            tone="dark"
                          />
                        </>
                      )}
                    </View>
                  ) : null}
                  <ActionError message={workspace.actionError} />
                </>
              )}
            </View>
          </View>
        </>
      )}
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  section: { gap: spacing.md, padding: spacing.lg, borderRadius: radii.lg, backgroundColor: colors.paper },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  icon: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md, backgroundColor: colors.plumSoft },
  headerCopy: { flex: 1, minWidth: 0 },
  eyebrow: { color: colors.plum, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  title: { color: colors.ink, fontSize: 20, fontFamily: type.display },
  description: { color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
  layout: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  queue: { flex: 1, minWidth: 260, gap: spacing.xs },
  detail: { flex: 2, minWidth: 300, gap: spacing.sm, padding: spacing.md, borderRadius: radii.md, borderWidth: 1, borderColor: colors.line },
  queueRow: { flexDirection: 'row', gap: spacing.sm, padding: spacing.sm, borderRadius: radii.md, borderWidth: 1, borderColor: colors.line },
  queueRowSelected: { borderColor: colors.plum, backgroundColor: colors.plumSoft },
  queueCopy: { flex: 1, minWidth: 0 },
  queueTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  queueDetails: { color: colors.inkMuted, fontSize: 11, lineHeight: 16, marginTop: 3 },
  meta: { color: colors.inkSubtle, fontSize: 9, lineHeight: 14, marginTop: 3 },
  empty: { color: colors.inkMuted, fontSize: 12, lineHeight: 18, padding: spacing.md },
  boundary: { flexDirection: 'row', gap: spacing.xs, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.plumSoft },
  boundaryText: { flex: 1, color: colors.plum, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  label: { color: colors.ink, fontSize: 11, fontWeight: '900' },
  snapshot: { color: colors.ink, fontSize: 12, lineHeight: 18, padding: spacing.sm, borderRadius: radii.sm, backgroundColor: colors.paperMuted },
  body: { color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  subsection: { gap: spacing.sm, paddingTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  subsectionTitle: { color: colors.ink, fontSize: 14, fontWeight: '900' },
  warning: { color: colors.amber, fontSize: 12, lineHeight: 18, fontWeight: '700' },
  attestation: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.sm, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: radii.md },
  attestationChecked: { borderColor: colors.mintDark, backgroundColor: colors.mintSoft },
  attestationText: { flex: 1, color: colors.ink, fontSize: 12, lineHeight: 17, fontWeight: '700' },
  pressed: { opacity: 0.72 },
});
