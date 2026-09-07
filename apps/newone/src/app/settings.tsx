import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Children, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
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
import { Avatar, IconButton, PrimaryButton } from '@/components/ui/primitives';
import type { AppLocale } from '@/i18n/catalog';
import type { OrganizationPreferences } from '@/domain/types';
import { isPersonalRealm } from '@/constants/personal-realm';
// Metro selects the native notification bridge or the web no-op.
// eslint-disable-next-line import/no-unresolved
import { getNotificationPermissionState, openNotificationSettings, type NotificationPermissionState } from '@/device/push-registration';
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
import { PasswordSection } from '@/features/settings/password-section';
import { outboxCopy } from '@/features/settings/outbox-copy';
import { useAuth } from '@/state/auth';
import { useDevicePreferences } from '@/state/device-preferences';
import { useWorkspace } from '@/state/workspace';
import { radii, spacing, type } from '@/theme/tokens';
import { THEME_PREFERENCES, type ThemePreference, useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

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

type Picker = 'appearance' | 'language' | 'messageLanguage' | 'readVisibility' | 'quietHours';

type IconName = keyof typeof Ionicons.glyphMap;

// Quiet hours arrive from the server as HH:MM:SS and are typed as HH:MM.
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export default function SettingsScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const router = useRouter();
  const workspace = useWorkspace();
  // Consumer accounts have no authenticator, recovery-case, or shift tooling;
  // those sections stay exclusively on workspace organizations.
  const personalRealm = isPersonalRealm(workspace.organizationId);
  const loadAccountSettings = workspace.loadAccountSettings;
  const enableNotifications = workspace.enableNotifications;
  const { currentUser } = workspace;
  const auth = useAuth();
  const { locale, setLocale, t } = useI18n();
  const devicePreferencesState = useDevicePreferences();
  const localPreferences = devicePreferencesState.preferences;
  const setLocalPreference = devicePreferencesState.setPreference;
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
  const [profileVisible, setProfileVisible] = useState(false);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [preferenceDraft, setPreferenceDraft] = useState<OrganizationPreferences | null>(null);
  const [profileDraft, setProfileDraft] =
    useState<{ displayName?: string; statusMessage?: string }>({});
  // The operating-system permission, refreshed whenever the app returns to the
  // foreground (the user may have just flipped it in the system settings).
  const [permission, setPermission] = useState<NotificationPermissionState | null>(null);
  const previousPermissionRef = useRef<NotificationPermissionState | null>(null);
  const devicePreferences = workspace.deviceNotificationPreferences;
  const deviceMuted = workspace.deviceNotificationsMuted;
  const setDeviceMuted = workspace.setDeviceNotificationsMuted;
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

  // Account settings save themselves: every change to the draft is written
  // after a short pause, no Save button.
  const saveOrganizationPreferences = workspace.saveOrganizationPreferences;
  const savedPreferences = workspace.organizationPreferences;
  useEffect(() => {
    if (!preferenceDraft || !savedPreferences) return;
    if (JSON.stringify(preferenceDraft) === JSON.stringify(savedPreferences)) return;
    const hasStart = Boolean(preferenceDraft.quietHoursStart);
    const hasEnd = Boolean(preferenceDraft.quietHoursEnd);
    if (hasStart !== hasEnd) return;
    if (hasStart && (
      !TIME_PATTERN.test(preferenceDraft.quietHoursStart as string)
      || !TIME_PATTERN.test(preferenceDraft.quietHoursEnd as string)
    )) return;
    const timer = setTimeout(() => {
      void saveOrganizationPreferences({ ...preferenceDraft, uiLanguage: locale });
    }, 500);
    return () => clearTimeout(timer);
  }, [locale, preferenceDraft, saveOrganizationPreferences, savedPreferences]);

  const refreshPermission = useCallback(async () => {
    try {
      setPermission(await getNotificationPermissionState());
    } catch {
      setPermission('unavailable');
    }
  }, []);

  useEffect(() => {
    let active = true;
    const read = () => {
      void getNotificationPermissionState()
        .then((state) => {
          if (active) setPermission(state);
        })
        .catch(() => {
          if (active) setPermission('unavailable');
        });
    };
    read();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') read();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  // Coming back from the system settings with permission newly granted: bind
  // the device without another tap. The initial read never triggers this.
  useEffect(() => {
    const previous = previousPermissionRef.current;
    previousPermissionRef.current = permission;
    if (
      permission === 'granted'
      && previous !== null
      && previous !== 'granted'
      && !devicePreferences
      && workspace.actionBusy !== 'device-register'
    ) {
      void enableNotifications();
    }
  }, [devicePreferences, enableNotifications, permission, workspace.actionBusy]);

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
      setProfileVisible(false);
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

  // The switch is the real state: the OS allows notifications, this device is
  // bound to the account, and the server is not muting it. Off mutes the
  // registration on the server (the worker skips it, nothing is sent); on
  // unmutes it and binds the device if it is not bound yet. An OS-level denial
  // still goes to the system settings, the only place it can be undone.
  const deviceRegistered = Boolean(devicePreferences);
  const notificationsOn = permission === 'granted' && deviceRegistered && !deviceMuted;
  const notificationsBusy = permission === null
    || workspace.actionBusy === 'device-register'
    || workspace.actionBusy === 'device-mute-save';
  const toggleNotifications = async (next: boolean) => {
    if (permission === 'denied') {
      await openNotificationSettings();
      return;
    }
    if (!next) {
      await setDeviceMuted(true);
      return;
    }
    if (deviceMuted && !(await setDeviceMuted(false))) return;
    if (!deviceRegistered || permission !== 'granted') {
      await enableNotifications();
      await refreshPermission();
    }
  };

  const openRevoke = (sessionId: string) => {
    workspace.clearActionError();
    setRevokeReason('');
    setRevokeTargetSessionId(sessionId);
    setRevokeVisible(true);
  };

  const localeLabel = (value: AppLocale) => (
    value === 'ko' ? t('settings.korean') : value === 'es' ? t('settings.spanish') : t('settings.english')
  );
  const readVisibilityLabel = (value: OrganizationPreferences['readVisibility']) => (
    value === 'everyone'
      ? t('settings.readEveryone')
      : value === 'contacts' ? t('settings.readContacts') : t('settings.readNobody')
  );
  const quietHoursValue = preferenceDraft?.quietHoursStart && preferenceDraft.quietHoursEnd
    ? `${preferenceDraft.quietHoursStart.slice(0, 5)}–${preferenceDraft.quietHoursEnd.slice(0, 5)}`
    : t('settings.disabled');
  const appearanceLabel = (value: ThemePreference) => value === 'light'
    ? t('settings.appearanceLight')
    : value === 'dark' ? t('settings.appearanceDark') : t('settings.appearanceSystem');
  const pickerTitle = picker === 'appearance'
    ? t('settings.appearance')
    : picker === 'language'
    ? t('settings.displayLanguage')
    : picker === 'messageLanguage'
      ? t('settings.messageLanguage')
      : picker === 'readVisibility' ? t('settings.readVisibility') : t('settings.quietHours');

  const verifiedFactor = mfaFactors.find((factor) => factor.status === 'verified');
  const privileged = workspace.capabilities.some((capability) => [
    'members.security', 'sessions.revoke', 'roles.manage', 'invites.manage',
    'communications.publish', 'reports.investigate', 'reports.assign', 'audit.read',
  ].includes(capability));
  const mfaStatus = verifiedFactor
    ? mfaLevel === 'aal2' ? t('settings.mfaAal2') : t('settings.mfaEnrolled')
    : t('settings.mfaNotEnrolled');
  const otherSessions = workspace.accountSessions.filter((session) => !session.current && !session.revoked);
  const showOutbox = workspace.messageOutbox.length > 0 || Boolean(workspace.outboxDegradedReason);

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
        <IconButton label={t('settings.close')} name="close" onPress={() => router.back()} size={36} />
        <Text accessibilityRole="header" style={styles.headerTitle}>{t('settings.title')}</Text>
        <View style={styles.headerSpacer} />
      </View>
      {/* One banner for the current action's error, visible at any scroll position. */}
      {workspace.actionError ? (
        <View style={styles.errorBanner}>
          <ActionError message={workspace.actionError} />
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <Pressable
          accessibilityLabel={t('settings.profileTitle')}
          accessibilityRole="button"
          onPress={() => {
            setProfileDraft({});
            setProfileVisible(true);
          }}
          style={({ pressed }) => [styles.profileRow, pressed && styles.pressed]}>
          <Avatar
            color={currentUser.avatarColor}
            imageUri={ownAvatarUrl}
            initials={currentUser.initials}
            presence={currentUser.presence}
            size={48}
          />
          <View style={styles.profileCopy}>
            <Text numberOfLines={1} style={styles.profileName}>{currentUser.displayName}</Text>
            {/* The @handle is what other people search for, so it sits next to the name. */}
            <Text numberOfLines={1} style={styles.profileMeta}>
              {[
                currentUser.username ? `@${currentUser.username}` : currentUser.roleLabel,
                currentUser.statusMessage?.trim() || null,
              ].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <Ionicons color={colors.inkSubtle} name="chevron-forward" size={18} />
        </Pressable>
        <PasswordSection />

        <Group title={t('settings.generalTitle')}>
          <Row
            disabled={false}
            icon="contrast-outline"
            label={t('settings.appearance')}
            onPress={() => setPicker('appearance')}
            testID="setting-appearance"
            value={appearanceLabel(localPreferences.theme)}
          />
          <Row
            disabled={false}
            icon="language-outline"
            label={t('settings.displayLanguage')}
            onPress={() => setPicker('language')}
            value={localeLabel(locale)}
          />
          <Row
            disabled={!preferenceDraft}
            icon="swap-horizontal-outline"
            label={t('settings.messageLanguage')}
            onPress={() => setPicker('messageLanguage')}
            value={preferenceDraft
              ? preferenceDraft.messageLanguage
                ? localeLabel(preferenceDraft.messageLanguage)
                : t('settings.messageLanguageAuto')
              : ''}
          />
          <Row
            disabled={!preferenceDraft}
            icon="checkmark-done-outline"
            label={t('settings.readVisibility')}
            onPress={() => setPicker('readVisibility')}
            value={preferenceDraft ? readVisibilityLabel(preferenceDraft.readVisibility) : ''}
          />
        </Group>

        <Group title={t('settings.chatsTitle')}>
          <SwitchRow
            hint={t('settings.translatedOnlyHint')}
            icon="text-outline"
            label={t('settings.translatedOnly')}
            onValueChange={(value) => setLocalPreference('translatedOnly', value)}
            testID="setting-translated-only"
            value={localPreferences.translatedOnly}
          />
          <SwitchRow
            icon="return-down-back-outline"
            label={t('settings.enterSends')}
            onValueChange={(value) => setLocalPreference('enterSends', value)}
            testID="setting-enter-sends"
            value={localPreferences.enterSends}
          />
        </Group>

        <Group title={t('settings.notificationsTitle')}>
          {permission !== 'unavailable' ? (
            <SwitchRow
              disabled={notificationsBusy}
              hint={deviceRegistered && deviceMuted ? t('settings.notificationsMuted') : undefined}
              icon="notifications-outline"
              label={t('settings.notifications')}
              onValueChange={(value) => void toggleNotifications(value)}
              testID="setting-allow-notifications"
              value={notificationsOn}
            />
          ) : null}
          <SwitchRow
            disabled={!preferenceDraft}
            icon="volume-medium-outline"
            label={t('settings.sound')}
            onValueChange={(value) => setPreferenceDraft((current) => current ? { ...current, soundEnabled: value } : current)}
            value={preferenceDraft?.soundEnabled ?? true}
          />
          <SwitchRow
            disabled={!preferenceDraft}
            icon="phone-portrait-outline"
            label={t('settings.vibration')}
            onValueChange={(value) => setPreferenceDraft((current) => current ? { ...current, vibrationEnabled: value } : current)}
            value={preferenceDraft?.vibrationEnabled ?? true}
          />
          <Row
            disabled={!preferenceDraft}
            icon="moon-outline"
            label={t('settings.quietHours')}
            onPress={() => setPicker('quietHours')}
            value={preferenceDraft ? quietHoursValue : ''}
          />
          {!personalRealm ? (
            <SwitchRow
              disabled={!preferenceDraft}
              icon="time-outline"
              label={t('settings.shiftSuppression')}
              onValueChange={(value) => setPreferenceDraft((current) => current ? { ...current, shiftAwareSuppression: value } : current)}
              value={preferenceDraft?.shiftAwareSuppression ?? false}
            />
          ) : null}
        </Group>

        {showOutbox ? (
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
        ) : null}

        {!personalRealm ? (
          <>
            <Group title={t('settings.securityTitle')}>
              <Row
                hint={mfaStatus}
                icon="shield-checkmark-outline"
                label={t('settings.mfaTitle')}
                right={(
                  <RowAction
                    label={verifiedFactor ? t('settings.mfaVerify') : t('settings.mfaEnroll')}
                    loading={mfaLoading && !mfaVisible}
                    onPress={() => void openMfa()}
                    tone={!verifiedFactor && privileged ? 'danger' : 'accent'}
                  />
                )}
              />
              {privileged && !verifiedFactor ? (
                <Text style={styles.warningText}>{t('settings.mfaPrivilegedWarning')}</Text>
              ) : null}
              {mfaError ? <View style={styles.inlineError}><ActionError message={mfaError} /></View> : null}
            </Group>
            <SelfRecoveryRequest
              accessToken={auth.session?.access_token ?? null}
              organizationId={workspace.organizationId}
            />
          </>
        ) : null}

        <Group title={t('settings.sessionsTitle')}>
          <Row
            icon={Platform.OS === 'web' ? 'globe-outline' : 'phone-portrait-outline'}
            label={t('settings.currentSession')}
            right={!personalRealm && auth.sessionId ? (
              <RowAction
                label={t('settings.revokeCurrent')}
                onPress={() => openRevoke(auth.sessionId as string)}
                tone="danger"
              />
            ) : undefined}
            value={t('settings.activeNow')}
          />
          {otherSessions.map((session) => (
            <Row
              hint={`${t('settings.lastUsed')} ${new Date(session.lastUsedAt).toLocaleString()}`}
              icon={session.platform === 'web' ? 'globe-outline' : 'phone-portrait-outline'}
              key={session.sessionId}
              label={session.device?.appVersion
                ? `${session.platform?.toUpperCase()} · ${session.device.appVersion}`
                : session.signal.clientFamily}
              right={(
                <RowAction
                  label={t('settings.revokeSession')}
                  onPress={() => openRevoke(session.sessionId)}
                  tone="danger"
                />
              )}
            />
          ))}
          {otherSessions.length === 0 ? (
            <Row icon="phone-portrait-outline" label={t('settings.noOtherSessions')} muted />
          ) : null}
        </Group>

        <Group>
          <Row
            icon="help-circle-outline"
            label={t('settings.help')}
            onPress={() => router.push('./help')}
          />
          <Row
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
          />
        </Group>

        <Group title={t('settings.dangerTitle')}>
          <Row
            icon="trash-outline"
            label={t('settings.deleteAccount')}
            onPress={() => {
              setDeleteError('');
              setDeleteConfirmation('');
              setDeleteVisible(true);
            }}
            tone="danger"
          />
        </Group>
      </ScrollView>

      <ActionModal
        onClose={() => setProfileVisible(false)}
        title={t('settings.profileTitle')}
        visible={profileVisible}>
        <View style={styles.photoRow}>
          <Avatar
            color={currentUser.avatarColor}
            imageUri={ownAvatarUrl}
            initials={currentUser.initials}
            size={56}
          />
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
          testID="profile-status"
          value={draftStatusMessage}
        />
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          disabled={!profileDirty || !profileValid}
          icon="save-outline"
          label={t('settings.saveProfile')}
          loading={workspace.actionBusy === 'profile-update'}
          onPress={() => void saveProfile()}
          tone="dark"
        />
      </ActionModal>

      <ActionModal onClose={() => setPicker(null)} title={pickerTitle} visible={picker !== null}>
        {picker === 'appearance' ? (
          <OptionList
            onSelect={(value) => {
              // Written straight to the device preference the theme provider
              // reads, so the whole app repaints before the sheet closes.
              setLocalPreference('theme', value);
              setPicker(null);
            }}
            options={THEME_PREFERENCES.map((value) => [value, appearanceLabel(value)])}
            selected={localPreferences.theme}
            title={pickerTitle}
          />
        ) : null}
        {picker === 'language' ? (
          <OptionList
            onSelect={(value) => {
              setLocale(value);
              setPicker(null);
            }}
            options={(['en', 'ko', 'es'] as AppLocale[]).map((value) => [value, localeLabel(value)])}
            selected={locale}
            title={pickerTitle}
          />
        ) : null}
        {picker === 'messageLanguage' && preferenceDraft ? (
          <OptionList
            onSelect={(value) => {
              setPreferenceDraft((current) => current ? { ...current, messageLanguage: value } : current);
              setPicker(null);
            }}
            options={([null, 'en', 'ko', 'es'] as OrganizationPreferences['messageLanguage'][])
              .map((value) => [value, value ? localeLabel(value) : t('settings.messageLanguageAuto')])}
            selected={preferenceDraft.messageLanguage}
            title={pickerTitle}
          />
        ) : null}
        {picker === 'readVisibility' && preferenceDraft ? (
          <OptionList
            onSelect={(value) => {
              setPreferenceDraft((current) => current ? { ...current, readVisibility: value } : current);
              setPicker(null);
            }}
            options={(['everyone', 'contacts', 'nobody'] as OrganizationPreferences['readVisibility'][])
              .map((value) => [value, readVisibilityLabel(value)])}
            selected={preferenceDraft.readVisibility}
            title={pickerTitle}
          />
        ) : null}
        {picker === 'quietHours' && preferenceDraft ? (
          <View style={styles.quietHoursRow}>
            <View style={styles.quietField}>
              <FormField
                label={t('settings.quietStart')}
                onChangeText={(value) => setPreferenceDraft((current) => current ? { ...current, quietHoursStart: value || null } : current)}
                placeholder="21:00"
                value={preferenceDraft.quietHoursStart?.slice(0, 5) ?? ''}
              />
            </View>
            <View style={styles.quietField}>
              <FormField
                label={t('settings.quietEnd')}
                onChangeText={(value) => setPreferenceDraft((current) => current ? { ...current, quietHoursEnd: value || null } : current)}
                placeholder="07:00"
                value={preferenceDraft.quietHoursEnd?.slice(0, 5) ?? ''}
              />
            </View>
          </View>
        ) : null}
      </ActionModal>

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
        description={personalRealm ? undefined : t('settings.revokeDescription')}
        onClose={() => setRevokeVisible(false)}
        title={personalRealm ? t('settings.signOutDeviceTitle') : t('settings.revokeTitle')}
        visible={revokeVisible}>
        {!personalRealm ? (
          <FormField
            label={t('settings.revokeReason')}
            multiline
            onChangeText={setRevokeReason}
            value={revokeReason}
          />
        ) : null}
        <ActionError message={workspace.actionError} />
        <PrimaryButton
          disabled={!personalRealm && revokeReason.trim().length < 3}
          icon="log-out-outline"
          label={personalRealm ? t('settings.signOutDeviceConfirm') : t('settings.revokeConfirm')}
          loading={workspace.actionBusy === 'session-revoke'}
          onPress={async () => {
            const revokingCurrentSession = revokeTargetSessionId === auth.sessionId;
            if (
              revokeTargetSessionId
              && await workspace.revokeSession(revokeTargetSessionId, personalRealm ? 'sign_out' : revokeReason)
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

/** A titled card of rows separated by hairlines, like a messenger's settings list. */
function Group({ title, children }: { title?: string; children: ReactNode }) {
  const styles = useThemedStyles(buildStyles);
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View style={styles.group}>
      {title ? <Text accessibilityRole="header" style={styles.groupTitle}>{title}</Text> : null}
      <View style={styles.groupCard}>
        {rows.map((row, index) => (
          <View key={index}>
            {index > 0 ? <View style={styles.separator} /> : null}
            {row}
          </View>
        ))}
      </View>
    </View>
  );
}

function Row({
  icon,
  label,
  value,
  hint,
  onPress,
  right,
  tone = 'default',
  muted = false,
  disabled = false,
  testID,
}: {
  icon: IconName;
  label: string;
  value?: string;
  hint?: string;
  onPress?: () => void;
  right?: ReactNode;
  tone?: 'default' | 'danger';
  muted?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const content = (
    <>
      <Ionicons
        color={tone === 'danger' ? colors.red : colors.inkMuted}
        name={icon}
        size={20}
        style={styles.rowIcon}
      />
      <View style={styles.rowCopy}>
        <Text
          numberOfLines={1}
          style={[styles.rowLabel, tone === 'danger' && styles.rowLabelDanger, muted && styles.rowLabelMuted]}>
          {label}
        </Text>
        {hint ? <Text numberOfLines={1} style={styles.rowHint}>{hint}</Text> : null}
      </View>
      {value ? <Text numberOfLines={1} style={styles.rowValue}>{value}</Text> : null}
      {right}
      {onPress ? <Ionicons color={colors.inkSubtle} name="chevron-forward" size={16} /> : null}
    </>
  );
  if (!onPress) {
    return <View accessible={false} style={styles.row}>{content}</View>;
  }
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={testID}>
      {content}
    </Pressable>
  );
}

function SwitchRow({
  icon,
  label,
  hint,
  value,
  onValueChange,
  disabled = false,
  testID,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <Row
      hint={hint}
      icon={icon}
      label={label}
      right={(
        <Switch
          accessibilityLabel={label}
          testID={testID}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onValueChange={onValueChange}
          // The default off track is near-invisible on the card background
          // (owner, Sep 6 2026); both states get real contrast.
          ios_backgroundColor={colors.switchOff}
          thumbColor={colors.white}
          trackColor={{ false: colors.switchOff, true: colors.mintDark }}
          value={value}
        />
      )}
    />
  );
}

/** A text action at the right edge of a row (verify, sign out, ...). */
function RowAction({
  label,
  onPress,
  tone = 'accent',
  loading = false,
}: {
  label: string;
  onPress: () => void;
  tone?: 'accent' | 'danger';
  loading?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: loading }}
      disabled={loading}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.rowAction, pressed && styles.pressed]}>
      {loading ? (
        <ActivityIndicator color={colors.mintDark} size="small" />
      ) : (
        <Text style={[styles.rowActionText, tone === 'danger' && styles.rowActionDanger]}>{label}</Text>
      )}
    </Pressable>
  );
}

function OptionList<T extends string | null>({
  title,
  options,
  selected,
  onSelect,
}: {
  title: string;
  options: [T, string][];
  selected: T;
  onSelect: (value: T) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.options}>
      {options.map(([value, label]) => (
        <Pressable
          accessibilityLabel={`${title}: ${label}`}
          accessibilityRole="button"
          accessibilityState={{ selected: selected === value }}
          key={value ?? 'auto'}
          onPress={() => onSelect(value)}
          style={({ pressed }) => [styles.option, pressed && styles.pressed]}>
          <Text style={[styles.optionText, selected === value && styles.optionTextSelected]}>{label}</Text>
          {selected === value ? <Ionicons color={colors.mintDark} name="checkmark" size={20} /> : null}
        </Pressable>
      ))}
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  loadingScreen: { flex: 1 },
  errorBanner: { paddingHorizontal: spacing.md, paddingTop: spacing.xs },
  header: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, backgroundColor: colors.paper },
  headerTitle: { flex: 1, color: colors.ink, fontFamily: type.display, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  headerSpacer: { width: 36 },
  page: { width: '100%', maxWidth: 640, alignSelf: 'center', paddingVertical: spacing.sm, paddingBottom: spacing.xxxl },
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.sm, borderRadius: radii.md, backgroundColor: colors.paper },
  profileCopy: { flex: 1, minWidth: 0 },
  profileName: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  profileMeta: { color: colors.inkSubtle, fontSize: 13, marginTop: 1 },
  group: { marginTop: spacing.md },
  groupTitle: { color: colors.inkSubtle, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginHorizontal: spacing.lg + spacing.xs, marginBottom: spacing.xxs },
  groupCard: { marginHorizontal: spacing.sm, borderRadius: radii.md, overflow: 'hidden', backgroundColor: colors.paper },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: spacing.sm + 20 + spacing.sm, backgroundColor: colors.line },
  row: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  rowIcon: { width: 20, textAlign: 'center' },
  rowCopy: { flex: 1, minWidth: 0 },
  rowLabel: { color: colors.ink, fontSize: 15 },
  rowLabelDanger: { color: colors.red },
  rowLabelMuted: { color: colors.inkSubtle },
  rowHint: { color: colors.inkSubtle, fontSize: 12, marginTop: 1 },
  rowValue: { color: colors.inkSubtle, fontSize: 14, maxWidth: '45%' },
  rowAction: { minHeight: 32, justifyContent: 'center', paddingHorizontal: spacing.xs },
  rowActionText: { color: colors.mintDark, fontSize: 14, fontWeight: '700' },
  rowActionDanger: { color: colors.red },
  warningText: { color: colors.amber, fontSize: 12, lineHeight: 16, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  inlineError: { paddingHorizontal: spacing.sm, paddingBottom: spacing.xs },
  photoRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  options: { gap: 0 },
  option: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, paddingHorizontal: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  optionText: { color: colors.ink, fontSize: 15 },
  optionTextSelected: { color: colors.mintDark, fontWeight: '700' },
  quietHoursRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  quietField: { flex: 1, minWidth: 140 },
  enrollment: { alignItems: 'center', gap: spacing.xs },
  qrCode: { width: 220, height: 220, backgroundColor: colors.white },
  secretLabel: { color: colors.inkSubtle, fontSize: 10, fontWeight: '800' },
  secret: { color: colors.ink, fontFamily: type.mono, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  pressed: { opacity: 0.7 },
});
