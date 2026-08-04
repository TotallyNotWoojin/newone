import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ActionError, FormField } from '@/components/ui/action-modal';
import { Chip, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { colors, radii, shadow, spacing, type } from '@/theme/tokens';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export function MessagePreservationSection({ privilegedReady }: { privilegedReady: boolean }) {
  const workspace = useWorkspace();
  const { t } = useI18n();
  const [conversationId, setConversationId] = useState('');
  const [messageId, setMessageId] = useState('');
  const [holdType, setHoldType] = useState<'legal' | 'incident_preservation'>('legal');
  const [reasonCode, setReasonCode] = useState('');
  const [policyReferenceSha256, setPolicyReferenceSha256] = useState('');
  const [holdId, setHoldId] = useState('');
  const [releaseReasonCode, setReleaseReasonCode] = useState('');
  const placeValid = UUID_PATTERN.test(conversationId.trim())
    && MESSAGE_ID_PATTERN.test(messageId.trim())
    && reasonCode.trim().length >= 3
    && reasonCode.trim().length <= 80
    && SHA256_PATTERN.test(policyReferenceSha256.trim());
  const releaseValid = UUID_PATTERN.test(holdId.trim())
    && releaseReasonCode.trim().length >= 3
    && releaseReasonCode.trim().length <= 80;

  const placeHold = async () => {
    workspace.clearActionError();
    const createdHoldId = await workspace.placeMessagePreservationHold({
      conversationId: conversationId.trim(),
      messageId: messageId.trim(),
      holdType,
      reasonCode: reasonCode.trim(),
      policyReferenceSha256: policyReferenceSha256.trim(),
    });
    if (createdHoldId) {
      setHoldId(createdHoldId);
      setReleaseReasonCode('');
    }
  };

  const releaseHold = async () => {
    workspace.clearActionError();
    if (await workspace.releaseMessagePreservationHold(holdId, releaseReasonCode)) {
      setHoldId('');
      setReleaseReasonCode('');
    }
  };

  return (
    <View style={[styles.section, shadow]}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>{t('admin.preservationEyebrow')}</Text>
          <Text accessibilityRole="header" style={styles.title}>{t('admin.preservationTitle')}</Text>
          <Text style={styles.description}>{t('admin.preservationDescription')}</Text>
        </View>
        <StatusBadge
          label={privilegedReady ? t('admin.aal2Ready') : t('admin.aal2Locked')}
          tone={privilegedReady ? 'success' : 'warning'}
        />
      </View>

      <View style={styles.form}>
        <FormField
          label={t('admin.preservationConversationId')}
          onChangeText={setConversationId}
          value={conversationId}
        />
        <FormField
          label={t('admin.preservationMessageId')}
          onChangeText={setMessageId}
          value={messageId}
        />
        <Text style={styles.label}>{t('admin.preservationType')}</Text>
        <View style={styles.row}>
          <Chip
            label={t('admin.preservationLegal')}
            onPress={() => setHoldType('legal')}
            selected={holdType === 'legal'}
          />
          <Chip
            label={t('admin.preservationIncident')}
            onPress={() => setHoldType('incident_preservation')}
            selected={holdType === 'incident_preservation'}
          />
        </View>
        <FormField
          label={t('admin.preservationReasonCode')}
          onChangeText={setReasonCode}
          value={reasonCode}
        />
        <FormField
          label={t('admin.preservationReferenceHash')}
          onChangeText={setPolicyReferenceSha256}
          value={policyReferenceSha256}
        />
        <Text style={styles.note}>{t('admin.preservationHashNote')}</Text>
        <PrimaryButton
          disabled={!privilegedReady || !placeValid}
          icon="lock-closed-outline"
          label={t('admin.preservationPlace')}
          loading={workspace.actionBusy === 'message-preservation-place'}
          onPress={() => void placeHold()}
          tone="dark"
        />
      </View>

      <View style={styles.divider} />

      <View style={styles.form}>
        <Text style={styles.subtitle}>{t('admin.preservationReleaseTitle')}</Text>
        <Text style={styles.note}>{t('admin.preservationReleaseDescription')}</Text>
        <FormField
          label={t('admin.preservationHoldId')}
          onChangeText={setHoldId}
          value={holdId}
        />
        <FormField
          label={t('admin.preservationReleaseReason')}
          onChangeText={setReleaseReasonCode}
          value={releaseReasonCode}
        />
        <PrimaryButton
          disabled={!privilegedReady || !releaseValid}
          icon="lock-open-outline"
          label={t('admin.preservationRelease')}
          loading={workspace.actionBusy === 'message-preservation-release'}
          onPress={() => void releaseHold()}
          tone="light"
        />
      </View>
      <ActionError message={workspace.actionError} />
    </View>
  );
}

const styles = StyleSheet.create({
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
  form: { gap: spacing.md },
  label: { color: colors.inkMuted, fontFamily: type.body, fontSize: 12, fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  note: { color: colors.inkMuted, fontFamily: type.body, fontSize: 12, lineHeight: 18 },
  divider: { backgroundColor: colors.line, height: StyleSheet.hairlineWidth },
});
