import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
import { Chip, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import type {
  RecoveryCase,
  RecoveryVerificationMethod,
} from '@/data/repositories/recovery-case-repository';
import {
  RecoveryCaseRepository,
  RecoveryCaseRepositoryError,
} from '@/data/repositories/recovery-case-repository';
import { maskedRecoveryCaseReference } from '@/data/repositories/recovery-case-dto.mjs';
import type { Person } from '@/domain/types';
import {
  interpolateRecoveryCopy,
  recoveryCopy,
} from '@/features/admin/recovery-copy';
import { SelfRecoveryRequest } from '@/features/security/self-recovery-request';
import { useI18n } from '@/i18n/provider';
import { createClientId } from '@/lib/client-id';
import { colors, radii, shadow, spacing, type } from '@/theme/tokens';

type RecoveryAction =
  { kind: 'verify'; item: RecoveryCase; idempotencyKey: string }
  | { kind: 'approve'; item: RecoveryCase; idempotencyKey: string }
  | { kind: 'reject'; item: RecoveryCase; idempotencyKey: string }
  | { kind: 'execute'; item: RecoveryCase; idempotencyKey: string };

interface Props {
  accessToken: string | null;
  assuranceLevel: 'aal1' | 'aal2' | null;
  currentUserId: string;
  onVerifyNow: () => void;
  onOpenSettings: () => void;
  organizationId: string;
  people: Pick<Person, 'id' | 'displayName'>[];
}

const TERMINAL_STATUSES = new Set(['completed', 'rejected', 'expired']);

function statusTone(status: RecoveryCase['status']) {
  if (status === 'completed') return 'success' as const;
  if (status === 'rejected' || status === 'expired') return 'danger' as const;
  if (status === 'approved' || status === 'executing') return 'purple' as const;
  return 'warning' as const;
}

export function AccountRecoverySection({
  accessToken,
  assuranceLevel,
  currentUserId,
  onVerifyNow,
  onOpenSettings,
  organizationId,
  people,
}: Props) {
  const { locale } = useI18n();
  const copy = recoveryCopy(locale);
  const repository = useMemo(
    () => new RecoveryCaseRepository(() => accessToken),
    [accessToken],
  );
  const peopleById = useMemo(
    () => new Map(people.map((person) => [person.id, person.displayName])),
    [people],
  );
  const [cases, setCases] = useState<RecoveryCase[]>([]);
  const [loading, setLoading] = useState(false);
  const [sectionError, setSectionError] = useState('');
  const [notice, setNotice] = useState('');
  const [action, setAction] = useState<RecoveryAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [verificationMethod, setVerificationMethod] =
    useState<RecoveryVerificationMethod>('in_person');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [clock, setClock] = useState(() => Date.now());
  const managerReady = assuranceLevel === 'aal2';

  const dateTime = useCallback((value: string) => {
    try {
      return new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value));
    } catch {
      return '';
    }
  }, [locale]);

  const errorMessage = useCallback((error: unknown) => {
    if (!(error instanceof RecoveryCaseRepositoryError)) return copy.errorGeneric;
    if (error.code === 'network_unavailable') return copy.errorNetwork;
    if (
      error.status === 401 || error.status === 403 ||
      ['authentication_required', 'csrf_required', 'unauthorized', 'forbidden'].includes(error.code)
    ) return copy.errorAuth;
    if (error.status === 409 || error.code === 'conflict') return copy.errorConflict;
    if (['invalid_response', 'response_too_large'].includes(error.code)) return copy.errorResponse;
    if (error.code.startsWith('invalid_')) return copy.errorInput;
    return copy.errorGeneric;
  }, [copy]);

  const loadCases = useCallback(async () => {
    if (!managerReady) return;
    setLoading(true);
    setSectionError('');
    try {
      const result = await repository.listCases(organizationId);
      if (result.scope !== 'organization') throw new Error('unexpected recovery scope');
      setCases(result.cases);
    } catch (error) {
      setSectionError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [errorMessage, managerReady, organizationId, repository]);

  useEffect(() => {
    if (!managerReady) return;
    const timeout = setTimeout(() => void loadCases(), 0);
    return () => clearTimeout(timeout);
  }, [loadCases, managerReady]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const closeAction = () => {
    if (actionBusy) return;
    setAction(null);
    setActionError('');
    setEvidenceReference('');
    setRejectionReason('');
  };

  const openManagerAction = (
    kind: RecoveryAction['kind'],
    item: RecoveryCase,
  ) => {
    if (!managerReady || item.targetUserId === currentUserId) return;
    setAction({ kind, item, idempotencyKey: createClientId() } as RecoveryAction);
    setActionError('');
    setEvidenceReference('');
    setRejectionReason('');
  };

  const submitAction = async () => {
    if (!action || actionBusy) return;
    setActionBusy(true);
    setActionError('');
    try {
      if (action.kind === 'verify') {
        await repository.recordVerification({
          organizationId,
          caseId: action.item.caseId,
          method: verificationMethod,
          evidenceReference,
          idempotencyKey: action.idempotencyKey,
        });
        setNotice(copy.noticeVerified);
      } else if (action.kind === 'approve') {
        const receipt = await repository.approveCase({
          organizationId,
          caseId: action.item.caseId,
          idempotencyKey: action.idempotencyKey,
        });
        setNotice(interpolateRecoveryCopy(copy.noticeApproved, {
          recorded: receipt.approvalsRecorded,
          required: receipt.requiredApprovals,
        }));
      } else if (action.kind === 'reject') {
        await repository.rejectCase({
          organizationId,
          caseId: action.item.caseId,
          reason: rejectionReason,
          idempotencyKey: action.idempotencyKey,
        });
        setNotice(copy.noticeRejected);
      } else {
        const receipt = await repository.executeCase({
          organizationId,
          caseId: action.item.caseId,
          idempotencyKey: action.idempotencyKey,
        });
        setNotice(receipt.alreadyCompleted
          ? copy.noticeAlreadyExecuted
          : interpolateRecoveryCopy(copy.noticeExecuted, {
              sessions: receipt.sessionsRevoked ?? 0,
              devices: receipt.devicesRevoked ?? 0,
            }));
      }
      setAction(null);
      setEvidenceReference('');
      setRejectionReason('');
      if (managerReady) await loadCases();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setActionBusy(false);
    }
  };

  const statusLabel = (status: RecoveryCase['status']) => ({
    awaiting_external_verification: copy.statusAwaitingVerification,
    awaiting_approval: copy.statusAwaitingApproval,
    approved: copy.statusApproved,
    executing: copy.statusExecuting,
    completed: copy.statusCompleted,
    rejected: copy.statusRejected,
    expired: copy.statusExpired,
  })[status];

  const methodLabel = (method: RecoveryVerificationMethod | null) => method === null
    ? copy.verificationPending
    : ({
        in_person: copy.methodInPerson,
        manager_callback: copy.methodManagerCallback,
        hr_record_match: copy.methodHrRecord,
        approved_provider: copy.methodProvider,
      })[method];

  const modalTitle = action?.kind === 'verify' ? copy.verifyTitle
    : action?.kind === 'approve' ? copy.approveTitle
      : action?.kind === 'reject' ? copy.rejectTitle
        : copy.executeTitle;
  const modalDescription = action?.kind === 'verify' ? copy.verifyDescription
    : action?.kind === 'approve' ? copy.approveDescription
      : action?.kind === 'reject' ? copy.rejectDescription
        : copy.executeDescription;

  return (
    <View style={styles.section}>
      <View style={styles.headingRow}>
        <View style={styles.headingCopy}>
          <Text style={styles.eyebrow}>{copy.eyebrow}</Text>
          <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
          <Text style={styles.description}>{copy.description}</Text>
        </View>
        <View style={styles.headingActions}>
          <SelfRecoveryRequest
            accessToken={accessToken}
            onCreated={async (createdNotice) => {
              setNotice(createdNotice);
              if (managerReady) await loadCases();
            }}
            onOpenSettings={onOpenSettings}
            organizationId={organizationId}
            presentation="button"
          />
          <PrimaryButton
            disabled={!managerReady || loading}
            icon="refresh-outline"
            label={loading ? copy.refreshing : copy.refresh}
            onPress={() => void loadCases()}
            tone="light"
          />
        </View>
      </View>

      <View style={[styles.boundaryCard, shadow]}>
        <View style={styles.boundaryRow}>
          <Ionicons
            name={managerReady ? 'shield-checkmark-outline' : 'lock-closed-outline'}
            color={managerReady ? colors.mintDark : colors.amber}
            size={20}
          />
          <View style={styles.boundaryCopy}>
            <Text style={styles.boundaryTitle}>
              {managerReady ? copy.aal2Ready : copy.aal2Locked}
            </Text>
            <Text style={styles.boundaryText}>
              {managerReady ? copy.freshnessReady : copy.freshnessLocked}
            </Text>
          </View>
          <PrimaryButton
            icon="shield-outline"
            label={copy.verifyNow}
            onPress={onVerifyNow}
            tone="light"
          />
        </View>
        <View style={styles.policyRow}>
          <Ionicons name="people-outline" color={colors.blue} size={17} />
          <Text style={styles.policyText}>{copy.externalBoundary}</Text>
        </View>
        <View style={[styles.policyRow, styles.warningRow]}>
          <Ionicons name="warning-outline" color={colors.amber} size={17} />
          <Text style={styles.policyText}>{copy.sensitiveWarning}</Text>
        </View>
      </View>

      {notice ? (
        <View accessibilityLiveRegion="polite" style={styles.notice}>
          <Ionicons name="checkmark-circle-outline" color={colors.mintDark} size={18} />
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}
      <ActionError message={sectionError} />

      {!managerReady ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>{copy.queryLocked}</Text>
        </View>
      ) : loading && cases.length === 0 ? (
        <View accessibilityLiveRegion="polite" style={styles.loadingCard}>
          <ActivityIndicator color={colors.mintDark} />
          <Text style={styles.emptyText}>{copy.loading}</Text>
        </View>
      ) : cases.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>{copy.empty}</Text>
        </View>
      ) : (
        <View accessibilityRole="list" style={styles.caseList}>
          {cases.map((item) => {
            const selfTarget = item.targetUserId === currentUserId;
            const expiredLocally = Date.parse(item.expiresAt) <= clock &&
              !TERMINAL_STATUSES.has(item.status);
            const managerActionDisabled = !managerReady || selfTarget || expiredLocally;
            const canReject = !['completed', 'rejected', 'expired', 'executing'].includes(item.status);
            return (
              <View key={item.caseId} style={[styles.caseCard, shadow]}>
                <View style={styles.caseTopRow}>
                  <View style={styles.caseIdentity}>
                    <Text style={styles.caseReferenceLabel}>{copy.caseReference}</Text>
                    <Text style={styles.caseReference}>
                      {maskedRecoveryCaseReference(item.caseId)}
                    </Text>
                  </View>
                  <StatusBadge
                    label={statusLabel(item.status)}
                    tone={statusTone(item.status)}
                  />
                </View>
                <Text style={styles.targetName}>
                  {copy.requestedFor} · {peopleById.get(item.targetUserId) ?? '—'}
                </Text>
                <Text style={styles.reasonLabel}>{copy.reason}</Text>
                <Text style={styles.reasonText}>{item.requestReason}</Text>
                <View style={styles.detailGrid}>
                  <Text style={styles.detailText}>{copy.created} · {dateTime(item.createdAt)}</Text>
                  <Text style={styles.detailText}>{copy.expires} · {dateTime(item.expiresAt)}</Text>
                  <Text style={styles.detailText}>
                    {copy.approvals} · {item.approvalsRecorded}/{item.requiredApprovals}
                  </Text>
                  <Text style={styles.detailText}>
                    {copy.verification} · {methodLabel(item.verificationMethod)}
                  </Text>
                  {item.completedAt ? (
                    <Text style={styles.detailText}>
                      {copy.completed} · {dateTime(item.completedAt)}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.policyTag}>
                  {item.privilegedTarget ? copy.privileged : copy.standard}
                </Text>
                {expiredLocally ? <Text style={styles.expiredText}>{copy.expiredLocally}</Text> : null}
                <Text style={selfTarget ? styles.selfText : styles.separationText}>
                  {selfTarget ? copy.selfSeparation : copy.separation}
                </Text>
                <View style={styles.actionRow}>
                  {item.status === 'awaiting_external_verification' ? (
                    <PrimaryButton
                      disabled={managerActionDisabled}
                      label={copy.verify}
                      onPress={() => openManagerAction('verify', item)}
                      tone="light"
                    />
                  ) : null}
                  {item.status === 'awaiting_approval' ? (
                    <PrimaryButton
                      disabled={managerActionDisabled}
                      label={copy.approve}
                      onPress={() => openManagerAction('approve', item)}
                      tone="dark"
                    />
                  ) : null}
                  {canReject ? (
                    <PrimaryButton
                      disabled={managerActionDisabled}
                      label={copy.reject}
                      onPress={() => openManagerAction('reject', item)}
                      tone="danger"
                    />
                  ) : null}
                  {['approved', 'executing'].includes(item.status) ? (
                    <PrimaryButton
                      disabled={managerActionDisabled}
                      label={copy.execute}
                      onPress={() => openManagerAction('execute', item)}
                      tone="danger"
                    />
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      )}

      <View style={styles.immutableNote}>
        <Ionicons name="server-outline" color={colors.inkSubtle} size={16} />
        <Text style={styles.immutableText}>{copy.immutableNote}</Text>
      </View>

      <ActionModal
        description={modalDescription}
        onClose={closeAction}
        title={modalTitle}
        visible={Boolean(action)}>
        {action?.kind === 'verify' ? (
          <>
            <View style={styles.modalWarning}>
              <Ionicons name="warning-outline" color={colors.amber} size={17} />
              <Text style={styles.modalWarningText}>{copy.sensitiveWarning}</Text>
            </View>
            <Text style={styles.fieldLabel}>{copy.method}</Text>
            <View style={styles.chips}>
              <Chip label={copy.methodInPerson} onPress={() => setVerificationMethod('in_person')} selected={verificationMethod === 'in_person'} />
              <Chip label={copy.methodManagerCallback} onPress={() => setVerificationMethod('manager_callback')} selected={verificationMethod === 'manager_callback'} />
              <Chip label={copy.methodHrRecord} onPress={() => setVerificationMethod('hr_record_match')} selected={verificationMethod === 'hr_record_match'} />
              <Chip label={copy.methodProvider} onPress={() => setVerificationMethod('approved_provider')} selected={verificationMethod === 'approved_provider'} />
            </View>
            <FormField
              label={copy.evidenceReference}
              onChangeText={(value) => setEvidenceReference(value.slice(0, 500))}
              placeholder={copy.evidencePlaceholder}
              value={evidenceReference}
            />
          </>
        ) : null}

        {action?.kind === 'reject' ? (
          <FormField
            label={copy.rejectionReason}
            multiline
            onChangeText={(value) => setRejectionReason(value.slice(0, 500))}
            placeholder={copy.rejectionPlaceholder}
            value={rejectionReason}
          />
        ) : null}

        {action?.kind === 'execute' ? (
          <View style={[styles.modalWarning, styles.destructiveWarning]}>
            <Ionicons name="alert-circle-outline" color={colors.red} size={18} />
            <Text style={styles.destructiveWarningText}>{copy.executeWarning}</Text>
          </View>
        ) : null}

        <ActionError message={actionError} />
        <View style={styles.modalActions}>
          <PrimaryButton
            disabled={actionBusy}
            label={copy.cancel}
            onPress={closeAction}
            tone="light"
          />
          <PrimaryButton
            disabled={
              action?.kind === 'verify'
                ? evidenceReference.trim().length < 8
                : action?.kind === 'reject'
                  ? rejectionReason.trim().length < 3
                  : !action
            }
            icon={action?.kind === 'execute' || action?.kind === 'reject'
              ? 'warning-outline'
              : 'checkmark-circle-outline'}
            label={actionBusy ? copy.working
              : action?.kind === 'verify' ? copy.recordVerification
                : action?.kind === 'approve' ? copy.approveConfirm
                  : action?.kind === 'reject' ? copy.rejectConfirm
                    : copy.executeConfirm}
            loading={actionBusy}
            onPress={() => void submitAction()}
            tone={action?.kind === 'execute' || action?.kind === 'reject' ? 'danger' : 'dark'}
          />
        </View>
      </ActionModal>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { width: '100%', marginTop: spacing.xl },
  headingRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.md, marginBottom: spacing.md },
  headingCopy: { flex: 1, minWidth: 260 },
  headingActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  eyebrow: { color: colors.mintDark, fontSize: 10, fontWeight: '900', letterSpacing: 0.9 },
  title: { color: colors.ink, fontFamily: type.display, fontSize: 21, fontWeight: '800', marginTop: 3 },
  description: { color: colors.inkMuted, fontSize: 11, lineHeight: 17, marginTop: 5, maxWidth: 680 },
  boundaryCard: { overflow: 'hidden', borderRadius: radii.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  boundaryRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  boundaryCopy: { flex: 1, minWidth: 230 },
  boundaryTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  boundaryText: { color: colors.inkMuted, fontSize: 10, lineHeight: 16, marginTop: 3 },
  policyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.blueSoft },
  warningRow: { backgroundColor: colors.amberSoft },
  policyText: { flex: 1, color: colors.inkMuted, fontSize: 10, lineHeight: 16 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.sm, marginTop: spacing.sm, borderRadius: radii.md, backgroundColor: colors.mintSoft },
  noticeText: { flex: 1, color: colors.mintDark, fontSize: 10, lineHeight: 16, fontWeight: '700' },
  loadingCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xl, marginTop: spacing.sm, borderRadius: radii.lg, backgroundColor: colors.paper },
  emptyCard: { padding: spacing.xl, marginTop: spacing.sm, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  emptyText: { color: colors.inkSubtle, fontSize: 11, lineHeight: 17, textAlign: 'center' },
  caseList: { gap: spacing.sm, marginTop: spacing.sm },
  caseCard: { padding: spacing.md, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  caseTopRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm },
  caseIdentity: { flex: 1, minWidth: 0 },
  caseReferenceLabel: { color: colors.inkSubtle, fontSize: 9, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  caseReference: { color: colors.ink, fontFamily: type.mono, fontSize: 13, fontWeight: '900', marginTop: 2 },
  targetName: { color: colors.ink, fontSize: 12, fontWeight: '900', marginTop: spacing.sm },
  reasonLabel: { color: colors.inkSubtle, fontSize: 9, fontWeight: '800', marginTop: spacing.sm },
  reasonText: { color: colors.inkMuted, fontSize: 11, lineHeight: 17, marginTop: 2 },
  detailGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  detailText: { color: colors.inkSubtle, fontSize: 9, lineHeight: 14 },
  policyTag: { color: colors.plum, fontSize: 10, fontWeight: '800', marginTop: spacing.sm },
  expiredText: { color: colors.red, fontSize: 10, fontWeight: '800', marginTop: spacing.xs },
  selfText: { color: colors.red, fontSize: 9, lineHeight: 14, marginTop: spacing.sm },
  separationText: { color: colors.inkSubtle, fontSize: 9, lineHeight: 14, marginTop: spacing.sm },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.xs, marginTop: spacing.md, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  immutableNote: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.md, marginTop: spacing.sm, borderRadius: radii.md, backgroundColor: colors.paperMuted },
  immutableText: { flex: 1, color: colors.inkSubtle, fontSize: 9, lineHeight: 15 },
  modalWarning: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.amberSoft },
  modalWarningText: { flex: 1, color: colors.inkMuted, fontSize: 10, lineHeight: 16 },
  destructiveWarning: { backgroundColor: colors.redSoft },
  destructiveWarningText: { flex: 1, color: colors.red, fontSize: 10, lineHeight: 16, fontWeight: '700' },
  fieldLabel: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  modalActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.xs },
});
