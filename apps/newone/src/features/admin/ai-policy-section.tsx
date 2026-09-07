import { Ionicons } from '@expo/vector-icons';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ActionError, FormField } from '@/components/ui/action-modal';
import { Chip, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import type { OrganizationAiUseCase } from '@/data/repositories/ai-policy-dto.mjs';
import { aiPolicyCopy } from '@/features/admin/ai-policy-copy';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { radii, shadow, spacing, type } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._/-]{1,159}$/;
const USE_CASES: OrganizationAiUseCase[] = ['language_detection', 'translation', 'summary'];

function canonicalProviders(value: string) {
  const providers = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (
    providers.length > 20 || new Set(providers).size !== providers.length ||
    providers.some((provider) => !PROVIDER_PATTERN.test(provider))
  ) return null;
  return [...providers].sort();
}

export function AiPolicySection({
  privilegedReady,
  onSignInAgain,
}: {
  privilegedReady: boolean;
  onSignInAgain: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const workspace = useWorkspace();
  const { locale } = useI18n();
  const copy = aiPolicyCopy(locale);
  const policy = workspace.organizationAiPolicy;
  const { loadOrganizationAiPolicy } = workspace;
  const [enabled, setEnabled] = useState(policy?.enabled ?? false);
  const [approvedUseCases, setApprovedUseCases] = useState<OrganizationAiUseCase[]>(
    policy ? [...policy.approvedUseCases] : [],
  );
  const [providerEntry, setProviderEntry] = useState(policy?.providerAllowlist.join(', ') ?? '');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');

  const applyPolicy = useCallback((next: NonNullable<typeof policy>) => {
    setEnabled(next.enabled);
    setApprovedUseCases([...next.approvedUseCases]);
    setProviderEntry(next.providerAllowlist.join(', '));
    setReason('');
  }, []);

  const loadPolicy = useCallback(async () => {
    const loaded = await loadOrganizationAiPolicy();
    if (loaded) applyPolicy(loaded);
  }, [applyPolicy, loadOrganizationAiPolicy]);

  const providers = useMemo(() => canonicalProviders(providerEntry), [providerEntry]);
  const effectiveUseCases = enabled ? [...approvedUseCases].sort() : [];
  const effectiveProviders = enabled ? providers : [];
  const changed = Boolean(policy) && (
    enabled !== policy?.enabled ||
    JSON.stringify(effectiveUseCases) !== JSON.stringify(policy?.approvedUseCases ?? []) ||
    JSON.stringify(effectiveProviders) !== JSON.stringify(policy?.providerAllowlist ?? [])
  );
  const valid = Boolean(
    policy && reason.trim().length >= 3 && reason.trim().length <= 500 &&
    (!enabled || (providers && approvedUseCases.length > 0 && providers.length > 0))
  );

  const toggleUseCase = (useCase: OrganizationAiUseCase) => {
    setApprovedUseCases((current) => current.includes(useCase)
      ? current.filter((item) => item !== useCase)
      : [...current, useCase].sort());
    setNotice('');
  };

  const save = async () => {
    if (!policy || (enabled && !providers)) return;
    workspace.clearActionError();
    setNotice('');
    const saved = await workspace.updateOrganizationAiPolicy({
      enabled,
      approvedUseCases: enabled ? approvedUseCases : [],
      providerAllowlist: enabled ? providers as string[] : [],
      routePolicy: enabled ? 'approved_zero_retention' : 'deny',
      reason: reason.trim(),
    });
    if (saved) {
      applyPolicy(saved);
      setNotice(copy.saved);
    }
  };

  return (
    <View style={[styles.section, shadow]}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>{copy.eyebrow}</Text>
          <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
          <Text style={styles.description}>{copy.description}</Text>
        </View>
        <StatusBadge
          icon={privilegedReady ? 'shield-checkmark' : 'lock-closed'}
          label={privilegedReady ? copy.mfaReady : copy.mfaLocked}
          tone={privilegedReady ? 'success' : 'warning'}
        />
      </View>

      <View style={styles.disclosure}>
        <Ionicons name="warning-outline" color={colors.amber} size={22} />
        <View style={styles.disclosureCopy}>
          <Text style={styles.disclosureTitle}>{copy.disclosureTitle}</Text>
          <Text style={styles.note}>{copy.disclosure}</Text>
          <Text style={styles.note}>{copy.safeguards}</Text>
          <Text style={styles.note}>{copy.enableFreshness}</Text>
          <Text style={styles.note}>{copy.originalFirst}</Text>
        </View>
      </View>

      {!policy ? (
        <View style={styles.form}>
          <PrimaryButton
            disabled={!privilegedReady}
            icon="refresh"
            label={copy.loading}
            loading={workspace.actionBusy === 'organization-ai-policy-load'}
            onPress={() => void loadPolicy()}
            tone="light"
          />
          <PrimaryButton
            icon="log-in-outline"
            label={copy.reverify}
            onPress={onSignInAgain}
            tone="light"
          />
        </View>
      ) : (
        <View style={styles.form}>
          <View style={styles.statusRow}>
            <StatusBadge
              icon={policy.enabled ? 'cloud-upload-outline' : 'cloud-offline-outline'}
              label={policy.enabled ? copy.enabled : copy.disabled}
              tone={policy.enabled ? 'warning' : 'success'}
            />
            <Text style={styles.version}>{copy.version} {policy.policyVersion}</Text>
            <PrimaryButton
              disabled={!privilegedReady}
              icon="refresh"
              label={copy.refresh}
              loading={workspace.actionBusy === 'organization-ai-policy-load'}
              onPress={() => void loadPolicy()}
              tone="light"
            />
          </View>

          <View style={styles.row}>
            <Chip label={copy.disable} onPress={() => { setEnabled(false); setNotice(''); }} selected={!enabled} />
            <Chip label={copy.enable} onPress={() => { setEnabled(true); setNotice(''); }} selected={enabled} />
          </View>

          {enabled ? (
            <>
              <PrimaryButton
                icon="log-in-outline"
                label={copy.reverify}
                onPress={onSignInAgain}
                tone="light"
              />
              <Text style={styles.label}>{copy.useCases}</Text>
              <View style={styles.row}>
                {USE_CASES.map((useCase) => (
                  <Chip
                    key={useCase}
                    label={{
                      language_detection: copy.languageDetection,
                      translation: copy.translation,
                      summary: copy.summary,
                    }[useCase]}
                    onPress={() => toggleUseCase(useCase)}
                    selected={approvedUseCases.includes(useCase)}
                  />
                ))}
              </View>
              <FormField
                label={copy.providers}
                onChangeText={(value) => { setProviderEntry(value); setNotice(''); }}
                placeholder={copy.providersPlaceholder}
                value={providerEntry}
              />
              <Text style={styles.note}>{copy.providersHelp}</Text>
            </>
          ) : null}

          <FormField
            label={copy.reason}
            multiline
            onChangeText={(value) => { setReason(value); setNotice(''); }}
            placeholder={copy.reasonPlaceholder}
            value={reason}
          />
          {!valid && changed ? <Text style={styles.validation}>{copy.invalid}</Text> : null}
          {notice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text> : null}
          <PrimaryButton
            disabled={!privilegedReady || !changed || !valid}
            icon={enabled ? 'shield-checkmark-outline' : 'shield-outline'}
            label={copy.save}
            loading={workspace.actionBusy === 'organization-ai-policy-update'}
            onPress={() => void save()}
            tone={enabled ? 'dark' : 'danger'}
          />
        </View>
      )}
      <ActionError message={workspace.actionError} />
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
  description: { color: colors.inkMuted, fontFamily: type.body, fontSize: 14, lineHeight: 20 },
  disclosure: {
    alignItems: 'flex-start',
    backgroundColor: colors.amberSoft,
    borderColor: colors.amber,
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  disclosureCopy: { flex: 1, gap: spacing.xs },
  disclosureTitle: { color: colors.ink, fontFamily: type.body, fontSize: 13, fontWeight: '800' },
  form: { gap: spacing.md },
  statusRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  version: { color: colors.inkMuted, flex: 1, fontFamily: type.body, fontSize: 12, minWidth: 100 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  label: { color: colors.inkMuted, fontFamily: type.body, fontSize: 12, fontWeight: '700' },
  note: { color: colors.inkMuted, fontFamily: type.body, fontSize: 12, lineHeight: 18 },
  validation: { color: colors.red, fontFamily: type.body, fontSize: 12, fontWeight: '700' },
  notice: { color: colors.mintDark, fontFamily: type.body, fontSize: 12, fontWeight: '700' },
});
