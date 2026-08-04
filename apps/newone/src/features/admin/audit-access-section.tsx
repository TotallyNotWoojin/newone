import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { useCallback, useMemo, useState } from 'react';
import {
  Platform,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ActionError, FormField } from '@/components/ui/action-modal';
import { Chip, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import type { AuditQueryInput } from '@/data/repositories/contracts';
import type {
  AuditAccessReason,
  AuditExportReceipt,
  PrivilegedAuditEvent,
} from '@/domain/types';
import { auditCopy } from '@/features/admin/audit-copy';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { colors, radii, shadow, spacing, type } from '@/theme/tokens';

type RangeChoice = 'day' | 'week' | 'month';
type QueryWithoutOrganization = Omit<AuditQueryInput, 'organizationId'>;

interface Props {
  privilegedReady: boolean;
  onVerifyNow: () => void;
}

const REASONS: AuditAccessReason[] = [
  'security_review',
  'compliance_review',
  'incident_investigation',
  'access_review',
];
const RANGES: RangeChoice[] = ['day', 'week', 'month'];
const RANGE_MILLIS: Record<RangeChoice, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$/;

function compactDigest(value: string) {
  return `${value.slice(0, 12)}…${value.slice(-12)}`;
}

export function AuditAccessSection({ privilegedReady, onVerifyNow }: Props) {
  const workspace = useWorkspace();
  const { locale } = useI18n();
  const copy = auditCopy(locale);
  const [reasonCode, setReasonCode] = useState<AuditAccessReason | null>(null);
  const [range, setRange] = useState<RangeChoice>('week');
  const [eventTypesText, setEventTypesText] = useState('');
  const [targetType, setTargetType] = useState('');
  const [targetId, setTargetId] = useState('');
  const [items, setItems] = useState<PrivilegedAuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [filterSha256, setFilterSha256] = useState<string | null>(null);
  const [queryReceiptId, setQueryReceiptId] = useState<string | null>(null);
  const [activeQuery, setActiveQuery] = useState<QueryWithoutOrganization | null>(null);
  const [receipt, setReceipt] = useState<AuditExportReceipt | null>(null);
  const [localError, setLocalError] = useState('');
  const [notice, setNotice] = useState('');
  const querying = workspace.actionBusy === 'audit-query';
  const exporting = workspace.actionBusy === 'audit-export';

  const peopleById = useMemo(
    () => new Map(workspace.people.map((person) => [person.id, person.displayName])),
    [workspace.people],
  );

  const dateTime = useCallback((value: string) => {
    try {
      return new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value));
    } catch {
      return value;
    }
  }, [locale]);

  const resetResults = () => {
    setItems([]);
    setNextCursor(null);
    setSnapshotAt(null);
    setFilterSha256(null);
    setQueryReceiptId(null);
    setActiveQuery(null);
    setReceipt(null);
    setNotice('');
    setLocalError('');
    workspace.clearActionError();
  };

  const buildQuery = (): QueryWithoutOrganization | null => {
    if (!reasonCode) {
      setLocalError(copy.chooseReason);
      return null;
    }
    const eventTypes = eventTypesText.split(',').map((value) => value.trim()).filter(Boolean);
    if (
      eventTypes.length > 10 || new Set(eventTypes).size !== eventTypes.length ||
      eventTypes.some((value) => !EVENT_TYPE_PATTERN.test(value))
    ) {
      setLocalError(copy.invalidEventTypes);
      return null;
    }
    const now = Date.now();
    return {
      reasonCode,
      dateFrom: new Date(now - RANGE_MILLIS[range]).toISOString(),
      dateTo: new Date(now).toISOString(),
      eventTypes,
      actorMembershipId: null,
      targetType: targetType.trim() || null,
      targetId: targetId.trim() || null,
      cursor: null,
      limit: 50,
    };
  };

  const viewRecords = async (append: boolean) => {
    if (!privilegedReady || querying || exporting) return;
    const query = append ? activeQuery : buildQuery();
    if (!query || (append && !nextCursor)) return;
    setLocalError('');
    setNotice('');
    workspace.clearActionError();
    const request = { ...query, cursor: append ? nextCursor : null };
    const page = await workspace.queryAudit(request);
    if (!page) {
      setLocalError(copy.actionFailed);
      return;
    }
    if (!append) setActiveQuery({ ...query, cursor: null });
    setItems((current) => append
      ? [...current, ...page.items.filter((row) => !current.some((item) => item.id === row.id))]
      : page.items);
    setNextCursor(page.nextCursor);
    setSnapshotAt(page.snapshotAt);
    setFilterSha256(page.filterSha256);
    setQueryReceiptId(page.receiptId);
  };

  const exportRecords = async (format: 'json' | 'csv') => {
    if (!privilegedReady || querying || exporting) return;
    const query = buildQuery();
    if (!query) return;
    setLocalError('');
    setNotice('');
    workspace.clearActionError();
    const result = await workspace.exportAudit({
      reasonCode: query.reasonCode,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      eventTypes: query.eventTypes,
      actorMembershipId: query.actorMembershipId,
      targetType: query.targetType,
      targetId: query.targetId,
      format,
    });
    if (!result) {
      setLocalError(copy.actionFailed);
      return;
    }
    setReceipt(result);
  };

  const saveExport = async () => {
    if (!receipt) return;
    try {
      const observedBytes = new TextEncoder().encode(receipt.payload).byteLength;
      const observedSha256 = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        receipt.payload,
      );
      if (observedBytes !== receipt.payloadBytes || observedSha256.toLowerCase() !== receipt.sha256) {
        setLocalError(copy.integrityFailed);
        return;
      }
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        const blob = new Blob([receipt.payload], { type: `${receipt.contentType};charset=utf-8` });
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = receipt.fileName;
        link.rel = 'noopener';
        link.click();
        URL.revokeObjectURL(href);
      } else {
        await Share.share({ message: receipt.payload, title: receipt.fileName });
      }
    } catch {
      setLocalError(copy.saveFailed);
    }
  };

  const outcomeLabel = (outcome: PrivilegedAuditEvent['outcome']) => copy[outcome];
  const outcomeTone = (outcome: PrivilegedAuditEvent['outcome']) =>
    outcome === 'succeeded' ? 'success' as const : 'danger' as const;

  return (
    <View style={styles.section}>
      <View style={styles.headingRow}>
        <View style={styles.headingIcon}>
          <Ionicons name="shield-checkmark-outline" size={22} color={colors.mintDark} />
        </View>
        <View style={styles.headingCopy}>
          <Text style={styles.eyebrow}>{copy.eyebrow}</Text>
          <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
          <Text style={styles.description}>{copy.description}</Text>
        </View>
      </View>

      <View style={styles.privacyNotice}>
        <Ionicons name="eye-off-outline" size={19} color={colors.blue} />
        <Text style={styles.privacyText}>{copy.privacyNotice}</Text>
      </View>

      {!privilegedReady ? (
        <View style={styles.verificationGate}>
          <View style={styles.gateCopy}>
            <Ionicons name="lock-closed-outline" size={20} color={colors.amber} />
            <Text style={styles.gateText}>{copy.verificationRequired}</Text>
          </View>
          <PrimaryButton icon="finger-print-outline" label={copy.verifyNow} onPress={onVerifyNow} tone="dark" />
        </View>
      ) : (
        <View style={[styles.controlCard, shadow]}>
          <View style={styles.controlGroup}>
            <Text style={styles.controlLabel}>{copy.reasonLabel}</Text>
            <Text style={styles.controlHelp}>{copy.reasonHelp}</Text>
            <View style={styles.chips}>
              {REASONS.map((reason) => (
                <Chip
                  key={reason}
                  label={copy.reasons[reason]}
                  onPress={() => {
                    setReasonCode(reason);
                    resetResults();
                  }}
                  selected={reasonCode === reason}
                />
              ))}
            </View>
          </View>

          <View style={styles.controlGroup}>
            <Text style={styles.controlLabel}>{copy.rangeLabel}</Text>
            <View style={styles.chips}>
              {RANGES.map((choice) => (
                <Chip
                  key={choice}
                  label={copy.ranges[choice]}
                  onPress={() => {
                    setRange(choice);
                    resetResults();
                  }}
                  selected={range === choice}
                />
              ))}
            </View>
          </View>

          <View style={styles.fields}>
            <View style={styles.fieldWide}>
              <FormField
                label={copy.eventTypesLabel}
                onChangeText={(value) => {
                  setEventTypesText(value);
                  resetResults();
                }}
                placeholder={copy.eventTypesPlaceholder}
                value={eventTypesText}
              />
            </View>
            <View style={styles.field}>
              <FormField
                label={copy.targetTypeLabel}
                onChangeText={(value) => {
                  setTargetType(value);
                  resetResults();
                }}
                placeholder={copy.targetTypePlaceholder}
                value={targetType}
              />
            </View>
            <View style={styles.field}>
              <FormField
                label={copy.targetIdLabel}
                onChangeText={(value) => {
                  setTargetId(value);
                  resetResults();
                }}
                placeholder={copy.targetIdPlaceholder}
                value={targetId}
              />
            </View>
          </View>

          <ActionError message={localError || workspace.actionError} />
          {notice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text> : null}
          <View style={styles.actions}>
            <PrimaryButton
              icon="search-outline"
              label={copy.viewRecords}
              loading={querying}
              onPress={() => void viewRecords(false)}
              tone="dark"
            />
            <PrimaryButton
              icon="code-download-outline"
              label={copy.exportJson}
              loading={exporting}
              onPress={() => void exportRecords('json')}
              tone="light"
            />
            <PrimaryButton
              icon="document-text-outline"
              label={copy.exportCsv}
              loading={exporting}
              onPress={() => void exportRecords('csv')}
              tone="light"
            />
          </View>
        </View>
      )}

      {privilegedReady && (snapshotAt || items.length > 0) ? (
        <View style={[styles.resultsCard, shadow]}>
          {snapshotAt && filterSha256 ? (
            <View style={styles.snapshotRow}>
              <Text style={styles.snapshotText}>{copy.snapshot}: {dateTime(snapshotAt)}</Text>
              <Text style={styles.receiptText}>
                {copy.filterReceipt}: {queryReceiptId ?? compactDigest(filterSha256)}
              </Text>
            </View>
          ) : null}
          {items.length ? items.map((event) => (
            <View key={event.id} style={styles.eventRow}>
              <View style={styles.eventIcon}>
                <Ionicons name="shield-outline" size={18} color={colors.mintDark} />
              </View>
              <View style={styles.eventCopy}>
                <Text style={styles.eventTitle}>{event.eventType}</Text>
                <Text style={styles.eventMeta}>
                  {peopleById.get(event.actorUserId ?? '') ?? copy.actorUnknown} · {event.targetType}
                </Text>
                <Text numberOfLines={1} style={styles.eventIdentifier}>{event.targetId}</Text>
                <Text style={styles.eventTime}>{dateTime(event.occurredAt)}</Text>
              </View>
              <StatusBadge label={outcomeLabel(event.outcome)} tone={outcomeTone(event.outcome)} />
            </View>
          )) : (
            <View style={styles.empty}>
              <Ionicons name="file-tray-outline" size={24} color={colors.inkSubtle} />
              <Text style={styles.emptyTitle}>{copy.emptyTitle}</Text>
              <Text style={styles.emptyBody}>{copy.emptyBody}</Text>
            </View>
          )}
          {nextCursor ? (
            <PrimaryButton
              icon="chevron-down-outline"
              label={copy.loadMore}
              loading={querying}
              onPress={() => void viewRecords(true)}
              tone="light"
            />
          ) : null}
        </View>
      ) : null}

      {receipt ? (
        <View style={[styles.exportCard, shadow]}>
          <View style={styles.exportIcon}>
            <Ionicons name="document-lock-outline" size={22} color={colors.plum} />
          </View>
          <View style={styles.exportCopy}>
            <Text style={styles.exportTitle}>{copy.exportReady}</Text>
            <Text style={styles.exportMeta}>
              {receipt.fileName} · {receipt.rowCount} {copy.rows} · {receipt.payloadBytes.toLocaleString(locale)} B
            </Text>
            <Text style={styles.exportMeta}>{copy.exportReceipt}: {receipt.receiptId}</Text>
            <Text selectable style={styles.digest}>{copy.digest}: {receipt.sha256}</Text>
          </View>
          <PrimaryButton
            icon={Platform.OS === 'web' ? 'download-outline' : 'share-outline'}
            label={copy.saveExport}
            onPress={() => void saveExport()}
            tone="dark"
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.md },
  headingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  headingIcon: {
    width: 44,
    height: 44,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.mintSoft,
  },
  headingCopy: { flex: 1, gap: spacing.xxs },
  eyebrow: {
    color: colors.mintDark,
    fontFamily: type.body,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  title: { color: colors.ink, fontFamily: type.display, fontSize: 24, fontWeight: '800' },
  description: { color: colors.inkMuted, fontFamily: type.body, fontSize: 14, lineHeight: 21 },
  privacyNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.blueSoft,
  },
  privacyText: { flex: 1, color: colors.blue, fontFamily: type.body, fontSize: 13, lineHeight: 19 },
  verificationGate: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.amber,
    borderRadius: radii.lg,
    backgroundColor: colors.amberSoft,
  },
  gateCopy: { flex: 1, minWidth: 240, flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  gateText: { flex: 1, color: colors.amber, fontFamily: type.body, fontSize: 14, lineHeight: 20 },
  controlCard: { padding: spacing.lg, borderRadius: radii.lg, backgroundColor: colors.paper, gap: spacing.lg },
  controlGroup: { gap: spacing.xs },
  controlLabel: { color: colors.ink, fontFamily: type.body, fontSize: 14, fontWeight: '800' },
  controlHelp: { color: colors.inkMuted, fontFamily: type.body, fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  fieldWide: { flexGrow: 2, flexBasis: 320 },
  field: { flexGrow: 1, flexBasis: 220 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  notice: { color: colors.mintDark, fontFamily: type.body, fontSize: 13, fontWeight: '700' },
  resultsCard: { padding: spacing.md, borderRadius: radii.lg, backgroundColor: colors.paper, gap: spacing.sm },
  snapshotRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: spacing.xs,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  snapshotText: { color: colors.inkMuted, fontFamily: type.body, fontSize: 12 },
  receiptText: { color: colors.inkSubtle, fontFamily: type.mono, fontSize: 11 },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  eventIcon: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.mintSoft,
  },
  eventCopy: { flex: 1, minWidth: 0, gap: 2 },
  eventTitle: { color: colors.ink, fontFamily: type.body, fontSize: 14, fontWeight: '800' },
  eventMeta: { color: colors.inkMuted, fontFamily: type.body, fontSize: 12 },
  eventIdentifier: { color: colors.inkSubtle, fontFamily: type.mono, fontSize: 11 },
  eventTime: { color: colors.inkSubtle, fontFamily: type.body, fontSize: 11 },
  empty: { alignItems: 'center', gap: spacing.xs, padding: spacing.xl },
  emptyTitle: { color: colors.ink, fontFamily: type.display, fontSize: 17, fontWeight: '800' },
  emptyBody: { maxWidth: 520, textAlign: 'center', color: colors.inkMuted, fontFamily: type.body, fontSize: 13 },
  exportCard: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.plumSoft,
  },
  exportIcon: {
    width: 44,
    height: 44,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.paper,
  },
  exportCopy: { flex: 1, minWidth: 260, gap: spacing.xxs },
  exportTitle: { color: colors.plum, fontFamily: type.display, fontSize: 17, fontWeight: '800' },
  exportMeta: { color: colors.inkMuted, fontFamily: type.body, fontSize: 12 },
  digest: { color: colors.ink, fontFamily: type.mono, fontSize: 11 },
});
