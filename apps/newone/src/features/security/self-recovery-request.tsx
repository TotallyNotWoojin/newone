import { Ionicons } from '@expo/vector-icons';
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
import { Chip, PrimaryButton } from '@/components/ui/primitives';
import type { VerifiedTotpFactor } from '@/data/repositories/recovery-case-repository';
import {
  RecoveryCaseRepository,
  RecoveryCaseRepositoryError,
} from '@/data/repositories/recovery-case-repository';
import {
  interpolateRecoveryCopy,
  recoveryCopy,
} from '@/features/security/recovery-copy';
import { useI18n } from '@/i18n/provider';
import { createClientId } from '@/lib/client-id';
import { radii, shadow, spacing, type } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

export interface SelfRecoveryRequestProps {
  accessToken: string | null;
  onCreated?: (notice: string) => Promise<void> | void;
  onOpenSettings?: () => void;
  organizationId: string;
  presentation?: 'card' | 'button';
}

export function SelfRecoveryRequest({
  accessToken,
  onCreated,
  onOpenSettings,
  organizationId,
  presentation = 'card',
}: SelfRecoveryRequestProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { locale } = useI18n();
  const copy = recoveryCopy(locale);
  const repository = useMemo(
    () => new RecoveryCaseRepository(() => accessToken),
    [accessToken],
  );
  const [visible, setVisible] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [factors, setFactors] = useState<VerifiedTotpFactor[]>([]);
  const [factorsLoading, setFactorsLoading] = useState(false);
  const [factorId, setFactorId] = useState('');
  const [requestReason, setRequestReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retryPayload, setRetryPayload] = useState<{
    factorId: string;
    idempotencyKey: string;
    reason: string;
  } | null>(null);
  const factorRequestSequence = useRef(0);

  const errorMessage = (failure: unknown) => {
    if (!(failure instanceof RecoveryCaseRepositoryError)) return copy.errorGeneric;
    if (failure.code === 'network_unavailable') return copy.errorNetwork;
    if (
      failure.status === 401 || failure.status === 403 ||
      ['authentication_required', 'csrf_required', 'unauthorized', 'forbidden'].includes(failure.code)
    ) return copy.errorAuth;
    if (failure.status === 409 || failure.code === 'conflict') return copy.errorConflict;
    if (['invalid_response', 'response_too_large'].includes(failure.code)) {
      return copy.errorResponse;
    }
    if (failure.code.startsWith('invalid_')) return copy.errorInput;
    return copy.errorGeneric;
  };

  const close = () => {
    if (busy) return;
    factorRequestSequence.current += 1;
    setVisible(false);
    setIdempotencyKey('');
    setFactors([]);
    setFactorId('');
    setRequestReason('');
    setRetryPayload(null);
    setError('');
  };

  const open = async () => {
    const requestSequence = factorRequestSequence.current + 1;
    factorRequestSequence.current = requestSequence;
    setVisible(true);
    setIdempotencyKey(createClientId());
    setFactors([]);
    setFactorId('');
    setRequestReason('');
    setRetryPayload(null);
    setError('');
    setFactorsLoading(true);
    try {
      const available = await repository.listVerifiedTotpFactors();
      if (factorRequestSequence.current !== requestSequence) return;
      setFactors(available);
      setFactorId(available[0]?.id ?? '');
    } catch (failure) {
      if (factorRequestSequence.current !== requestSequence) return;
      setError(errorMessage(failure));
    } finally {
      if (factorRequestSequence.current === requestSequence) setFactorsLoading(false);
    }
  };

  const updateFactor = (value: string) => {
    if (busy || value === factorId) return;
    if (retryPayload) {
      setRetryPayload(null);
      setIdempotencyKey(createClientId());
      setError('');
    }
    setFactorId(value);
  };

  const updateReason = (value: string) => {
    if (busy) return;
    const bounded = value.slice(0, 1000);
    if (bounded === requestReason) return;
    if (retryPayload) {
      setRetryPayload(null);
      setIdempotencyKey(createClientId());
      setError('');
    }
    setRequestReason(bounded);
  };

  const submit = async () => {
    if (busy || !idempotencyKey) return;
    const payload = retryPayload ?? {
      factorId,
      idempotencyKey,
      reason: requestReason,
    };
    if (!payload.factorId || payload.reason.trim().length < 10) return;
    setBusy(true);
    setError('');
    setRetryPayload(payload);
    try {
      const receipt = await repository.createCase({
        organizationId,
        factorId: payload.factorId,
        reason: payload.reason,
        idempotencyKey: payload.idempotencyKey,
      });
      const createdNotice = interpolateRecoveryCopy(copy.noticeCreated, {
        expiry: new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(receipt.expiresAt)),
        approvals: receipt.requiredApprovals,
      });
      setNotice(createdNotice);
      setVisible(false);
      setIdempotencyKey('');
      setFactors([]);
      setFactorId('');
      setRequestReason('');
      setRetryPayload(null);
      try {
        await onCreated?.(createdNotice);
      } catch {
        // The case is already committed. A parent refresh failure must not be
        // presented as a failed or safely retryable recovery request.
      }
    } catch (failure) {
      // Keep the exact body and idempotency key in memory so an ambiguous
      // network result can be retried safely while this dialog remains open.
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {presentation === 'card' ? (
        <View style={[styles.card, shadow]}>
          <View style={styles.cardTop}>
            <View style={styles.icon}>
              <Ionicons name="key-outline" color={colors.mintDark} size={20} />
            </View>
            <View style={styles.cardCopy}>
              <Text accessibilityRole="header" style={styles.title}>{copy.createTitle}</Text>
              <Text style={styles.description}>{copy.selfServiceDescription}</Text>
              <Text style={styles.aal1Note}>{copy.selfServiceAal1}</Text>
            </View>
            <PrimaryButton
              icon="add-circle-outline"
              label={copy.createSelf}
              onPress={() => void open()}
              tone="dark"
            />
          </View>
          <View style={styles.warning}>
            <Ionicons name="warning-outline" color={colors.amber} size={17} />
            <Text style={styles.warningText}>{copy.sensitiveWarning}</Text>
          </View>
          {notice ? (
            <View accessibilityLiveRegion="polite" style={styles.notice}>
              <Ionicons name="checkmark-circle-outline" color={colors.mintDark} size={18} />
              <Text style={styles.noticeText}>{notice}</Text>
            </View>
          ) : null}
        </View>
      ) : (
        <PrimaryButton
          icon="add-circle-outline"
          label={copy.createSelf}
          onPress={() => void open()}
          tone="dark"
        />
      )}

      <ActionModal
        description={copy.createDescription}
        onClose={close}
        title={copy.createTitle}
        visible={visible}>
        <View style={styles.warning}>
          <Ionicons name="warning-outline" color={colors.amber} size={17} />
          <Text style={styles.warningText}>{copy.sensitiveWarning}</Text>
        </View>
        <Text style={styles.fieldLabel}>{copy.authenticator}</Text>
        {factorsLoading ? (
          <ActivityIndicator color={colors.mintDark} />
        ) : factors.length ? (
          <View style={styles.chips}>
            {factors.map((factor, index) => (
              <Chip
                key={factor.id}
                label={factor.friendlyName ?? `${copy.authenticatorFallback} ${index + 1}`}
                onPress={() => updateFactor(factor.id)}
                selected={factorId === factor.id}
              />
            ))}
          </View>
        ) : (
          <>
            <Text style={styles.statusText}>{copy.noAuthenticator}</Text>
            {onOpenSettings ? (
              <PrimaryButton label={copy.openSettings} onPress={onOpenSettings} tone="light" />
            ) : null}
          </>
        )}
        <FormField
          label={copy.requestReason}
          multiline
          onChangeText={updateReason}
          placeholder={copy.requestReasonPlaceholder}
          value={requestReason}
        />
        <ActionError message={error} />
        <View style={styles.actions}>
          <PrimaryButton disabled={busy} label={copy.cancel} onPress={close} tone="light" />
          <PrimaryButton
            disabled={!factorId || requestReason.trim().length < 10}
            icon="checkmark-circle-outline"
            label={busy ? copy.working : copy.submitRequest}
            loading={busy}
            onPress={() => void submit()}
            tone="dark"
          />
        </View>
      </ActionModal>
    </>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  card: { overflow: 'hidden', borderRadius: radii.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  cardTop: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  icon: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md, backgroundColor: colors.mintSoft },
  cardCopy: { flex: 1, minWidth: 230 },
  title: { color: colors.ink, fontFamily: type.display, fontSize: 16, fontWeight: '900' },
  description: { color: colors.inkMuted, fontSize: 10, lineHeight: 16, marginTop: 3 },
  aal1Note: { color: colors.mintDark, fontSize: 9, lineHeight: 14, fontWeight: '800', marginTop: 4 },
  warning: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.sm, backgroundColor: colors.amberSoft },
  warningText: { flex: 1, color: colors.inkMuted, fontSize: 10, lineHeight: 16 },
  statusText: { color: colors.inkSubtle, fontSize: 10, lineHeight: 16, padding: spacing.sm, textAlign: 'center' },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.sm, backgroundColor: colors.mintSoft },
  noticeText: { flex: 1, color: colors.mintDark, fontSize: 10, lineHeight: 16, fontWeight: '700' },
  fieldLabel: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.xs },
});
