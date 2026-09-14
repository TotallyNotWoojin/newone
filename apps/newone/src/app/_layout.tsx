import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';

import { type Href, Stack, usePathname, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { StatusBar } from 'expo-status-bar';
import { PropsWithChildren, useEffect, useMemo, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  Image,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { stackMotion } from '@/components/navigation/stack-motion';
import { AuthProvider, useAuth } from '@/state/auth';
import { WorkspaceProvider, useWorkspace } from '@/state/workspace';
import { I18nProvider } from '@/i18n/provider';
import { DevicePreferencesProvider } from '@/state/device-preferences';
import { spacing, type } from '@/theme/tokens';
import { ThemeProvider, useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';
import { useSystemChrome } from '@/theme/system-chrome';
// Metro selects the native notification bridge or the web no-op.
// eslint-disable-next-line import/no-unresolved
import { useNotificationNavigation } from '@/device/notification-navigation';
import { installCrashGuard } from '@/lib/crash-guard';
import { consumeWebDeepLink } from '@/lib/web-deep-link';

installCrashGuard();

/**
 * The appearance providers sit outside the view tree so the shell itself, the
 * status bar and the root background all read the same resolved theme. Nothing
 * below this point may import colours from the module-level palette.
 */
export default function RootLayout() {
  return (
    <I18nProvider>
      <DevicePreferencesProvider>
        <ThemeProvider>
          <AppShell />
        </ThemeProvider>
      </DevicePreferencesProvider>
    </I18nProvider>
  );
}

function AppShell() {
  const styles = useThemedStyles(buildStyles);
  const { scheme } = useTheme();
  useSystemChrome();
  const [privacyShielded, setPrivacyShielded] = useState(
    Platform.OS !== 'web' && AppState.currentState !== 'active',
  );

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const subscription = AppState.addEventListener('change', (state) => {
      setPrivacyShielded(state !== 'active');
    });
    return () => subscription.remove();
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
          <Head>
            <title>Gist · Messages in any language</title>
            <meta
              content="Private messaging for people who do not share a language. Gist translates as you chat and keeps the original one tap away."
              name="description"
            />
          </Head>
          <AuthProvider>
            {/* The bar's glyphs must contrast with the app, not with the phone. */}
            <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
            <ProtectedNavigator />
          </AuthProvider>
      </SafeAreaProvider>
      {privacyShielded ? (
        <View
          accessibilityLabel="Gist content hidden"
          accessibilityRole="none"
          importantForAccessibility="yes"
          pointerEvents="auto"
          style={styles.privacyShield}>
          {/* The third code-drawn Newone letterform: a literal "n" on the
              loading screen and the privacy shield, which is the first thing a
              person sees and the exact screen reported as still showing the old
              logo (owner, Sep 14 2026). */}
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="contain"
            source={require('../../assets/images/gist-splash.png')}
            style={styles.loadingMark}
          />
        </View>
      ) : null}
    </GestureHandlerRootView>
  );
}

function ProtectedNavigator() {
  const { colors } = useTheme();
  const auth = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [reduceMotion, setReduceMotion] = useState(false);
  const onSignInRoute = pathname === '/sign-in';
  const onHelpRoute = pathname === '/help';
  const onPublicRoute = onSignInRoute || onHelpRoute;
  const onAuthOnlyRoute = onSignInRoute;
  const redirectingToSignIn = !auth.authenticated && !onPublicRoute;
  const redirectingToWorkspace = auth.authenticated && onAuthOnlyRoute;

  useEffect(() => {
    if (auth.loading) return;
    if (!auth.authenticated && !onPublicRoute) router.replace('/sign-in');
    if (auth.authenticated && onAuthOnlyRoute) router.replace('/');
  }, [auth.authenticated, auth.loading, onAuthOnlyRoute, onPublicRoute, router]);

  // A static web host sends deep links through 404.html; finish them here,
  // after the session is known, so the route is not lost behind sign-in.
  useEffect(() => {
    if (auth.loading || !auth.authenticated) return;
    const target = consumeWebDeepLink();
    if (target) router.replace(target as Href);
  }, [auth.authenticated, auth.loading, router]);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  if (auth.loading || redirectingToSignIn || redirectingToWorkspace) {
    return <AuthLoadingScreen label={auth.loading ? 'Loading…' : 'One moment…'} />;
  }

  const motion = stackMotion(reduceMotion);
  const navigator = (
    <Stack
      screenOptions={{
        headerShown: false,
        // The card behind a screen, seen during a push and around a modal.
        contentStyle: { backgroundColor: colors.canvas },
        ...motion.screen,
      }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="conversation/[id]" options={motion.push} />
      <Stack.Screen name="people" />
      <Stack.Screen name="new-group" options={{ presentation: 'modal' }} />
      <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
      <Stack.Screen name="help" options={{ presentation: 'modal' }} />
      <Stack.Screen name="sign-in" />
    </Stack>
  );

  if (!auth.authenticated) return navigator;
  return (
    <WorkspaceProvider>
      <NotificationAwareWorkspace>{navigator}</NotificationAwareWorkspace>
    </WorkspaceProvider>
  );
}

function NotificationAwareWorkspace({ children }: PropsWithChildren) {
  const workspace = useWorkspace();
  const badgeCount = useMemo(
    () => workspace.conversations.reduce(
      (total, conversation) => conversation.managementOnly
        ? total
        : total + Math.max(0, conversation.unreadCount),
      0,
    ) + workspace.updates.filter(
      (update) => update.acknowledgementRequired && !update.acknowledged,
    ).length + workspace.handoffs.filter(
      (handoff) => handoff.canAcknowledge && !handoff.acknowledgedByMe,
    ).length,
    [workspace.conversations, workspace.handoffs, workspace.updates],
  );
  useNotificationNavigation({
    enabled: workspace.status === 'ready',
    organizationId: workspace.organizationId || null,
    badgeCount,
  });
  // The browser tab is the web app's only badge: "Gist (2)" while messages
  // wait, the plain title once they are read (owner request, Sep 14 2026).
  // Rendered through Head rather than document.title: the layout's own Head
  // re-applied its static title on every navigation and overwrote the count
  // (owner report, same day, "the badge isn't working").
  return (
    <>
      <Head>
        <title>{badgeCount > 0 ? `Gist (${badgeCount})` : 'Gist · Messages in any language'}</title>
      </Head>
      {children}
    </>
  );
}

function AuthLoadingScreen({ label }: { label: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.loadingScreen}>
      <Image
        accessibilityIgnoresInvertColors
        resizeMode="contain"
        source={require('../../assets/images/gist-splash.png')}
        style={styles.loadingMark}
      />
      <ActivityIndicator color={colors.mint} />
      <Text style={styles.loadingText}>{label}</Text>
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  privacyShield: {
    position: 'absolute',
    inset: 0,
    zIndex: 10_000,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.forest,
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    backgroundColor: colors.forest,
  },
  loadingMark: {
    width: 54,
    height: 54,
  },
  loadingText: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 11,
    fontWeight: '700',
  },
});
