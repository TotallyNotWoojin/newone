import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
import { Chip, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import {
  ModerationCaseRepository,
  ModerationCaseRepositoryError,
  type ModerationCaseDetail,
  type ModerationCaseListItem,
  type ModerationCaseStatus,
  type ModerationEvidenceMetadata,
} from '@/data/repositories/moderation-case-repository';
import type { Person } from '@/domain/types';
import { moderationCopy } from '@/features/admin/moderation-copy';
import { useI18n } from '@/i18n/provider';
import { createClientId } from '@/lib/client-id';
import { getRealtimeClient } from '@/lib/supabase';
import { colors, radii, shadow, spacing, type } from '@/theme/tokens';
import { useHydrationSafeWindowDimensions } from '@/hooks/use-hydration-safe-window-dimensions';

interface Props {
  accessToken: string | null;
  assuranceLevel: 'aal1' | 'aal2' | null;
  currentUserId: string;
  onVerifyNow: () => void;
  organizationId: string;
  people: Pick<Person, 'id' | 'displayName' | 'suspended'>[];
}

type CaseFilter = 'active' | 'open' | 'closed' | 'all';
type CaseAction =
  | { kind: 'assign'; item: ModerationCaseListItem; idempotencyKey: string }
  | { kind: 'claim'; item: ModerationCaseListItem; idempotencyKey: string }
  | { kind: 'review'; item: ModerationCaseListItem; idempotencyKey: string }
  | { kind: 'resolve'; item: ModerationCaseListItem; idempotencyKey: string }
  | { kind: 'dismiss'; item: ModerationCaseListItem; idempotencyKey: string };

const ALL_STATUSES: ModerationCaseStatus[] = [
  'open',
  'assigned',
  'in_review',
  'resolved',
  'dismissed',
];

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function caseReference(caseId: string): string {
  return `#${caseId.slice(-8).toUpperCase()}`;
}

function statusTone(status: ModerationCaseStatus) {
  if (status === 'resolved') return 'success' as const;
  if (status === 'dismissed') return 'neutral' as const;
  if (status === 'in_review') return 'purple' as const;
  if (status === 'assigned') return 'info' as const;
  return 'warning' as const;
}

export function ModerationCaseSection({
  accessToken,
  assuranceLevel,
  currentUserId,
  onVerifyNow,
  organizationId,
  people,
}: Props) {
  const { locale } = useI18n();
  const copy = moderationCopy(locale);
  const { width } = useHydrationSafeWindowDimensions();
  const desktop = width >= 920;
  const repository = useMemo(
    () => new ModerationCaseRepository(() => accessToken),
    [accessToken],
  );
  const activePeople = useMemo(() => people.filter((person) => !person.suspended), [people]);
  const [cases, setCases] = useState<ModerationCaseListItem[]>([]);
  const [filter, setFilter] = useState<CaseFilter>('active');
  const [loading, setLoading] = useState(false);
  const [sectionError, setSectionError] = useState('');
  const [notice, setNotice] = useState('');
  const [detail, setDetail] = useState<ModerationCaseDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [action, setAction] = useState<CaseAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [reason, setReason] = useState('');
  const [investigatorId, setInvestigatorId] = useState('');
  const [referenceText, setReferenceText] = useState('');
  const [policyCode, setPolicyCode] = useState('');
  const [severity, setSeverity] = useState<ModerationEvidenceMetadata['severity']>();
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
    if (!(error instanceof ModerationCaseRepositoryError)) return copy.errorGeneric;
    if (error.code === 'network_unavailable') return copy.errorNetwork;
    if (
      error.status === 401 || error.status === 403 ||
      ['authentication_required', 'csrf_required', 'unauthorized', 'forbidden'].includes(error.code)
    ) return copy.errorAuth;
    if (error.status === 409 || ['conflict', 'version_conflict'].includes(error.code)) {
      return copy.errorConflict;
    }
    if (['invalid_response', 'response_too_large'].includes(error.code)) return copy.errorResponse;
    if (error.code.startsWith('invalid_')) return copy.errorInput;
    return copy.errorGeneric;
  }, [copy]);

  const loadCases = useCallback(async () => {
    if (!managerReady) return;
    setLoading(true);
    setSectionError('');
    try {
      const result = await repository.queryCases({
        organizationId,
        statuses: ALL_STATUSES,
        limit: 100,
      });
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
    const interval = setInterval(() => void loadCases(), 60_000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [loadCases, managerReady]);

  useEffect(() => {
    const client = getRealtimeClient();
    if (
      assuranceLevel !== 'aal2' || !accessToken || !client ||
      !organizationId || !currentUserId
    ) return;
    let active = true;
    let channel: ReturnType<typeof client.channel> | null = null;
    void client.realtime.setAuth(accessToken).then(() => {
      if (!active) return;
      channel = client.channel(`org:${organizationId}:user:${currentUserId}:inbox`, {
        config: { private: true, broadcast: { ack: true, self: false } },
      });
      channel.on('broadcast', { event: 'workspace.invalidated' }, (raw) => {
        const outer = record(raw);
        const first = record(outer.payload ?? outer);
        const value = record(first.payload ?? first);
        if (
          value.schemaVersion === 1 && value.event === 'workspace.invalidated' &&
          value.organizationId === organizationId && value.entityType === 'moderation_case' &&
          typeof value.entityId === 'string'
        ) void loadCases();
      });
      channel.subscribe((status) => {
        if (active && status === 'SUBSCRIBED') void loadCases();
      });
    }).catch(() => {
      // Periodic reconciliation remains active if the private socket is unavailable.
    });
    return () => {
      active = false;
      if (channel) void client.removeChannel(channel);
    };
  }, [accessToken, assuranceLevel, currentUserId, loadCases, organizationId]);

  const visibleCases = useMemo(() => cases.filter((item) => {
    if (filter === 'active') return ['open', 'assigned', 'in_review'].includes(item.status);
    if (filter === 'open') return item.status === 'open';
    if (filter === 'closed') return item.readOnly;
    return true;
  }), [cases, filter]);

  const statusLabel = (status: ModerationCaseStatus) => ({
    open: copy.statusOpen,
    assigned: copy.statusAssigned,
    in_review: copy.statusInReview,
    resolved: copy.statusResolved,
    dismissed: copy.statusDismissed,
  })[status];

  const categoryLabel = (category: ModerationCaseListItem['category']) => ({
    harassment: copy.categoryHarassment,
    threat: copy.categoryThreat,
    spam: copy.categorySpam,
    privacy: copy.categoryPrivacy,
    misinformation: copy.categoryMisinformation,
    other: copy.categoryOther,
  })[category];

  const targetTypeLabel = (targetType: ModerationCaseListItem['target']['type']) => ({
    message: copy.targetMessage,
    group: copy.targetGroup,
    member: copy.targetMember,
  })[targetType];

  const openAction = (kind: CaseAction['kind'], item: ModerationCaseListItem) => {
    if (!managerReady || item.readOnly) return;
    setAction({ kind, item, idempotencyKey: createClientId() } as CaseAction);
    setReason('');
    setInvestigatorId('');
    setReferenceText('');
    setPolicyCode('');
    setSeverity(undefined);
    setActionError('');
    setNotice('');
  };

  const closeAction = () => {
    if (actionBusy) return;
    setAction(null);
    setActionError('');
  };

  const readCase = async (item: ModerationCaseListItem) => {
    if (!item.canViewEvidence || detailLoading) return;
    setDetailLoading(true);
    setSectionError('');
    try {
      const next = await repository.readCase({
        organizationId,
        caseId: item.caseId,
      });
      if (next) setDetail(next);
    } catch (error) {
      setSectionError(errorMessage(error));
    } finally {
      setDetailLoading(false);
    }
  };

  const submitAction = async () => {
    if (!action || actionBusy || reason.trim().length < 3) return;
    const references = referenceText.split(',').map((value) => value.trim()).filter(Boolean);
    const metadata: ModerationEvidenceMetadata = {
      ...(references.length ? { referenceIds: references } : {}),
      ...(policyCode.trim() ? { policyCode: policyCode.trim() } : {}),
      ...(severity ? { severity } : {}),
    };
    if (
      (action.kind === 'resolve' || action.kind === 'dismiss') &&
      Object.keys(metadata).length === 0
    ) return;
    if (action.kind === 'assign' && !investigatorId) return;
    setActionBusy(true);
    setActionError('');
    try {
      if (action.kind === 'assign') {
        await repository.assignCase({
          organizationId,
          caseId: action.item.caseId,
          investigatorUserId: investigatorId,
          expectedVersion: action.item.recordVersion,
          reason,
          idempotencyKey: action.idempotencyKey,
        });
      } else if (action.kind === 'claim') {
        await repository.claimCase({
          organizationId,
          caseId: action.item.caseId,
          expectedVersion: action.item.recordVersion,
          reason,
          idempotencyKey: action.idempotencyKey,
        });
      } else {
        await repository.transitionCase({
          organizationId,
          caseId: action.item.caseId,
          status: action.kind === 'review'
            ? 'in_review'
            : action.kind === 'resolve' ? 'resolved' : 'dismissed',
          expectedVersion: action.item.recordVersion,
          reason,
          ...(action.kind === 'review' ? {} : { evidenceMetadata: metadata }),
          idempotencyKey: action.idempotencyKey,
        });
      }
      setNotice(action.kind === 'assign' || action.kind === 'claim'
        ? copy.noticeAssigned
        : action.kind === 'review' ? copy.noticeReview
          : action.kind === 'resolve' ? copy.noticeResolved : copy.noticeDismissed);
      setAction(null);
      setDetail(null);
      await loadCases();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setActionBusy(false);
    }
  };

  const actionTitle = action?.kind === 'assign' ? copy.assignmentTitle
    : action?.kind === 'claim' ? copy.claimTitle
      : action?.kind === 'review' ? copy.reviewTitle
        : action?.kind === 'resolve' ? copy.resolveTitle : copy.dismissTitle;
  const actionDescription = action?.kind === 'assign' ? copy.assignmentDescription
    : action?.kind === 'claim' ? copy.claimDescription
      : action?.kind === 'review' ? copy.reviewDescription
        : action?.kind === 'resolve' ? copy.resolveDescription : copy.dismissDescription;
  const evidenceMetadataRequired = action?.kind === 'resolve' || action?.kind === 'dismiss';
  const eligiblePeople = action?.kind === 'assign'
    ? activePeople.filter((person) => action.item.eligibleInvestigatorUserIds.includes(person.id))
    : [];

  return (
    <View style={styles.section}>
      <View style={styles.headingRow}>
        <View style={styles.headingCopy}>
          <Text style={styles.eyebrow}>{copy.eyebrow}</Text>
          <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
          <Text style={styles.description}>{copy.description}</Text>
        </View>
        <PrimaryButton
          disabled={!managerReady || loading}
          icon="refresh-outline"
          label={loading ? copy.refreshing : copy.refresh}
          onPress={() => void loadCases()}
          tone="light"
        />
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
              {managerReady ? copy.aal2Ready : copy.aal2Required}
            </Text>
            <Text style={styles.boundaryText}>{copy.privacyBoundary}</Text>
          </View>
          {!managerReady ? (
            <PrimaryButton
              icon="shield-outline"
              label={copy.verifyNow}
              onPress={onVerifyNow}
              tone="light"
            />
          ) : null}
        </View>
        <View style={styles.noContentRow}>
          <Ionicons name="eye-off-outline" color={colors.blue} size={17} />
          <Text style={styles.noContentText}>{copy.noContentList}</Text>
        </View>
      </View>

      <View style={styles.filters}>
        <Chip label={copy.activeFilter} onPress={() => setFilter('active')} selected={filter === 'active'} />
        <Chip label={copy.openFilter} onPress={() => setFilter('open')} selected={filter === 'open'} />
        <Chip label={copy.closedFilter} onPress={() => setFilter('closed')} selected={filter === 'closed'} />
        <Chip label={copy.allFilter} onPress={() => setFilter('all')} selected={filter === 'all'} />
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
          <Text style={styles.emptyText}>{copy.aal2Required}</Text>
        </View>
      ) : loading && cases.length === 0 ? (
        <View accessibilityLiveRegion="polite" style={styles.loadingCard}>
          <ActivityIndicator color={colors.mintDark} />
          <Text style={styles.emptyText}>{copy.loading}</Text>
        </View>
      ) : visibleCases.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>{copy.empty}</Text>
        </View>
      ) : (
        <View accessibilityRole="list" style={[styles.caseGrid, desktop && styles.caseGridDesktop]}>
          {visibleCases.map((item) => (
            <View key={item.caseId} style={[styles.caseCard, desktop && styles.caseCardDesktop, shadow]}>
              <View style={styles.cardTopRow}>
                <View style={styles.caseIdentity}>
                  <Text style={styles.referenceLabel}>{copy.caseReference}</Text>
                  <Text selectable style={styles.reference}>{caseReference(item.caseId)}</Text>
                </View>
                <StatusBadge label={statusLabel(item.status)} tone={statusTone(item.status)} />
              </View>
              <Text style={styles.category}>{categoryLabel(item.category)}</Text>
              <View style={styles.targetRow}>
                <Ionicons
                  name={item.target.type === 'message'
                    ? 'chatbubble-outline'
                    : item.target.type === 'group' ? 'people-outline' : 'person-outline'}
                  color={colors.blue}
                  size={15}
                />
                <Text style={styles.targetText}>
                  {copy.target} · {targetTypeLabel(item.target.type)} · {item.target.label}
                </Text>
              </View>
              <View style={styles.metaGrid}>
                <Text style={styles.meta}>{copy.reported} · {dateTime(item.reportedAt)}</Text>
                <Text style={styles.meta}>{copy.updated} · {dateTime(item.updatedAt)}</Text>
                {item.assignedAt ? (
                  <Text style={styles.meta}>{copy.assigned} · {dateTime(item.assignedAt)}</Text>
                ) : null}
              </View>
              <View style={styles.protectedRow}>
                <Ionicons name="person-outline" color={colors.plum} size={15} />
                <Text style={styles.protectedText}>{copy.protectedReporter}</Text>
              </View>
              <View style={styles.actions}>
                {item.canClaim ? (
                  <PrimaryButton label={copy.claim} onPress={() => openAction('claim', item)} tone="dark" />
                ) : null}
                {item.canAssign ? (
                  <PrimaryButton
                    label={item.status === 'assigned' ? copy.reassign : copy.assign}
                    onPress={() => openAction('assign', item)}
                    tone="light"
                  />
                ) : null}
                {item.canViewEvidence ? (
                  <PrimaryButton
                    label={copy.viewCase}
                    loading={detailLoading}
                    onPress={() => void readCase(item)}
                    tone="light"
                  />
                ) : null}
                {item.assignedToMe && item.status === 'assigned' ? (
                  <PrimaryButton label={copy.review} onPress={() => openAction('review', item)} tone="dark" />
                ) : null}
                {item.assignedToMe && item.status === 'in_review' ? (
                  <>
                    <PrimaryButton label={copy.resolve} onPress={() => openAction('resolve', item)} tone="dark" />
                    <PrimaryButton label={copy.dismiss} onPress={() => openAction('dismiss', item)} tone="danger" />
                  </>
                ) : null}
              </View>
              {item.readOnly ? (
                <View style={styles.readOnlyRow}>
                  <Ionicons name="lock-closed-outline" color={colors.inkSubtle} size={14} />
                  <Text style={styles.readOnlyText}>{copy.readOnly}</Text>
                </View>
              ) : null}
            </View>
          ))}
        </View>
      )}

      <ActionModal
        description={actionDescription}
        onClose={closeAction}
        title={actionTitle}
        visible={Boolean(action)}>
        {action?.kind === 'assign' ? (
          <>
            <Text style={styles.fieldLabel}>{copy.investigator}</Text>
            {eligiblePeople.length ? (
              <View style={styles.chips}>
                {eligiblePeople.map((person) => (
                  <Chip
                    key={person.id}
                    label={person.displayName}
                    onPress={() => setInvestigatorId(person.id)}
                    selected={investigatorId === person.id}
                  />
                ))}
              </View>
            ) : <Text style={styles.helperText}>{copy.noEligibleInvestigator}</Text>}
          </>
        ) : null}
        <FormField
          label={copy.actionReason}
          multiline
          onChangeText={(value) => setReason(value.slice(0, 2000))}
          placeholder={copy.actionReasonPlaceholder}
          value={reason}
        />
        {evidenceMetadataRequired ? (
          <>
            <FormField
              label={copy.policyCode}
              onChangeText={(value) => setPolicyCode(value.slice(0, 80))}
              placeholder={copy.policyCodePlaceholder}
              value={policyCode}
            />
            <FormField
              label={copy.evidenceReference}
              onChangeText={(value) => setReferenceText(value.slice(0, 1000))}
              placeholder={copy.evidenceReferencePlaceholder}
              value={referenceText}
            />
            <Text style={styles.fieldLabel}>{copy.severity}</Text>
            <View style={styles.chips}>
              <Chip label={copy.severityLow} onPress={() => setSeverity('low')} selected={severity === 'low'} />
              <Chip label={copy.severityMedium} onPress={() => setSeverity('medium')} selected={severity === 'medium'} />
              <Chip label={copy.severityHigh} onPress={() => setSeverity('high')} selected={severity === 'high'} />
              <Chip label={copy.severityCritical} onPress={() => setSeverity('critical')} selected={severity === 'critical'} />
            </View>
          </>
        ) : null}
        <ActionError message={actionError} />
        <View style={styles.modalActions}>
          <PrimaryButton disabled={actionBusy} label={copy.cancel} onPress={closeAction} tone="light" />
          <PrimaryButton
            disabled={
              !action || reason.trim().length < 3 ||
              (action.kind === 'assign' && !investigatorId) ||
              (evidenceMetadataRequired && !policyCode.trim() && !referenceText.trim() && !severity)
            }
            icon={action?.kind === 'dismiss' ? 'close-circle-outline' : 'checkmark-circle-outline'}
            label={actionBusy ? copy.working : copy.submit}
            loading={actionBusy}
            onPress={() => void submitAction()}
            tone={action?.kind === 'dismiss' ? 'danger' : 'dark'}
          />
        </View>
      </ActionModal>

      <ActionModal
        description={detail ? `${copy.caseReference} ${caseReference(detail.caseId)}` : ''}
        onClose={() => setDetail(null)}
        title={copy.evidenceTitle}
        visible={Boolean(detail)}>
        {detail ? (
          <>
            <View style={styles.detailBoundary}>
              <Ionicons name="shield-checkmark-outline" color={colors.mintDark} size={18} />
              <Text style={styles.detailBoundaryText}>
                {detail.target.type === 'message'
                  ? copy.evidenceDescription
                  : copy.targetOnlyDescription}
              </Text>
            </View>
            <View style={styles.cardTopRow}>
              <StatusBadge label={statusLabel(detail.status)} tone={statusTone(detail.status)} />
              {detail.readOnly ? <StatusBadge icon="lock-closed" label={copy.readOnly} /> : null}
            </View>
            <Text style={styles.fieldLabel}>{copy.target}</Text>
            <Text style={styles.detailText}>
              {targetTypeLabel(detail.target.type)} · {detail.target.label}
            </Text>
            <Text style={styles.fieldLabel}>{copy.details}</Text>
            <Text style={styles.detailText}>{detail.details || copy.detailsEmpty}</Text>
            {detail.target.type === 'message' ? (
            <View accessibilityRole="list" style={styles.evidenceList}>
              {detail.evidence.map((item) => (
                <View key={item.evidenceId} style={styles.evidenceCard}>
                  <Text style={styles.evidenceKind}>{item.relationship === 'reported'
                    ? copy.evidenceReported
                    : item.relationship === 'context_before' ? copy.evidenceBefore : copy.evidenceAfter}</Text>
                  <Text style={styles.evidenceSender}>{item.senderLabel} · {dateTime(item.sentAt)}</Text>
                  <Text selectable style={styles.evidenceBody}>
                    {item.messageBody ?? copy.attachmentEvidence}
                  </Text>
                  <Text selectable style={styles.hash}>SHA-256 · {item.bodySha256.slice(0, 16)}…</Text>
                </View>
              ))}
            </View>
            ) : null}
            <View style={styles.historyHeading}>
              <Text style={styles.fieldLabel}>{copy.historyTitle}</Text>
              <Text style={styles.helperText}>{copy.historyDescription}</Text>
            </View>
            <View accessibilityRole="list" style={styles.historyList}>
              {detail.history.map((item) => {
                const actor = item.actorLabel === 'protected_reporter' ? copy.actorReporter
                  : item.actorLabel === 'assigned_investigator' ? copy.actorInvestigator
                    : copy.actorManager;
                const metadata = [
                  item.evidenceMetadata.policyCode,
                  item.evidenceMetadata.severity,
                  ...(item.evidenceMetadata.referenceIds ?? []),
                ].filter(Boolean).join(' · ');
                return (
                  <View key={item.eventId} style={styles.historyItem}>
                    <Ionicons name="ellipse" color={colors.mintDark} size={8} />
                    <View style={styles.historyCopy}>
                      <Text style={styles.historyEvent}>{item.eventType.replaceAll('_', ' ')}</Text>
                      <Text style={styles.historyMeta}>{actor} · {dateTime(item.occurredAt)}</Text>
                      {item.reason ? <Text style={styles.historyReason}>{item.reason}</Text> : null}
                      {metadata ? <Text style={styles.hash}>{metadata}</Text> : null}
                    </View>
                  </View>
                );
              })}
            </View>
            <PrimaryButton label={copy.close} onPress={() => setDetail(null)} tone="light" />
          </>
        ) : null}
      </ActionModal>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { width: '100%', marginTop: spacing.xl },
  headingRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.md, marginBottom: spacing.md },
  headingCopy: { flex: 1, minWidth: 260 },
  eyebrow: { color: colors.mintDark, fontSize: 10, fontWeight: '900', letterSpacing: 0.9 },
  title: { color: colors.ink, fontFamily: type.display, fontSize: 21, fontWeight: '800', marginTop: 3 },
  description: { color: colors.inkMuted, fontSize: 11, lineHeight: 17, marginTop: 5, maxWidth: 720 },
  boundaryCard: { overflow: 'hidden', borderRadius: radii.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  boundaryRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  boundaryCopy: { flex: 1, minWidth: 230 },
  boundaryTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  boundaryText: { color: colors.inkMuted, fontSize: 10, lineHeight: 16, marginTop: 3 },
  noContentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.blueSoft },
  noContentText: { flex: 1, color: colors.blue, fontSize: 10, lineHeight: 16, fontWeight: '700' },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.sm, marginTop: spacing.sm, borderRadius: radii.md, backgroundColor: colors.mintSoft },
  noticeText: { flex: 1, color: colors.mintDark, fontSize: 10, lineHeight: 16, fontWeight: '700' },
  loadingCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xl, marginTop: spacing.sm, borderRadius: radii.lg, backgroundColor: colors.paper },
  emptyCard: { padding: spacing.xl, marginTop: spacing.sm, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  emptyText: { color: colors.inkSubtle, fontSize: 11, lineHeight: 17, textAlign: 'center' },
  caseGrid: { gap: spacing.sm, marginTop: spacing.sm },
  caseGridDesktop: { flexDirection: 'row', flexWrap: 'wrap' },
  caseCard: { width: '100%', padding: spacing.md, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  caseCardDesktop: { width: '49%', flexGrow: 1 },
  cardTopRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm },
  caseIdentity: { flex: 1, minWidth: 0 },
  referenceLabel: { color: colors.inkSubtle, fontSize: 9, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  reference: { color: colors.ink, fontFamily: type.mono, fontSize: 13, fontWeight: '900', marginTop: 2 },
  category: { color: colors.ink, fontSize: 14, fontWeight: '900', marginTop: spacing.sm },
  targetRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  targetText: { flex: 1, color: colors.blue, fontSize: 10, lineHeight: 15, fontWeight: '700' },
  metaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  meta: { color: colors.inkSubtle, fontSize: 9, lineHeight: 14 },
  protectedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, padding: spacing.xs, marginTop: spacing.sm, borderRadius: radii.sm, backgroundColor: colors.plumSoft },
  protectedText: { color: colors.plum, fontSize: 10, fontWeight: '800' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, justifyContent: 'flex-end', marginTop: spacing.md, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  readOnlyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.xs, marginTop: spacing.sm },
  readOnlyText: { color: colors.inkSubtle, fontSize: 10, fontWeight: '700' },
  fieldLabel: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  helperText: { color: colors.inkMuted, fontSize: 10, lineHeight: 16 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  modalActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.xs },
  detailBoundary: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.mintSoft },
  detailBoundaryText: { flex: 1, color: colors.mintDark, fontSize: 10, lineHeight: 16, fontWeight: '700' },
  detailText: { color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
  evidenceList: { gap: spacing.sm },
  evidenceCard: { padding: spacing.sm, borderRadius: radii.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paperMuted },
  evidenceKind: { color: colors.mintDark, fontSize: 10, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.4 },
  evidenceSender: { color: colors.inkSubtle, fontSize: 10, marginTop: 3 },
  evidenceBody: { color: colors.ink, fontSize: 13, lineHeight: 19, marginTop: spacing.xs },
  hash: { color: colors.inkSubtle, fontFamily: type.mono, fontSize: 9, lineHeight: 14, marginTop: spacing.xs },
  historyHeading: { gap: 3 },
  historyList: { gap: spacing.sm },
  historyItem: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  historyCopy: { flex: 1, minWidth: 0, paddingBottom: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  historyEvent: { color: colors.ink, fontSize: 12, fontWeight: '900', textTransform: 'capitalize' },
  historyMeta: { color: colors.inkSubtle, fontSize: 9, marginTop: 2 },
  historyReason: { color: colors.inkMuted, fontSize: 11, lineHeight: 17, marginTop: spacing.xs },
});
