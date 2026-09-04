import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionError, ActionModal, FormField } from '@/components/ui/action-modal';
import { MessageOutboxSection } from '@/components/settings/message-outbox-section';
import { Avatar, IconButton, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import type { AppLocale } from '@/i18n/catalog';
import type { OrganizationPreferences } from '@/domain/types';
import type {
  DeviceNotificationPreferenceOverrides,
} from '@/data/repositories/device-notification-preferences-dto.mjs';
import { isPersonalRealm } from '@/constants/personal-realm';
import { useProfileAvatar } from '@/state/profile-avatar';
import { errorMessageKey } from '@/i18n/errors';
import * as ImagePicker from 'expo-image-picker';
import { useI18n } from '@/i18n/provider';
import { getSupabaseClient } from '@/lib/supabase';
import {
  challengeWebMfa,
  enrollWebMfa,
  listWebMfaFactors,
  verifyWebMfa,
} from '@/lib/web-auth';
import { SelfRecoveryRequest } from '@/features/security/self-recovery-request';
import { outboxCopy } from '@/features/settings/outbox-copy';
import { useAuth } from '@/state/auth';
import { useWorkspace } from '@/state/workspace';
import { colors, radii, shadow, spacing, type } from '@/theme/tokens';
import { useHydrationSafeWindowDimensions } from '@/hooks/use-hydration-safe-window-dimensions';

interface MfaFactor {
  id: string;
  friendly_name?: string;
  status: 'verified' | 'unverified';
}

interface MfaEnrollment {
  factorId: string;
  qrCode: string;
  secret: string;
}

export default function SettingsScreen() {
  const router = useRouter();
  const { width } = useHydrationSafeWindowDimensions();
  const compact = width < 520;
  const workspace = useWorkspace();
  // Consumer accounts have no authenticator, recovery-case, or shift tooling;
  // those sections stay exclusively on workspace organizations.
  const personalRealm = isPersonalRealm(workspace.organizationId);
  const loadAccountSettings = workspace.loadAccountSettings;
  const { currentUser } = workspace;
  const auth = useAuth();
  const { locale, setLocale, t } = useI18n();
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaError, setMfaError] = useState('');
  const [mfaFactors, setMfaFactors] = useState<MfaFactor[]>([]);
  const [mfaLevel, setMfaLevel] = useState<'aal1' | 'aal2' | null>(auth.assuranceLevel);
  const [mfaVisible, setMfaVisible] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaEnrollment, setMfaEnrollment] = useState<MfaEnrollment | null>(null);
  const [challengeFactorId, setChallengeFactorId] = useState('');
  const [webChallengeId, setWebChallengeId] = useState('');
  const [revokeVisible, setRevokeVisible] = useState(false);
  const [revokeTargetSessionId, setRevokeTargetSessionId] = useState('');
  const [revokeReason, setRevokeReason] = useState('');
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [preferenceDraft, setPreferenceDraft] = useState<OrganizationPreferences | null>(null);
  // Profile picture (owner backlog v2): the current user's photo, chosen from
  // the library and uploaded through the profile avatar grant.
  const ownAvatarUrl = useProfileAvatar(currentUser?.id ?? null);
  const choosePhoto = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.86,
    });
    const asset = result.assets?.[0];
    if (!asset) return;
    await workspace.uploadProfileAvatar({
      uri: asset.uri,
      name: asset.fileName ?? `profile-${Date.now()}.jpg`,
      mimeType: asset.mimeType ?? 'image/jpeg',
      size: asset.fileSize,
      width: asset.width,
      height: asset.height,
      imageMode: 'optimized',
    });
  };
  // Consumer settings save themselves (owner backlog, Sep 4 2026): every
  // change to the draft is written after a short pause, no Save button.
  const saveOrganizationPreferences = workspace.saveOrganizationPreferences;
  const savedPreferences = workspace.organizationPreferences;
  useEffect(() => {
    if (!personalRealm || !preferenceDraft || !savedPreferences) return;
    if (JSON.stringify(preferenceDraft) === JSON.stringify(savedPreferences)) return;
    const hasStart = Boolean(preferenceDraft.quietHoursStart);
    const hasEnd = Boolean(preferenceDraft.quietHoursEnd);
    const time = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (hasStart !== hasEnd || (hasStart && (!time.test(preferenceDraft.quietHoursStart as string) || !time.test(preferenceDraft.quietHoursEnd as string)))) return;
    const timer = setTimeout(() => {
      void saveOrganizationPreferences({ ...preferenceDraft, uiLanguage: locale });
    }, 500);
    return () => clearTimeout(timer);
  }, [locale, personalRealm, preferenceDraft, saveOrganizationPreferences, savedPreferences]);
  const [devicePreferenceDraft, setDevicePreferenceDraft] =
    useState<DeviceNotificationPreferenceOverrides | null>(null);
  const [profileDraft, setProfileDraft] =
    useState<{ displayName?: string; statusMessage?: string }>({});
  const devicePreferences = workspace.deviceNotificationPreferences;

  const loadMfa = useCallback(async () => {
    if (Platform.OS === 'web') {
      setMfaLoading(true);
      try {
        const factors = await listWebMfaFactors();
        setMfaFactors(factors.map((factor) => ({
          id: factor.id,
          friendly_name: factor.friendlyName,
          status: factor.status,
        })));
        setMfaLevel((current) => current ?? 'aal1');
        setMfaError('');
      } catch {
        setMfaError(t('settings.mfaLoadError'));
      } finally {
        setMfaLoading(false);
      }
      return;
    }
    const client = getSupabaseClient();
    if (!client) return;
    setMfaLoading(true);
    const [factorResult, levelResult] = await Promise.all([
      client.auth.mfa.listFactors(),
      client.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
    setMfaLoading(false);
    if (factorResult.error || levelResult.error) {
      setMfaError(t('settings.mfaLoadError'));
      return;
    }
    setMfaFactors(
      factorResult.data.all
        .filter((factor) => factor.factor_type === 'totp')
        .map((factor) => ({
          id: factor.id,
          friendly_name: factor.friendly_name,
          status: factor.status,
        })),
    );
    setMfaLevel(levelResult.data.currentLevel === 'aal2' ? 'aal2' : 'aal1');
    setMfaError('');
  }, [t]);

  useEffect(() => {
    if (personalRealm) return;
    const timeout = setTimeout(() => void loadMfa(), 0);
    return () => clearTimeout(timeout);
  }, [loadMfa, personalRealm]);

  useEffect(() => {
    const timeout = setTimeout(() => void loadAccountSettings(), 0);
    return () => clearTimeout(timeout);
  }, [loadAccountSettings]);

  useEffect(() => {
    if (!workspace.organizationPreferences) return;
    const timeout = setTimeout(() => setPreferenceDraft(workspace.organizationPreferences), 0);
    return () => clearTimeout(timeout);
  }, [workspace.organizationPreferences]);

  useEffect(() => {
    const current = workspace.deviceNotificationPreferences;
    const timeout = setTimeout(
      () => setDevicePreferenceDraft(current ? { ...current.overrides } : null),
      0,
    );
    return () => clearTimeout(timeout);
  }, [workspace.deviceNotificationPreferences]);

  const openMfa = async () => {
    if (Platform.OS === 'web') {
      setMfaLoading(true);
      setMfaError('');
      setMfaCode('');
      try {
        if (mfaEnrollment) {
          setMfaVisible(true);
          return;
        }
        const verified = mfaFactors.find((factor) => factor.status === 'verified');
        if (verified) {
          const challenge = await challengeWebMfa(verified.id);
          setChallengeFactorId(verified.id);
          setWebChallengeId(challenge.challengeId);
          setMfaEnrollment(null);
        } else {
          const enrollment = await enrollWebMfa('Newone authenticator');
          const challenge = await challengeWebMfa(enrollment.factorId);
          setChallengeFactorId(enrollment.factorId);
          setWebChallengeId(challenge.challengeId);
          setMfaEnrollment(enrollment);
        }
        setMfaVisible(true);
      } catch {
        setMfaError(verifiedFactor ? t('settings.mfaVerifyError') : t('settings.mfaEnrollError'));
      } finally {
        setMfaLoading(false);
      }
      return;
    }
    const client = getSupabaseClient();
    if (!client) return;
    setMfaLoading(true);
    setMfaError('');
    setMfaCode('');
    const verified = mfaFactors.find((factor) => factor.status === 'verified');
    if (verified) {
      setChallengeFactorId(verified.id);
      setMfaEnrollment(null);
      setMfaVisible(true);
      setMfaLoading(false);
      return;
    }
    for (const factor of mfaFactors.filter((item) => item.status === 'unverified')) {
      await client.auth.mfa.unenroll({ factorId: factor.id });
    }
    const { data, error } = await client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Newone authenticator',
    });
    setMfaLoading(false);
    if (error || !data) {
      setMfaError(t('settings.mfaEnrollError'));
      return;
    }
    setChallengeFactorId(data.id);
    setMfaEnrollment({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
    setMfaVisible(true);
  };

  const closeMfa = async () => {
    if (Platform.OS === 'web') {
      setMfaVisible(false);
      setMfaCode('');
      return;
    }
    if (mfaEnrollment) {
      await getSupabaseClient()?.auth.mfa.unenroll({ factorId: mfaEnrollment.factorId });
    }
    setMfaVisible(false);
    setMfaEnrollment(null);
    setMfaCode('');
    await loadMfa();
  };

  const verifyMfa = async () => {
    const client = getSupabaseClient();
    const code = mfaCode.replace(/\s/g, '');
    if (!challengeFactorId || !/^\d{6}$/.test(code)) {
      setMfaError(t('settings.mfaCodeError'));
      return;
    }
    setMfaLoading(true);
    setMfaError('');
    if (Platform.OS === 'web') {
      try {
        await verifyWebMfa({ factorId: challengeFactorId, challengeId: webChallengeId, code });
        await auth.refreshAssurance();
        setMfaLevel('aal2');
        setMfaEnrollment(null);
        setMfaVisible(false);
        setMfaCode('');
        await loadMfa();
      } catch {
        setMfaError(t('settings.mfaVerifyError'));
      } finally {
        setMfaLoading(false);
      }
      return;
    }
    if (!client) {
      setMfaLoading(false);
      setMfaError(t('settings.mfaVerifyError'));
      return;
    }
    const { error } = await client.auth.mfa.challengeAndVerify({ factorId: challengeFactorId, code });
    setMfaLoading(false);
    if (error) {
      setMfaError(t('settings.mfaVerifyError'));
      return;
    }
    await auth.refreshAssurance();
    setMfaEnrollment(null);
    setMfaVisible(false);
    setMfaCode('');
    await loadMfa();
  };

  // The draft holds only what the user has typed. Untouched fields follow the
  // authoritative profile, and a successful save clears the draft so the
  // inputs show the server's values rather than the text that was submitted.
  const draftDisplayName = profileDraft.displayName ?? currentUser?.displayName ?? '';
  const draftStatusMessage = profileDraft.statusMessage ?? currentUser?.statusMessage ?? '';
  const trimmedDisplayName = draftDisplayName.trim();
  const trimmedStatusMessage = draftStatusMessage.trim();
  const profileValid = trimmedDisplayName.length >= 1
    && trimmedDisplayName.length <= 120
    && trimmedStatusMessage.length <= 280;
  const profileDirty = trimmedDisplayName !== (currentUser?.displayName ?? '')
    || trimmedStatusMessage !== (currentUser?.statusMessage ?? '');

  const saveProfile = async () => {
    if (await workspace.updateProfile({
      displayName: draftDisplayName,
      statusMessage: draftStatusMessage,
    })) {
      setProfileDraft({});
    }
  };

  // Confirmation requires the account's username; DELETE is the deliberate
  // fallback while a signed-in identity has no username to retype.
  const deletionUsername = currentUser?.username?.trim() || null;
  const deletionToken = deletionUsername ?? 'DELETE';

  const confirmDeletion = async () => {
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await auth.deleteAccount();
      router.replace('/sign-in');
    } catch (deletionFailure) {
      setDeleteError(t(errorMessageKey(deletionFailure)));
    } finally {
      setDeleteBusy(false);
    }
  };

  const verifiedFactor = mfaFactors.find((factor) => factor.status === 'verified');
  const privileged = workspace.capabilities.some((capability) => [
    'members.security', 'sessions.revoke', 'roles.manage', 'invites.manage',
    'communications.publish', 'reports.investigate', 'reports.assign', 'audit.read',
  ].includes(capability));

  if (!currentUser) {
    return (
      <SafeAreaView style={styles.root}>
        <ActivityIndicator color={colors.mintDark} style={styles.loadingScreen} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <IconButton label={t('settings.close')} name="close" onPress={() => router.back()} />
        <View style={styles.headerCopy}>
          <Text accessibilityRole="header" style={styles.headerTitle}>{t('settings.title')}</Text>
          <Text style={styles.headerSubtitle}>{t('settings.subtitle')}</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <View style={[styles.profileCard, compact && styles.profileCardCompact, shadow]}>
          <Avatar
            color={currentUser.avatarColor}
            imageUri={ownAvatarUrl}
            initials={currentUser.initials}
            presence={currentUser.presence}
            size={64}
          />
          <View style={styles.profileCopy}>
            <Text style={styles.profileName}>{currentUser.displayName}</Text>
            <Text style={styles.profileRole}>{currentUser.roleLabel}</Text>
            <View style={styles.profileBadges}>
              <StatusBadge
                icon="checkmark-circle"
                label={t(personalRealm ? 'settings.accountVerified' : 'settings.companyVerified')}
                tone="success"
              />
              <StatusBadge
                icon="language"
                label={locale === 'ko' ? '한국어' : locale === 'es' ? 'Español' : 'English'}
                tone="purple"
              />
            </View>
          </View>
        </View>

        <SettingsSection
          description={t('settings.profileDescription')}
          icon="person-circle-outline"
          title={t('settings.profileTitle')}>
          <View style={styles.preferenceForm}>
            <View style={styles.photoRow}>
              <PrimaryButton
                icon="image-outline"
                label={t('settings.choosePhoto')}
                loading={workspace.actionBusy === 'profile-avatar-upload'}
                onPress={() => void choosePhoto()}
                tone="light"
              />
              {ownAvatarUrl ? (
                <PrimaryButton
                  icon="trash-outline"
                  label={t('settings.removePhoto')}
                  loading={workspace.actionBusy === 'profile-avatar-remove'}
                  onPress={() => void workspace.removeProfileAvatar()}
                  tone="light"
                />
              ) : null}
            </View>
            <Text style={styles.rowHint}>
              {workspace.actionBusy === 'profile-avatar-upload' ? t('settings.photoUploading') : t('settings.photoHint')}
            </Text>
            <FormField
              label={t('settings.displayName')}
              onChangeText={(value) => setProfileDraft((current) => ({ ...current, displayName: value }))}
              value={draftDisplayName}
            />
            <FormField
              label={t('settings.statusMessage')}
              multiline
              onChangeText={(value) => setProfileDraft((current) => ({ ...current, statusMessage: value }))}
              placeholder={t('settings.statusMessagePlaceholder')}
              value={draftStatusMessage}
            />
            <Text style={styles.rowNote}>{t('settings.profileLimits')}</Text>
            {currentUser.username ? (
              <Text style={styles.rowNote}>{t('settings.usernameNote')} @{currentUser.username}</Text>
            ) : null}
            <View style={styles.notificationActions}>
              <PrimaryButton
                disabled={!profileDirty || !profileValid}
                icon="save-outline"
                label={t('settings.saveProfile')}
                loading={workspace.actionBusy === 'profile-update'}
                onPress={() => void saveProfile()}
                tone="dark"
              />
            </View>
          </View>
          <ActionError message={workspace.actionError} />
        </SettingsSection>

        <SettingsSection
          description={t('settings.languageDescription')}
          icon="language-outline"
          title={t('settings.languageTitle')}>
          <View style={styles.languageRow}>
            <Text style={styles.rowLabel}>{t('settings.displayLanguage')}</Text>
            <View style={styles.languageOptions}>
              {([
                ['en', t('settings.english')],
                ['ko', t('settings.korean')],
                ['es', t('settings.spanish')],
              ] as [AppLocale, string][]).map(([id, label]) => (
                <Pressable
                  accessibilityLabel={`${t('settings.displayLanguage')}: ${label}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: locale === id }}
                  key={id}
                  onPress={() => setLocale(id)}
                  style={({ pressed }) => [
                    styles.languageOption,
                    locale === id && styles.languageOptionSelected,
                    pressed && styles.pressed,
                  ]}>
                  <Text style={[styles.languageOptionText, locale === id && styles.languageOptionTextSelected]}>{label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        </SettingsSection>

        <SettingsSection
          description={t(personalRealm ? 'settings.preferencesDescriptionConsumer' : 'settings.preferencesDescription')}
          icon="options-outline"
          title={t('settings.preferencesTitle')}>
          {workspace.actionBusy === 'account-settings-load' && !preferenceDraft ? (
            <ActivityIndicator color={colors.mintDark} />
          ) : preferenceDraft ? (
            <View style={styles.preferenceForm}>
              <Text style={styles.rowLabel}>{t('settings.messageLanguage')}</Text>
              <View style={styles.languageOptions}>
                {([
                  [null, t('settings.messageLanguageAuto')],
                  ['en', t('settings.english')],
                  ['ko', t('settings.korean')],
                  ['es', t('settings.spanish')],
                ] as [OrganizationPreferences['messageLanguage'], string][]).map(([id, label]) => (
                  <Pressable
                    accessibilityLabel={`${t('settings.messageLanguage')}: ${label}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: preferenceDraft.messageLanguage === id }}
                    key={id ?? 'auto'}
                    onPress={() => setPreferenceDraft((current) => current ? { ...current, messageLanguage: id } : current)}
                    style={({ pressed }) => [styles.languageOption, preferenceDraft.messageLanguage === id && styles.languageOptionSelected, pressed && styles.pressed]}>
                    <Text style={[styles.languageOptionText, preferenceDraft.messageLanguage === id && styles.languageOptionTextSelected]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.rowLabel}>{t('settings.notificationPreview')}</Text>
              <View style={styles.languageOptions}>
                {([
                  ['generic', t('settings.previewGeneric')],
                  ['hidden', t('settings.previewHidden')],
                ] as [OrganizationPreferences['notificationPreview'], string][]).map(([id, label]) => (
                  <Pressable
                    accessibilityLabel={`${t('settings.notificationPreview')}: ${label}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: preferenceDraft.notificationPreview === id }}
                    key={id}
                    onPress={() => setPreferenceDraft((current) => current ? { ...current, notificationPreview: id } : current)}
                    style={({ pressed }) => [styles.languageOption, preferenceDraft.notificationPreview === id && styles.languageOptionSelected, pressed && styles.pressed]}>
                    <Text style={[styles.languageOptionText, preferenceDraft.notificationPreview === id && styles.languageOptionTextSelected]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.rowLabel}>{t('settings.readVisibility')}</Text>
              <View style={styles.languageOptions}>
                {([
                  ['everyone', t('settings.readEveryone')],
                  ['contacts', t('settings.readContacts')],
                  ['nobody', t('settings.readNobody')],
                ] as [OrganizationPreferences['readVisibility'], string][]).map(([id, label]) => (
                  <Pressable
                    accessibilityLabel={`${t('settings.readVisibility')}: ${label}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: preferenceDraft.readVisibility === id }}
                    key={id}
                    onPress={() => setPreferenceDraft((current) => current ? { ...current, readVisibility: id } : current)}
                    style={({ pressed }) => [styles.languageOption, preferenceDraft.readVisibility === id && styles.languageOptionSelected, pressed && styles.pressed]}>
                    <Text style={[styles.languageOptionText, preferenceDraft.readVisibility === id && styles.languageOptionTextSelected]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.quietHoursRow}>
                <View style={styles.quietField}>
                  <FormField
                    label={t('settings.quietStart')}
                    onChangeText={(value) => setPreferenceDraft((current) => current ? { ...current, quietHoursStart: value || null } : current)}
                    value={preferenceDraft.quietHoursStart?.slice(0, 5) ?? ''}
                  />
                </View>
                <View style={styles.quietField}>
                  <FormField
                    label={t('settings.quietEnd')}
                    onChangeText={(value) => setPreferenceDraft((current) => current ? { ...current, quietHoursEnd: value || null } : current)}
                    value={preferenceDraft.quietHoursEnd?.slice(0, 5) ?? ''}
                  />
                </View>
              </View>
              {!personalRealm ? (
                <PreferenceSwitch
                  label={t('settings.shiftSuppression')}
                  onValueChange={(value) => setPreferenceDraft((current) => current ? { ...current, shiftAwareSuppression: value } : current)}
                  value={preferenceDraft.shiftAwareSuppression}
                />
              ) : null}
              <PreferenceSwitch
                label={t('settings.sound')}
                onValueChange={(value) => setPreferenceDraft((current) => current ? { ...current, soundEnabled: value } : current)}
                value={preferenceDraft.soundEnabled}
              />
              <PreferenceSwitch
                label={t('settings.vibration')}
                onValueChange={(value) => setPreferenceDraft((current) => current ? { ...current, vibrationEnabled: value } : current)}
                value={preferenceDraft.vibrationEnabled}
              />
              {personalRealm ? (
                <Text style={styles.rowHint}>
                  {workspace.actionBusy === 'organization-preferences-save' ? t('settings.preferencesSaving') : t('settings.preferencesAutoSaved')}
                </Text>
              ) : (
              <PrimaryButton
                label={t('settings.savePreferences')}
                loading={workspace.actionBusy === 'organization-preferences-save'}
                onPress={async () => {
                  const hasStart = Boolean(preferenceDraft.quietHoursStart);
                  const hasEnd = Boolean(preferenceDraft.quietHoursEnd);
                  if (hasStart !== hasEnd || (hasStart && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(preferenceDraft.quietHoursStart as string) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(preferenceDraft.quietHoursEnd as string)))) return;
                  if (await workspace.saveOrganizationPreferences({ ...preferenceDraft, uiLanguage: locale })) setLocale(locale);
                }}
                tone="dark"
              />
              )}
            </View>
          ) : null}
          <ActionError message={workspace.actionError} />
        </SettingsSection>

        <MessageOutboxSection
          actionBusy={workspace.actionBusy}
          actionError={workspace.actionError}
          copy={outboxCopy(locale)}
          degradedReason={workspace.outboxDegradedReason}
          items={workspace.messageOutbox}
          onCancel={workspace.cancelOutboxMessage}
          onClearError={workspace.clearActionError}
          onEdit={workspace.editOutboxMessage}
          onRetry={workspace.retryOutboxMessage}
          resolveConversationTitle={(conversationId) =>
            workspace.conversations.find((conversation) => conversation.id === conversationId)?.title ?? null}
        />

        <SettingsSection
          description={t('settings.notificationsDescription')}
          icon="notifications-outline"
          title={t('settings.notificationsTitle')}>
          <View style={styles.preferenceForm}>
            <View style={styles.securityRow}>
              <View style={styles.securityCopy}>
                <Text style={styles.rowLabel}>{t('settings.deviceNotifications')}</Text>
                <Text style={styles.rowNote}>
                  {t(personalRealm ? 'settings.deviceNotificationsNoteConsumer' : 'settings.deviceNotificationsNote')}
                </Text>
              </View>
              {Platform.OS === 'web' ? (
                <StatusBadge label={t('settings.nativeOnly')} />
              ) : devicePreferences ? (
                <StatusBadge
                  icon="phone-portrait-outline"
                  label={`${t('settings.currentDevice')} · ${devicePreferences.platform.toUpperCase()}`}
                  tone="success"
                />
              ) : (
                <PrimaryButton
                  icon="notifications-outline"
                  label={t('settings.enableNotifications')}
                  loading={workspace.actionBusy === 'device-register'}
                  onPress={() => void workspace.enableNotifications()}
                />
              )}
            </View>
            {devicePreferences && devicePreferenceDraft ? (
              <>
                <View style={styles.devicePreferenceBoundary}>
                  <Ionicons name="shield-checkmark-outline" color={colors.mintDark} size={18} />
                  <View style={styles.securityCopy}>
                    <Text style={styles.rowLabel}>{t('settings.currentDevicePreferences')}</Text>
                    <Text style={styles.rowNote}>
                      {t(personalRealm ? 'settings.devicePreferencesBoundaryConsumer' : 'settings.devicePreferencesBoundary')}
                    </Text>
                  </View>
                </View>
                <Text style={styles.rowLabel}>{t('settings.notificationPreview')}</Text>
                <View style={styles.languageOptions}>
                  {([
                    [null, t('settings.inheritAccount')],
                    ['generic', t('settings.previewGeneric')],
                    ['hidden', t('settings.previewHiddenDevice')],
                  ] as [DeviceNotificationPreferenceOverrides['notificationPreview'], string][])
                    .map(([value, label]) => (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: devicePreferenceDraft.notificationPreview === value }}
                        key={`device-preview-${value ?? 'inherit'}`}
                        onPress={() => setDevicePreferenceDraft((current) => current
                          ? { ...current, notificationPreview: value }
                          : current)}
                        style={({ pressed }) => [
                          styles.languageOption,
                          devicePreferenceDraft.notificationPreview === value && styles.languageOptionSelected,
                          pressed && styles.pressed,
                        ]}>
                        <Text style={[
                          styles.languageOptionText,
                          devicePreferenceDraft.notificationPreview === value && styles.languageOptionTextSelected,
                        ]}>{label}</Text>
                      </Pressable>
                    ))}
                </View>
                <Text style={styles.effectivePreference}>
                  {t('settings.effectiveValue')} · {devicePreferences.effective.notificationPreview === 'generic'
                    ? t('settings.previewGeneric')
                    : t('settings.previewHiddenDevice')}
                </Text>
                {([
                  ['soundEnabled', t('settings.sound')],
                  ['vibrationEnabled', t('settings.vibration')],
                ] as const).map(([field, label]) => (
                  <View key={field} style={styles.devicePreferenceField}>
                    <Text style={styles.rowLabel}>{label}</Text>
                    <View style={styles.languageOptions}>
                      {([
                        [null, t('settings.inheritAccount')],
                        [true, t('settings.enabled')],
                        [false, t('settings.disabled')],
                      ] as [boolean | null, string][]).map(([value, optionLabel]) => (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityState={{ selected: devicePreferenceDraft[field] === value }}
                          key={`${field}-${String(value)}`}
                          onPress={() => setDevicePreferenceDraft((current) => current
                            ? { ...current, [field]: value }
                            : current)}
                          style={({ pressed }) => [
                            styles.languageOption,
                            devicePreferenceDraft[field] === value && styles.languageOptionSelected,
                            pressed && styles.pressed,
                          ]}>
                          <Text style={[
                            styles.languageOptionText,
                            devicePreferenceDraft[field] === value && styles.languageOptionTextSelected,
                          ]}>{optionLabel}</Text>
                        </Pressable>
                      ))}
                    </View>
                    <Text style={styles.effectivePreference}>
                      {t('settings.effectiveValue')} · {devicePreferences.effective[field]
                        ? t('settings.enabled') : t('settings.disabled')}
                    </Text>
                  </View>
                ))}
                <Text style={styles.rowNote}>
                  {t('settings.devicePreferencesUpdated')} · {new Date(
                    devicePreferences.updatedAt,
                  ).toLocaleString()}
                </Text>
                <View style={styles.notificationActions}>
                  <PrimaryButton
                    icon="refresh-outline"
                    label={t('settings.refreshDevicePreferences')}
                    loading={workspace.actionBusy === 'device-preferences-load'}
                    onPress={() => void workspace.loadDeviceNotificationPreferences()}
                    tone="light"
                  />
                  <PrimaryButton
                    disabled={JSON.stringify(devicePreferenceDraft) === JSON.stringify(
                      devicePreferences.overrides,
                    )}
                    icon="save-outline"
                    label={t('settings.saveDevicePreferences')}
                    loading={workspace.actionBusy === 'device-preferences-save'}
                    onPress={() => void workspace.saveDeviceNotificationPreferences(
                      devicePreferenceDraft,
                    )}
                    tone="dark"
                  />
                </View>
              </>
            ) : Platform.OS !== 'web' ? (
              <Text style={styles.rowNote}>{t('settings.devicePreferencesUnavailable')}</Text>
            ) : null}
          </View>
          <ActionError message={workspace.actionError} />
        </SettingsSection>

        {!personalRealm ? (
          <>
          <SettingsSection
            description={t('settings.mfaDescription')}
            icon="shield-checkmark-outline"
            title={t('settings.securityTitle')}>
            {mfaLoading && !mfaVisible ? <ActivityIndicator color={colors.mintDark} /> : null}
            <View style={styles.securityRow}>
              <View style={styles.securityCopy}>
                <Text style={styles.rowLabel}>{t('settings.mfaTitle')}</Text>
                <Text style={styles.rowNote}>
                  {Platform.OS === 'web'
                    ? verifiedFactor
                      ? mfaLevel === 'aal2'
                        ? t('settings.mfaAal2')
                        : t('settings.mfaEnrolled')
                      : t('settings.mfaNotEnrolled')
                    : verifiedFactor
                      ? mfaLevel === 'aal2'
                        ? t('settings.mfaAal2')
                        : t('settings.mfaEnrolled')
                      : t('settings.mfaNotEnrolled')}
                </Text>
              </View>
              <PrimaryButton
                icon={verifiedFactor ? 'key-outline' : 'add-circle-outline'}
                label={verifiedFactor ? t('settings.mfaVerify') : t('settings.mfaEnroll')}
                loading={mfaLoading}
                onPress={() => void openMfa()}
                tone={verifiedFactor ? 'dark' : privileged ? 'danger' : 'light'}
              />
            </View>
            {privileged && !verifiedFactor ? (
              <View style={styles.warningRow}>
                <Ionicons name="warning" size={16} color={colors.amber} />
                <Text style={styles.warningText}>{t('settings.mfaPrivilegedWarning')}</Text>
              </View>
            ) : null}
            <ActionError message={mfaError} />
          </SettingsSection>

          <SelfRecoveryRequest
            accessToken={auth.session?.access_token ?? null}
            organizationId={workspace.organizationId}
          />
          </>
        ) : null}

        <SettingsSection
          description={t('settings.sessionsDescription')}
          icon="phone-portrait-outline"
          title={t('settings.sessionsTitle')}>
          <View style={styles.deviceRow}>
            <View style={styles.deviceIcon}>
              <Ionicons
                name={Platform.OS === 'web' ? 'globe-outline' : 'phone-portrait-outline'}
                size={20}
                color={colors.mintDark}
              />
            </View>
            <View style={styles.deviceCopy}>
              <Text style={styles.rowLabel}>{t('settings.currentSession')}</Text>
              <Text style={styles.rowNote}>
                {Platform.OS === 'web' ? t('settings.httpOnlySession') : `${Platform.OS.toUpperCase()} · ${auth.assuranceLevel ?? 'aal1'}`}
              </Text>
            </View>
            <StatusBadge label={t('settings.activeNow')} tone="success" />
          </View>
          {auth.sessionId ? (
            <PrimaryButton
              icon="log-out-outline"
              label={t('settings.revokeCurrent')}
              onPress={() => {
                workspace.clearActionError();
                setRevokeReason('');
                setRevokeTargetSessionId(auth.sessionId as string);
                setRevokeVisible(true);
              }}
              tone="danger"
            />
          ) : null}
          {workspace.accountSessions.filter((session) => !session.current && !session.revoked).map((session) => (
            <View key={session.sessionId} style={styles.deviceRow}>
              <View style={styles.deviceIcon}>
                <Ionicons name={session.platform === 'web' ? 'globe-outline' : 'phone-portrait-outline'} size={20} color={colors.mintDark} />
              </View>
              <View style={styles.deviceCopy}>
                <Text style={styles.rowLabel}>{session.device?.appVersion ? `${session.platform?.toUpperCase()} · ${session.device.appVersion}` : session.signal.clientFamily}</Text>
                <Text style={styles.rowNote}>{t('settings.lastUsed')} {new Date(session.lastUsedAt).toLocaleString()}</Text>
              </View>
              <PrimaryButton
                label={t('settings.revokeSession')}
                onPress={() => {
                  workspace.clearActionError();
                  setRevokeReason('');
                  setRevokeTargetSessionId(session.sessionId);
                  setRevokeVisible(true);
                }}
                tone="danger"
              />
            </View>
          ))}
          {!workspace.accountSessions.some((session) => !session.current && !session.revoked) ? (
            <View style={styles.scopeNote}>
              <Ionicons name="information-circle-outline" color={colors.inkSubtle} size={16} />
              <Text style={styles.scopeNoteText}>{t('settings.noOtherSessions')}</Text>
            </View>
          ) : null}
        </SettingsSection>

        {!personalRealm ? (
          <View style={styles.footerNote}>
            <Ionicons name="lock-closed" size={14} color={colors.inkSubtle} />
            <Text style={styles.footerNoteText}>{t('settings.privateDmNote')}</Text>
          </View>
        ) : null}
        <PrimaryButton
          icon="help-circle-outline"
          label={t('settings.help')}
          onPress={() => router.push('./help')}
          tone="light"
        />
        <PrimaryButton
          icon="log-out-outline"
          label={t('settings.signOut')}
          onPress={async () => {
            // Sign-out revokes this session on the server (owner decision,
            // Sep 4 2026) so the Devices list and other devices see it end;
            // if the revoke cannot be sent, the local sign-out still happens.
            const revoked = auth.sessionId
              ? await workspace.revokeSession(auth.sessionId, 'sign_out')
              : false;
            if (!revoked) await auth.signOut();
            router.replace('/sign-in');
          }}
          tone="danger"
        />

        <View style={[styles.dangerSection, shadow]}>
          <View style={styles.sectionHeader}>
            <View style={styles.dangerIcon}>
              <Ionicons name="trash-outline" size={19} color={colors.red} />
            </View>
            <View style={styles.sectionHeaderCopy}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>
                {t('settings.dangerTitle')}
              </Text>
              <Text style={styles.sectionDescription}>{t('settings.dangerDescription')}</Text>
            </View>
          </View>
          <View style={styles.sectionRows}>
            <View style={styles.securityRow}>
              <View style={styles.securityCopy}>
                <Text style={styles.rowLabel}>{t('settings.deleteAccount')}</Text>
                <Text style={styles.rowNote}>{t('settings.deleteAccountNote')}</Text>
              </View>
              <PrimaryButton
                icon="trash-outline"
                label={t('settings.deleteAccount')}
                onPress={() => {
                  setDeleteError('');
                  setDeleteConfirmation('');
                  setDeleteVisible(true);
                }}
                tone="danger"
              />
            </View>
          </View>
        </View>
      </ScrollView>

      <ActionModal
        description={mfaEnrollment ? t('settings.mfaEnrollInstructions') : t('settings.mfaVerifyInstructions')}
        onClose={() => void closeMfa()}
        title={mfaEnrollment ? t('settings.mfaEnrollDialog') : t('settings.mfaVerifyDialog')}
        visible={mfaVisible}>
        {mfaEnrollment ? (
          <View style={styles.enrollment}>
            <Image
              accessibilityLabel={t('settings.mfaQrLabel')}
              resizeMode="contain"
              source={{ uri: `data:image/svg+xml;utf-8,${encodeURIComponent(mfaEnrollment.qrCode)}` }}
              style={styles.qrCode}
            />
            <Text style={styles.secretLabel}>{t('settings.mfaSecretLabel')}</Text>
            <Text selectable style={styles.secret}>{mfaEnrollment.secret}</Text>
          </View>
        ) : null}
        <FormField
          keyboardType="number-pad"
          label={t('settings.mfaCodeLabel')}
          onChangeText={setMfaCode}
          value={mfaCode}
        />
        <ActionError message={mfaError} />
        <PrimaryButton
          disabled={!/^\d{6}$/.test(mfaCode.replace(/\s/g, ''))}
          icon="shield-checkmark-outline"
          label={t('settings.mfaConfirm')}
          loading={mfaLoading}
          onPress={() => void verifyMfa()}
          tone="dark"
        />
      </ActionModal>

      <ActionModal
        description={t('settings.revokeDescription')}
        onClose={() => setRevokeVisible(false)}
        title={t('settings.revokeTitle')}
        visible={revokeVisible}>
        <FormField
          label={t('settings.revokeReason')}
          multiline
          onChangeText={setRevokeReason}
          value={revokeReason}
        />
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          disabled={revokeReason.trim().length < 3}
          icon="log-out-outline"
          label={t('settings.revokeConfirm')}
          loading={workspace.actionBusy === 'session-revoke'}
          onPress={async () => {
            const revokingCurrentSession = revokeTargetSessionId === auth.sessionId;
            if (
              revokeTargetSessionId
              && await workspace.revokeSession(revokeTargetSessionId, revokeReason)
            ) {
              if (revokingCurrentSession) {
                router.replace('/sign-in');
              } else {
                setRevokeVisible(false);
                await workspace.loadAccountSettings();
              }
            }
          }}
          tone="danger"
        />
      </ActionModal>

      <ActionModal
        description={t('settings.deleteDialogDescription')}
        onClose={() => {
          if (!deleteBusy) setDeleteVisible(false);
        }}
        title={t('settings.deleteDialogTitle')}
        visible={deleteVisible}>
        <FormField
          label={deletionUsername
            ? t('settings.deleteConfirmUsername')
            : t('settings.deleteConfirmFallback')}
          onChangeText={setDeleteConfirmation}
          placeholder={deletionToken}
          value={deleteConfirmation}
        />
        <ActionError message={deleteError} />
        <PrimaryButton
          disabled={deleteConfirmation.trim() !== deletionToken}
          icon="trash-outline"
          label={t('settings.deleteConfirm')}
          loading={deleteBusy}
          onPress={() => void confirmDeletion()}
          tone="danger"
        />
      </ActionModal>
    </SafeAreaView>
  );
}

