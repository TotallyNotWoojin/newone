import { Ionicons } from '@expo/vector-icons';
import { Href, useRouter } from 'expo-router';
import type { ComponentProps, ReactNode } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { radii, spacing, type } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';
import { Avatar } from '@/components/ui/primitives';
import { useProfileAvatar } from '@/state/profile-avatar';
import { useWorkspace } from '@/state/workspace';
import { useI18n } from '@/i18n/provider';
import type { MessageKey } from '@/i18n/catalog';
import { canAccessAdminSurface } from '@/features/admin/admin-access';
import { isPersonalRealm } from '@/constants/personal-realm';
import { useHydrationSafeWindowDimensions } from '@/hooks/use-hydration-safe-window-dimensions';

type IconName = ComponentProps<typeof Ionicons>['name'];
export type NavigationKey = 'chats' | 'updates' | 'handoffs' | 'people' | 'admin';

const navItems: {
  key: NavigationKey;
  labelKey: MessageKey;
  icon: IconName;
  iconActive: IconName;
  href: Href;
}[] = [
  {
    key: 'chats',
    labelKey: 'nav.chats',
    icon: 'chatbubble-ellipses-outline',
    iconActive: 'chatbubble-ellipses',
    href: '/',
  },
  {
    key: 'updates',
    labelKey: 'nav.updates',
    icon: 'megaphone-outline',
    iconActive: 'megaphone',
    href: '/updates',
  },
  {
    key: 'handoffs',
    labelKey: 'nav.handoffs',
    icon: 'swap-horizontal-outline',
    iconActive: 'swap-horizontal',
    href: '/handoffs',
  },
  {
    key: 'people',
    labelKey: 'nav.contacts',
    icon: 'people-outline',
    iconActive: 'people',
    href: '/people',
  },
  {
    key: 'admin',
    labelKey: 'nav.admin',
    icon: 'shield-checkmark-outline',
    iconActive: 'shield-checkmark',
    href: '/admin',
  },
];

/**
 * Search has no tab of its own: the one field on Chats does that job, so a
 * consumer's bar is Chats · Contacts · Settings. Updates and handoffs remain
 * workspace-organization surfaces, and admin stays gated on server-granted
 * capabilities.
 */
function visibleNavItems(personalRealm: boolean, canOpenAdmin: boolean) {
  return navItems.filter((item) => {
    if (item.key === 'admin') return canOpenAdmin;
    if (item.key === 'updates' || item.key === 'handoffs') return !personalRealm;
    return true;
  });
}

export function AppScaffold({
  current,
  children,
  mobileHeader,
  hideMobileTabs = false,
}: {
  current: NavigationKey;
  children: ReactNode;
  mobileHeader?: ReactNode;
  hideMobileTabs?: boolean;
}) {
  const styles = useThemedStyles(buildStyles);
  const { width } = useHydrationSafeWindowDimensions();
  const insets = useSafeAreaInsets();
  const desktop = width >= 920;
  const bottomBarHeight = hideMobileTabs ? 0 : 68 + insets.bottom;

  if (desktop) {
    return (
      <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.root}>
        <View style={styles.desktopFrame}>
          <DesktopRail current={current} />
          <View style={styles.desktopContent}>{children}</View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.mobileContent}>
        {mobileHeader}
        <View style={[styles.mobileBody, { paddingBottom: bottomBarHeight }]}>{children}</View>
      </SafeAreaView>
      {!hideMobileTabs ? <MobileTabs current={current} /> : null}
    </View>
  );
}

