import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { LinkPreviewMetadata } from '@/data/repositories/contracts';
import { previewSiteLabel } from '@/features/chat/link-preview';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { radii, spacing } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

/**
 * The card under a message that holds a link: what the page calls itself and
 * which site it is on.
 *
 * Nothing here reaches the site. The gateway fetched the page once and kept
 * what it said, so a link shared into a group is one request from us rather
 * than one from every phone that scrolls past it — and nobody's address goes to
 * whoever they were sent a link to until they choose to open it.
 *
 * The page's own thumbnail is deliberately not drawn: loading it would be the
 * phone fetching a third-party address, which is the thing this avoids.
 */
export function LinkPreviewCard({ url }: { url: string }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const workspace = useWorkspace();
  const { t } = useI18n();
  const [preview, setPreview] = useState<LinkPreviewMetadata | null>(null);
  // Read through a ref: the loader's identity moves with the workspace
  // snapshot, and one card must ask about its address once, not once per
  // message that arrives in the chat while it is on screen.
  const loadRef = useRef(workspace.loadLinkPreview);
  useEffect(() => {
    loadRef.current = workspace.loadLinkPreview;
  }, [workspace.loadLinkPreview]);

  useEffect(() => {
    let live = true;
    void loadRef.current(url).then((result) => {
      if (live) setPreview(result);
    });
    return () => {
      live = false;
    };
  }, [url]);

  if (!preview || preview.status !== 'ready' || !preview.title) return null;
  const site = previewSiteLabel(preview.url, preview.siteName);

  return (
    <Pressable
      accessibilityLabel={site ? `${preview.title} · ${site}` : preview.title}
      accessibilityHint={t('chat.openLink')}
      accessibilityRole="link"
      onPress={() => void Linking.openURL(preview.url)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <View style={styles.copy}>
        <Text numberOfLines={2} style={styles.title}>{preview.title}</Text>
        {site ? <Text numberOfLines={1} style={styles.site}>{site}</Text> : null}
      </View>
      <Ionicons color={colors.inkSubtle} name="open-outline" size={14} />
    </Pressable>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  card: {
    alignItems: 'center',
    backgroundColor: 'rgba(16,46,39,0.05)',
    borderRadius: radii.xs,
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: 6,
    paddingHorizontal: spacing.xs,
    paddingVertical: 6,
  },
  copy: { flex: 1, minWidth: 0 },
  title: { color: colors.ink, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  site: { color: colors.inkMuted, fontSize: 11, marginTop: 1 },
  pressed: { opacity: 0.72 },
});
