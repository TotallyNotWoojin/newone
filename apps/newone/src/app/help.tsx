import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconButton, PrimaryButton, StatusBadge } from '@/components/ui/primitives';
import { publicRuntimeConfig } from '@/config/runtime';
import { useI18n } from '@/i18n/provider';
import { radii, shadow, spacing, type } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

export default function HelpScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const router = useRouter();
  const { t } = useI18n();
  const support = publicRuntimeConfig.supportContact;
  const sections = [
    { icon: 'person-add-outline' as const, title: t('help.onboardingTitle'), body: t('help.onboardingBody') },
    { icon: 'phone-portrait-outline' as const, title: t('help.recoveryTitle'), body: t('help.recoveryBody') },
    { icon: 'lock-closed-outline' as const, title: t('help.privacyTitle'), body: t('help.privacyBody') },
    { icon: 'language-outline' as const, title: t('help.translationTitle'), body: t('help.translationBody') },
    { icon: 'warning-outline' as const, title: t('help.safetyTitle'), body: t('help.safetyBody') },
  ];
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <IconButton label={t('help.close')} name="close" onPress={() => router.back()} />
        <View style={styles.headerCopy}>
          <Text accessibilityRole="header" style={styles.headerTitle}>{t('help.title')}</Text>
          <Text style={styles.headerSubtitle}>{t('help.subtitle')}</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <View style={[styles.intro, shadow]}>
          <View style={styles.introIcon}>
            <Ionicons color={colors.forest} name="help-buoy-outline" size={26} />
          </View>
          <View style={styles.introCopy}>
            <Text style={styles.introTitle}>{t('help.introTitle')}</Text>
            <Text style={styles.introBody}>{t('help.introBody')}</Text>
          </View>
        </View>
        <View style={styles.grid}>
          {sections.map((section) => (
            <View key={section.title} style={[styles.card, shadow]}>
              <View style={styles.cardIcon}>
                <Ionicons color={colors.mintDark} name={section.icon} size={21} />
              </View>
              <Text style={styles.cardTitle}>{section.title}</Text>
              <Text style={styles.cardBody}>{section.body}</Text>
            </View>
          ))}
        </View>
        <View style={[styles.support, shadow]}>
          <View style={styles.supportCopy}>
            <Text style={styles.cardTitle}>{t('help.supportTitle')}</Text>
            <Text style={styles.cardBody}>{t('help.supportBody')}</Text>
          </View>
          {support ? (
            support.url ? (
              <PrimaryButton
                icon="open-outline"
                label={support.label}
                onPress={() => void Linking.openURL(support.url as string)}
                tone="dark"
              />
            ) : <StatusBadge label={support.label} tone="info" />
          ) : <StatusBadge label={t('help.supportUnconfigured')} tone="warning" />}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  header: {
    minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    paddingHorizontal: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line, backgroundColor: colors.paper,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  headerSpacer: { width: 40 },
  headerTitle: { color: colors.ink, fontFamily: type.display, fontSize: 19, fontWeight: '900' },
  headerSubtitle: { color: colors.inkSubtle, fontSize: 11, marginTop: 2 },
  page: {
    width: '100%', maxWidth: 980, alignSelf: 'center', gap: spacing.md,
    padding: spacing.lg, paddingBottom: spacing.xxxl,
  },
  intro: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg,
    borderRadius: radii.lg, backgroundColor: colors.forest,
  },
  introIcon: {
    width: 52, height: 52, borderRadius: radii.lg, alignItems: 'center',
    justifyContent: 'center', backgroundColor: colors.mint,
  },
  introCopy: { flex: 1, minWidth: 0 },
  introTitle: { color: colors.white, fontFamily: type.display, fontSize: 19, fontWeight: '900' },
  introBody: { color: 'rgba(255,255,255,0.72)', fontSize: 12, lineHeight: 18, marginTop: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  card: {
    minWidth: 280, flex: 1, padding: spacing.lg, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper,
  },
  cardIcon: {
    width: 42, height: 42, alignItems: 'center', justifyContent: 'center',
    borderRadius: radii.md, backgroundColor: colors.mintSoft, marginBottom: spacing.sm,
  },
  cardTitle: { color: colors.ink, fontFamily: type.display, fontSize: 16, fontWeight: '900' },
  cardBody: { color: colors.inkMuted, fontSize: 12, lineHeight: 19, marginTop: spacing.xs },
  support: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md,
    padding: spacing.lg, borderRadius: radii.lg, borderWidth: 1,
    borderColor: colors.line, backgroundColor: colors.paper,
  },
  supportCopy: { flex: 1, minWidth: 240 },
});
