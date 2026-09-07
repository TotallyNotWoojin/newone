import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';

import { ActionError, FormField } from '@/components/ui/action-modal';
import { Chip, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import type { OrganizationPolicy } from '@/data/repositories/organization-policy-dto.mjs';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { radii, shadow, spacing, type } from '@/theme/tokens';
import { useThemedStyles, type ThemeColors } from '@/theme/provider';

export function OrganizationPolicySection({ privilegedReady }: { privilegedReady: boolean }) {
  const styles = useThemedStyles(buildStyles);
  const workspace = useWorkspace();
  const { t } = useI18n();
  const policy = workspace.organizationPolicy;
  if (!policy) {
    return (
      <View style={[styles.section, shadow]}>
        <Text style={styles.description}>{t('status.loading')}</Text>
      </View>
    );
  }
  return <OrganizationPolicyEditor policy={policy} privilegedReady={privilegedReady} />;
}

function OrganizationPolicyEditor({
  policy,
  privilegedReady,
}: {
  policy: OrganizationPolicy;
  privilegedReady: boolean;
}) {
  const styles = useThemedStyles(buildStyles);
  const workspace = useWorkspace();
  const { t } = useI18n();
  const [messageRetentionDays, setMessageRetentionDays] = useState(String(policy.messageRetentionDays));
  const [allowMemberDirectMessages, setAllowMemberDirectMessages] = useState(policy.allowMemberDirectMessages);
  const [dmPolicy, setDmPolicy] = useState(policy.dmPolicy);
  const [requireMfaForAdmins, setRequireMfaForAdmins] = useState(policy.requireMfaForAdmins);
  const [shiftScheduleAuthoritative, setShiftScheduleAuthoritative] = useState(policy.shiftScheduleAuthoritative);
  const [groupCreationPolicy, setGroupCreationPolicy] = useState(policy.groupCreationPolicy);
  const [allowExternalGuests, setAllowExternalGuests] = useState(policy.allowExternalGuests);
  const [externalGuestMaxAccessDays, setExternalGuestMaxAccessDays] = useState(
    String(policy.externalGuestMaxAccessDays),
  );
  const [reason, setReason] = useState('');
  const creatorLabels = {
    members: t('admin.organizationPolicyCreators.members'),
    managers: t('admin.organizationPolicyCreators.managers'),
    admins: t('admin.organizationPolicyCreators.admins'),
  };
  const dmPolicyLabels = {
    directory_open: t('admin.organizationPolicyDm.directory_open'),
    request_first: t('admin.organizationPolicyDm.request_first'),
    scoped_unit: t('admin.organizationPolicyDm.scoped_unit'),
  };

  useEffect(() => {
    const timeout = setTimeout(() => {
      setMessageRetentionDays(String(policy.messageRetentionDays));
      setAllowMemberDirectMessages(policy.allowMemberDirectMessages);
      setDmPolicy(policy.dmPolicy);
      setRequireMfaForAdmins(policy.requireMfaForAdmins);
      setShiftScheduleAuthoritative(policy.shiftScheduleAuthoritative);
      setGroupCreationPolicy(policy.groupCreationPolicy);
      setAllowExternalGuests(policy.allowExternalGuests);
      setExternalGuestMaxAccessDays(String(policy.externalGuestMaxAccessDays));
    }, 0);
    return () => clearTimeout(timeout);
  }, [policy]);

  const retentionDays = Number(messageRetentionDays);
  const guestDays = Number(externalGuestMaxAccessDays);
  const changed = useMemo(() =>
    retentionDays !== policy.messageRetentionDays
    || allowMemberDirectMessages !== policy.allowMemberDirectMessages
    || dmPolicy !== policy.dmPolicy
    || requireMfaForAdmins !== policy.requireMfaForAdmins
    || shiftScheduleAuthoritative !== policy.shiftScheduleAuthoritative
    || groupCreationPolicy !== policy.groupCreationPolicy
    || allowExternalGuests !== policy.allowExternalGuests
    || guestDays !== policy.externalGuestMaxAccessDays, [
      allowExternalGuests,
      allowMemberDirectMessages,
      dmPolicy,
      groupCreationPolicy,
      guestDays,
      policy,
      requireMfaForAdmins,
      retentionDays,
      shiftScheduleAuthoritative,
    ]);
  const valid = Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 3650
    && Number.isInteger(guestDays) && guestDays >= 1 && guestDays <= 365
    && reason.trim().length >= 3 && reason.trim().length <= 500;

  const save = async () => {
    workspace.clearActionError();
    const saved = await workspace.updateOrganizationPolicy({
      messageRetentionDays: retentionDays,
      allowMemberDirectMessages,
      dmPolicy,
      requireMfaForAdmins,
      shiftScheduleAuthoritative,
      groupCreationPolicy,
      allowExternalGuests,
      externalGuestMaxAccessDays: guestDays,
      version: policy.version,
      reason: reason.trim(),
    });
    if (saved) setReason('');
  };

  return (
    <View style={[styles.section, shadow]}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>{t('admin.organizationPolicyEyebrow')}</Text>
          <Text accessibilityRole="header" style={styles.title}>
            {t('admin.organizationPolicyTitle')}
          </Text>
          <Text style={styles.description}>{t('admin.organizationPolicyDescription')}</Text>
        </View>
        <StatusBadge
          label={privilegedReady ? t('admin.aal2Ready') : t('admin.aal2Locked')}
          tone={privilegedReady ? 'success' : 'warning'}
        />
      </View>

      <View style={styles.group}>
        <Text style={styles.subtitle}>{t('admin.organizationPolicyGroupCreation')}</Text>
        <Text style={styles.note}>{t('admin.organizationPolicyGroupCreationDescription')}</Text>
        <View style={styles.row}>
          {(['members', 'managers', 'admins'] as const).map((value) => (
            <Chip
              key={value}
              label={creatorLabels[value]}
              onPress={() => setGroupCreationPolicy(value)}
              selected={groupCreationPolicy === value}
            />
          ))}
        </View>
        <PolicySwitch
          label={t('admin.organizationPolicyExternalGuests')}
          note={t('admin.organizationPolicyExternalGuestsDescription')}
          onValueChange={setAllowExternalGuests}
          value={allowExternalGuests}
        />
        <FormField
          keyboardType="number-pad"
          label={t('admin.organizationPolicyGuestDays')}
          onChangeText={setExternalGuestMaxAccessDays}
          value={externalGuestMaxAccessDays}
        />
        <PolicySwitch
          label={t('admin.organizationPolicyShiftAuthority')}
          note={t('admin.organizationPolicyShiftAuthorityDescription')}
          onValueChange={setShiftScheduleAuthoritative}
          value={shiftScheduleAuthoritative}
        />
      </View>

      <View style={styles.divider} />

      <View style={styles.group}>
        <Text style={styles.subtitle}>{t('admin.organizationPolicySecurity')}</Text>
        <PolicySwitch
          label={t('admin.organizationPolicyMemberDms')}
          note={t('admin.organizationPolicyMemberDmsDescription')}
          onValueChange={setAllowMemberDirectMessages}
          value={allowMemberDirectMessages}
        />
        <Text style={styles.label}>{t('admin.organizationPolicyDmPolicy')}</Text>
        <View style={styles.row}>
          {(['directory_open', 'request_first', 'scoped_unit'] as const).map((value) => (
            <Chip
              key={value}
              label={dmPolicyLabels[value]}
              onPress={() => setDmPolicy(value)}
              selected={dmPolicy === value}
            />
          ))}
        </View>
        <PolicySwitch
          label={t('admin.organizationPolicyAdminMfa')}
          note={t('admin.organizationPolicyAdminMfaDescription')}
          onValueChange={setRequireMfaForAdmins}
          value={requireMfaForAdmins}
        />
        <FormField
          keyboardType="number-pad"
          label={t('admin.organizationPolicyRetentionDays')}
          onChangeText={setMessageRetentionDays}
          value={messageRetentionDays}
        />
      </View>

      <FormField
        label={t('admin.organizationPolicyReason')}
        multiline
        onChangeText={setReason}
        placeholder={t('admin.organizationPolicyReasonPlaceholder')}
        value={reason}
      />
      <Text style={styles.note}>{t('admin.organizationPolicyOwnerOnly')}</Text>
      <ActionError message={workspace.actionError} />
      <PrimaryButton
        disabled={!privilegedReady || !changed || !valid}
        icon="shield-checkmark-outline"
        label={t('admin.organizationPolicySave')}
        loading={workspace.actionBusy === 'organization-policy-update'}
        onPress={() => void save()}
        tone="dark"
      />
    </View>
  );
}

function PolicySwitch({
  label,
  note,
  value,
  onValueChange,
}: {
  label: string;
  note: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchCopy}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.note}>{note}</Text>
      </View>
      <Switch accessibilityLabel={label} onValueChange={onValueChange} value={value} />
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
  header: { flexDirection: 'row', gap: spacing.md, justifyContent: 'space-between' },
  headerCopy: { flex: 1, gap: spacing.xs },
  eyebrow: { color: colors.mintDark, fontFamily: type.body, fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: colors.ink, fontFamily: type.display, fontSize: 22, fontWeight: '700' },
  subtitle: { color: colors.ink, fontFamily: type.display, fontSize: 17, fontWeight: '700' },
  description: { color: colors.inkMuted, fontFamily: type.body, fontSize: 14, lineHeight: 20 },
  group: { gap: spacing.md },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  switchRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.md, justifyContent: 'space-between' },
  switchCopy: { flex: 1, gap: spacing.xs },
  label: { color: colors.inkMuted, fontFamily: type.body, fontSize: 12, fontWeight: '700' },
  note: { color: colors.inkMuted, fontFamily: type.body, fontSize: 12, lineHeight: 18 },
  divider: { backgroundColor: colors.line, height: StyleSheet.hairlineWidth },
});
