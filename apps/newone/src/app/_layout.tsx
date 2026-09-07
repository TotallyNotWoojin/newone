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
import { colors, spacing, type } from '@/theme/tokens';
// Metro selects the native notification bridge or the web no-op.
// eslint-disable-next-line import/no-unresolved
import { useNotificationNavigation } from '@/device/notification-navigation';
import { installCrashGuard } from '@/lib/crash-guard';
import { consumeWebDeepLink } from '@/lib/web-deep-link';

installCrashGuard();

export default function RootLayout() {
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
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <I18nProvider>
          <DevicePreferencesProvider>
          <Head>
            <title>Newone · Workplace communication</title>
            <meta
              content="Private workplace messaging, company updates, contacts, and shift handoffs for multilingual teams."
              name="description"
            />
          </Head>
          <AuthProvider>
            <StatusBar style="dark" />
            <ProtectedNavigator />
          </AuthProvider>
          </DevicePreferencesProvider>
        </I18nProvider>
      </SafeAreaProvider>
      {privacyShielded ? (
        <View
          accessibilityLabel="Newone content hidden"
          accessibilityRole="none"
          importantForAccessibility="yes"
          pointerEvents="auto"
          style={styles.privacyShield}>
          <View style={styles.loadingMark}>
            <Text style={styles.loadingMarkText}>n</Text>
          </View>
        </View>
      ) : null}
    </GestureHandlerRootView>
  );
}

function ProtectedNavigator() {
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
    <Stack screenOptions={{ headerShown: false, ...motion.screen }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="conversation/[id]" options={motion.push} />
      <Stack.Screen name="updates" />
      <Stack.Screen name="handoffs" />
      <Stack.Screen name="people" />
      <Stack.Screen name="new-group" options={{ presentation: 'modal' }} />
      <Stack.Screen name="admin" />
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
  return children;
}

function AuthLoadingScreen({ label }: { label: string }) {
  return (
    <View style={styles.loadingScreen}>
      <View style={styles.loadingMark}>
        <Text style={styles.loadingMarkText}>n</Text>
      </View>
      <ActivityIndicator color={colors.mint} />
      <Text style={styles.loadingText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: colors.mint,
  },
  loadingMarkText: {
    color: colors.forest,
    fontFamily: type.display,
    fontSize: 31,
    fontWeight: '900',
  },
  loadingText: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 11,
    fontWeight: '700',
  },
});
