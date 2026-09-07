import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { ActionError, FormField } from '@/components/ui/action-modal';
import { Chip, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import {
  parseDynamicGroupPolicySpec,
  type DynamicGroupMembershipRole,
  type DynamicGroupPolicy,
  type DynamicGroupPolicySpec,
  type DynamicGroupPreviewReceipt,
  type DynamicGroupShiftMode,
} from '@/data/repositories/dynamic-group-dto.mjs';
import type { OrganizationUnitOption } from '@/data/repositories/contracts';
import { dynamicGroupCopy } from '@/features/admin/dynamic-group-copy';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { radii, shadow, spacing, type } from '@/theme/tokens';
import { useThemedStyles, type ThemeColors } from '@/theme/provider';

const membershipRoleOrder: DynamicGroupMembershipRole[] = ['owner', 'admin', 'manager', 'member'];

export function DynamicGroupSection({ privilegedReady }: { privilegedReady: boolean }) {
  const styles = useThemedStyles(buildStyles);
  const workspace = useWorkspace();
  const { locale } = useI18n();
  const copy = dynamicGroupCopy(locale);
  const loadedOrganizationRef = useRef('');
  const [policyId, setPolicyId] = useState<string | null>(null);
  const [expectedVersion, setExpectedVersion] = useState(0);
  const [conversationId, setConversationId] = useState('');
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [lineIds, setLineIds] = useState<string[]>([]);
  const [unitIds, setUnitIds] = useState<string[]>([]);
  const [includeDescendants, setIncludeDescendants] = useState(false);
  const [membershipRoles, setMembershipRoles] = useState<DynamicGroupMembershipRole[]>(['member']);
  const [operationalRoles, setOperationalRoles] = useState('');
  const [shiftMode, setShiftMode] = useState<DynamicGroupShiftMode>('none');
  const [scheduledShiftStartsAt, setScheduledShiftStartsAt] = useState('');
  const [scheduledShiftEndsAt, setScheduledShiftEndsAt] = useState('');
  const [maximumMembers, setMaximumMembers] = useState('500');
  const [preview, setPreview] = useState<DynamicGroupPreviewReceipt | null>(null);
  const [previewFresh, setPreviewFresh] = useState(false);
  const [pauseReason, setPauseReason] = useState('');
  const [notice, setNotice] = useState('');
  const canManage = workspace.hasCapability('unit.manage');

  useEffect(() => {
    if (!privilegedReady || !canManage || !workspace.organizationId) {
      loadedOrganizationRef.current = '';
      return;
    }
    if (loadedOrganizationRef.current === workspace.organizationId) return;
    loadedOrganizationRef.current = workspace.organizationId;
    void workspace.loadDynamicGroupPolicies(false);
  }, [canManage, privilegedReady, workspace]);

  const conversations = useMemo(
    () => workspace.conversations.filter((conversation) =>
      ['group', 'team', 'shift'].includes(conversation.kind) &&
      !conversation.archived && conversation.canManageDynamicGroup === true
    ),
    [workspace.conversations],
  );
  const conversationKindLabel = {
    group: copy.groupKind,
    team: copy.teamKind,
    shift: copy.shiftKind,
  } as const;
  const membershipRoleLabel: Record<DynamicGroupMembershipRole, string> = {
    owner: copy.ownerRole,
    admin: copy.adminRole,
    manager: copy.managerRole,
    member: copy.memberRole,
  };
  const selectedPolicy = workspace.dynamicGroupPolicies.find((policy) =>
    policy.policyId === policyId
  );
  const selectorKey = JSON.stringify({
    conversationId,
    siteIds,
    departmentIds,
    teamIds,
    lineIds,
    unitIds,
    includeDescendants,
    membershipRoles,
    operationalRoles,
    shiftMode,
    scheduledShiftStartsAt,
    scheduledShiftEndsAt,
    maximumMembers,
  });
  const previousSelectorKeyRef = useRef(selectorKey);

  useEffect(() => {
    if (previousSelectorKeyRef.current === selectorKey) return;
    previousSelectorKeyRef.current = selectorKey;
    setPreview(null);
    setNotice('');
  }, [selectorKey]);

  useEffect(() => {
    if (!preview) return;
    const remainingMs = Date.parse(preview.validUntil) - Date.now();
    const timer = setTimeout(() => setPreviewFresh(false), Math.max(0, remainingMs));
    return () => clearTimeout(timer);
  }, [preview]);

  const startNew = () => {
    setPolicyId(null);
    setExpectedVersion(0);
    setConversationId(conversations[0]?.id ?? '');
    setSiteIds([]);
    setDepartmentIds([]);
    setTeamIds([]);
    setLineIds([]);
    setUnitIds([]);
    setIncludeDescendants(false);
    setMembershipRoles(['member']);
    setOperationalRoles('');
    setShiftMode('none');
    setScheduledShiftStartsAt('');
    setScheduledShiftEndsAt('');
    setMaximumMembers('500');
    setPreview(null);
    setPauseReason('');
    setNotice('');
    workspace.clearActionError();
  };

  const editPolicy = (policy: DynamicGroupPolicy) => {
    setPolicyId(policy.policyId);
    setExpectedVersion(policy.version);
    setConversationId(policy.conversationId);
    setSiteIds(policy.policySpec.siteIds);
    setDepartmentIds(policy.policySpec.departmentIds);
    setTeamIds(policy.policySpec.teamIds);
    setLineIds(policy.policySpec.lineIds);
    setUnitIds(policy.policySpec.unitIds);
    setIncludeDescendants(policy.policySpec.includeDescendants);
    setMembershipRoles(policy.policySpec.membershipRoles);
    setOperationalRoles(policy.policySpec.operationalRoles.join(', '));
    setShiftMode(policy.policySpec.shiftMode);
    setScheduledShiftStartsAt(policy.policySpec.scheduledShiftStartsAt ?? '');
    setScheduledShiftEndsAt(policy.policySpec.scheduledShiftEndsAt ?? '');
    setMaximumMembers(String(policy.maximumMembers));
    setPreview(null);
    setPauseReason('');
    setNotice('');
    workspace.clearActionError();
  };

  const setUnitSelected = (unit: OrganizationUnitOption) => {
    const setter = unit.kind === 'site'
      ? setSiteIds
      : unit.kind === 'department'
        ? setDepartmentIds
        : unit.kind === 'team'
          ? setTeamIds
          : unit.kind === 'line'
            ? setLineIds
            : setUnitIds;
    setter((current) => current.includes(unit.unitId)
      ? current.filter((id) => id !== unit.unitId)
      : [...current, unit.unitId].sort());
  };

  const selectedUnit = (unit: OrganizationUnitOption) => {
    const ids = unit.kind === 'site'
      ? siteIds
      : unit.kind === 'department'
        ? departmentIds
        : unit.kind === 'team'
          ? teamIds
          : unit.kind === 'line'
            ? lineIds
            : unitIds;
    return ids.includes(unit.unitId);
  };

  const toggleMembershipRole = (role: DynamicGroupMembershipRole) => {
    setMembershipRoles((current) => current.includes(role)
      ? current.filter((item) => item !== role)
      : [...current, role].sort() as DynamicGroupMembershipRole[]);
  };

  const buildPolicySpec = (): DynamicGroupPolicySpec | null => {
    const roleText = operationalRoles
      .split(/[,;\n]/)
      .map((role) => role.trim().toLocaleLowerCase('en-US'))
      .filter(Boolean);
    if (new Set(roleText).size !== roleText.length) return null;
    let startsAt: string | null = null;
    let endsAt: string | null = null;
    if (shiftMode === 'scheduled') {
      const start = Date.parse(scheduledShiftStartsAt.trim());
      const end = Date.parse(scheduledShiftEndsAt.trim());
      if (
        !Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
        end - start > 31 * 24 * 60 * 60 * 1000
      ) return null;
      startsAt = new Date(start).toISOString();
      endsAt = new Date(end).toISOString();
    }
    try {
      return parseDynamicGroupPolicySpec({
        siteIds: [...siteIds].sort(),
        departmentIds: [...departmentIds].sort(),
        teamIds: [...teamIds].sort(),
        lineIds: [...lineIds].sort(),
        unitIds: [...unitIds].sort(),
        includeDescendants,
        operationalRoles: [...roleText].sort(),
        membershipRoles: [...membershipRoles].sort(),
        shiftMode,
        scheduledShiftStartsAt: startsAt,
        scheduledShiftEndsAt: endsAt,
      });
    } catch {
      return null;
    }
  };

  const memberLimit = Number(maximumMembers);
  const preparedSpec = buildPolicySpec();
  const formValid = Boolean(
    conversationId && preparedSpec && membershipRoles.length &&
    Number.isInteger(memberLimit) && memberLimit >= 1 && memberLimit <= 5000,
  );
  const previewIsFresh = Boolean(
    preview && previewFresh && policyId && preview.policyId === policyId &&
    preview.policyVersion === expectedVersion,
  );

  const saveAndPreview = async () => {
    workspace.clearActionError();
    setNotice('');
    if (!preparedSpec || !formValid) {
      setNotice(copy.invalidForm);
      return;
    }
    const saved = await workspace.saveDynamicGroupPolicy({
      conversationId,
      policyId,
      expectedVersion,
      policySpec: preparedSpec,
      maximumMembers: memberLimit,
    });
    if (!saved) return;
    setPolicyId(saved.policyId);
    setExpectedVersion(saved.version);
    const nextPreview = await workspace.previewDynamicGroupPolicy(saved.policyId, saved.version, 50);
    if (!nextPreview) {
      await workspace.loadDynamicGroupPolicies(false);
      return;
    }
    setPreviewFresh(true);
    setPreview(nextPreview);
    setNotice(copy.savedNotice);
    await workspace.loadDynamicGroupPolicies(false);
  };

  const publish = async () => {
    if (!preview || !policyId || !previewIsFresh) return;
    workspace.clearActionError();
    setNotice('');
    const receipt = await workspace.publishDynamicGroupPolicy(
      policyId,
      expectedVersion,
      preview.previewFingerprint,
    );
    if (!receipt) return;
    setPreview(null);
    setNotice(copy.publishedNotice);
    await workspace.loadDynamicGroupPolicies(false);
  };

  const pause = async () => {
    if (!policyId || pauseReason.trim().length < 3) return;
    workspace.clearActionError();
    setNotice('');
    const receipt = await workspace.pauseDynamicGroupPolicy(
      policyId,
      expectedVersion,
      pauseReason.trim(),
    );
    if (!receipt) return;
    setPauseReason('');
    setPreview(null);
    setNotice(copy.pausedNotice);
    await workspace.loadDynamicGroupPolicies(false);
  };

  const personLabel = (id: string) => {
    const person = workspace.people.find((candidate) => candidate.id === id) ??
      (workspace.currentUser?.id === id ? workspace.currentUser : null);
    return person?.displayName ?? `${id.slice(0, 8)}…${id.slice(-4)}`;
  };

  return (
    <View style={[styles.section, shadow]} testID="dynamic-group-section">
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>{copy.eyebrow}</Text>
          <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
          <Text style={styles.description}>{copy.description}</Text>
        </View>
        <StatusBadge
          label={privilegedReady ? copy.aal2Ready : copy.aal2Locked}
          tone={privilegedReady ? 'success' : 'warning'}
        />
      </View>
      <Text style={styles.security}>{copy.securityNote}</Text>

      {!canManage ? <Text style={styles.warning}>{copy.accessDenied}</Text> : (
        <>
          <View style={styles.toolbar}>
            <Text style={styles.subtitle}>{copy.policies}</Text>
            <View style={styles.row}>
              <PrimaryButton
                disabled={!privilegedReady}
                icon="refresh-outline"
                label={copy.refresh}
                loading={workspace.actionBusy === 'dynamic-group-list'}
                onPress={() => void workspace.loadDynamicGroupPolicies(false)}
                tone="light"
              />
              <PrimaryButton
                disabled={!privilegedReady}
                icon="add-outline"
                label={copy.newPolicy}
                onPress={startNew}
                tone="dark"
              />
            </View>
          </View>

          {workspace.dynamicGroupPolicies.length ? (
            <View style={styles.policyGrid}>
              {workspace.dynamicGroupPolicies.map((policy) => (
                <Pressable
                  accessibilityLabel={`${policy.conversationName}, ${copy.version} ${policy.version}`}
                  accessibilityRole="button"
                  key={policy.policyId}
                  onPress={() => editPolicy(policy)}
                  style={({ pressed }) => [
                    styles.policyCard,
                    policy.policyId === policyId && styles.policyCardSelected,
                    pressed && styles.pressed,
                  ]}>
                  <View style={styles.policyCardHeader}>
                    <Text numberOfLines={1} style={styles.policyName}>{policy.conversationName}</Text>
                    <StatusBadge
                      label={copy[policy.status]}
                      tone={policy.status === 'active' ? 'success' : policy.status === 'paused' ? 'warning' : 'neutral'}
                    />
                  </View>
                  <Text style={styles.meta}>
                    {conversationKindLabel[policy.conversationKind]} · {copy.version} {policy.version} · {copy[policy.draftState]}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : <Text style={styles.empty}>{copy.noPolicies}</Text>}
          {workspace.dynamicGroupNextAfterPolicyId ? (
            <PrimaryButton
              disabled={!privilegedReady}
              label={copy.loadMore}
              loading={workspace.actionBusy === 'dynamic-group-list'}
              onPress={() => void workspace.loadDynamicGroupPolicies(true)}
              tone="light"
            />
          ) : null}

          <View style={styles.divider} />
          <Text style={styles.subtitle}>{copy.conversation}</Text>
          <View style={styles.row}>
            {conversations.map((conversation) => (
              <Chip
                key={conversation.id}
                label={conversation.title}
                onPress={policyId ? undefined : () => setConversationId(conversation.id)}
                selected={conversation.id === conversationId}
              />
            ))}
          </View>
          {policyId ? <Text style={styles.note}>{copy.conversationLocked}</Text> : null}

          <View style={styles.group}>
            <Text style={styles.subtitle}>{copy.selectors}</Text>
            <Text style={styles.note}>{copy.selectorsNote}</Text>
            {workspace.units.length ? (
              <View style={styles.row}>
                {workspace.units.map((unit) => (
                  <Chip
                    key={unit.unitId}
                    label={`${copy[unit.kind]} · ${unit.name}`}
                    onPress={() => setUnitSelected(unit)}
                    selected={selectedUnit(unit)}
                  />
                ))}
              </View>
            ) : <Text style={styles.empty}>{copy.noUnits}</Text>}
            <View style={styles.switchRow}>
              <View style={styles.switchCopy}>
                <Text style={styles.label}>{copy.descendants}</Text>
                <Text style={styles.note}>{copy.descendantsNote}</Text>
              </View>
              <Switch
                accessibilityLabel={copy.descendants}
                onValueChange={setIncludeDescendants}
                value={includeDescendants}
              />
            </View>
          </View>

          <View style={styles.group}>
            <Text style={styles.subtitle}>{copy.membershipRoles}</Text>
            <View style={styles.row}>
              {membershipRoleOrder.map((role) => (
                <Chip
                  key={role}
                  label={membershipRoleLabel[role]}
                  onPress={() => toggleMembershipRole(role)}
                  selected={membershipRoles.includes(role)}
                />
              ))}
            </View>
            <FormField
              label={copy.operationalRoles}
              onChangeText={setOperationalRoles}
              placeholder={copy.operationalRolesPlaceholder}
              value={operationalRoles}
            />
            <Text style={styles.note}>{copy.operationalRolesNote}</Text>
          </View>

          <View style={styles.group}>
            <Text style={styles.subtitle}>{copy.shiftWindow}</Text>
            <View style={styles.row}>
              {([
                ['none', copy.shiftNone],
                ['current', copy.shiftCurrent],
                ['scheduled', copy.shiftScheduled],
              ] as const).map(([mode, label]) => (
                <Chip
                  key={mode}
                  label={label}
                  onPress={() => {
                    setShiftMode(mode);
                    if (mode !== 'scheduled') {
                      setScheduledShiftStartsAt('');
                      setScheduledShiftEndsAt('');
                    }
                  }}
                  selected={shiftMode === mode}
                />
              ))}
            </View>
            {shiftMode === 'scheduled' ? (
              <View style={styles.fieldGrid}>
                <View style={styles.fieldCell}>
                  <FormField
                    label={copy.shiftStarts}
                    onChangeText={setScheduledShiftStartsAt}
                    placeholder="2026-08-04T18:00:00-06:00"
                    value={scheduledShiftStartsAt}
                  />
                </View>
                <View style={styles.fieldCell}>
                  <FormField
                    label={copy.shiftEnds}
                    onChangeText={setScheduledShiftEndsAt}
                    placeholder="2026-08-05T06:00:00-06:00"
                    value={scheduledShiftEndsAt}
                  />
                </View>
              </View>
            ) : null}
            <FormField
              keyboardType="number-pad"
              label={copy.maxMembers}
              onChangeText={setMaximumMembers}
              value={maximumMembers}
            />
          </View>

          <PrimaryButton
            disabled={!privilegedReady || !formValid}
            icon="people-circle-outline"
            label={workspace.actionBusy === 'dynamic-group-save' || workspace.actionBusy === 'dynamic-group-preview'
              ? copy.savingPreview : copy.savePreview}
            loading={workspace.actionBusy === 'dynamic-group-save' || workspace.actionBusy === 'dynamic-group-preview'}
            onPress={() => void saveAndPreview()}
            tone="dark"
          />

          {preview ? (
            <View style={styles.preview} testID="dynamic-group-preview">
              <View style={styles.policyCardHeader}>
                <Text style={styles.subtitle}>{copy.previewTitle}</Text>
                <StatusBadge
                  label={`${copy.version} ${preview.policyVersion}`}
                  tone={previewIsFresh ? 'success' : 'warning'}
                />
              </View>
              <Text style={styles.note}>
                {copy.previewExpires}: {new Date(preview.validUntil).toLocaleString(locale)}
              </Text>
              <View style={styles.countGrid}>
                <Count label={copy.eligible} value={preview.eligibleCount} />
                <Count label={copy.added} value={preview.addedCount} />
                <Count label={copy.removed} value={preview.removedCount} />
                <Count label={copy.unchanged} value={preview.unchangedCount} />
              </View>
              <SampleList copy={copy} ids={preview.addedSampleUserIds} label={copy.added} personLabel={personLabel} />
              <SampleList copy={copy} ids={preview.removedSampleUserIds} label={copy.removed} personLabel={personLabel} />
              <SampleList copy={copy} ids={preview.unchangedSampleUserIds} label={copy.unchanged} personLabel={personLabel} />
              {!previewIsFresh ? <Text style={styles.warning}>{copy.stalePreview}</Text> : null}
              <PrimaryButton
                disabled={!privilegedReady || !previewIsFresh}
                icon="cloud-upload-outline"
                label={workspace.actionBusy === 'dynamic-group-publish' ? copy.publishing : copy.publish}
                loading={workspace.actionBusy === 'dynamic-group-publish'}
                onPress={() => void publish()}
                tone="accent"
              />
            </View>
          ) : null}

          {selectedPolicy?.status === 'active' ? (
            <View style={styles.pausePanel}>
              <FormField
                label={copy.pauseReason}
                multiline
                onChangeText={setPauseReason}
                placeholder={copy.pauseReasonPlaceholder}
                value={pauseReason}
              />
              <PrimaryButton
                disabled={!privilegedReady || pauseReason.trim().length < 3 || pauseReason.trim().length > 500}
                icon="pause-circle-outline"
                label={workspace.actionBusy === 'dynamic-group-pause' ? copy.pausing : copy.pause}
                loading={workspace.actionBusy === 'dynamic-group-pause'}
                onPress={() => void pause()}
                tone="danger"
              />
            </View>
          ) : null}
          {notice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text> : null}
          <ActionError message={workspace.actionError} />
        </>
      )}
    </View>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.count}>
      <Text style={styles.countValue}>{value}</Text>
      <Text style={styles.meta}>{label}</Text>
    </View>
  );
}

function SampleList({
  copy,
  ids,
  label,
  personLabel,
}: {
  copy: ReturnType<typeof dynamicGroupCopy>;
  ids: string[];
  label: string;
  personLabel: (id: string) => string;
}) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.sampleBlock}>
      <Text style={styles.label}>{label} · {copy.sample}</Text>
      <Text style={styles.note}>
        {ids.length ? ids.map(personLabel).join(', ') : copy.noSample}
      </Text>
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  section: {
    backgroundColor: colors.paper,
    borderColor: colors.line,
    borderRadius: radii.xl,
    borderWidth: 1,
    gap: spacing.lg,
    padding: spacing.xl,
  },
  header: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, justifyContent: 'space-between' },
  headerCopy: { flex: 1, gap: spacing.xs, minWidth: 240 },
  eyebrow: { color: colors.mintDark, fontFamily: type.body, fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: colors.ink, fontFamily: type.display, fontSize: 22, fontWeight: '700' },
  subtitle: { color: colors.ink, fontFamily: type.display, fontSize: 17, fontWeight: '700' },
  description: { color: colors.inkMuted, fontFamily: type.body, fontSize: 14, lineHeight: 20 },
  security: { backgroundColor: colors.blueSoft, borderRadius: radii.md, color: colors.blue, fontFamily: type.body, fontSize: 12, lineHeight: 18, padding: spacing.md },
  warning: { backgroundColor: colors.amberSoft, borderRadius: radii.md, color: colors.amber, fontFamily: type.body, fontSize: 12, lineHeight: 18, padding: spacing.md },
  notice: { backgroundColor: colors.mintSoft, borderRadius: radii.md, color: colors.mintDark, fontFamily: type.body, fontSize: 12, lineHeight: 18, padding: spacing.md },
  toolbar: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, justifyContent: 'space-between' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  group: { gap: spacing.md },
  policyGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  policyCard: { backgroundColor: colors.paperMuted, borderColor: colors.line, borderRadius: radii.lg, borderWidth: 1, flexGrow: 1, gap: spacing.xs, minWidth: 220, padding: spacing.md },
  policyCardSelected: { borderColor: colors.mintDark, borderWidth: 2 },
  policyCardHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, justifyContent: 'space-between' },
  policyName: { color: colors.ink, flex: 1, fontFamily: type.body, fontSize: 14, fontWeight: '800' },
  meta: { color: colors.inkMuted, fontFamily: type.body, fontSize: 11, lineHeight: 16 },
  note: { color: colors.inkMuted, fontFamily: type.body, fontSize: 12, lineHeight: 18 },
  label: { color: colors.ink, fontFamily: type.body, fontSize: 12, fontWeight: '800' },
  empty: { color: colors.inkMuted, fontFamily: type.body, fontSize: 13, fontStyle: 'italic' },
  switchRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.md, justifyContent: 'space-between' },
  switchCopy: { flex: 1, gap: spacing.xs },
  fieldGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  fieldCell: { flex: 1, minWidth: 220 },
  divider: { backgroundColor: colors.line, height: StyleSheet.hairlineWidth },
  preview: { backgroundColor: colors.mintSoft, borderColor: colors.mint, borderRadius: radii.lg, borderWidth: 1, gap: spacing.md, padding: spacing.lg },
  countGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  count: { backgroundColor: colors.paper, borderRadius: radii.md, flexGrow: 1, minWidth: 100, padding: spacing.md },
  countValue: { color: colors.ink, fontFamily: type.display, fontSize: 24, fontWeight: '800' },
  sampleBlock: { gap: spacing.xs },
  pausePanel: { backgroundColor: colors.redSoft, borderRadius: radii.lg, gap: spacing.md, padding: spacing.lg },
  pressed: { opacity: 0.72 },
});
