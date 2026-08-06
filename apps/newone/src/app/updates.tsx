import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  Switch,
  View,
} from 'react-native';

import {
  AppScaffold,
  DesktopPageHeader,
  MobileBrandHeader,
} from '@/components/navigation/app-scaffold';
import { Chip, IconButton, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
import {
  WorkspaceStatePanel,
  WorkspaceStatusBanner,
} from '@/components/workspace/workspace-state';
import type { CompanyUpdate } from '@/domain/types';
import { BffCommandRepository } from '@/data/repositories/bff-command-repository';
import type {
  CommandRepository,
  ManagedUpdate,
  UpdateAudiencePreview,
  UpdateAudienceSpec,
  UpdateNonAcknowledger,
} from '@/data/repositories/contracts';
import { RepositoryError } from '@/data/repositories/contracts';
import { useHydrationSafeWindowDimensions } from '@/hooks/use-hydration-safe-window-dimensions';
import { updateCopy } from '@/features/updates/update-copy';
import { createClientId } from '@/lib/client-id';
import { getSupabaseClient } from '@/lib/supabase';
import { useAuth } from '@/state/auth';
import { useWorkspace } from '@/state/workspace';
import { colors, radii, shadow, spacing, type } from '@/theme/tokens';
import { useI18n } from '@/i18n/provider';

type UpdatePriority = 'normal' | 'important' | 'emergency';
type CriticalCategory = NonNullable<ManagedUpdate['criticalCategory']>;
type AudienceScope = 'company' | 'conversation' | 'units';

function futureIso(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function parsedFuture(value: string, floor: number) {
  const timestamp = Date.parse(value.trim());
  return Number.isFinite(timestamp) && timestamp > floor ? timestamp : null;
}

function commandErrorMessage(error: unknown, copy: ReturnType<typeof updateCopy>) {
  if (error instanceof RepositoryError && error.code === 'network_unavailable') {
    return copy.networkError;
  }
  return copy.serverRejected;
}

function notificationClassForPriority(priority: UpdatePriority) {
  return priority === 'emergency' ? 'critical' as const
    : priority === 'important' ? 'urgent' as const
    : 'routine' as const;
}

function toggledValue<Value extends string>(values: Value[], value: Value) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export default function UpdatesScreen() {
  const router = useRouter();
  const { width } = useHydrationSafeWindowDimensions();
  const desktop = width >= 920;
  const workspace = useWorkspace();
  const auth = useAuth();
  const { locale, t } = useI18n();
  const copy = updateCopy(locale);
  const commands = useMemo<CommandRepository>(() => (
    new BffCommandRepository({
      getSession: async () => {
        const client = getSupabaseClient();
        if (!client) return null;
        const { data } = await client.auth.getSession();
        return data.session;
      },
    })
  ), []);
  const canPublish = workspace.hasCapability('communications.publish');
  const channels = useMemo(() => workspace.conversations.filter((conversation) => (
    conversation.kind === 'announcement'
    && !conversation.managementOnly
    && conversation.canPost !== false
  )), [workspace.conversations]);
  const channelAuthorizationSignature = channels.map((conversation) => conversation.id).sort().join('|');
  const [localUpdates, setLocalUpdates] = useState<CompanyUpdate[]>([]);
  const [acknowledgedIds, setAcknowledgedIds] = useState<Set<string>>(() => new Set());
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set());
  const displayedUpdates = useMemo(() => {
    const localIds = new Set(localUpdates.map((update) => update.id));
    return [
      ...localUpdates,
      ...workspace.updates.filter((update) => !localIds.has(update.id)),
    ].map((update) => ({
      ...update,
      acknowledged: update.acknowledged || acknowledgedIds.has(update.id),
      readAt: update.readAt ?? (readIds.has(update.id) ? new Date().toISOString() : null),
    }));
  }, [acknowledgedIds, localUpdates, readIds, workspace.updates]);
  const outstanding = displayedUpdates.filter(
    (update) => update.acknowledgementRequired && !update.acknowledged,
  ).length;
  const acknowledged = displayedUpdates.filter((update) => update.acknowledged).length;

  const [showCreate, setShowCreate] = useState(false);
  const [channelId, setChannelId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<UpdatePriority>('normal');
  const [requiresAcknowledgement, setRequiresAcknowledgement] = useState(false);
  const [expiresAt, setExpiresAt] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [criticalCategory, setCriticalCategory] = useState<CriticalCategory>('safety');
  const [overrideReason, setOverrideReason] = useState('');
  const [attestationRequired, setAttestationRequired] = useState(false);
  const [attestationPrompt, setAttestationPrompt] = useState('');
  const [remindersEnabled, setRemindersEnabled] = useState(false);
  const [acknowledgementDeadline, setAcknowledgementDeadline] = useState('');
  const [reminderIntervalMinutes, setReminderIntervalMinutes] = useState('');
  const [maximumReminders, setMaximumReminders] = useState('');
  const [escalateAfterMinutes, setEscalateAfterMinutes] = useState('');
  const [audiencePreview, setAudiencePreview] = useState<UpdateAudiencePreview | null>(null);
  const [previewChannelId, setPreviewChannelId] = useState<string | null>(null);
  const [previewAudienceFingerprint, setPreviewAudienceFingerprint] = useState<string | null>(null);
  const [audienceScope, setAudienceScope] = useState<AudienceScope>('company');
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  const [selectedOperationalRoles, setSelectedOperationalRoles] = useState<string[]>([]);
  const [operationalRoleEntry, setOperationalRoleEntry] = useState('');
  const [selectedMembershipRoles, setSelectedMembershipRoles] = useState<
    UpdateAudienceSpec['membershipRoles']
  >([]);
  const [selectedAudienceLanguages, setSelectedAudienceLanguages] = useState<string[]>([]);
  const [currentShiftOnly, setCurrentShiftOnly] = useState(false);
  const [expirationFloor, setExpirationFloor] = useState(0);
  const [secureBusy, setSecureBusy] = useState<string | null>(null);
  const [secureError, setSecureError] = useState<string | null>(null);
  const [secureNotice, setSecureNotice] = useState<string | null>(null);
  const [managedUpdates, setManagedUpdates] = useState<ManagedUpdate[]>([]);
  const [managedLoading, setManagedLoading] = useState(false);
  const [managedError, setManagedError] = useState<string | null>(null);
  const [detailUpdate, setDetailUpdate] = useState<CompanyUpdate | null>(null);
  const [ackTarget, setAckTarget] = useState<CompanyUpdate | null>(null);
  const [attestationConfirmed, setAttestationConfirmed] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<ManagedUpdate | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [correctionTarget, setCorrectionTarget] = useState<ManagedUpdate | null>(null);
  const [correctionTitle, setCorrectionTitle] = useState('');
  const [correctionBody, setCorrectionBody] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [nonResponderTarget, setNonResponderTarget] = useState<ManagedUpdate | null>(null);
  const [nonResponders, setNonResponders] = useState<UpdateNonAcknowledger[]>([]);
  const [nonResponderCursor, setNonResponderCursor] = useState<string | null>(null);
  const [nonResponderHasMore, setNonResponderHasMore] = useState(false);

  const refreshManaged = useCallback(async () => {
    if (!canPublish || !workspace.organizationId) return;
    if (auth.assuranceLevel !== 'aal2') {
      setManagedError(copy.recentMfaRequired);
      return;
    }
    setManagedLoading(true);
    setManagedError(null);
    try {
      const result = await commands.listManagedUpdates({
        organizationId: workspace.organizationId,
        limit: 100,
      });
      setManagedUpdates(result.updates);
    } catch (error) {
      setManagedError(commandErrorMessage(error, copy));
    } finally {
      setManagedLoading(false);
    }
  }, [auth.assuranceLevel, canPublish, commands, copy, workspace.organizationId]);

  useEffect(() => {
    if (workspace.status !== 'ready') return undefined;
    const timeout = setTimeout(() => void refreshManaged(), 0);
    return () => clearTimeout(timeout);
  }, [refreshManaged, workspace.status]);

  useEffect(() => {
    if (!channelId || channels.some((conversation) => conversation.id === channelId)) return;
    const timeout = setTimeout(() => {
      setChannelId('');
      setAudiencePreview(null);
      setPreviewChannelId(null);
      setPreviewAudienceFingerprint(null);
    }, 0);
    return () => clearTimeout(timeout);
  }, [channelAuthorizationSignature, channelId, channels]);

  const expirationTimestamp = expiresAt.trim() ? Date.parse(expiresAt.trim()) : null;
  const publishFloor = scheduledAt.trim()
    ? parsedFuture(scheduledAt, expirationFloor)
    : expirationFloor;
  const expirationValid = expirationTimestamp === null
    || (Number.isFinite(expirationTimestamp) && publishFloor !== null && expirationTimestamp > publishFloor);
  const scheduleValid = !scheduledAt.trim() || parsedFuture(scheduledAt, expirationFloor) !== null;
  const reminderInterval = Number(reminderIntervalMinutes);
  const reminderMaximum = Number(maximumReminders);
  const escalationMinutes = Number(escalateAfterMinutes);
  const deadlineTimestamp = acknowledgementDeadline.trim()
    ? Date.parse(acknowledgementDeadline.trim())
    : Number.NaN;
  const reminderPolicyValid = !remindersEnabled || (
    requiresAcknowledgement
    && Number.isFinite(deadlineTimestamp)
    && publishFloor !== null
    && deadlineTimestamp > publishFloor
    && Number.isInteger(reminderInterval) && reminderInterval >= 5 && reminderInterval <= 10080
    && Number.isInteger(reminderMaximum) && reminderMaximum >= 1 && reminderMaximum <= 20
    && Number.isInteger(escalationMinutes) && escalationMinutes >= 15
    && escalationMinutes >= reminderInterval && escalationMinutes <= 43200
  );
  const overrideValid = priority === 'normal'
    || (overrideReason.trim().length >= 3 && overrideReason.trim().length <= 500);
  const attestationValid = !attestationRequired
    || (requiresAcknowledgement && attestationPrompt.trim().length >= 3
      && attestationPrompt.trim().length <= 500);
  const enteredOperationalRoles = useMemo(() => [...new Set(operationalRoleEntry
    .split(',')
    .map((role) => role.trim().toLocaleLowerCase('en-US'))
    .filter(Boolean))], [operationalRoleEntry]);
  const operationalRoleEntryValid = enteredOperationalRoles.length <= 50
    && enteredOperationalRoles.every((role) => role.length <= 160);
  const audienceSpec = useMemo<UpdateAudienceSpec>(() => {
    const selectedUnits = workspace.units.filter((unit) => selectedUnitIds.includes(unit.unitId));
    return {
      company: audienceScope === 'company',
      conversationMembers: audienceScope === 'conversation',
      siteIds: selectedUnits.filter((unit) => unit.kind === 'site').map((unit) => unit.unitId),
      departmentIds: selectedUnits.filter((unit) => unit.kind === 'department').map((unit) => unit.unitId),
      teamIds: selectedUnits.filter((unit) => unit.kind === 'team').map((unit) => unit.unitId),
      unitIds: selectedUnits
        .filter((unit) => unit.kind === 'line' || unit.kind === 'shift')
        .map((unit) => unit.unitId),
      operationalRoles: [...new Set([...selectedOperationalRoles, ...enteredOperationalRoles])],
      membershipRoles: selectedMembershipRoles,
      languages: selectedAudienceLanguages,
      currentShiftOnly,
    };
  }, [
    audienceScope,
    currentShiftOnly,
    enteredOperationalRoles,
    selectedAudienceLanguages,
    selectedMembershipRoles,
    selectedOperationalRoles,
    selectedUnitIds,
    workspace.units,
  ]);
  const audienceFingerprint = JSON.stringify(audienceSpec);
  const audienceSelectorValid = (audienceScope !== 'units' || selectedUnitIds.length > 0)
    && operationalRoleEntryValid;
  const channelAuthorized = channels.some((conversation) => conversation.id === channelId);
  const audienceReady = channelAuthorized && previewChannelId === channelId && audiencePreview !== null
    && previewAudienceFingerprint === audienceFingerprint;
  const canUsePublisherActions = auth.assuranceLevel === 'aal2';
  const operationalRoleOptions = useMemo(() => [...new Set(workspace.people
    .map((person) => person.roleLabel.trim())
    .filter(Boolean))].sort((left, right) => left.localeCompare(right)), [workspace.people]);
  const audienceLanguageOptions = useMemo(() => [...new Set(workspace.people
    .map((person) => person.preferredLanguage))].sort(), [workspace.people]);

  const openCreate = () => {
    workspace.clearActionError();
    setChannelId(channels[0]?.id ?? '');
    setTitle('');
    setBody('');
    setPriority('normal');
    setRequiresAcknowledgement(false);
    setExpiresAt('');
    setScheduledAt('');
    setCriticalCategory('safety');
    setOverrideReason('');
    setAttestationRequired(false);
    setAttestationPrompt('');
    setRemindersEnabled(false);
    setAcknowledgementDeadline('');
    setReminderIntervalMinutes('');
    setMaximumReminders('');
    setEscalateAfterMinutes('');
    setAudiencePreview(null);
    setPreviewChannelId(null);
    setPreviewAudienceFingerprint(null);
    setAudienceScope('company');
    setSelectedUnitIds([]);
    setSelectedOperationalRoles([]);
    setOperationalRoleEntry('');
    setSelectedMembershipRoles([]);
    setSelectedAudienceLanguages([]);
    setCurrentShiftOnly(false);
    setSecureError(null);
    setSecureNotice(null);
    setExpirationFloor(Date.now());
    setShowCreate(true);
  };

  const previewCurrentAudience = async () => {
    if (!channelAuthorized) return;
    setSecureBusy('audience-preview');
    setSecureError(null);
    try {
      const result = await commands.previewUpdateAudience({
        organizationId: workspace.organizationId,
        conversationId: channelId,
        audienceSpec,
        idempotencyKey: createClientId(),
      });
      setAudiencePreview(result);
      setPreviewChannelId(channelId);
      setPreviewAudienceFingerprint(audienceFingerprint);
    } catch (error) {
      setAudiencePreview(null);
      setPreviewChannelId(null);
      setPreviewAudienceFingerprint(null);
      setSecureError(commandErrorMessage(error, copy));
    } finally {
      setSecureBusy(null);
    }
  };

  const publishUpdate = async () => {
    const currentUser = workspace.currentUser;
    if (
      !currentUser || !audienceReady || !canUsePublisherActions || !channelId || !title.trim() || !body.trim()
      || !expirationValid || !scheduleValid || !reminderPolicyValid || !overrideValid
      || !attestationValid || !audienceSelectorValid
    ) return;
    const clientMessageId = createClientId();
    const notificationClass = notificationClassForPriority(priority);
    setSecureBusy('update-publish');
    setSecureError(null);
    try {
      const result = await commands.publishUpdate({
        organizationId: workspace.organizationId,
        conversationId: channelId,
        clientMessageId,
        title: title.trim(),
        body: body.trim(),
        languageCode: currentUser.preferredLanguage,
        priority,
        requiresAcknowledgement,
        expiresAt: expiresAt.trim() || null,
        scheduledAt: scheduledAt.trim() || null,
        acknowledgementSchema: {
          schemaVersion: 1,
          attestationRequired: requiresAcknowledgement && attestationRequired,
          attestationPrompt: requiresAcknowledgement && attestationRequired
            ? attestationPrompt.trim()
            : null,
          requiredKeys: requiresAcknowledgement && attestationRequired ? ['confirmed'] : [],
          carryForwardOnCorrection: false,
        },
        notificationClass,
        criticalCategory: priority === 'normal' ? null : criticalCategory,
        quietHoursOverrideReason: priority === 'normal' ? null : overrideReason.trim(),
        reminderPolicy: {
          enabled: requiresAcknowledgement && remindersEnabled,
          deadlineAt: requiresAcknowledgement && remindersEnabled
            ? new Date(deadlineTimestamp).toISOString()
            : null,
          intervalSeconds: requiresAcknowledgement && remindersEnabled
            ? reminderInterval * 60
            : null,
          maximumReminders: requiresAcknowledgement && remindersEnabled ? reminderMaximum : 0,
          escalateAfterSeconds: requiresAcknowledgement && remindersEnabled
            ? escalationMinutes * 60
            : null,
          smsFallback: false,
        },
        audienceSpec,
        idempotencyKey: clientMessageId,
      });
      const scheduled = result.status === 'scheduled' || Boolean(scheduledAt.trim());
      const local: CompanyUpdate = {
        id: result.announcementId,
        versionId: result.versionId,
        versionNumber: 1,
        title: title.trim(),
        body: body.trim(),
        author: currentUser.displayName,
        audience: scheduled
          ? copy.snapshotPending
          : `${result.audienceCount ?? audiencePreview.audienceCount} ${copy.recipients}`,
        publishedAt: scheduled && (result.scheduledAt ?? scheduledAt)
          ? `${copy.scheduledFor} · ${new Date(result.scheduledAt ?? scheduledAt).toLocaleString()}`
          : new Date().toLocaleString(),
        severity: priority === 'emergency' ? 'critical' : priority === 'important' ? 'important' : 'standard',
        acknowledgementRequired: requiresAcknowledgement,
        acknowledged: false,
        acknowledgedCount: 0,
        recipientCount: scheduled ? 0 : result.audienceCount ?? audiencePreview.audienceCount,
        recipientCountKnown: !scheduled,
        deadline: remindersEnabled ? new Date(deadlineTimestamp).toLocaleString() : undefined,
        status: scheduled ? 'scheduled' : 'published',
        scheduledAt: (result.scheduledAt ?? scheduledAt.trim()) || undefined,
        notificationClass,
        acknowledgementSchema: {
          schemaVersion: 1,
          attestationRequired: requiresAcknowledgement && attestationRequired,
          attestationPrompt: requiresAcknowledgement && attestationRequired ? attestationPrompt.trim() : null,
          requiredKeys: requiresAcknowledgement && attestationRequired ? ['confirmed'] : [],
          carryForwardOnCorrection: false,
        },
        reminderPolicy: {
          enabled: requiresAcknowledgement && remindersEnabled,
          deadlineAt: requiresAcknowledgement && remindersEnabled ? new Date(deadlineTimestamp).toISOString() : null,
          intervalSeconds: requiresAcknowledgement && remindersEnabled ? reminderInterval * 60 : null,
          maximumReminders: requiresAcknowledgement && remindersEnabled ? reminderMaximum : 0,
          escalateAfterSeconds: requiresAcknowledgement && remindersEnabled ? escalationMinutes * 60 : null,
          smsFallback: false,
        },
      };
      setLocalUpdates((current) => [local, ...current]);
      setSecureNotice(copy.saved);
      setShowCreate(false);
      await Promise.all([workspace.refresh(), refreshManaged()]);
    } catch (error) {
      setSecureError(commandErrorMessage(error, copy));
    } finally {
      setSecureBusy(null);
    }
  };

  const openUpdateDetail = async (update: CompanyUpdate) => {
    setDetailUpdate(update);
    if (update.readAt || readIds.has(update.id) || update.status === 'scheduled') return;
    try {
      await commands.markUpdateRead({
        organizationId: workspace.organizationId,
        announcementId: update.id,
        idempotencyKey: createClientId(),
      });
      setReadIds((current) => new Set(current).add(update.id));
    } catch (error) {
      setSecureError(commandErrorMessage(error, copy));
    }
  };

  const acknowledgeExactVersion = async () => {
    if (!ackTarget) return;
    const schema = ackTarget.acknowledgementSchema;
    if (schema?.attestationRequired && !attestationConfirmed) return;
    const attestation = schema?.attestationRequired
      ? Object.fromEntries(schema.requiredKeys.map((key) => [key, true]))
      : {};
    setSecureBusy('update-acknowledge');
    setSecureError(null);
    try {
      await commands.acknowledgeUpdate({
        organizationId: workspace.organizationId,
        versionId: ackTarget.versionId,
        attestation,
        idempotencyKey: createClientId(),
      });
      setAcknowledgedIds((current) => new Set(current).add(ackTarget.id));
      setSecureNotice(copy.acknowledgementRecorded);
      setAckTarget(null);
      setAttestationConfirmed(false);
      await workspace.refresh();
    } catch (error) {
      setSecureError(commandErrorMessage(error, copy));
    } finally {
      setSecureBusy(null);
    }
  };

  const cancelScheduled = async () => {
    if (!cancelTarget || cancelReason.trim().length < 3) return;
    setSecureBusy('update-cancel');
    setSecureError(null);
    try {
      await commands.cancelScheduledUpdate({
        organizationId: workspace.organizationId,
        announcementId: cancelTarget.announcementId,
        reason: cancelReason.trim(),
        idempotencyKey: createClientId(),
      });
      setManagedUpdates((current) => current.map((update) =>
        update.announcementId === cancelTarget.announcementId
          ? { ...update, status: 'cancelled', cancellationReason: cancelReason.trim() }
          : update
      ));
      setLocalUpdates((current) => current.map((update) =>
        update.id === cancelTarget.announcementId ? { ...update, status: 'cancelled' } : update
      ));
      setCancelTarget(null);
      setCancelReason('');
      setSecureNotice(copy.saved);
      await refreshManaged();
    } catch (error) {
      setSecureError(commandErrorMessage(error, copy));
    } finally {
      setSecureBusy(null);
    }
  };

  const openCorrection = (update: ManagedUpdate) => {
    setCorrectionTarget(update);
    setCorrectionTitle(update.title);
    setCorrectionBody(update.body);
    setCorrectionReason('');
    setSecureError(null);
  };

  const publishCorrection = async () => {
    if (
      !correctionTarget || correctionTitle.trim().length < 1 || correctionBody.trim().length < 1
      || correctionReason.trim().length < 3
    ) return;
    const clientMessageId = createClientId();
    setSecureBusy('update-correct');
    setSecureError(null);
    try {
      await commands.correctUpdate({
        organizationId: workspace.organizationId,
        announcementId: correctionTarget.announcementId,
        clientMessageId,
        title: correctionTitle.trim(),
        body: correctionBody.trim(),
        priority: correctionTarget.priority,
        requiresAcknowledgement: correctionTarget.requiresAcknowledgement,
        expiresAt: correctionTarget.expiresAt,
        reason: correctionReason.trim(),
        idempotencyKey: clientMessageId,
      });
      setCorrectionTarget(null);
      setSecureNotice(copy.saved);
      await Promise.all([workspace.refresh(), refreshManaged()]);
    } catch (error) {
      setSecureError(commandErrorMessage(error, copy));
    } finally {
      setSecureBusy(null);
    }
  };

  const loadNonResponders = async (update: ManagedUpdate, append = false) => {
    setNonResponderTarget(update);
    if (!append) {
      setNonResponders([]);
      setNonResponderCursor(null);
      setNonResponderHasMore(false);
    }
    setSecureBusy('update-non-responders');
    setSecureError(null);
    try {
      const page = await commands.listUpdateNonAcknowledgers({
        organizationId: workspace.organizationId,
        announcementId: update.announcementId,
        afterUserId: append ? nonResponderCursor : null,
        limit: 50,
      });
      setNonResponders((current) => append ? [...current, ...page.people] : page.people);
      setNonResponderCursor(page.nextAfterUserId);
      setNonResponderHasMore(page.hasMore);
    } catch (error) {
      setSecureError(commandErrorMessage(error, copy));
    } finally {
      setSecureBusy(null);
    }
  };

  return (
    <AppScaffold
      current="updates"
      mobileHeader={
        <MobileBrandHeader
          right={
            <IconButton
              label={t('updates.notificationSettings')}
              name="notifications-outline"
              onPress={() => router.push('/settings')}
              size={38}
            />
          }
          subtitle={outstanding ? `${outstanding} ${t('updates.responseRequiredSuffix')}` : t('updates.caughtUp')}
          title={t('updates.title')}
        />
      }>
      <WorkspaceStatusBanner />
      {workspace.status === 'loading' || workspace.status === 'error' ? (
        <WorkspaceStatePanel resource="updates" />
      ) : (
      <ScrollView
        contentContainerStyle={[styles.page, !desktop && styles.pageMobile]}
        showsVerticalScrollIndicator={false}>
        {desktop ? (
          <DesktopPageHeader
            actions={
              canPublish && channels.length
                ? <PrimaryButton icon="add" label={t('updates.create')} onPress={openCreate} />
                : undefined
            }
            description={t('updates.description')}
            eyebrow={t('updates.eyebrow')}
            title={t('updates.heading')}
          />
        ) : null}

        <View style={[styles.content, desktop && styles.contentDesktop]}>
          {secureNotice ? (
            <View accessibilityLiveRegion="polite" style={styles.successNotice}>
              <Ionicons name="checkmark-circle" color={colors.mintDark} size={18} />
              <Text style={styles.successNoticeText}>{secureNotice}</Text>
            </View>
          ) : null}
          <View style={styles.summaryRow}>
            <SummaryCard
              icon="warning"
              label={t('updates.needsResponse')}
              tone="danger"
              value={String(outstanding)}
            />
            <SummaryCard
              icon="checkmark-done"
              label={t('updates.acknowledgedByYou')}
              tone="success"
              value={String(acknowledged)}
            />
            <SummaryCard
              icon="megaphone-outline"
              label={t('updates.visible')}
              tone="neutral"
              value={String(displayedUpdates.length)}
            />
          </View>

          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionEyebrow}>{t('updates.inbox')}</Text>
              <Text style={styles.sectionTitle}>{t('updates.forYou')}</Text>
            </View>
            {canPublish && channels.length && !desktop ? (
              <PrimaryButton icon="add" label={t('updates.create')} onPress={openCreate} />
            ) : null}
          </View>

          <View style={styles.updateList}>
            {displayedUpdates.map((update) => (
              <UpdateCard
                desktop={desktop}
                key={update.id}
                onAcknowledge={() => {
                  setAckTarget(update);
                  setAttestationConfirmed(false);
                  setSecureError(null);
                }}
                onOpen={() => void openUpdateDetail(update)}
                update={update}
              />
            ))}
            {!displayedUpdates.length ? (
              <View style={styles.noUpdates}>
                <Ionicons name="megaphone-outline" color={colors.mintDark} size={25} />
                <Text style={styles.noUpdatesTitle}>{t('updates.empty')}</Text>
                <Text style={styles.noUpdatesText}>{t('updates.emptyBody')}</Text>
              </View>
            ) : null}
          </View>

          {canPublish ? (
            <PublisherControlCenter
              copy={copy}
              error={managedError}
              loading={managedLoading}
              onCancel={(update) => {
                setCancelTarget(update);
                setCancelReason('');
                setSecureError(null);
              }}
              onCorrect={openCorrection}
              onNonResponders={(update) => void loadNonResponders(update)}
              onRefresh={() => void refreshManaged()}
              updates={managedUpdates}
            />
          ) : null}
        </View>
      </ScrollView>
      )}
      <ActionModal
        description={t('updates.publishDescription')}
        onClose={() => setShowCreate(false)}
        title={t('updates.publishTitle')}
        visible={showCreate}>
        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>{t('updates.channel')}</Text>
          <View style={styles.formChips}>
            {channels.map((conversation) => (
              <Chip
                key={conversation.id}
                label={conversation.title}
                onPress={() => {
                  setChannelId(conversation.id);
                  setAudiencePreview(null);
                  setPreviewChannelId(null);
                  setPreviewAudienceFingerprint(null);
                }}
                selected={channelId === conversation.id}
              />
            ))}
          </View>
        </View>
        <FormField label={t('updates.fieldTitle')} onChangeText={setTitle} value={title} />
        <FormField label={t('updates.message')} multiline onChangeText={setBody} value={body} />
        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>{t('updates.priority')}</Text>
          <View style={styles.formChips}>
            {(['normal', 'important', 'emergency'] as const).map((item) => (
              <Chip
                key={item}
                label={{
                  normal: t('updates.priorityNormal'),
                  important: t('updates.priorityImportant'),
                  emergency: t('updates.priorityEmergency'),
                }[item]}
                onPress={() => setPriority(item)}
                selected={priority === item}
              />
            ))}
          </View>
          <Text style={styles.policyHint}>{copy.notificationMapping}</Text>
          <StatusBadge
            icon={priority === 'emergency' ? 'warning' : priority === 'important' ? 'alert-circle' : 'notifications-outline'}
            label={`${copy.notificationClass}: ${{
              routine: copy.routine,
              urgent: copy.urgent,
              critical: copy.critical,
            }[notificationClassForPriority(priority)]}`}
            tone={priority === 'emergency' ? 'danger' : priority === 'important' ? 'warning' : 'info'}
          />
        </View>
        {priority !== 'normal' ? (
          <View style={styles.policyPanel}>
            <Text style={styles.formLabel}>{copy.overrideCategory}</Text>
            <View style={styles.formChips}>
              {(['safety', 'security', 'operations', 'weather', 'business_continuity'] as const).map((category) => (
                <Chip
                  key={category}
                  label={{
                    safety: copy.safety,
                    security: copy.security,
                    operations: copy.operations,
                    weather: copy.weather,
                    business_continuity: copy.businessContinuity,
                  }[category]}
                  onPress={() => setCriticalCategory(category)}
                  selected={criticalCategory === category}
                />
              ))}
            </View>
            <FormField
              label={copy.overrideReason}
              multiline
              onChangeText={setOverrideReason}
              placeholder={copy.overrideReasonPlaceholder}
              value={overrideReason}
            />
            {!overrideValid ? <Text style={styles.validationError}>{copy.overrideReasonPlaceholder}</Text> : null}
            <Text style={styles.policyHint}>{copy.overrideAudit}</Text>
          </View>
        ) : null}
        <View style={styles.formGroup}>
          <FormField
            label={copy.scheduledFor}
            onChangeText={setScheduledAt}
            placeholder={copy.schedulePlaceholder}
            value={scheduledAt}
          />
          <View style={styles.formChips}>
            <Chip label={copy.publishNow} onPress={() => setScheduledAt('')} selected={!scheduledAt} />
            <Chip label={copy.in15Minutes} onPress={() => setScheduledAt(futureIso(15))} />
            <Chip label={copy.inOneHour} onPress={() => setScheduledAt(futureIso(60))} />
            <Chip label={copy.tomorrow} onPress={() => setScheduledAt(futureIso(1440))} />
          </View>
          {!scheduleValid ? <Text style={styles.validationError}>{copy.scheduleInvalid}</Text> : null}
        </View>
        <View style={styles.ackToggle}>
          <View style={styles.ackToggleCopy}>
            <Text style={styles.formLabel}>{t('updates.requireAcknowledgement')}</Text>
            <Text style={styles.ackToggleNote}>{t('updates.acknowledgementNote')}</Text>
          </View>
          <Switch
            onValueChange={(next) => {
              setRequiresAcknowledgement(next);
              if (!next) {
                setAttestationRequired(false);
                setRemindersEnabled(false);
              }
            }}
            value={requiresAcknowledgement}
          />
        </View>
        {requiresAcknowledgement ? (
          <View style={styles.policyPanel}>
            <View style={styles.ackToggle}>
              <View style={styles.ackToggleCopy}>
                <Text style={styles.formLabel}>{copy.attestation}</Text>
                <Text style={styles.ackToggleNote}>{copy.attestationEvidence}</Text>
              </View>
              <Switch onValueChange={setAttestationRequired} value={attestationRequired} />
            </View>
            {attestationRequired ? (
              <FormField
                label={copy.attestationPrompt}
                multiline
                onChangeText={setAttestationPrompt}
                placeholder={copy.attestationPlaceholder}
                value={attestationPrompt}
              />
            ) : null}
            <View style={styles.ackToggle}>
              <View style={styles.ackToggleCopy}>
                <Text style={styles.formLabel}>{copy.reminders}</Text>
                <Text style={styles.ackToggleNote}>{copy.smsDisabled}</Text>
              </View>
              <Switch onValueChange={setRemindersEnabled} value={remindersEnabled} />
            </View>
            {remindersEnabled ? (
              <View style={styles.formGroup}>
                <FormField
                  label={copy.deadline}
                  onChangeText={setAcknowledgementDeadline}
                  placeholder={copy.deadlinePlaceholder}
                  value={acknowledgementDeadline}
                />
                <View style={styles.policyGrid}>
                  <FormField
                    keyboardType="number-pad"
                    label={copy.intervalMinutes}
                    onChangeText={setReminderIntervalMinutes}
                    value={reminderIntervalMinutes}
                  />
                  <FormField
                    keyboardType="number-pad"
                    label={copy.maximumReminders}
                    onChangeText={setMaximumReminders}
                    value={maximumReminders}
                  />
                  <FormField
                    keyboardType="number-pad"
                    label={copy.escalateMinutes}
                    onChangeText={setEscalateAfterMinutes}
                    value={escalateAfterMinutes}
                  />
                </View>
              </View>
            ) : null}
            {!attestationValid || !reminderPolicyValid ? (
              <Text style={styles.validationError}>{copy.policyInvalid}</Text>
            ) : null}
          </View>
        ) : null}
        <FormField
          label={t('updates.expiresAt')}
          onChangeText={setExpiresAt}
          placeholder={t('updates.expiresPlaceholder')}
          value={expiresAt}
        />
        {!expirationValid ? <Text style={styles.validationError}>{t('updates.expirationInvalid')}</Text> : null}
        <View style={styles.policyPanel}>
          <Text style={styles.formLabel}>{copy.audienceBuilder}</Text>
          <Text style={styles.policyHint}>{copy.audienceBuilderDescription}</Text>
          <View style={styles.formChips}>
            <Chip
              label={copy.companyAudience}
              onPress={() => {
                setAudienceScope('company');
                setSelectedUnitIds([]);
              }}
              selected={audienceScope === 'company'}
            />
            <Chip
              label={copy.channelAudience}
              onPress={() => {
                setAudienceScope('conversation');
                setSelectedUnitIds([]);
              }}
              selected={audienceScope === 'conversation'}
            />
            <Chip
              label={copy.unitAudience}
              onPress={() => setAudienceScope('units')}
              selected={audienceScope === 'units'}
            />
          </View>
          {audienceScope === 'units' ? (
            <View style={styles.audienceDimensions}>
              {(['site', 'department', 'team', 'line', 'shift'] as const).map((kind) => {
                const options = workspace.units.filter((unit) => unit.kind === kind);
                if (!options.length) return null;
                return (
                  <View key={kind} style={styles.formGroup}>
                    <Text style={styles.dimensionLabel}>{{
                      site: copy.sites,
                      department: copy.departments,
                      team: copy.teams,
                      line: copy.lines,
                      shift: copy.units,
                    }[kind]}</Text>
                    <View style={styles.formChips}>
                      {options.map((unit) => (
                        <Chip
                          key={unit.unitId}
                          label={unit.name}
                          onPress={() => setSelectedUnitIds((current) =>
                            toggledValue(current, unit.unitId))}
                          selected={selectedUnitIds.includes(unit.unitId)}
                        />
                      ))}
                    </View>
                  </View>
                );
              })}
              <Text style={styles.policyHint}>{copy.descendantDisclosure}</Text>
              {!audienceSelectorValid ? (
                <Text style={styles.validationError}>{copy.unitRequired}</Text>
              ) : null}
            </View>
          ) : null}
          <View style={styles.formGroup}>
            <Text style={styles.dimensionLabel}>{copy.operationalRoles}</Text>
            <Text style={styles.policyHint}>{copy.operationalRolesDescription}</Text>
            {operationalRoleOptions.length ? (
              <View style={styles.formChips}>
                {operationalRoleOptions.map((role) => (
                  <Chip
                    key={role}
                    label={role}
                    onPress={() => setSelectedOperationalRoles((current) =>
                      toggledValue(current, role.toLocaleLowerCase('en-US')))}
                    selected={selectedOperationalRoles.includes(role.toLocaleLowerCase('en-US'))}
                  />
                ))}
              </View>
            ) : null}
            <FormField
              label={copy.configuredRoles}
              onChangeText={setOperationalRoleEntry}
              placeholder={copy.configuredRolesPlaceholder}
              value={operationalRoleEntry}
            />
            {!operationalRoleEntryValid ? (
              <Text style={styles.validationError}>{copy.configuredRolesInvalid}</Text>
            ) : null}
          </View>
          <View style={styles.formGroup}>
            <Text style={styles.dimensionLabel}>{copy.accessRoles}</Text>
            <Text style={styles.policyHint}>{copy.accessRolesDescription}</Text>
            <View style={styles.formChips}>
              {(['owner', 'admin', 'manager', 'member'] as const).map((role) => (
                <Chip
                  key={role}
                  label={{ owner: copy.owner, admin: copy.admin, manager: copy.manager, member: copy.member }[role]}
                  onPress={() => setSelectedMembershipRoles((current) => toggledValue(current, role))}
                  selected={selectedMembershipRoles.includes(role)}
                />
              ))}
            </View>
          </View>
          <View style={styles.formGroup}>
            <Text style={styles.dimensionLabel}>{copy.preferredLanguages}</Text>
            <View style={styles.formChips}>
              {audienceLanguageOptions.map((languageCode) => (
                <Chip
                  key={languageCode}
                  label={languageCode.toUpperCase()}
                  onPress={() => setSelectedAudienceLanguages((current) =>
                    toggledValue(current, languageCode))}
                  selected={selectedAudienceLanguages.includes(languageCode)}
                />
              ))}
            </View>
          </View>
          <View style={styles.ackToggle}>
            <View style={styles.ackToggleCopy}>
              <Text style={styles.dimensionLabel}>{copy.currentShiftOnly}</Text>
              <Text style={styles.policyHint}>{copy.currentShiftDescription}</Text>
            </View>
            <Switch
              accessibilityLabel={copy.currentShiftOnly}
              onValueChange={setCurrentShiftOnly}
              value={currentShiftOnly}
            />
          </View>
        </View>
        <View style={styles.audienceNotice}>
          <Ionicons name="people-circle-outline" color={colors.mintDark} size={20} />
          <View style={styles.audienceNoticeCopy}>
            <Text style={styles.audienceNoticeTitle}>{t('updates.audiencePolicy')}</Text>
            <Text style={styles.audienceNoticeText}>{t('updates.audiencePolicyBody')}</Text>
          </View>
        </View>
        <PrimaryButton
          disabled={!channelId || !canUsePublisherActions || !audienceSelectorValid}
          icon="people-outline"
          label={copy.previewAudience}
          loading={secureBusy === 'audience-preview'}
          onPress={() => void previewCurrentAudience()}
          tone="light"
        />
        {audienceReady && audiencePreview ? (
          <View accessibilityLiveRegion="polite" style={styles.previewCard}>
            <Text style={styles.previewTitle}>{copy.audienceSnapshot}</Text>
            <Text style={styles.previewMetric}>
              {audiencePreview.audienceCount} {copy.recipients} · {audiencePreview.excludedCount} {copy.excluded}
            </Text>
            <Text style={styles.previewText}>
              {copy.exclusionBreakdown}: {audiencePreview.exclusionCounts.inactiveMembers} {copy.inactive}, {' '}
              {audiencePreview.exclusionCounts.selectorMismatch} {copy.selectorMismatch}
            </Text>
            <Text style={styles.previewText}>
              {copy.languages}: {audiencePreview.notificationLanguages.join(', ') || '—'}
            </Text>
            {audiencePreview.sample.length ? (
              <Text style={styles.previewText}>
                {audiencePreview.sample.map((person) => person.displayName).join(', ')}
              </Text>
            ) : null}
            <Text style={styles.previewHint}>{copy.previewBasis}</Text>
          </View>
        ) : (
          <Text style={styles.validationError}>{copy.previewRequired}</Text>
        )}
        {!canUsePublisherActions ? (
          <View style={styles.warningPanel}>
            <Ionicons name="shield-checkmark-outline" color={colors.amber} size={18} />
            <Text style={styles.warningText}>{copy.recentMfaRequired}</Text>
          </View>
        ) : null}
        <ActionError message={secureError} />
        <PrimaryButton
          disabled={
            !channelId || !title.trim() || !body.trim() || !expirationValid || !scheduleValid
            || !reminderPolicyValid || !overrideValid || !attestationValid || !audienceReady
            || !canUsePublisherActions
          }
          icon="megaphone-outline"
          label={scheduledAt ? copy.scheduledFor : t('updates.publish')}
          loading={secureBusy === 'update-publish'}
          onPress={() => void publishUpdate()}
          tone={priority === 'emergency' ? 'danger' : 'dark'}
        />
      </ActionModal>
      <ActionModal
        description={detailUpdate ? `${copy.version} ${detailUpdate.versionNumber} · ${copy.markReadBoundary}` : undefined}
        onClose={() => {
          setDetailUpdate(null);
          setSecureError(null);
        }}
        title={detailUpdate?.title ?? copy.detailTitle}
        visible={detailUpdate !== null}>
        {detailUpdate ? (
          <>
            <View style={styles.modalBadgeRow}>
              <StatusBadge
                icon="document-text-outline"
                label={`${copy.version} ${detailUpdate.versionNumber}`}
                tone="info"
              />
              {detailUpdate.readAt || readIds.has(detailUpdate.id) ? (
                <StatusBadge icon="eye" label={copy.read} tone="success" />
              ) : null}
              <StatusBadge
                icon={detailUpdate.acknowledgementRequired ? 'hand-left-outline' : 'checkmark-circle-outline'}
                label={detailUpdate.acknowledgementRequired
                  ? copy.acknowledgementRequired
                  : copy.noAcknowledgementRequired}
                tone={detailUpdate.acknowledgementRequired ? 'purple' : 'neutral'}
              />
            </View>
            <Text selectable style={styles.detailBody}>{detailUpdate.body}</Text>
            {detailUpdate.translatedBody ? (
              <View style={styles.translationBlock}>
                <Text selectable style={styles.translationText}>{detailUpdate.translatedBody}</Text>
              </View>
            ) : null}
            <View style={styles.detailMetadata}>
              <Text style={styles.detailMetaText}>{detailUpdate.author}</Text>
              <Text style={styles.detailMetaText}>{detailUpdate.audience}</Text>
              <Text style={styles.detailMetaText}>{detailUpdate.publishedAt}</Text>
              {detailUpdate.deadline ? (
                <Text style={styles.updateDeadline}>{copy.deadline}: {detailUpdate.deadline}</Text>
              ) : null}
            </View>
            <ActionError message={secureError} />
            {detailUpdate.acknowledgementRequired
              && !detailUpdate.acknowledged
              && detailUpdate.status !== 'scheduled'
              && detailUpdate.status !== 'cancelled' ? (
              <PrimaryButton
                icon="hand-left"
                label={copy.confirmAcknowledgement}
                onPress={() => {
                  setAckTarget(detailUpdate);
                  setAttestationConfirmed(false);
                  setDetailUpdate(null);
                  setSecureError(null);
                }}
                tone={detailUpdate.severity === 'critical' ? 'danger' : 'dark'}
              />
            ) : null}
          </>
        ) : null}
      </ActionModal>
      <ActionModal
        description={copy.acknowledgeDescription}
        onClose={() => {
          setAckTarget(null);
          setAttestationConfirmed(false);
          setSecureError(null);
        }}
        title={copy.acknowledgeTitle}
        visible={ackTarget !== null}>
        {ackTarget ? (
          <>
            <View style={styles.versionStatement}>
              <Text style={styles.versionStatementLabel}>{copy.version} {ackTarget.versionNumber}</Text>
              <Text style={styles.versionStatementTitle}>{ackTarget.title}</Text>
              <Text selectable style={styles.versionStatementBody}>{ackTarget.body}</Text>
            </View>
            {ackTarget.acknowledgementSchema?.attestationRequired ? (
              <View style={styles.attestationConfirm}>
                <View style={styles.ackToggleCopy}>
                  <Text style={styles.attestationPrompt}>
                    {ackTarget.acknowledgementSchema.attestationPrompt}
                  </Text>
                  <Text style={styles.policyHint}>{copy.attestationEvidence}</Text>
                </View>
                <Switch
                  accessibilityLabel={copy.confirmAttestation}
                  onValueChange={setAttestationConfirmed}
                  value={attestationConfirmed}
                />
              </View>
            ) : null}
            <ActionError message={secureError} />
            <PrimaryButton
              disabled={Boolean(
                ackTarget.acknowledgementSchema?.attestationRequired && !attestationConfirmed
              )}
              icon="shield-checkmark-outline"
              label={copy.confirmAcknowledgement}
              loading={secureBusy === 'update-acknowledge'}
              onPress={() => void acknowledgeExactVersion()}
              tone={ackTarget.severity === 'critical' ? 'danger' : 'dark'}
            />
          </>
        ) : null}
      </ActionModal>
      <ActionModal
        description={cancelTarget?.title}
        onClose={() => {
          setCancelTarget(null);
          setCancelReason('');
          setSecureError(null);
        }}
        title={copy.cancelScheduled}
        visible={cancelTarget !== null}>
        <FormField
          label={copy.cancelReason}
          multiline
          onChangeText={setCancelReason}
          placeholder={copy.cancelReasonPlaceholder}
          value={cancelReason}
        />
        <ActionError message={secureError} />
        <PrimaryButton
          disabled={cancelReason.trim().length < 3}
          icon="close-circle-outline"
          label={copy.confirmCancel}
          loading={secureBusy === 'update-cancel'}
          onPress={() => void cancelScheduled()}
          tone="danger"
        />
      </ActionModal>
      <ActionModal
        description={copy.correctionDescription}
        onClose={() => {
          setCorrectionTarget(null);
          setSecureError(null);
        }}
        title={copy.correctionTitle}
        visible={correctionTarget !== null}>
        {correctionTarget ? (
          <View style={styles.immutableNotice}>
            <Ionicons name="lock-closed-outline" color={colors.plum} size={18} />
            <Text style={styles.immutableNoticeText}>
              {copy.version} {correctionTarget.versionNumber} · {copy.immutableHistory}
            </Text>
          </View>
        ) : null}
        <FormField label={t('updates.fieldTitle')} onChangeText={setCorrectionTitle} value={correctionTitle} />
        <FormField label={t('updates.message')} multiline onChangeText={setCorrectionBody} value={correctionBody} />
        <FormField
          label={copy.correctionReason}
          multiline
          onChangeText={setCorrectionReason}
          placeholder={copy.correctionReasonPlaceholder}
          value={correctionReason}
        />
        <ActionError message={secureError} />
        <PrimaryButton
          disabled={
            !correctionTitle.trim() || !correctionBody.trim() || correctionReason.trim().length < 3
          }
          icon="git-compare-outline"
          label={copy.publishCorrection}
          loading={secureBusy === 'update-correct'}
          onPress={() => void publishCorrection()}
          tone="dark"
        />
      </ActionModal>
      <ActionModal
        description={nonResponderTarget
          ? `${nonResponderTarget.title} · ${copy.version} ${nonResponderTarget.versionNumber}`
          : copy.nonResponderPrivacy}
        onClose={() => {
          setNonResponderTarget(null);
          setNonResponders([]);
          setNonResponderCursor(null);
          setNonResponderHasMore(false);
          setSecureError(null);
        }}
        title={copy.nonResponderTitle}
        visible={nonResponderTarget !== null}>
        <View style={styles.privacyNotice}>
          <Ionicons name="shield-checkmark-outline" color={colors.mintDark} size={18} />
          <Text style={styles.privacyNoticeText}>{copy.nonResponderPrivacy}</Text>
        </View>
        {secureBusy === 'update-non-responders' && !nonResponders.length ? (
          <ActivityIndicator accessibilityLabel={copy.previewLoading} color={colors.mintDark} />
        ) : null}
        {nonResponders.map((person) => (
          <NonResponderRow copy={copy} key={person.userId} person={person} />
        ))}
        {!nonResponders.length && secureBusy !== 'update-non-responders' ? (
          <Text style={styles.emptyManagedText}>{copy.noNonResponders}</Text>
        ) : null}
        <ActionError message={secureError} />
        {nonResponderHasMore && nonResponderTarget ? (
          <PrimaryButton
            icon="chevron-down"
            label={copy.loadMore}
            loading={secureBusy === 'update-non-responders'}
            onPress={() => void loadNonResponders(nonResponderTarget, true)}
            tone="light"
          />
        ) : null}
      </ActionModal>
    </AppScaffold>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  tone: 'danger' | 'success' | 'neutral';
}) {
  const palette = {
    danger: { background: colors.redSoft, foreground: colors.red },
    success: { background: colors.mintSoft, foreground: colors.mintDark },
    neutral: { background: colors.paperMuted, foreground: colors.inkMuted },
  }[tone];
  return (
    <View style={[styles.summaryCard, shadow]}>
      <View style={[styles.summaryIcon, { backgroundColor: palette.background }]}>
        <Ionicons name={icon} color={palette.foreground} size={19} />
      </View>
      <View>
        <Text style={styles.summaryValue}>{value}</Text>
        <Text style={styles.summaryLabel}>{label}</Text>
      </View>
    </View>
  );
}

function UpdateCard({
  update,
  onAcknowledge,
  onOpen,
  desktop,
}: {
  update: CompanyUpdate;
  onAcknowledge: () => void;
  onOpen: () => void;
  desktop: boolean;
}) {
  const { locale, t } = useI18n();
  const copy = updateCopy(locale);
  const critical = update.severity === 'critical';
  const actionAllowed = update.status !== 'scheduled' && update.status !== 'cancelled';
  const severityLabel = {
    standard: t('updates.severityStandard'),
    important: t('updates.severityImportant'),
    critical: t('updates.severityCritical'),
  }[update.severity];
  return (
    <View style={[styles.updateCard, critical && styles.updateCardCritical, shadow]}>
      <View style={styles.updateTopline}>
        <View style={styles.updateBadges}>
          <StatusBadge
            icon={critical ? 'warning' : update.severity === 'important' ? 'alert-circle' : 'megaphone'}
            label={severityLabel}
            tone={critical ? 'danger' : update.severity === 'important' ? 'warning' : 'info'}
          />
          {update.acknowledgementRequired ? (
            <StatusBadge icon="hand-left-outline" label={t('updates.responseRequired')} tone="purple" />
          ) : null}
          {update.status ? (
            <StatusBadge
              icon={update.status === 'scheduled' ? 'time-outline'
                : update.status === 'cancelled' ? 'close-circle-outline'
                : update.status === 'draft' ? 'create-outline'
                : 'checkmark-circle-outline'}
              label={{
                draft: copy.statusDraft,
                scheduled: copy.statusScheduled,
                published: copy.statusPublished,
                cancelled: copy.statusCancelled,
              }[update.status]}
              tone={update.status === 'cancelled' ? 'danger'
                : update.status === 'scheduled' ? 'warning'
                : 'success'}
            />
          ) : null}
          {update.readAt ? <StatusBadge icon="eye" label={copy.read} tone="info" /> : null}
        </View>
        <Text style={styles.updateTime}>{update.publishedAt}</Text>
      </View>

      <Text style={styles.updateTitle}>{update.title}</Text>
      <Text numberOfLines={4} style={styles.updateBody}>{update.body}</Text>
      {update.translatedBody ? (
        <View style={styles.translationBlock}>
          <View style={styles.translationLabelRow}>
            <Ionicons name="language" size={13} color={colors.mintDark} />
            <Text style={styles.translationLabel}>{t('updates.translationLabel')}</Text>
          </View>
          <Text style={styles.translationText}>{update.translatedBody}</Text>
        </View>
      ) : null}

      <View style={[styles.updateFooter, !desktop && styles.updateFooterMobile]}>
        <View style={styles.updateMeta}>
          <Text style={styles.updateAuthor}>{update.author}</Text>
          <Text style={styles.updateAudience}>{update.audience}</Text>
          <Text style={styles.updateAudience}>{copy.version} {update.versionNumber}</Text>
          {update.deadline ? <Text style={styles.updateDeadline}>{t('updates.due')} {update.deadline}</Text> : null}
        </View>
        <View style={styles.updateResponse}>
          {update.acknowledgementRequired ? (
            <Text style={styles.responseCount}>
              {update.recipientCountKnown
                ? `${update.acknowledgedCount}/${update.recipientCount} ${t('updates.acknowledgedSuffix')}`
                : update.acknowledged
                  ? t('updates.youAcknowledged')
                  : t('updates.yourAcknowledgementRequired')}
            </Text>
          ) : (
            <Text style={styles.responseCount}>
              {update.recipientCountKnown ? `${update.recipientCount} ${t('updates.recipientsSuffix')}` : t('updates.publishedAudience')}
            </Text>
          )}
          <PrimaryButton
            icon="open-outline"
            label={copy.openUpdate}
            onPress={onOpen}
            tone="light"
          />
          {update.acknowledgementRequired && actionAllowed ? (
            <PrimaryButton
              disabled={update.acknowledged}
              icon={update.acknowledged ? 'checkmark-circle' : 'hand-left'}
              label={update.acknowledged ? t('updates.acknowledged') : t('updates.understand')}
              onPress={onAcknowledge}
              tone={update.acknowledged ? 'light' : critical ? 'danger' : 'dark'}
            />
          ) : !update.acknowledgementRequired ? (
            <StatusBadge icon="checkmark-circle-outline" label={t('updates.noResponse')} tone="success" />
          ) : null}
        </View>
      </View>
    </View>
  );
}

function PublisherControlCenter({
  copy,
  error,
  loading,
  onCancel,
  onCorrect,
  onNonResponders,
  onRefresh,
  updates,
}: {
  copy: ReturnType<typeof updateCopy>;
  error: string | null;
  loading: boolean;
  onCancel: (update: ManagedUpdate) => void;
  onCorrect: (update: ManagedUpdate) => void;
  onNonResponders: (update: ManagedUpdate) => void;
  onRefresh: () => void;
  updates: ManagedUpdate[];
}) {
  return (
    <View style={styles.publisherSection}>
      <View style={styles.publisherHeader}>
        <View style={styles.publisherHeaderCopy}>
          <Text accessibilityRole="header" style={styles.publisherTitle}>{copy.publisherView}</Text>
          <Text style={styles.publisherDescription}>{copy.publisherDescription}</Text>
        </View>
        <PrimaryButton
          icon="refresh"
          label={copy.refreshPublisher}
          loading={loading}
          onPress={onRefresh}
          tone="light"
        />
      </View>
      <ActionError message={error} />
      {loading && !updates.length ? (
        <ActivityIndicator accessibilityLabel={copy.refreshPublisher} color={colors.mintDark} />
      ) : null}
      {!loading && !error && !updates.length ? (
        <Text style={styles.emptyManagedText}>{copy.noManagedUpdates}</Text>
      ) : null}
      <View style={styles.managedList}>
        {updates.map((update) => {
          const statusLabel = {
            scheduled: copy.statusScheduled,
            published: copy.statusPublished,
            cancelled: copy.statusCancelled,
            archived: copy.statusArchived,
          }[update.status];
          const notificationLabel = {
            routine: copy.routine,
            urgent: copy.urgent,
            critical: copy.critical,
          }[update.notificationClass];
          return (
            <View key={update.announcementId} style={[styles.managedCard, shadow]}>
              <View style={styles.managedTopline}>
                <View style={styles.updateBadges}>
                  <StatusBadge
                    icon={update.status === 'scheduled' ? 'time-outline'
                      : update.status === 'cancelled' ? 'close-circle-outline'
                      : update.status === 'archived' ? 'archive-outline'
                      : 'checkmark-circle-outline'}
                    label={statusLabel}
                    tone={update.status === 'cancelled' ? 'danger'
                      : update.status === 'scheduled' ? 'warning'
                      : 'success'}
                  />
                  <StatusBadge
                    icon={update.notificationClass === 'critical' ? 'warning'
                      : update.notificationClass === 'urgent' ? 'alert-circle-outline'
                      : 'notifications-outline'}
                    label={`${copy.notificationClass}: ${notificationLabel}`}
                    tone={update.notificationClass === 'critical' ? 'danger'
                      : update.notificationClass === 'urgent' ? 'warning'
                      : 'info'}
                  />
                  <StatusBadge
                    icon={update.requiresAcknowledgement ? 'hand-left-outline' : 'checkmark-circle-outline'}
                    label={update.requiresAcknowledgement
                      ? copy.acknowledgementRequired
                      : copy.noAcknowledgementRequired}
                    tone={update.requiresAcknowledgement ? 'purple' : 'neutral'}
                  />
                </View>
                <Text style={styles.managedChannel}>{update.conversationTitle}</Text>
              </View>
              <Text style={styles.managedTitle}>{update.title}</Text>
              <Text numberOfLines={3} style={styles.managedBody}>{update.body}</Text>
              <View style={styles.managedMetaRow}>
                <Text style={styles.managedMetaText}>{copy.version} {update.versionNumber}/{update.versionCount}</Text>
                {update.scheduledAt ? (
                  <Text style={styles.managedMetaText}>
                    {copy.scheduledFor}: {new Date(update.scheduledAt).toLocaleString()}
                  </Text>
                ) : null}
                {update.publishedAt ? (
                  <Text style={styles.managedMetaText}>{new Date(update.publishedAt).toLocaleString()}</Text>
                ) : null}
              </View>
              {!update.audienceSnapshotted ? (
                <View style={styles.snapshotPending}>
                  <Ionicons name="people-outline" color={colors.amber} size={16} />
                  <Text style={styles.snapshotPendingText}>{copy.snapshotPending}</Text>
                </View>
              ) : (
                <View style={styles.metricGrid}>
                  <PublisherMetric label={copy.recipients} value={update.recipientCount} />
                  <PublisherMetric label={copy.delivered} value={update.deliveredCount} />
                  <PublisherMetric label={copy.read} value={update.readCount} />
                  <PublisherMetric label={copy.acknowledgedCount} value={update.acknowledgedCount} />
                  <PublisherMetric label={copy.nonAcknowledged} tone="danger" value={update.nonAcknowledgedCount} />
                  <PublisherMetric label={copy.overdue} tone="danger" value={update.overdueCount} />
                  <PublisherMetric label={copy.unreachable} tone="warning" value={update.unreachableCount} />
                </View>
              )}
              {update.reminderPolicy.enabled ? (
                <View style={styles.reminderPanel}>
                  <Ionicons name="alarm-outline" color={colors.plum} size={17} />
                  <View style={styles.reminderPanelCopy}>
                    <Text style={styles.reminderTitle}>{copy.reminders}</Text>
                    <Text style={styles.reminderText}>
                      {copy.deadline}: {update.reminderPolicy.deadlineAt
                        ? new Date(update.reminderPolicy.deadlineAt).toLocaleString()
                        : '—'}
                    </Text>
                    <Text style={styles.reminderText}>
                      {copy.intervalMinutes}: {Math.round((update.reminderPolicy.intervalSeconds ?? 0) / 60)} · {copy.maximumReminders}: {update.reminderPolicy.maximumReminders} · {copy.escalateMinutes}: {Math.round((update.reminderPolicy.escalateAfterSeconds ?? 0) / 60)}
                    </Text>
                  </View>
                </View>
              ) : null}
              {update.quietHoursOverrideReason ? (
                <View style={styles.overrideReasonPanel}>
                  <Text style={styles.overrideReasonLabel}>{copy.overrideReason}</Text>
                  <Text style={styles.overrideReasonText}>{update.quietHoursOverrideReason}</Text>
                </View>
              ) : null}
              {update.cancellationReason ? (
                <Text style={styles.cancellationText}>{copy.cancelReason}: {update.cancellationReason}</Text>
              ) : null}
              <View style={styles.managedActions}>
                {update.status === 'scheduled' ? (
                  <PrimaryButton
                    icon="close-circle-outline"
                    label={copy.cancelScheduled}
                    onPress={() => onCancel(update)}
                    tone="danger"
                  />
                ) : null}
                {update.status === 'published' ? (
                  <PrimaryButton
                    icon="git-compare-outline"
                    label={copy.correct}
                    onPress={() => onCorrect(update)}
                    tone="light"
                  />
                ) : null}
                {update.requiresAcknowledgement
                  && (update.status === 'published' || update.status === 'archived') ? (
                  <PrimaryButton
                    icon="people-outline"
                    label={`${copy.viewNonResponders} (${update.nonAcknowledgedCount})`}
                    onPress={() => onNonResponders(update)}
                    tone="dark"
                  />
                ) : null}
              </View>
              <View style={styles.versionHistory}>
                <Text style={styles.versionHistoryTitle}>{copy.versions}</Text>
                <Text style={styles.versionHistoryHint}>{copy.immutableHistory}</Text>
                {update.versions.map((version) => (
                  <View key={version.versionId} style={styles.versionRow}>
                    <View style={styles.versionDot} />
                    <View style={styles.versionRowCopy}>
                      <Text style={styles.versionRowTitle}>
                        {copy.version} {version.versionNumber} · {version.title}
                      </Text>
                      <Text style={styles.versionRowMeta}>
                        {version.createdByDisplayName}
                        {version.publishedAt ? ` · ${new Date(version.publishedAt).toLocaleString()}` : ''}
                      </Text>
                      {version.correctionReason ? (
                        <Text style={styles.versionReason}>
                          {copy.correctionReason}: {version.correctionReason}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ))}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function PublisherMetric({
  label,
  tone = 'neutral',
  value,
}: {
  label: string;
  tone?: 'neutral' | 'danger' | 'warning';
  value: number;
}) {
  return (
    <View style={[
      styles.publisherMetric,
      tone === 'danger' && styles.publisherMetricDanger,
      tone === 'warning' && styles.publisherMetricWarning,
    ]}>
      <Text style={styles.publisherMetricValue}>{value}</Text>
      <Text style={styles.publisherMetricLabel}>{label}</Text>
    </View>
  );
}

function NonResponderRow({
  copy,
  person,
}: {
  copy: ReturnType<typeof updateCopy>;
  person: UpdateNonAcknowledger;
}) {
  const reachabilityLabel = {
    delivered: copy.deliveredReachability,
    pending: copy.pendingReachability,
    unreachable: copy.unreachableReachability,
  }[person.reachability];
  return (
    <View style={styles.nonResponderRow}>
      <View style={styles.nonResponderHeader}>
        <View style={styles.nonResponderNameBlock}>
          <Text style={styles.nonResponderName}>{person.displayName}</Text>
          <Text style={styles.nonResponderLanguage}>{person.preferredLanguage.toUpperCase()}</Text>
        </View>
        <View style={styles.updateBadges}>
          <StatusBadge
            icon={person.reachability === 'unreachable' ? 'cloud-offline-outline'
              : person.reachability === 'delivered' ? 'checkmark-done-outline'
              : 'time-outline'}
            label={reachabilityLabel}
            tone={person.reachability === 'unreachable' ? 'danger'
              : person.reachability === 'delivered' ? 'success'
              : 'warning'}
          />
          {person.overdue ? <StatusBadge icon="alarm-outline" label={copy.overdue} tone="danger" /> : null}
        </View>
      </View>
      <View style={styles.nonResponderFacts}>
        <Text style={styles.nonResponderFact}>
          {copy.read}: {person.readAt ? new Date(person.readAt).toLocaleString() : copy.notRead}
        </Text>
        <Text style={styles.nonResponderFact}>{copy.reminded}: {person.reminderCount}</Text>
        {person.escalatedAt ? (
          <Text style={styles.nonResponderFact}>
            {copy.escalated}: {new Date(person.escalatedAt).toLocaleString()}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flexGrow: 1,
    paddingBottom: spacing.xxxl,
  },
  pageMobile: {
    padding: spacing.md,
    paddingBottom: 100,
  },
  content: {
    width: '100%',
    maxWidth: 1040,
    alignSelf: 'center',
  },
  contentDesktop: {
    paddingHorizontal: spacing.xxl,
  },
  summaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  summaryCard: {
    minWidth: 210,
    flex: 1,
    minHeight: 86,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.paper,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
  },
  summaryIcon: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
  },
  summaryValue: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 20,
    fontWeight: '900',
  },
  summaryLabel: {
    color: colors.inkSubtle,
    fontSize: 11,
    marginTop: 2,
  },
  sectionHeader: {
    minHeight: 92,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
  },
  sectionEyebrow: {
    color: colors.mintDark,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.9,
  },
  sectionTitle: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 21,
    fontWeight: '800',
    marginTop: 3,
  },
  updateList: {
    gap: spacing.md,
  },
  updateCard: {
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
  },
  updateCardCritical: {
    borderLeftWidth: 4,
    borderLeftColor: colors.red,
  },
  updateTopline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  updateBadges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  updateTime: {
    color: colors.inkSubtle,
    fontSize: 10,
  },
  updateTitle: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 19,
    lineHeight: 25,
    fontWeight: '800',
    letterSpacing: -0.35,
    marginTop: spacing.md,
  },
  updateBody: {
    color: colors.inkMuted,
    fontSize: 14,
    lineHeight: 21,
    marginTop: spacing.xs,
  },
  translationBlock: {
    marginTop: spacing.md,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.mintSoft,
  },
  translationLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 4,
  },
  translationLabel: {
    color: colors.mintDark,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  translationText: {
    color: '#245C4C',
    fontSize: 13,
    lineHeight: 20,
  },
  updateFooter: {
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.lg,
  },
  updateFooterMobile: {
    alignItems: 'stretch',
    flexDirection: 'column',
  },
  updateMeta: {
    flex: 1,
  },
  updateAuthor: {
    color: colors.ink,
    fontSize: 11,
    fontWeight: '800',
  },
  updateAudience: {
    color: colors.inkSubtle,
    fontSize: 10,
    marginTop: 2,
  },
  updateDeadline: {
    color: colors.red,
    fontSize: 10,
    fontWeight: '800',
    marginTop: 4,
  },
  updateResponse: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  responseCount: {
    color: colors.inkSubtle,
    fontSize: 10,
    fontWeight: '700',
  },
  noUpdates: {
    minHeight: 240,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    padding: spacing.xl,
    borderRadius: radii.lg,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
  },
  noUpdatesTitle: { color: colors.ink, fontSize: 17, fontWeight: '900' },
  noUpdatesText: { color: colors.inkMuted, fontSize: 12, textAlign: 'center' },
  formGroup: { gap: spacing.xs },
  formLabel: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  formChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  audienceDimensions: { gap: spacing.sm },
  dimensionLabel: { color: colors.ink, fontSize: 11, fontWeight: '800' },
  ackToggle: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.paperMuted,
  },
  ackToggleCopy: { flex: 1, minWidth: 0 },
  ackToggleNote: { color: colors.inkSubtle, fontSize: 10, lineHeight: 15, marginTop: 2 },
  validationError: { color: colors.red, fontSize: 10, fontWeight: '700' },
  audienceNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.mintSoft },
  audienceNoticeCopy: { flex: 1, minWidth: 0 },
  audienceNoticeTitle: { color: colors.forest, fontSize: 11, fontWeight: '900' },
  audienceNoticeText: { color: colors.inkMuted, fontSize: 10, lineHeight: 15, marginTop: 2 },
  successNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    padding: spacing.sm,
    marginBottom: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.mint,
    backgroundColor: colors.mintSoft,
  },
  successNoticeText: { flex: 1, color: colors.forest, fontSize: 12, fontWeight: '800' },
  policyHint: { color: colors.inkMuted, fontSize: 10, lineHeight: 16 },
  policyPanel: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paperMuted,
  },
  policyGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  previewCard: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.mint,
    backgroundColor: colors.mintSoft,
  },
  previewTitle: { color: colors.forest, fontSize: 12, fontWeight: '900' },
  previewMetric: { color: colors.mintDark, fontSize: 14, fontWeight: '900' },
  previewText: { color: colors.inkMuted, fontSize: 11, lineHeight: 16 },
  previewHint: { color: colors.inkSubtle, fontSize: 9, lineHeight: 14 },
  warningPanel: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.amberSoft,
  },
  warningText: { flex: 1, color: colors.amber, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  modalBadgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  detailBody: { color: colors.ink, fontSize: 15, lineHeight: 23 },
  detailMetadata: {
    gap: 3,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  detailMetaText: { color: colors.inkSubtle, fontSize: 11, lineHeight: 16 },
  versionStatement: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.paperMuted,
  },
  versionStatementLabel: { color: colors.mintDark, fontSize: 10, fontWeight: '900' },
  versionStatementTitle: { color: colors.ink, fontSize: 17, lineHeight: 22, fontWeight: '900' },
  versionStatementBody: { color: colors.inkMuted, fontSize: 13, lineHeight: 20 },
  attestationConfirm: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.plum,
    backgroundColor: colors.plumSoft,
  },
  attestationPrompt: { color: colors.ink, fontSize: 13, lineHeight: 19, fontWeight: '800' },
  immutableNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.plumSoft,
  },
  immutableNoticeText: { flex: 1, color: colors.plum, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  privacyNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.mintSoft,
  },
  privacyNoticeText: { flex: 1, color: colors.forest, fontSize: 11, lineHeight: 17 },
  publisherSection: { gap: spacing.md, paddingTop: spacing.xxxl },
  publisherHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.lineStrong,
  },
  publisherHeaderCopy: { flex: 1, minWidth: 240 },
  publisherTitle: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 22,
    fontWeight: '900',
  },
  publisherDescription: { color: colors.inkMuted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  emptyManagedText: {
    padding: spacing.lg,
    color: colors.inkMuted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  managedList: { gap: spacing.md },
  managedCard: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paper,
  },
  managedTopline: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  managedChannel: { color: colors.inkSubtle, fontSize: 10, fontWeight: '800' },
  managedTitle: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '900',
  },
  managedBody: { color: colors.inkMuted, fontSize: 13, lineHeight: 20 },
  managedMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  managedMetaText: { color: colors.inkSubtle, fontSize: 10, lineHeight: 15 },
  snapshotPending: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.amberSoft,
  },
  snapshotPendingText: { flex: 1, color: colors.amber, fontSize: 11, fontWeight: '700' },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  publisherMetric: {
    minWidth: 105,
    flexGrow: 1,
    flexBasis: 105,
    gap: 2,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.paperMuted,
  },
  publisherMetricDanger: { backgroundColor: colors.redSoft },
  publisherMetricWarning: { backgroundColor: colors.amberSoft },
  publisherMetricValue: { color: colors.ink, fontSize: 17, fontWeight: '900' },
  publisherMetricLabel: { color: colors.inkSubtle, fontSize: 9, lineHeight: 13 },
  reminderPanel: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.plumSoft,
  },
  reminderPanelCopy: { flex: 1, minWidth: 0 },
  reminderTitle: { color: colors.plum, fontSize: 11, fontWeight: '900' },
  reminderText: { color: colors.inkMuted, fontSize: 10, lineHeight: 15, marginTop: 2 },
  overrideReasonPanel: {
    gap: 3,
    padding: spacing.sm,
    borderRadius: radii.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.amber,
    backgroundColor: colors.amberSoft,
  },
  overrideReasonLabel: { color: colors.amber, fontSize: 10, fontWeight: '900' },
  overrideReasonText: { color: colors.inkMuted, fontSize: 11, lineHeight: 16 },
  cancellationText: { color: colors.red, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  managedActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  versionHistory: {
    gap: spacing.xs,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  versionHistoryTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  versionHistoryHint: { color: colors.inkSubtle, fontSize: 9, lineHeight: 14 },
  versionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: 5 },
  versionDot: {
    width: 8,
    height: 8,
    marginTop: 5,
    borderRadius: radii.pill,
    backgroundColor: colors.mintDark,
  },
  versionRowCopy: { flex: 1, minWidth: 0 },
  versionRowTitle: { color: colors.ink, fontSize: 11, lineHeight: 16, fontWeight: '800' },
  versionRowMeta: { color: colors.inkSubtle, fontSize: 9, lineHeight: 14 },
  versionReason: { color: colors.plum, fontSize: 10, lineHeight: 15, marginTop: 2 },
  nonResponderRow: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.paperMuted,
  },
  nonResponderHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  nonResponderNameBlock: { gap: 2 },
  nonResponderName: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  nonResponderLanguage: { color: colors.inkSubtle, fontSize: 9, fontWeight: '800' },
  nonResponderFacts: { gap: 3 },
  nonResponderFact: { color: colors.inkMuted, fontSize: 10, lineHeight: 15 },
});
