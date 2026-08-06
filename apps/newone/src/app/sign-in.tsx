import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Chip, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
// Metro selects the Turnstile-backed web challenge or the native risk-adapter boundary.
// eslint-disable-next-line import/no-unresolved
import { CaptchaChallenge } from '@/components/security/captcha-challenge';
import { isWebAuthBlocked } from '@/lib/supabase';
import { colors, radii, shadow, spacing, type } from '@/theme/tokens';
import { useAuth } from '@/state/auth';
import { useI18n } from '@/i18n/provider';
import { errorMessageKey } from '@/i18n/errors';
import { useHydrationSafeWindowDimensions } from '@/hooks/use-hydration-safe-window-dimensions';

function invitationFromInitialLocation() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    // Native invitation capabilities are entered directly and never accepted
    // from deep links, query strings, or URLs.
    return '';
  }

  const current = new URL(window.location.href);
  const fragment = new URLSearchParams(current.hash.startsWith('#') ? current.hash.slice(1) : current.hash);
  const invitationToken = fragment.get('invite')
    ?? fragment.get('invitationToken')
    ?? '';

  // Invitation capabilities are bearer secrets. Scrub the fragment synchronously
  // during the first render, before Turnstile mounts.
  fragment.delete('invite');
  fragment.delete('invitationToken');
  const remainingFragment = fragment.toString();
  const cleanLocation = `${current.pathname}${current.search}${remainingFragment ? `#${remainingFragment}` : ''}`;
  window.history.replaceState(window.history.state, '', cleanLocation);

  return invitationToken;
}

function normalizeDestination(destinationType: 'email' | 'phone', value: string) {
  return destinationType === 'email'
    ? value.trim().toLocaleLowerCase()
    : value.trim().replace(/[\s().-]/g, '');
}

