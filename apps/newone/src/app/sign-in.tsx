import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
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

import { PASSWORD_MIN_LENGTH, PasswordField } from '@/components/ui/password-field';
import { Chip, PrimaryButton } from '@/components/ui/primitives';
// Metro selects the Turnstile-backed web challenge or the native risk-adapter boundary.
// eslint-disable-next-line import/no-unresolved
import { CaptchaChallenge } from '@/components/security/captcha-challenge';
import { publicRuntimeConfig } from '@/config/runtime';
import { isWebAuthBlocked } from '@/lib/supabase';
import { colors, radii, shadow, spacing, type } from '@/theme/tokens';
import { useAuth } from '@/state/auth';
import { useI18n } from '@/i18n/provider';
import { errorMessageKey } from '@/i18n/errors';
import type { MessageKey } from '@/i18n/catalog';
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

// Mirrors the server-side consumer username contract exactly.
const SIGNUP_USERNAME_PATTERN = /^[a-z0-9][a-z0-9_]{2,28}[a-z0-9]$/;

// Every code delivery (arrival on the verify step and each resend) closes the
// resend window for this long.
const RESEND_COOLDOWN_SECONDS = 60;

/** The gateway answers a wrong email or password with a bare 401. */
function credentialRejected(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    && typeof (error as { code: unknown }).code === 'string'
    ? (error as { code: string }).code.toLocaleLowerCase()
    : '';
  return code === 'unauthorized' || code === 'http_401';
}

const UI_LANGUAGES = [
  { code: 'en', labelKey: 'auth.languageEnglish' },
  { code: 'es', labelKey: 'auth.languageSpanish' },
  { code: 'ko', labelKey: 'auth.languageKorean' },
] as const;