export function BrandMark({ compact = false }: { compact?: boolean }) {
  const styles = useThemedStyles(buildStyles);
  const workspace = useWorkspace();
  // Consumer accounts see the plain product mark; the workplace tag remains
  // the brand treatment for workspace organizations only.
  const personalRealm = isPersonalRealm(workspace.organizationId);
  return (
    <View style={[styles.brand, compact && styles.brandCompact]}>
      <View style={styles.logoMark}>
        <View style={styles.logoStem} />
        <View style={styles.logoDot} />
      </View>
      {!compact ? (
        <View>
          <Text style={styles.brandName}>newone</Text>
          {!personalRealm ? <Text style={styles.brandTag}>WORKPLACE</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function DesktopRail({ current }: { current: NavigationKey }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const router = useRouter();
  const workspace = useWorkspace();
  const ownAvatarUrl = useProfileAvatar(workspace.currentUser?.id ?? null);
  const { currentUser } = workspace;
  const { t } = useI18n();
  const canOpenAdmin = canAccessAdminSurface(workspace.capabilities);
  const visibleItems = visibleNavItems(isPersonalRealm(workspace.organizationId), canOpenAdmin);
  return (
    <View style={styles.rail}>
      <BrandMark compact />

      <View style={styles.workspaceMark}>
        <Text style={styles.workspaceInitial}>N</Text>
        <View style={styles.workspaceOnline} />
      </View>

      <View style={styles.railNav}>
        {visibleItems.map((item) => {
          const selected = item.key === current;
          const badge = item.key === 'chats'
            ? workspace.conversations.reduce((sum, conversation) => (
                conversation.managementOnly ? sum : sum + conversation.unreadCount
              ), 0)
            : item.key === 'updates'
              ? workspace.updates.filter((update) => update.acknowledgementRequired && !update.acknowledged).length
              : 0;
          return (
            <Pressable
              accessibilityLabel={t(item.labelKey)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={item.key}
              onPress={() => router.replace(item.href)}
              style={({ pressed }) => [
                styles.railItem,
                selected && styles.railItemSelected,
                pressed && styles.pressed,
              ]}>
              <View>
                <Ionicons
                  color={selected ? colors.onAccent : 'rgba(255,255,255,0.72)'}
                  name={selected ? item.iconActive : item.icon}
                  size={22}
                />
                {badge > 0 ? (
                  <View style={styles.railBadge}>
                    <Text style={styles.railBadgeText}>{badge > 99 ? '99+' : badge}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={[styles.railLabel, selected && styles.railLabelSelected]}>
                {t(item.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.railFooter}>
        <Pressable
          accessibilityLabel={t('nav.settings')}
          accessibilityRole="button"
          onPress={() => router.push('/settings')}
          style={({ pressed }) => [styles.railAvatarButton, pressed && styles.pressed]}>
          {currentUser ? (
            <Avatar
              color={currentUser.avatarColor}
              imageUri={ownAvatarUrl}
              initials={currentUser.initials}
              presence={currentUser.presence}
              size={38}
            />
          ) : (
            <Ionicons name="person-circle-outline" color="rgba(255,255,255,0.72)" size={38} />
          )}
        </Pressable>
        <View style={styles.secureDotRow}>
          <Ionicons name="lock-closed" color="rgba(255,255,255,0.46)" size={11} />
          <Text style={styles.secureLabel}>{t('nav.private')}</Text>
        </View>
      </View>
    </View>
  );
}

function MobileTabs({ current }: { current: NavigationKey }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const workspace = useWorkspace();
  const { t } = useI18n();
  const canOpenAdmin = canAccessAdminSurface(workspace.capabilities);
  const visibleItems = visibleNavItems(isPersonalRealm(workspace.organizationId), canOpenAdmin);
  return (
    <View style={[styles.mobileTabs, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {visibleItems.map((item) => {
        const selected = item.key === current;
        const badge = item.key === 'chats'
          ? workspace.conversations.reduce((sum, conversation) => (
              conversation.managementOnly ? sum : sum + conversation.unreadCount
            ), 0)
          : item.key === 'updates'
            ? workspace.updates.filter((update) => update.acknowledgementRequired && !update.acknowledged).length
            : 0;
        return (
          <Pressable
            accessibilityLabel={t(item.labelKey)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            key={item.key}
            onPress={() => router.replace(item.href)}
            style={({ pressed }) => [styles.mobileTab, pressed && styles.pressed]}>
            <View style={[styles.mobileTabIcon, selected && styles.mobileTabIconSelected]}>
              <Ionicons
                name={selected ? item.iconActive : item.icon}
                size={20}
                color={selected ? colors.onAccent : colors.inkSubtle}
              />
              {badge > 0 ? <View style={styles.mobileBadge} /> : null}
            </View>
            <Text style={[styles.mobileTabLabel, selected && styles.mobileTabLabelSelected]}>
              {t(item.labelKey)}
            </Text>
          </Pressable>
        );
      })}
      <Pressable
        accessibilityLabel={t('nav.settingsTab')}
        accessibilityRole="button"
        onPress={() => router.push('/settings')}
        style={({ pressed }) => [styles.mobileTab, pressed && styles.pressed]}>
        <View style={styles.mobileTabIcon}>
          <Ionicons name="person-circle-outline" size={20} color={colors.inkSubtle} />
        </View>
        <Text style={styles.mobileTabLabel}>{t('nav.settingsTab')}</Text>
      </Pressable>
    </View>
  );
}

export function MobileBrandHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.mobileHeader}>
      <View style={styles.mobileHeaderBrand}>
        <BrandMark compact />
        <View style={styles.mobileHeaderCopy}>
          <Text style={styles.mobileHeaderTitle}>{title}</Text>
          {subtitle ? <Text style={styles.mobileHeaderSubtitle}>{subtitle}</Text> : null}
        </View>
      </View>
      {right}
    </View>
  );
}

export function DesktopPageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  const styles = useThemedStyles(buildStyles);
  return (
    <View style={styles.pageHeader}>
      <View style={styles.pageHeaderCopy}>
        {eyebrow ? <Text style={styles.pageEyebrow}>{eyebrow}</Text> : null}
        <Text style={styles.pageTitle}>{title}</Text>
        {description ? <Text style={styles.pageDescription}>{description}</Text> : null}
      </View>
      {actions ? <View style={styles.pageActions}>{actions}</View> : null}
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  desktopFrame: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: colors.canvas,
  },
  desktopContent: {
    flex: 1,
    minWidth: 0,
  },
  rail: {
    width: 92,
    backgroundColor: colors.forest,
    alignItems: 'center',
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderTopRightRadius: radii.lg,
    borderBottomRightRadius: radii.lg,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  brandCompact: {
    justifyContent: 'center',
  },
  logoMark: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.mint,
    position: 'relative',
    overflow: 'hidden',
  },
  logoStem: {
    position: 'absolute',
    width: 9,
    height: 23,
    left: 9,
    top: 7,
    borderRadius: 5,
    backgroundColor: colors.forest,
    transform: [{ rotate: '-18deg' }],
  },
  logoDot: {
    position: 'absolute',
    width: 9,
    height: 9,
    right: 7,
    top: 7,
    borderRadius: 5,
    backgroundColor: colors.white,
  },
  brandName: {
    color: colors.white,
    fontFamily: type.display,
    fontSize: 19,
    fontWeight: '800',
    letterSpacing: -0.7,
  },
  brandTag: {
    color: 'rgba(255,255,255,0.47)',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  workspaceMark: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    marginTop: spacing.xxl,
    backgroundColor: colors.forestRaised,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  workspaceInitial: {
    color: colors.white,
    fontSize: 17,
    fontWeight: '900',
  },
  workspaceOnline: {
    position: 'absolute',
    width: 9,
    height: 9,
    right: -2,
    bottom: -2,
    borderRadius: 5,
    backgroundColor: colors.mint,
    borderColor: colors.forest,
    borderWidth: 2,
  },
  railNav: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    gap: 6,
    paddingTop: spacing.xxl,
  },
  railItem: {
    width: 70,
    minHeight: 56,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  railItemSelected: {
    backgroundColor: colors.mint,
  },
  railLabel: {
    color: 'rgba(255,255,255,0.64)',
    fontSize: 10,
    fontWeight: '700',
  },
  railLabelSelected: {
    color: colors.onAccent,
    fontWeight: '900',
  },
  railBadge: {
    position: 'absolute',
    right: -9,
    top: -8,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: colors.redStrong,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: colors.forest,
    borderWidth: 1.5,
  },
  railBadgeText: {
    color: colors.white,
    fontSize: 8,
    fontWeight: '900',
  },
  railFooter: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  railAvatarButton: {
    padding: 4,
  },
  secureDotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  secureLabel: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 9,
    fontWeight: '700',
  },
  mobileContent: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  mobileBody: {
    flex: 1,
  },
  mobileTabs: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.paper,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.lineStrong,
    paddingTop: 7,
    paddingHorizontal: 4,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 -8px 30px rgba(25, 52, 43, 0.06)' }
      : {}),
  },
  mobileTab: {
    flex: 1,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  mobileTabIcon: {
    minWidth: 42,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
  },
  mobileTabIconSelected: {
    backgroundColor: colors.mintSoft,
  },
  mobileTabLabel: {
    color: colors.inkSubtle,
    fontSize: 9,
    fontWeight: '700',
  },
  mobileTabLabelSelected: {
    color: colors.mintDark,
    fontWeight: '900',
  },
  mobileBadge: {
    position: 'absolute',
    width: 7,
    height: 7,
    right: 8,
    top: 4,
    borderRadius: 4,
    backgroundColor: colors.red,
    borderColor: colors.paper,
    borderWidth: 1,
  },
  mobileHeader: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.paper,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  mobileHeaderBrand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flex: 1,
    minWidth: 0,
  },
  mobileHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  mobileHeaderTitle: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 19,
    fontWeight: '800',
    letterSpacing: -0.45,
  },
  mobileHeaderSubtitle: {
    color: colors.inkSubtle,
    fontSize: 11,
    marginTop: 1,
  },
  pageHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.xl,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xl,
  },
  pageHeaderCopy: {
    flex: 1,
    maxWidth: 760,
  },
  pageEyebrow: {
    color: colors.mintDark,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: spacing.xs,
  },
  pageTitle: {
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '800',
    letterSpacing: -1.15,
  },
  pageDescription: {
    color: colors.inkMuted,
    fontSize: 14,
    lineHeight: 21,
    marginTop: spacing.xs,
  },
  pageActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  pressed: {
    opacity: 0.72,
  },
});
