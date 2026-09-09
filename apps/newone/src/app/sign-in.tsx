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
import { radii, shadow, spacing, type } from '@/theme/tokens';
import { useKeyboardAppearance, useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';
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

// Sign-in is email only (owner decision, Sep 2026); the server's phone paths
// stay inert.
const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

function normalizeEmail(value: string) {
  return value.trim().toLocaleLowerCase();
}

// Mirrors the server-side consumer username contract exactly.
const SIGNUP_USERNAME_PATTERN = /^[a-z0-9][a-z0-9_]{2,28}[a-z0-9]$/;

// Every code delivery (arrival on the verify step and each resend) closes the
// resend window for this long.
const RESEND_COOLDOWN_SECONDS = 60;

/** The gateway answers a wrong password or a wrong code with a bare 401. */
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

type AccessMode = 'signup' | 'returning' | 'enrollment';

// identity: the email (plus the signup or invitation fields). password: a
// known account's password. verify: the emailed code (signup, invitation, or
// forgot password). new-password: the replacement after a recovery code.
type AuthStep = 'identity' | 'password' | 'verify' | 'new-password';

export default function SignInScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const keyboardAppearance = useKeyboardAppearance();
  const router = useRouter();
  const auth = useAuth();
  const { locale, setLocale, t } = useI18n();
  const { width } = useHydrationSafeWindowDimensions();
  const wide = Platform.OS === 'web' && width >= 920;
  const [destination, setDestination] = useState('');
  const [destinationFocused, setDestinationFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [code, setCode] = useState('');
  const [authStep, setAuthStep] = useState<AuthStep>('identity');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const [initialInvitationToken] = useState(invitationFromInitialLocation);
  const [accessMode, setAccessMode] = useState<AccessMode>(
    initialInvitationToken ? 'enrollment' : 'signup',
  );
  const [invitationToken, setInvitationToken] = useState(initialInvitationToken);
  const [employeeCode, setEmployeeCode] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  // The lookup found no account for the email: offer the signup shortcut.
  const [unknownAccount, setUnknownAccount] = useState(false);
  const signupMode = accessMode === 'signup';
  const returningMode = accessMode === 'returning';
  const enrollmentMode = accessMode === 'enrollment';
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

  const captchaMissing = () =>
    captchaConfigured && (!captchaToken || captchaToken.length < 20 || /\s/.test(captchaToken));
  const resetCaptcha = () => {
    setCaptchaToken(null);
    setCaptchaKey((current) => current + 1);
  };

  const chooseAccessMode = (nextMode: AccessMode) => {
    setAccessMode(nextMode);
    setAuthStep('identity');
    setCode('');
    setPassword('');
    setMessage('');
    setUnknownAccount(false);
    resetCaptcha();
    if (nextMode !== 'enrollment') {
      setInvitationToken('');
      setEmployeeCode('');
    }
  };

  // Back to the email from the password, code, or new-password step.
  const useDifferentEmail = () => {
    setAuthStep('identity');
    setCode('');
    setPassword('');
    setMessage('');
    setUnknownAccount(false);
  };

  // Forgot password (and the rare account that never chose a password): email
  // a recovery code and move to the code step. Throws so the caller localizes.
  const sendRecoveryCode = async (normalized: string) => {
    const result = await auth.requestRecoveryOtp({
      destinationType: 'email',
      destination: normalized,
      ...(captchaToken ? { captchaToken } : {}),
    });
    resetCaptcha();
    if (!result.channelConfigured) {
      setMessage(t('auth.channelUnavailable'));
      return;
    }
    setPassword('');
    setCode('');
    setAuthStep('verify');
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
  };

  // Returning sign-in, step one: the service says whether an account uses the
  // email and whether it has a password.
  const lookupAccount = async () => {
    if (isWebAuthBlocked) {
      setMessage(t('auth.gatewayUnavailable'));
      return;
    }
    const normalized = normalizeEmail(destination);
    if (!EMAIL_PATTERN.test(normalized)) {
      setMessage(t('auth.emailInvalid'));
      return;
    }
    if (captchaMissing()) {
      setMessage(t('auth.challengeRequired'));
      return;
    }
    setLoading(true);
    setMessage('');
    setUnknownAccount(false);
    try {
      const account = await auth.lookupAccount({
        destinationType: 'email',
        destination: normalized,
        ...(captchaToken ? { captchaToken } : {}),
      });
      if (!account.exists) {
        setUnknownAccount(true);
        setMessage(t('auth.noAccount'));
        return;
      }
      if (account.hasPassword) {
        setPassword('');
        setAuthStep('password');
        return;
      }
      // No password on file (only possible for an account from before the
      // v3.2 wipe): the forgot-password road, code then a new password.
      await sendRecoveryCode(normalized);
    } catch (lookupError) {
      setMessage(failureMessage(lookupError, 'auth.signInUnavailable'));
    } finally {
      setLoading(false);
    }
  };

  const forgotPassword = async () => {
    if (captchaMissing()) {
      setMessage(t('auth.challengeRequired'));
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      await sendRecoveryCode(normalizeEmail(destination));
    } catch (requestError) {
      setMessage(failureMessage(requestError, 'auth.signInUnavailable'));
    } finally {
      setLoading(false);
    }
  };

  const signInWithPassword = async () => {
    if (password.length < PASSWORD_MIN_LENGTH) {
      setMessage(t('auth.passwordTooShort'));
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      await auth.signInWithPassword({
        destinationType: 'email',
        destination: normalizeEmail(destination),
        password,
      });
      router.replace('/');
    } catch (signInError) {
      setMessage(credentialRejected(signInError)
        ? t('auth.passwordIncorrect')
        : failureMessage(signInError, 'auth.signInUnavailable'));
    } finally {
      setLoading(false);
    }
  };

  // After the recovery code: the new password is saved through the recovered
  // session, which keeps that session valid, and the member is signed in.
  const saveNewPassword = async () => {
    if (password.length < PASSWORD_MIN_LENGTH) {
      setMessage(t('auth.passwordTooShort'));
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      await auth.completeRecovery(password);
      router.replace('/');
    } catch (saveError) {
      setMessage(failureMessage(saveError, 'errors.action'));
    } finally {
      setLoading(false);
    }
  };

  // Signup and workplace invitation: request the emailed code.
  const sendLink = async () => {
    if (isWebAuthBlocked) {
      setMessage(t('auth.gatewayUnavailable'));
      return;
    }
    const normalized = normalizeEmail(destination);
    if (!EMAIL_PATTERN.test(normalized)) {
      setMessage(t(signupMode ? 'auth.signupEmailInvalid' : 'auth.emailInvalid'));
      return;
    }
    if (captchaMissing()) {
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
      const result = await auth.requestOtp({
        destinationType: 'email',
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
      setMessage(t('auth.otpSent'));
    } catch (requestError) {
      setMessage(failureMessage(requestError, 'auth.signInUnavailable'));
    } finally {
      setLoading(false);
      resetCaptcha();
    }
  };

  // Re-runs the exact request that delivered the current code, with the values
  // already entered, then closes a fresh resend window.
  const resendCode = async () => {
    setLoading(true);
    setMessage('');
    const normalized = normalizeEmail(destination);
    try {
      if (signupMode) {
        await auth.requestSignup({
          destination: normalized,
          username,
          displayName: displayName.trim(),
          language: locale,
          password,
        });
        setMessage(t('auth.codeResent'));
        return;
      }
      const result = returningMode
        ? await auth.requestRecoveryOtp({ destinationType: 'email', destination: normalized })
        : await auth.requestOtp({
            destinationType: 'email',
            destination: normalized,
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
    const normalized = normalizeEmail(destination);
    try {
      if (signupMode) {
        await auth.verifySignup({ destination: normalized, code: normalizedCode, password });
        router.replace('/');
        return;
      }
      if (returningMode) {
        // Forgot password: the code signs the member in only once the new
        // password below is saved.
        await auth.verifyRecoveryOtp({
          destinationType: 'email',
          destination: normalized,
          code: normalizedCode,
        });
        setPassword('');
        setCode('');
        setAuthStep('new-password');
        return;
      }
      await auth.verifyOtp({
        destinationType: 'email',
        destination: normalized,
        ...(enrollmentMode ? { invitationToken: invitationToken.trim().toLocaleLowerCase() } : {}),
        ...(employeeCode.trim() ? { employeeCode: employeeCode.trim() } : {}),
        code: normalizedCode,
      });
      router.replace('/');
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
        resetCaptcha();
      }
      setMessage(credentialRejected(verifyError)
        ? t('auth.verifyFailed')
        : failureMessage(verifyError, 'auth.verifyFailed'));
    } finally {
      setLoading(false);
    }
  };

  const onCaptchaToken = useCallback((token: string | null) => setCaptchaToken(token), []);
  const onCaptchaError = useCallback(() => setMessage(t('auth.challengeUnavailable')), [t]);

  const title = enrollmentMode
    ? t('auth.titleEnroll')
    : signupMode
      ? t('auth.titleSignup')
      : authStep === 'new-password'
        ? t('auth.newPasswordTitle')
        : t('auth.titleReturn');
  const subtitle = enrollmentMode
    ? t('auth.subtitleEnroll')
    : signupMode
      ? t('auth.subtitleSignup')
      : authStep === 'password'
        ? t('auth.subtitlePassword')
        : authStep === 'verify'
          ? t('auth.otpSent')
          : authStep === 'new-password'
            ? t('auth.passwordRule')
            : t('auth.subtitleReturn');
  const primaryLabel = isWebAuthBlocked
    ? t('auth.webNotConfigured')
    : authStep === 'verify'
      ? t(signupMode ? 'auth.verifySignup' : returningMode ? 'auth.continue' : 'auth.verifySignIn')
      : authStep === 'password'
        ? t('auth.signIn')
        : authStep === 'new-password'
          ? t('auth.savePassword')
          : t('auth.continue');
  const primaryAction = authStep === 'verify'
    ? verifyCode
    : authStep === 'password'
      ? signInWithPassword
      : authStep === 'new-password'
        ? saveNewPassword
        : returningMode
          ? lookupAccount
          : sendLink;
  // The challenge guards every code delivery. It sits on the identity step;
  // the password step shows it only when no token is held for a
  // "Forgot password?" request (the lookup keeps its token for that).
  const showCaptcha = captchaConfigured && !isWebAuthBlocked
    && (authStep === 'identity' || (authStep === 'password' && !captchaToken));

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
        {/* The statement and the trust list are for a desktop, where there is
            room beside the form. On a phone they pushed the form off the
            bottom, so the brand is one line and the form starts at the top
            (owner, Sep 8 2026). */}
        <View style={[
          wide ? styles.brandColumn : styles.brandRow,
          wide ? styles.brandColumnWide : styles.fullWidth,
        ]}>
          <View style={wide ? styles.logoMark : styles.logoMarkCompact}>
            <View style={wide ? styles.logoStem : styles.logoStemCompact} />
            <View style={wide ? styles.logoDot : styles.logoDotCompact} />
          </View>
          <Text style={wide ? styles.brand : styles.brandCompact}>newone</Text>
          {wide ? (
            <>
              <Text style={styles.brandStatement}>{t('auth.statement')}</Text>
              <View style={styles.trustList}>
                <TrustItem icon="language-outline" text={t('auth.trustLanguages')} />
                <TrustItem icon="people-outline" text={t('auth.trustMessages')} />
              </View>
            </>
          ) : null}
        </View>

        <View style={[styles.card, wide ? styles.cardWide : styles.fullWidth, shadow]}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>

          {/* The three chips say what they are; the caption was a word taking
              a row's width on a phone (owner, Sep 8 2026). */}
          <View style={styles.languageRow}>
            {wide ? <Text style={styles.languageLabel}>{t('auth.languageLabel')}</Text> : null}
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
              <Chip label={t('auth.returning')} onPress={() => chooseAccessMode('returning')} selected={returningMode} />
            </View>
          ) : null}

          {authStep === 'identity' && enrollmentMode ? (
            <View style={styles.enrollmentFields}>
              <Text style={styles.label}>{t('auth.invitationTokenLabel')}</Text>
              <View style={styles.inputWrap}>
                <Ionicons name="key-outline" size={18} color={colors.inkSubtle} />
                <TextInput
                  keyboardAppearance={keyboardAppearance}
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
                  keyboardAppearance={keyboardAppearance}
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

          {authStep === 'identity' || authStep === 'verify' ? (
            <>
              <Text style={styles.label}>
                {authStep === 'verify'
                  ? t('auth.codeLabel')
                  : t(signupMode ? 'auth.signupEmailLabel' : 'auth.emailLabel')}
              </Text>
              <View style={[styles.inputWrap, destinationFocused && styles.inputWrapFocused]}>
                <Ionicons
                  name={authStep === 'verify' ? 'keypad-outline' : 'mail-outline'}
                  size={18}
                  color={colors.inkSubtle}
                />
                {authStep === 'verify' ? (
                  <TextInput
                    keyboardAppearance={keyboardAppearance}
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
                    testID="sign-in-code"
                    textContentType="oneTimeCode"
                    value={code}
                  />
                ) : (
                  <TextInput
                    keyboardAppearance={keyboardAppearance}
                    accessibilityHint={
                      enrollmentMode
                        ? t('auth.emailInviteHint')
                        : signupMode
                          ? t('auth.signupEmailHint')
                          : t('auth.emailHint')
                    }
                    accessibilityLabel={t(signupMode ? 'auth.signupEmailLabel' : 'auth.emailLabel')}
                    autoCapitalize="none"
                    autoComplete="email"
                    keyboardType="email-address"
                    onBlur={() => setDestinationFocused(false)}
                    onChangeText={setDestination}
                    onFocus={() => setDestinationFocused(true)}
                    onSubmitEditing={returningMode ? lookupAccount : sendLink}
                    clearButtonMode="while-editing"
                    testID="sign-in-destination"
                    placeholder="you@example.com"
                    placeholderTextColor={colors.inkSubtle}
                    returnKeyType="send"
                    style={styles.input}
                    textContentType="emailAddress"
                    value={destination}
                  />
                )}
              </View>
            </>
          ) : null}

          {authStep === 'password' ? (
            <>
              <Text style={styles.label}>{t('auth.emailLabel')}</Text>
              <View style={styles.inputWrap}>
                <Ionicons name="mail-outline" size={18} color={colors.inkSubtle} />
                <Text numberOfLines={1} style={styles.staticValue}>{normalizeEmail(destination)}</Text>
              </View>
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
                disabled={loading}
                onPress={forgotPassword}
                style={({ pressed }) => [styles.resendLink, pressed && styles.pressed]}
                testID="forgot-password">
                <Text style={styles.resendText}>{t('auth.forgotPassword')}</Text>
              </Pressable>
            </>
          ) : null}

          {authStep === 'new-password' ? (
            <PasswordField
              autoComplete="new-password"
              label={t('auth.newPasswordLabel')}
              testID="new-password"
              onChangeText={setPassword}
              onSubmitEditing={saveNewPassword}
              returnKeyType="go"
              value={password}
            />
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
                  keyboardAppearance={keyboardAppearance}
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
                  keyboardAppearance={keyboardAppearance}
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
          {showCaptcha ? (
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
          {unknownAccount && authStep === 'identity' ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => chooseAccessMode('signup')}
              style={({ pressed }) => [styles.resendLink, pressed && styles.pressed]}
              testID="create-account-shortcut">
              <Text style={styles.resendText}>{t('auth.createAccountShortcut')}</Text>
            </Pressable>
          ) : null}
          <PrimaryButton
            disabled={isWebAuthBlocked}
            icon={authStep === 'new-password' ? 'checkmark' : 'arrow-forward'}
            label={primaryLabel}
            loading={loading}
            onPress={primaryAction}
            style={styles.fullButton}
          />
          {authStep === 'verify' || authStep === 'password' ? (
            <Pressable
              accessibilityRole="button"
              onPress={useDifferentEmail}
              style={({ pressed }) => [styles.secondaryLink, pressed && styles.pressed]}
              testID="different-email">
              <Text style={styles.secondaryLinkText}>{t('auth.differentEmail')}</Text>
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="link"
            onPress={() => router.push('./help')}
            style={({ pressed }) => [styles.secondaryLink, pressed && styles.pressed]}>
            <Text style={styles.secondaryLinkText}>{t('auth.help')}</Text>
          </Pressable>

        </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function TrustItem({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.trustItem}>
      <View style={styles.trustIcon}>
        <Ionicons name={icon} size={18} color={colors.onAccent} />
      </View>
      <Text style={styles.trustText}>{text}</Text>
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
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
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
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
  // A phone's brand: one line, so the form starts near the top.
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  logoMarkCompact: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: colors.mint,
    position: 'relative',
    overflow: 'hidden',
  },
  logoStemCompact: {
    position: 'absolute',
    width: 8,
    height: 22,
    left: 9,
    top: 6,
    borderRadius: 4,
    backgroundColor: colors.forest,
    transform: [{ rotate: '-18deg' }],
  },
  logoDotCompact: {
    position: 'absolute',
    width: 8,
    height: 8,
    right: 6,
    top: 6,
    borderRadius: 4,
    backgroundColor: colors.white,
  },
  brandCompact: {
    color: colors.white,
    fontFamily: type.display,
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: -0.9,
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
    padding: spacing.lg,
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
    fontSize: 21,
    lineHeight: 26,
    fontWeight: '900',
    letterSpacing: -0.7,
  },
  subtitle: {
    color: colors.inkMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
    marginBottom: spacing.md,
  },
  modeChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.md },
  passwordField: { marginTop: spacing.sm },
  languageRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  languageLabel: {
    color: colors.inkSubtle,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  enrollmentFields: { gap: spacing.xs, marginBottom: spacing.sm },
  signupFields: { gap: spacing.xs, marginTop: spacing.sm },
  helperText: {
    color: colors.inkSubtle,
    fontSize: 10,
    lineHeight: 15,
    marginBottom: spacing.xs,
  },
  label: {
    color: colors.ink,
    fontSize: 11,
    fontWeight: '900',
    marginBottom: 4,
  },
  inputWrap: {
    minHeight: 44,
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
  staticValue: {
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
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  secondaryLinkText: {
    color: colors.mintDark,
    fontSize: 11,
    fontWeight: '900',
  },
  pressed: {
    opacity: 0.72,
  },
});