export default function SignInScreen() {
  const router = useRouter();
  const auth = useAuth();
  const { t } = useI18n();
  const { width } = useHydrationSafeWindowDimensions();
  const wide = Platform.OS === 'web' && width >= 920;
  const [destination, setDestination] = useState('');
  const [destinationFocused, setDestinationFocused] = useState(false);
  const [destinationType, setDestinationType] = useState<'email' | 'phone'>('email');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [code, setCode] = useState('');
  const [authStep, setAuthStep] = useState<'identity' | 'verify'>('identity');
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const [initialInvitationToken] = useState(invitationFromInitialLocation);
  const [accessMode, setAccessMode] = useState<'returning' | 'enrollment' | 'recovery'>(
    initialInvitationToken ? 'enrollment' : 'returning',
  );
  const [invitationToken, setInvitationToken] = useState(initialInvitationToken);
  const [employeeCode, setEmployeeCode] = useState('');
  const enrollmentMode = accessMode === 'enrollment';
  const recoveryMode = accessMode === 'recovery';

  const chooseDestinationType = (nextType: 'email' | 'phone') => {
    if (nextType === destinationType) return;
    setDestinationType(nextType);
    setDestination('');
    setCode('');
    setMessage('');
    setCaptchaToken(null);
    setCaptchaKey((current) => current + 1);
  };

  const chooseAccessMode = (nextMode: 'returning' | 'enrollment' | 'recovery') => {
    setAccessMode(nextMode);
    setAuthStep('identity');
    setCode('');
    setMessage('');
    setCaptchaToken(null);
    setCaptchaKey((current) => current + 1);
    if (nextMode !== 'enrollment') {
      setInvitationToken('');
      setEmployeeCode('');
    }
  };

  const sendLink = async () => {
    if (isWebAuthBlocked) {
      setMessage(t('auth.gatewayUnavailable'));
      return;
    }
    const normalized = normalizeDestination(destinationType, destination);
    const destinationValid = destinationType === 'email'
      ? /^\S+@\S+\.\S+$/.test(normalized)
      : /^\+[1-9][0-9]{7,14}$/.test(normalized);
    if (!destinationValid) {
      setMessage(t(destinationType === 'email' ? 'auth.emailInvalid' : 'auth.phoneInvalid'));
      return;
    }
    if (!captchaToken || captchaToken.length < 20 || /\s/.test(captchaToken)) {
      setMessage(t('auth.challengeRequired'));
      return;
    }
    const normalizedInvitationToken = invitationToken.trim().toLocaleLowerCase();
    const normalizedEmployeeCode = employeeCode.trim();
    if (enrollmentMode && !/^[0-9a-f]{64}$/.test(normalizedInvitationToken)) {
      setMessage(t('auth.invitationTokenInvalid'));
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      const result = recoveryMode
        ? await auth.requestRecoveryOtp({
            destinationType,
            destination: normalized,
            captchaToken,
          })
        : await auth.requestOtp({
            destinationType,
            destination: normalized,
            captchaToken,
            ...(enrollmentMode ? { invitationToken: normalizedInvitationToken } : {}),
            ...(normalizedEmployeeCode ? { employeeCode: normalizedEmployeeCode } : {}),
          });
      if (!result.channelConfigured) {
        setMessage(t('auth.channelUnavailable'));
        return;
      }
      setAuthStep('verify');
      setMessage(t(recoveryMode ? 'auth.recoveryOtpSent' : 'auth.otpSent'));
    } catch (requestError) {
      setMessage(requestError instanceof Error
        ? t(errorMessageKey(requestError))
        : t('auth.signInUnavailable'));
    } finally {
      setLoading(false);
      setCaptchaToken(null);
      setCaptchaKey((current) => current + 1);
    }
  };

  const verifyCode = async () => {
    const normalizedCode = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(normalizedCode)) {
      setMessage(t('auth.codeInvalid'));
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      if (recoveryMode) {
        await auth.verifyRecoveryOtp({
          destinationType,
          destination: normalizeDestination(destinationType, destination),
          code: normalizedCode,
        });
      } else {
        await auth.verifyOtp({
          destinationType,
          destination: normalizeDestination(destinationType, destination),
          ...(enrollmentMode ? { invitationToken: invitationToken.trim().toLocaleLowerCase() } : {}),
          ...(employeeCode.trim() ? { employeeCode: employeeCode.trim() } : {}),
          code: normalizedCode,
        });
      }
      router.replace('/');
    } catch (verifyError) {
      setMessage(verifyError instanceof Error
        ? t(errorMessageKey(verifyError))
        : t('auth.verifyFailed'));
    } finally {
      setLoading(false);
    }
  };

  const onCaptchaToken = useCallback((token: string | null) => setCaptchaToken(token), []);
  const onCaptchaError = useCallback(() => setMessage(t('auth.challengeUnavailable')), [t]);

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboard}>
        <ScrollView
          contentContainerStyle={[styles.scrollContent, wide && styles.scrollContentWide]}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
        <View style={[styles.brandColumn, wide ? styles.brandColumnWide : styles.fullWidth]}>
          <View style={styles.logoMark}>
            <View style={styles.logoStem} />
            <View style={styles.logoDot} />
          </View>
          <Text style={styles.brand}>newone</Text>
          <Text style={styles.brandTag}>{t('auth.brandTag')}</Text>
          <Text style={styles.brandStatement}>
            {t('auth.statement')}
          </Text>
          <View style={styles.trustList}>
            <TrustItem icon="people-outline" text={t('auth.trustMessages')} />
            <TrustItem icon="language-outline" text={t('auth.trustLanguages')} />
            <TrustItem icon="shield-checkmark-outline" text={t('auth.trustIdentity')} />
          </View>
        </View>

        <View style={[styles.card, wide ? styles.cardWide : styles.fullWidth, shadow]}>
          <View style={styles.cardTopline}>
            <StatusBadge
              icon={recoveryMode ? 'shield-checkmark' : 'lock-closed'}
              label={recoveryMode ? t('auth.recovery') : enrollmentMode ? t('auth.firstUse') : t('auth.returning')}
              tone={recoveryMode ? 'warning' : 'success'}
            />
            <Text style={styles.cardStep}>{t('auth.secureAccess')}</Text>
          </View>
          <Text style={styles.title}>
            {recoveryMode ? t('auth.titleRecovery') : enrollmentMode ? t('auth.titleEnroll') : t('auth.titleReturn')}
          </Text>
          <Text style={styles.subtitle}>
            {recoveryMode ? t('auth.subtitleRecovery') : enrollmentMode ? t('auth.subtitleEnroll') : t('auth.subtitleReturn')}
          </Text>

          {authStep === 'identity' ? (
            <View style={styles.modeChoices}>
              <Chip label={t('auth.returning')} onPress={() => {
                chooseAccessMode('returning');
              }} selected={accessMode === 'returning'} />
              <Chip label={t('auth.firstUse')} onPress={() => chooseAccessMode('enrollment')} selected={enrollmentMode} />
              <Chip label={t('auth.recovery')} onPress={() => chooseAccessMode('recovery')} selected={recoveryMode} />
            </View>
          ) : null}

          {authStep === 'identity' ? (
            <View style={styles.modeChoices}>
              <Chip
                label={t('auth.emailChannel')}
                onPress={() => chooseDestinationType('email')}
                selected={destinationType === 'email'}
              />
              <Chip
                label={t('auth.phoneChannel')}
                onPress={() => chooseDestinationType('phone')}
                selected={destinationType === 'phone'}
              />
            </View>
          ) : null}

          {authStep === 'identity' && recoveryMode ? (
            <View style={styles.recoveryWarning}>
              <Ionicons color={colors.amber} name="warning-outline" size={18} />
              <Text style={styles.recoveryWarningText}>{t('auth.recoveryWarning')}</Text>
            </View>
          ) : null}

          {authStep === 'identity' && enrollmentMode ? (
            <View style={styles.enrollmentFields}>
              <Text style={styles.label}>{t('auth.invitationTokenLabel')}</Text>
              <View style={styles.inputWrap}>
                <Ionicons name="key-outline" size={18} color={colors.inkSubtle} />
                <TextInput
                  accessibilityLabel={t('auth.invitationTokenLabel')}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setInvitationToken}
                  placeholder={t('auth.invitationTokenPlaceholder')}
                  placeholderTextColor={colors.inkSubtle}
                  secureTextEntry
                  style={styles.input}
                  value={invitationToken}
                />
              </View>
              <Text style={styles.label}>{t('auth.employeeCodeLabel')}</Text>
              <View style={styles.inputWrap}>
                <Ionicons name="id-card-outline" size={18} color={colors.inkSubtle} />
                <TextInput
                  accessibilityLabel={t('auth.employeeCodeLabel')}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  onChangeText={setEmployeeCode}
                  placeholder={t('auth.employeeCodePlaceholder')}
                  placeholderTextColor={colors.inkSubtle}
                  style={styles.input}
                  value={employeeCode}
                />
              </View>
            </View>
          ) : null}

          <Text style={styles.label}>
            {authStep === 'verify'
              ? t('auth.codeLabel')
              : t(destinationType === 'email' ? 'auth.emailLabel' : 'auth.phoneLabel')}
          </Text>
          <View style={[styles.inputWrap, destinationFocused && styles.inputWrapFocused]}>
            <Ionicons
              name={authStep === 'verify' ? 'keypad-outline' : destinationType === 'email' ? 'mail-outline' : 'call-outline'}
              size={18}
              color={colors.inkSubtle}
            />
            {authStep === 'verify' ? (
              <TextInput
                accessibilityLabel={t('auth.codeA11y')}
                autoComplete="one-time-code"
                keyboardType="number-pad"
                maxLength={6}
                onChangeText={setCode}
                onSubmitEditing={verifyCode}
                placeholder="000000"
                placeholderTextColor={colors.inkSubtle}
                returnKeyType="done"
                style={styles.input}
                textContentType="oneTimeCode"
                value={code}
              />
            ) : (
              <TextInput
                accessibilityHint={
                  destinationType === 'email'
                    ? recoveryMode
                      ? t('auth.recoveryEmailHint')
                      : enrollmentMode
                        ? t('auth.emailInviteHint')
                        : t('auth.emailHint')
                    : recoveryMode
                      ? t('auth.recoveryPhoneHint')
                      : enrollmentMode
                        ? t('auth.phoneInviteHint')
                        : t('auth.phoneHint')
                }
                accessibilityLabel={t(destinationType === 'email' ? 'auth.emailLabel' : 'auth.phoneLabel')}
                autoCapitalize="none"
                autoComplete={destinationType === 'email' ? 'email' : 'tel'}
                keyboardType={destinationType === 'email' ? 'email-address' : 'phone-pad'}
                onBlur={() => setDestinationFocused(false)}
                onChangeText={setDestination}
                onFocus={() => setDestinationFocused(true)}
                onSubmitEditing={sendLink}
                placeholder={destinationType === 'email' ? 'you@company.com' : '+52 81 5555 0192'}
                placeholderTextColor={colors.inkSubtle}
                returnKeyType="send"
                style={styles.input}
                textContentType={destinationType === 'email' ? 'emailAddress' : 'telephoneNumber'}
                value={destination}
              />
            )}
          </View>
          {authStep === 'identity' && !isWebAuthBlocked ? (
            <CaptchaChallenge
              key={captchaKey}
              label={t('auth.challengeLabel')}
              onError={onCaptchaError}
              onToken={onCaptchaToken}
            />
          ) : null}
          {isWebAuthBlocked || message || auth.error ? (
            <Text accessibilityLiveRegion="polite" style={styles.message}>
              {isWebAuthBlocked
                ? t('auth.webLocked')
                : message || auth.error}
            </Text>
          ) : null}
          <PrimaryButton
            disabled={isWebAuthBlocked}
            icon="arrow-forward"
            label={
              isWebAuthBlocked
                ? t('auth.webNotConfigured')
                : authStep === 'verify'
                  ? t(recoveryMode ? 'auth.verifyRecovery' : 'auth.verifySignIn')
                  : t('auth.continue')
            }
            loading={loading}
            onPress={authStep === 'verify' ? verifyCode : sendLink}
            style={styles.fullButton}
          />
          {authStep === 'verify' ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setAuthStep('identity');
                setCode('');
                setMessage('');
              }}
              style={({ pressed }) => [styles.secondaryLink, pressed && styles.pressed]}>
              <Text style={styles.secondaryLinkText}>{t('auth.differentIdentity')}</Text>
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="link"
            onPress={() => router.push('./help')}
            style={({ pressed }) => [styles.secondaryLink, pressed && styles.pressed]}>
            <Text style={styles.secondaryLinkText}>{t('auth.help')}</Text>
          </Pressable>

          <View style={styles.securityNote}>
            <Ionicons name="information-circle-outline" size={16} color={colors.inkSubtle} />
            <Text style={styles.securityNoteText}>
              {t('auth.securityNote')}
            </Text>
          </View>
        </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function TrustItem({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return (
    <View style={styles.trustItem}>
      <View style={styles.trustIcon}>
        <Ionicons name={icon} size={18} color={colors.forest} />
      </View>
      <Text style={styles.trustText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.forest,
  },
  keyboard: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: spacing.xl,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
  },
  scrollContentWide: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.xxxl,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xxxl,
  },
  fullWidth: {
    width: '100%',
  },
  brandColumn: {
    maxWidth: 430,
    flexShrink: 1,
  },
  brandColumnWide: {
    flexBasis: 430,
    flexGrow: 1,
  },
  logoMark: {
    width: 58,
    height: 58,
    borderRadius: 19,
    backgroundColor: colors.mint,
    position: 'relative',
    overflow: 'hidden',
  },
  logoStem: {
    position: 'absolute',
    width: 13,
    height: 37,
    left: 15,
    top: 11,
    borderRadius: 7,
    backgroundColor: colors.forest,
    transform: [{ rotate: '-18deg' }],
  },
  logoDot: {
    position: 'absolute',
    width: 13,
    height: 13,
    right: 11,
    top: 11,
    borderRadius: 7,
    backgroundColor: colors.white,
  },
  brand: {
    color: colors.white,
    fontFamily: type.display,
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -1.4,
    marginTop: spacing.md,
  },
  brandTag: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.8,
    marginTop: 2,
  },
  brandStatement: {
    maxWidth: 410,
    color: colors.white,
    fontFamily: type.display,
    fontSize: 25,
    lineHeight: 33,
    fontWeight: '700',
    letterSpacing: -0.6,
    marginTop: spacing.xxl,
  },
  trustList: {
    gap: spacing.sm,
    marginTop: spacing.xl,
  },
  trustItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  trustIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.mint,
  },
  trustText: {
    flex: 1,
    color: 'rgba(255,255,255,0.76)',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '600',
  },
  card: {
    maxWidth: 460,
    flexShrink: 1,
    padding: spacing.xl,
    borderRadius: radii.xl,
    backgroundColor: colors.paper,
  },
  cardWide: {
    flexBasis: 460,
    flexGrow: 1,
  },
  cardTopline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardStep: {
    color: colors.inkSubtle,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
  },
  title: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '900',
    letterSpacing: -0.7,
    marginTop: spacing.lg,
  },
  subtitle: {
    color: colors.inkMuted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
  modeChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.md },
  enrollmentFields: { gap: spacing.xs, marginBottom: spacing.md },
  enrollmentNote: { color: colors.inkSubtle, fontSize: 10, lineHeight: 15, marginTop: spacing.xs },
  recoveryWarning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    padding: spacing.sm,
    marginBottom: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.amberSoft,
  },
  recoveryWarningText: {
    flex: 1,
    color: colors.amber,
    fontSize: 10,
    lineHeight: 16,
    fontWeight: '700',
  },
  label: {
    color: colors.ink,
    fontSize: 11,
    fontWeight: '900',
    marginBottom: 6,
  },
  inputWrap: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.paperMuted,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  inputWrapFocused: {
    borderWidth: 2,
    borderColor: colors.mintDark,
  },
  input: {
    flex: 1,
    minWidth: 0,
    color: colors.ink,
    fontSize: 14,
    paddingVertical: spacing.sm,
  },
  message: {
    color: colors.amber,
    fontSize: 10,
    lineHeight: 15,
    marginTop: spacing.xs,
  },
  fullButton: {
    width: '100%',
    marginTop: spacing.md,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.lineStrong,
  },
  dividerText: {
    color: colors.inkSubtle,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  ssoNote: {
    color: colors.inkSubtle,
    fontSize: 9,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  secondaryLink: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  secondaryLinkText: {
    color: colors.mintDark,
    fontSize: 11,
    fontWeight: '900',
  },
  securityNote: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  securityNoteText: {
    flex: 1,
    color: colors.inkSubtle,
    fontSize: 9,
    lineHeight: 14,
  },
  pressed: {
    opacity: 0.72,
  },
});