export default function SignInScreen() {
  const router = useRouter();
  const auth = useAuth();
  const { locale, setLocale, t } = useI18n();
  const { width } = useHydrationSafeWindowDimensions();
  const wide = Platform.OS === 'web' && width >= 920;
  const [destination, setDestination] = useState('');
  const [destinationFocused, setDestinationFocused] = useState(false);
  const [destinationType, setDestinationType] = useState<'email' | 'phone'>('email');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [code, setCode] = useState('');
  const [authStep, setAuthStep] = useState<'identity' | 'verify'>('identity');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const [initialInvitationToken] = useState(invitationFromInitialLocation);
  const [accessMode, setAccessMode] = useState<'signup' | 'returning' | 'enrollment' | 'recovery'>(
    initialInvitationToken ? 'enrollment' : 'signup',
  );
  const [invitationToken, setInvitationToken] = useState(initialInvitationToken);
  const [employeeCode, setEmployeeCode] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [signInMethod, setSignInMethod] = useState<'code' | 'password'>('code');
  const [password, setPassword] = useState('');
  const signupMode = accessMode === 'signup';
  const passwordMode = accessMode === 'returning' && signInMethod === 'password';
  const enrollmentMode = accessMode === 'enrollment';
  const recoveryMode = accessMode === 'recovery';
  // Without a configured Turnstile site key the challenge cannot load; the
  // server exempts tokenless native requests, so the client omits the token.
  const captchaConfigured = Boolean(publicRuntimeConfig.turnstileSiteKey);

  // One countdown ticker runs for the whole stay on the verify step; leaving
  // the step (or unmounting) tears it down. The cooldown itself is armed by
  // the actions that deliver a code.
  useEffect(() => {
    if (authStep !== 'verify') return undefined;
    const ticker = setInterval(() => {
      setResendCooldown((current) => Math.max(0, current - 1));
    }, 1000);
    return () => clearInterval(ticker);
  }, [authStep]);

  // Localizes a failed auth call; the generic fallback copy additionally quotes
  // the stable error code and a short correlation id so members can report an
  // otherwise indistinguishable failure to support. Specific copy stays clean.
  const failureMessage = (error: unknown, fallbackKey: MessageKey) => {
    if (!(error instanceof Error)) return t(fallbackKey);
    const messageKey = errorMessageKey(error);
    const localized = t(messageKey);
    if (messageKey !== 'errors.action') return localized;
    const errorCode = 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : '';
    if (!errorCode) return localized;
    const correlationId = 'correlationId' in error
      && typeof (error as { correlationId?: unknown }).correlationId === 'string'
      ? (error as { correlationId: string }).correlationId.slice(0, 8)
      : '';
    return correlationId
      ? `${localized} (${errorCode} · ${correlationId})`
      : `${localized} (${errorCode})`;
  };

  const chooseDestinationType = (nextType: 'email' | 'phone') => {
    if (nextType === destinationType) return;
    setDestinationType(nextType);
    setDestination('');
    setCode('');
    setMessage('');
    setCaptchaToken(null);
    setCaptchaKey((current) => current + 1);
  };

  const chooseAccessMode = (nextMode: 'signup' | 'returning' | 'enrollment' | 'recovery') => {
    setAccessMode(nextMode);
    setAuthStep('identity');
    setCode('');
    setPassword('');
    setMessage('');
    setCaptchaToken(null);
    setCaptchaKey((current) => current + 1);
    if (nextMode !== 'enrollment') {
      setInvitationToken('');
      setEmployeeCode('');
    }
    if (nextMode === 'signup' && destinationType !== 'email') {
      // Open signup is delivered exclusively over email.
      setDestinationType('email');
      setDestination('');
    }
  };

  const chooseSignInMethod = (nextMethod: 'code' | 'password') => {
    setSignInMethod(nextMethod);
    setMessage('');
    setPassword('');
    if (nextMethod === 'password' && destinationType !== 'email') {
      // A password pairs with the account email; phone stays a code channel.
      setDestinationType('email');
      setDestination('');
    }
  };

  const signInWithPassword = async () => {
    const normalized = normalizeDestination('email', destination);
    if (!/^\S+@\S+\.\S+$/.test(normalized)) {
      setMessage(t('auth.emailInvalid'));
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      setMessage(t('auth.passwordTooShort'));
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      await auth.signInWithPassword({ destinationType: 'email', destination: normalized, password });
      router.replace('/');
    } catch (signInError) {
      setMessage(credentialRejected(signInError)
        ? t('auth.passwordIncorrect')
        : failureMessage(signInError, 'auth.signInUnavailable'));
    } finally {
      setLoading(false);
    }
  };

  // The one-time offer after a code sign-in: save a password, or skip.
  const savePassword = async () => {
    if (password.length < PASSWORD_MIN_LENGTH) {
      setMessage(t('auth.passwordTooShort'));
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      await auth.setPassword(password);
      router.replace('/');
    } catch (saveError) {
      setMessage(failureMessage(saveError, 'errors.action'));
    } finally {
      setLoading(false);
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
      setMessage(t(destinationType === 'email'
        ? signupMode ? 'auth.signupEmailInvalid' : 'auth.emailInvalid'
        : 'auth.phoneInvalid'));
      return;
    }
    if (captchaConfigured && (!captchaToken || captchaToken.length < 20 || /\s/.test(captchaToken))) {
      setMessage(t('auth.challengeRequired'));
      return;
    }
    const normalizedDisplayName = displayName.trim();
    if (signupMode && !SIGNUP_USERNAME_PATTERN.test(username)) {
      setMessage(t('auth.usernameInvalid'));
      return;
    }
    if (signupMode && !normalizedDisplayName) {
      setMessage(t('auth.displayNameInvalid'));
      return;
    }
    if (signupMode && password.length < PASSWORD_MIN_LENGTH) {
      setMessage(t('auth.passwordRule'));
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
      if (signupMode) {
        await auth.requestSignup({
          destination: normalized,
          username,
          displayName: normalizedDisplayName,
          language: locale,
          password,
          ...(captchaToken ? { captchaToken } : {}),
        });
        setAuthStep('verify');
        setResendCooldown(RESEND_COOLDOWN_SECONDS);
        setMessage(t('auth.signupOtpSent'));
        return;
      }
      const result = recoveryMode
        ? await auth.requestRecoveryOtp({
            destinationType,
            destination: normalized,
            ...(captchaToken ? { captchaToken } : {}),
          })
        : await auth.requestOtp({
            destinationType,
            destination: normalized,
            ...(captchaToken ? { captchaToken } : {}),
            ...(enrollmentMode ? { invitationToken: normalizedInvitationToken } : {}),
            ...(normalizedEmployeeCode ? { employeeCode: normalizedEmployeeCode } : {}),
          });
      if (!result.channelConfigured) {
        setMessage(t('auth.channelUnavailable'));
        return;
      }
      setAuthStep('verify');
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
      setMessage(t(recoveryMode ? 'auth.recoveryOtpSent' : 'auth.otpSent'));
    } catch (requestError) {
      setMessage(failureMessage(requestError, 'auth.signInUnavailable'));
    } finally {
      setLoading(false);
      setCaptchaToken(null);
      setCaptchaKey((current) => current + 1);
    }
  };

  // Re-runs the exact request that delivered the current code, with the values
  // already entered on the identity step, then closes a fresh resend window.
  const resendCode = async () => {
    setLoading(true);
    setMessage('');
    try {
      if (signupMode) {
        await auth.requestSignup({
          destination: normalizeDestination('email', destination),
          username,
          displayName: displayName.trim(),
          language: locale,
          password,
        });
        setMessage(t('auth.codeResent'));
        return;
      }
      const result = recoveryMode
        ? await auth.requestRecoveryOtp({
            destinationType,
            destination: normalizeDestination(destinationType, destination),
          })
        : await auth.requestOtp({
            destinationType,
            destination: normalizeDestination(destinationType, destination),
            ...(enrollmentMode ? { invitationToken: invitationToken.trim().toLocaleLowerCase() } : {}),
            ...(employeeCode.trim() ? { employeeCode: employeeCode.trim() } : {}),
          });
      if (!result.channelConfigured) {
        setMessage(t('auth.channelUnavailable'));
        return;
      }
      setMessage(t('auth.codeResent'));
    } catch (resendError) {
      setMessage(failureMessage(resendError, 'auth.signInUnavailable'));
    } finally {
      setLoading(false);
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
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
      let outcome: { hasPassword: boolean };
      if (signupMode) {
        outcome = await auth.verifySignup({
          destination: normalizeDestination('email', destination),
          code: normalizedCode,
          password,
        });
      } else if (recoveryMode) {
        outcome = await auth.verifyRecoveryOtp({
          destinationType,
          destination: normalizeDestination(destinationType, destination),
          code: normalizedCode,
        });
      } else {
        outcome = await auth.verifyOtp({
          destinationType,
          destination: normalizeDestination(destinationType, destination),
          ...(enrollmentMode ? { invitationToken: invitationToken.trim().toLocaleLowerCase() } : {}),
          ...(employeeCode.trim() ? { employeeCode: employeeCode.trim() } : {}),
          code: normalizedCode,
        });
      }
      // An account without a password stays here for the add-a-password offer
      // (auth.passwordPromptPending renders it); everyone else goes home.
      if (outcome.hasPassword) router.replace('/');
    } catch (verifyError) {
      const signupExpired = signupMode
        && typeof verifyError === 'object'
        && verifyError !== null
        && 'code' in verifyError
        && (verifyError as { code?: unknown }).code === 'signup_expired';
      if (signupExpired) {
        // The code or username reservation lapsed: return to the signup form
        // with every field intact so the member can request a fresh code.
        setAuthStep('identity');
        setCode('');
        setCaptchaToken(null);
        setCaptchaKey((current) => current + 1);
      }
      setMessage(failureMessage(verifyError, 'auth.verifyFailed'));
    } finally {
      setLoading(false);
    }
  };

  const onCaptchaToken = useCallback((token: string | null) => setCaptchaToken(token), []);
  const onCaptchaError = useCallback(() => setMessage(t('auth.challengeUnavailable')), [t]);

  if (auth.passwordPromptPending) {
    return (
      <SafeAreaView style={styles.root}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.keyboard}>
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <View style={[styles.card, styles.fullWidth, shadow]}>
              <Text style={styles.title}>{t('auth.passwordPromptTitle')}</Text>
              <Text style={styles.subtitle}>{t('auth.passwordPromptBody')}</Text>
              <PasswordField
                autoComplete="new-password"
                label={t('auth.newPasswordLabel')}
                testID="new-password"
                onChangeText={setPassword}
                onSubmitEditing={savePassword}
                returnKeyType="go"
                value={password}
              />
              <Text style={styles.helperText}>{t('auth.passwordRule')}</Text>
              {message ? (
                <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text>
              ) : null}
              <PrimaryButton
                icon="checkmark"
                label={t('auth.savePassword')}
                loading={loading}
                onPress={savePassword}
                style={styles.fullButton}
              />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

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
          <Text style={styles.brandStatement}>
            {t('auth.statement')}
          </Text>
          <View style={styles.trustList}>
            <TrustItem icon="language-outline" text={t('auth.trustLanguages')} />
            <TrustItem icon="people-outline" text={t('auth.trustMessages')} />
          </View>
        </View>

        <View style={[styles.card, wide ? styles.cardWide : styles.fullWidth, shadow]}>
          <Text style={styles.title}>
            {recoveryMode
              ? t('auth.titleRecovery')
              : enrollmentMode
                ? t('auth.titleEnroll')
                : signupMode
                  ? t('auth.titleSignup')
                  : t('auth.titleReturn')}
          </Text>
          <Text style={styles.subtitle}>
            {recoveryMode
              ? t('auth.subtitleRecovery')
              : enrollmentMode
                ? t('auth.subtitleEnroll')
                : signupMode
                  ? t('auth.subtitleSignup')
                  : t('auth.subtitleReturn')}
          </Text>

          <View style={styles.languageRow}>
            <Text style={styles.languageLabel}>{t('auth.languageLabel')}</Text>
            {UI_LANGUAGES.map((language) => (
              <Chip
                key={language.code}
                label={t(language.labelKey)}
                onPress={() => setLocale(language.code)}
                selected={locale === language.code}
              />
            ))}
          </View>

          {authStep === 'identity' ? (
            <View style={styles.modeChoices}>
              <Chip label={t('auth.modeSignup')} onPress={() => chooseAccessMode('signup')} selected={signupMode} />
              <Chip label={t('auth.returning')} onPress={() => {
                chooseAccessMode('returning');
              }} selected={accessMode === 'returning'} />
            </View>
          ) : null}

          {authStep === 'identity' && accessMode === 'returning' ? (
            <View style={styles.modeChoices}>
              <Chip
                label={t('auth.methodCode')}
                onPress={() => chooseSignInMethod('code')}
                selected={signInMethod === 'code'}
              />
              <Chip
                label={t('auth.methodPassword')}
                onPress={() => chooseSignInMethod('password')}
                selected={signInMethod === 'password'}
              />
            </View>
          ) : null}

          {authStep === 'identity' && !signupMode && !passwordMode ? (
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
              : t(destinationType === 'email'
                  ? signupMode ? 'auth.signupEmailLabel' : 'auth.emailLabel'
                  : 'auth.phoneLabel')}
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
                        : signupMode
                          ? t('auth.signupEmailHint')
                          : t('auth.emailHint')
                    : recoveryMode
                      ? t('auth.recoveryPhoneHint')
                      : enrollmentMode
                        ? t('auth.phoneInviteHint')
                        : t('auth.phoneHint')
                }
                accessibilityLabel={t(destinationType === 'email'
                  ? signupMode ? 'auth.signupEmailLabel' : 'auth.emailLabel'
                  : 'auth.phoneLabel')}
                autoCapitalize="none"
                autoComplete={destinationType === 'email' ? 'email' : 'tel'}
                keyboardType={destinationType === 'email' ? 'email-address' : 'phone-pad'}
                onBlur={() => setDestinationFocused(false)}
                onChangeText={setDestination}
                onFocus={() => setDestinationFocused(true)}
                onSubmitEditing={passwordMode ? undefined : sendLink}
                testID="sign-in-destination"
                placeholder={
                  destinationType === 'email'
                    ? 'you@example.com'
                    : '+52 81 5555 0192'
                }
                placeholderTextColor={colors.inkSubtle}
                returnKeyType={passwordMode ? 'next' : 'send'}
                style={styles.input}
                textContentType={destinationType === 'email' ? 'emailAddress' : 'telephoneNumber'}
                value={destination}
              />
            )}
          </View>
          {authStep === 'identity' && passwordMode ? (
            <>
              <PasswordField
                autoComplete="current-password"
                label={t('auth.passwordLabel')}
                testID="password"
                onChangeText={setPassword}
                onSubmitEditing={signInWithPassword}
                placeholder={t('auth.passwordPlaceholder')}
                returnKeyType="go"
                style={styles.passwordField}
                value={password}
              />
              <Pressable
                accessibilityRole="button"
                onPress={() => chooseSignInMethod('code')}
                style={({ pressed }) => [styles.resendLink, pressed && styles.pressed]}>
                <Text style={styles.resendText}>{t('auth.forgotPassword')}</Text>
              </Pressable>
            </>
          ) : null}
          {authStep === 'verify' ? (
            <Pressable
              accessibilityLabel={t('auth.resendCode')}
              accessibilityRole="button"
              disabled={loading || resendCooldown > 0}
              onPress={resendCode}
              style={({ pressed }) => [styles.resendLink, pressed && styles.pressed]}>
              <Text
                style={[
                  styles.resendText,
                  (loading || resendCooldown > 0) && styles.resendTextDisabled,
                ]}>
                {t('auth.resendCode')}
              </Text>
              {resendCooldown > 0 ? (
                <Text style={styles.resendCountdown}>{`(${resendCooldown}s)`}</Text>
              ) : null}
            </Pressable>
          ) : null}
          {authStep === 'identity' && signupMode ? (
            <View style={styles.signupFields}>
              <Text style={styles.label}>{t('auth.usernameLabel')}</Text>
              <View style={styles.inputWrap}>
                <Ionicons name="at-outline" size={18} color={colors.inkSubtle} />
                <TextInput
                  accessibilityLabel={t('auth.usernameLabel')}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={30}
                  onChangeText={(value) => setUsername(value.toLocaleLowerCase())}
                  placeholder={t('auth.usernamePlaceholder')}
                  placeholderTextColor={colors.inkSubtle}
                  style={styles.input}
                  value={username}
                />
              </View>
              <Text style={styles.helperText}>{t('auth.usernameHelp')}</Text>
              <Text style={styles.label}>{t('auth.displayNameLabel')}</Text>
              <View style={styles.inputWrap}>
                <Ionicons name="person-outline" size={18} color={colors.inkSubtle} />
                <TextInput
                  accessibilityLabel={t('auth.displayNameLabel')}
                  autoCorrect={false}
                  maxLength={80}
                  onChangeText={setDisplayName}
                  placeholder={t('auth.displayNamePlaceholder')}
                  placeholderTextColor={colors.inkSubtle}
                  style={styles.input}
                  value={displayName}
                />
              </View>
              {/* Every account is created with a password (owner rule). */}
              <PasswordField
                autoComplete="new-password"
                label={t('auth.signupPasswordLabel')}
                testID="signup-password"
                onChangeText={setPassword}
                placeholder={t('auth.passwordRule')}
                value={password}
              />
            </View>
          ) : null}
          {authStep === 'identity' && captchaConfigured && !isWebAuthBlocked && !passwordMode ? (
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
                  ? t(recoveryMode ? 'auth.verifyRecovery' : signupMode ? 'auth.verifySignup' : 'auth.verifySignIn')
                  : passwordMode
                    ? t('auth.signIn')
                    : t('auth.continue')
            }
            loading={loading}
            onPress={authStep === 'verify' ? verifyCode : passwordMode ? signInWithPassword : sendLink}
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
  title: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '900',
    letterSpacing: -0.7,
  },
  subtitle: {
    color: colors.inkMuted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
  modeChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.md },
  passwordField: { marginTop: spacing.md },
  languageRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  languageLabel: {
    color: colors.inkSubtle,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  enrollmentFields: { gap: spacing.xs, marginBottom: spacing.md },
  signupFields: { gap: spacing.xs, marginTop: spacing.md },
  helperText: {
    color: colors.inkSubtle,
    fontSize: 10,
    lineHeight: 15,
    marginBottom: spacing.xs,
  },
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
  resendLink: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs,
    alignSelf: 'flex-start',
  },
  resendText: {
    color: colors.mintDark,
    fontSize: 11,
    fontWeight: '900',
  },
  resendTextDisabled: {
    color: colors.inkSubtle,
  },
  resendCountdown: {
    color: colors.inkSubtle,
    fontSize: 11,
    fontWeight: '700',
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
