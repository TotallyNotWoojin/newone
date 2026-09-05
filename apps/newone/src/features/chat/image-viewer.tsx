import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useI18n } from '@/i18n/provider';
import { colors, spacing } from '@/theme/tokens';

/**
 * Full-screen viewer for an image attachment, fed by the same signed preview
 * URL the bubble already uses, so nothing is downloaded to Files just to look
 * at a photo. Pinch-to-zoom rides on the platform scroll view (iOS zooms
 * natively; Android shows the image fitted to the screen). The download
 * action stays available from the top bar.
 */
export function ImageViewerModal({
  visible,
  uri,
  name,
  onClose,
  onDownload,
}: {
  visible: boolean;
  uri: string | null | undefined;
  name?: string | null;
  onClose: () => void;
  onDownload?: () => void;
}) {
  const { t } = useI18n();
  const { width, height } = useWindowDimensions();
  const [chromeVisible, setChromeVisible] = useState(true);
  useEffect(() => {
    if (visible) setChromeVisible(true);
  }, [visible]);
  if (!uri) return null;
  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      statusBarTranslucent
      visible={visible}>
      <View style={styles.root}>
        <ScrollView
          bouncesZoom
          centerContent
          contentContainerStyle={styles.scrollContent}
          maximumZoomScale={5}
          minimumZoomScale={1}
          pinchGestureEnabled
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}>
          <Pressable
            accessibilityLabel={name ?? t('chat.imageViewerImage')}
            accessibilityRole="image"
            onPress={() => setChromeVisible((current) => !current)}>
            <Image
              accessibilityIgnoresInvertColors
              resizeMode="contain"
              source={{ uri }}
              style={{ width, height }}
            />
          </Pressable>
        </ScrollView>
        {chromeVisible ? (
          <SafeAreaView edges={['top']} pointerEvents="box-none" style={styles.chrome}>
            <View style={styles.bar}>
              <Pressable
                accessibilityLabel={t('chat.imageViewerClose')}
                accessibilityRole="button"
                hitSlop={12}
                onPress={onClose}
                style={({ pressed }) => [styles.barButton, pressed && styles.pressed]}>
                <Ionicons name="close" size={24} color={colors.white} />
              </Pressable>
              <Text numberOfLines={1} style={styles.title}>{name ?? ''}</Text>
              {onDownload ? (
                <Pressable
                  accessibilityLabel={t('chat.imageViewerDownload')}
                  accessibilityRole="button"
                  hitSlop={12}
                  onPress={onDownload}
                  style={({ pressed }) => [styles.barButton, pressed && styles.pressed]}>
                  <Ionicons name="download-outline" size={22} color={colors.white} />
                </Pressable>
              ) : (
                <View style={styles.barButton} />
              )}
            </View>
          </SafeAreaView>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  scrollContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  chrome: { position: 'absolute', top: 0, left: 0, right: 0 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  barButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  title: { flex: 1, color: colors.white, fontSize: 15, fontWeight: '600', textAlign: 'center', marginHorizontal: spacing.sm },
  pressed: { opacity: 0.6 },
});