function SettingsSection({
  icon,
  title,
  description,
  children,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.section, shadow]}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionIcon}>
          <Ionicons name={icon} size={19} color={colors.mintDark} />
        </View>
        <View style={styles.sectionHeaderCopy}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>
          <Text style={styles.sectionDescription}>{description}</Text>
        </View>
      </View>
      <View style={styles.sectionRows}>{children}</View>
    </View>
  );
}

function PreferenceSwitch({
  label,
  value,
  onValueChange,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.preferenceSwitch}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Switch accessibilityLabel={label} onValueChange={onValueChange} value={value} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  loadingScreen: { flex: 1 },
  header: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, backgroundColor: colors.paper },
  headerCopy: { flex: 1, minWidth: 0 },
  headerTitle: { color: colors.ink, fontFamily: type.display, fontSize: 18, fontWeight: '900', textAlign: 'center' },
  headerSubtitle: { color: colors.inkSubtle, fontSize: 10, textAlign: 'center', marginTop: 2 },
  headerSpacer: { width: 40 },
  page: { width: '100%', maxWidth: 800, alignSelf: 'center', gap: spacing.md, padding: spacing.md, paddingBottom: spacing.xxxl },
  profileCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  profileCardCompact: { alignItems: 'flex-start', flexDirection: 'column' },
  profileCopy: { flex: 1, minWidth: 0, maxWidth: '100%' },
  profileName: { color: colors.ink, fontFamily: type.display, fontSize: 19, fontWeight: '900', flexShrink: 1 },
  profileRole: { color: colors.inkMuted, fontSize: 11, marginTop: 3 },
  profileBadges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  section: { overflow: 'hidden', borderRadius: radii.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  dangerSection: { overflow: 'hidden', borderRadius: radii.lg, borderWidth: 1, borderColor: colors.red, backgroundColor: colors.paper },
  dangerIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md, backgroundColor: colors.redSoft },
  sectionHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.lg, backgroundColor: colors.paperMuted },
  sectionIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md, backgroundColor: colors.mintSoft },
  sectionHeaderCopy: { flex: 1, minWidth: 0 },
  sectionTitle: { color: colors.ink, fontSize: 14, fontWeight: '900' },
  sectionDescription: { color: colors.inkSubtle, fontSize: 10, lineHeight: 15, marginTop: 3 },
  sectionRows: { gap: spacing.sm, padding: spacing.md },
  languageRow: { gap: spacing.sm },
  languageOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  languageOption: { minHeight: 44, minWidth: 90, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radii.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paperMuted },
  languageOptionSelected: { borderColor: colors.forest, backgroundColor: colors.forest },
  languageOptionText: { color: colors.inkMuted, fontSize: 12, fontWeight: '800' },
  languageOptionTextSelected: { color: colors.white },
  preferenceForm: { gap: spacing.md },
  devicePreferenceBoundary: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.mintSoft },
  devicePreferenceField: { gap: spacing.xs },
  effectivePreference: { color: colors.mintDark, fontSize: 10, lineHeight: 15, fontWeight: '700' },
  notificationActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.xs },
  quietHoursRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  quietField: { flex: 1, minWidth: 180 },
  preferenceSwitch: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  photoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  rowHint: {
    color: colors.inkMuted,
    fontSize: 13,
  },
  rowLabel: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  rowNote: { color: colors.inkSubtle, fontSize: 10, lineHeight: 15, marginTop: 3 },
  securityRow: { minHeight: 62, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  securityCopy: { flex: 1, minWidth: 190 },
  warningRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.amberSoft },
  warningText: { flex: 1, color: colors.amber, fontSize: 10, lineHeight: 15, fontWeight: '700' },
  deviceRow: { minHeight: 62, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  deviceIcon: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md, backgroundColor: colors.mintSoft },
  deviceCopy: { flex: 1, minWidth: 150 },
  scopeNote: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.sm, borderRadius: radii.md, backgroundColor: colors.paperMuted },
  scopeNoteText: { flex: 1, color: colors.inkSubtle, fontSize: 10, lineHeight: 15 },
  footerNote: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, padding: spacing.sm },
  footerNoteText: { flex: 1, color: colors.inkSubtle, fontSize: 10, lineHeight: 15 },
  enrollment: { alignItems: 'center', gap: spacing.xs },
  qrCode: { width: 220, height: 220, backgroundColor: colors.white },
  secretLabel: { color: colors.inkSubtle, fontSize: 10, fontWeight: '800' },
  secret: { color: colors.ink, fontFamily: type.mono, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  pressed: { opacity: 0.7 },
});
