import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionModal } from '@/components/ui/action-modal';
import type { SharedMediaItem, SharedMediaPage } from '@/data/repositories/contracts';
import { ImageViewerModal } from '@/features/chat/image-viewer';
import type { MessageKey } from '@/i18n/catalog';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { colors, radii, spacing } from '@/theme/tokens';

/** A thumbnail is only worth drawing for something the viewer can show. */
export function isThumbnail(item: SharedMediaItem): boolean {
  return (item.kind === 'image' || item.kind === 'video') && Boolean(item.previewUrl);
}

export type SharedMediaSection =
  | { kind: 'thumbnails'; items: SharedMediaItem[] }
  | { kind: 'file'; item: SharedMediaItem };

/**
 * Newest first, whatever it is: runs of photos and videos become one wrapped
 * grid, and anything else becomes a compact row where it fell. Keeping the
 * single order means the grid reads as the chat's history, not two lists.
 */
export function sharedMediaSections(items: SharedMediaItem[]): SharedMediaSection[] {
  const sections: SharedMediaSection[] = [];
  for (const item of items) {
    if (!isThumbnail(item)) {
      sections.push({ kind: 'file', item });
      continue;
    }
    const last = sections.at(-1);
    if (last?.kind === 'thumbnails') last.items.push(item);
    else sections.push({ kind: 'thumbnails', items: [item] });
  }
  return sections;
}

export function mediaSizeLabel(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`;
  if (byteSize < 1024 * 1024) return `${Math.ceil(byteSize / 1024)} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

export function mediaKindKey(kind: SharedMediaItem['kind']): MessageKey {
  if (kind === 'image') return 'chat.attachmentPhoto';
  if (kind === 'video') return 'chat.attachmentVideo';
  if (kind === 'voice') return 'chat.attachmentVoice';
  return 'chat.attachmentFile';
}

function Thumbnail({ item, onPress }: { item: SharedMediaItem; onPress: () => void }) {
  const { t } = useI18n();
  return (
    <Pressable
      accessibilityLabel={item.name || t(mediaKindKey(item.kind))}
      accessibilityRole="imagebutton"
      onPress={onPress}
      style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}>
      <Image
        accessibilityIgnoresInvertColors
        resizeMode="cover"
        source={{ uri: item.previewUrl as string }}
        style={styles.tileImage}
      />
      {item.kind === 'video' ? (
        <View pointerEvents="none" style={styles.videoMark}>
          <Ionicons color={colors.white} name="play" size={14} />
        </View>
      ) : null}
    </Pressable>
  );
}

function FileRow({ item }: { item: SharedMediaItem }) {
  const { t } = useI18n();
  const icon = item.kind === 'voice'
    ? 'mic-outline'
    : item.kind === 'image' || item.kind === 'video'
      ? 'image-outline'
      : 'document-outline';
  return (
    <View accessible={false} style={styles.fileRow}>
      <View style={styles.fileIcon}>
        <Ionicons color={colors.inkMuted} name={icon} size={16} />
      </View>
      <View style={styles.fileCopy}>
        <Text numberOfLines={1} style={styles.fileName}>
          {item.name || t(mediaKindKey(item.kind))}
        </Text>
        <Text numberOfLines={1} style={styles.fileMeta}>
          {`${item.senderName} · ${mediaSizeLabel(item.byteSize)}`}
        </Text>
      </View>
    </View>
  );
}

/**
 * Everything a chat has carried, newest first. Photos and videos open in the
 * viewer already built, and a swipe (or an arrow key with a mouse) moves along
 * the photos in this grid rather than closing it.
 */
export function SharedMediaModal({
  visible,
  conversationId,
  onClose,
}: {
  visible: boolean;
  conversationId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const workspace = useWorkspace();
  const loadSharedMedia = workspace.loadSharedMedia;
  const [items, setItems] = useState<SharedMediaItem[] | null>(null);
  const [cursor, setCursor] = useState<SharedMediaPage['cursor']>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  // Mounted for one opening, so the first page loads once and nothing has to
  // be cleared on the way in.
  useEffect(() => {
    let live = true;
    void loadSharedMedia(conversationId).then((page) => {
      if (!live) return;
      setItems(page?.items ?? []);
      setCursor(page?.cursor ?? null);
    });
    return () => {
      live = false;
    };
  }, [conversationId, loadSharedMedia]);

  const showMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const page = await loadSharedMedia(conversationId, cursor);
    setLoadingMore(false);
    if (!page) return;
    setItems((current) => [...(current ?? []), ...page.items]);
    setCursor(page.cursor);
  };

  const viewable = (items ?? []).filter(isThumbnail);
  const viewingIndex = viewable.findIndex((item) => item.attachmentId === viewing);
  const shown = viewingIndex >= 0 ? viewable[viewingIndex] : null;
  const step = (delta: number) => {
    const next = viewable[viewingIndex + delta];
    if (next) setViewing(next.attachmentId);
  };

  return (
    <ActionModal onClose={onClose} title={t('chat.sharedMediaTitle')} visible={visible}>
      {items === null ? (
        <ActivityIndicator accessibilityLabel={t('chat.sharedMediaTitle')} color={colors.mintDark} />
      ) : items.length === 0 ? (
        <Text style={styles.empty}>{t('chat.sharedMediaEmpty')}</Text>
      ) : (
        <View style={styles.sections}>
          {sharedMediaSections(items).map((section) => (
            section.kind === 'thumbnails' ? (
              <View key={`grid:${section.items[0].attachmentId}`} style={styles.grid}>
                {section.items.map((item) => (
                  <Thumbnail
                    item={item}
                    key={item.attachmentId}
                    onPress={() => setViewing(item.attachmentId)}
                  />
                ))}
              </View>
            ) : (
              <FileRow item={section.item} key={section.item.attachmentId} />
            )
          ))}
          {cursor ? (
            <Pressable
              accessibilityLabel={t('chat.sharedMediaMore')}
              accessibilityRole="button"
              disabled={loadingMore}
              onPress={() => void showMore()}
              style={({ pressed }) => [styles.more, pressed && styles.morePressed]}>
              <Text style={styles.moreText}>{t('chat.sharedMediaMore')}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
      {shown ? (
        <ImageViewerModal
          name={shown.name}
          onClose={() => setViewing(null)}
          onNext={viewingIndex < viewable.length - 1 ? () => step(1) : undefined}
          onPrevious={viewingIndex > 0 ? () => step(-1) : undefined}
          uri={shown.previewUrl}
          visible
        />
      ) : null}
    </ActionModal>
  );
}

const styles = StyleSheet.create({
  sections: { gap: spacing.xs },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  tile: {
    flexBasis: '31%',
    flexGrow: 0,
    aspectRatio: 1,
    borderRadius: radii.sm,
    overflow: 'hidden',
    backgroundColor: colors.paperMuted,
  },
  tilePressed: { opacity: 0.7 },
  tileImage: { width: '100%', height: '100%' },
  videoMark: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: 6,
  },
  fileIcon: {
    width: 30,
    height: 30,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.paperMuted,
  },
  fileCopy: { flex: 1, minWidth: 0 },
  fileName: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  fileMeta: { color: colors.inkSubtle, fontSize: 10, marginTop: 1 },
  more: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.paperMuted,
  },
  morePressed: { opacity: 0.7 },
  moreText: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  empty: { color: colors.inkSubtle, fontSize: 12, paddingVertical: spacing.sm },
});
