import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors } from '@/theme/tokens';

/**
 * Inline video attachment: the first frame is the poster and the platform
 * controls carry play and fullscreen. Nothing autoplays; the player stays
 * paused until the viewer taps (owner report: videos rendered as file cards).
 */
export function VideoAttachment({
  uri,
  width,
  height,
  label,
  downloadLabel,
  onDownload,
}: {
  uri: string;
  width: number;
  height: number;
  label: string;
  downloadLabel?: string;
  onDownload?: () => void;
}) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = false;
  });
  return (
    <View style={[styles.frame, { width, height }]}>
      <VideoView
        accessibilityLabel={label}
        contentFit="contain"
        fullscreenOptions={{ enable: true }}
        nativeControls
        player={player}
        style={styles.video}
        useExoShutter={false}
      />
      {onDownload && downloadLabel ? (
        <Pressable
          accessibilityLabel={downloadLabel}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onDownload}
          style={({ pressed }) => [styles.download, pressed && styles.pressed]}>
          <Ionicons name="download-outline" size={16} color={colors.white} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: 14, overflow: 'hidden', backgroundColor: '#000' },
  video: { flex: 1 },
  download: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  pressed: { opacity: 0.7 },
});
