import { Ionicons } from '@expo/vector-icons';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { isPersonalRealm } from '@/constants/personal-realm';
import type { Attachment, Message } from '@/domain/types';
import { ImageViewerModal } from '@/features/chat/image-viewer';
import { mediaFrame } from '@/features/chat/timeline-layout';
import { VideoAttachment } from '@/features/chat/video-attachment';
import { useI18n } from '@/i18n/provider';
import { useWorkspace } from '@/state/workspace';
import { spacing } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

const VIDEO_RATIO = 16 / 9;

/** Uploaded and clean: the file can be opened or downloaded. */
export function attachmentReady(attachment: Attachment) {
  return attachment.status === 'clean' && (!attachment.transfer || attachment.transfer.state === 'uploaded');
}

export function isVideoAttachment(attachment: Attachment) {
  return attachment.mimeType?.startsWith('video/') === true;
}

/**
 * A displayable source for media: the row's own download URL, the short-lived
 * signed preview the workspace grants once per attachment, or the local file
 * while the upload still runs. The last shown source survives the swap from
 * the optimistic row to the server row so the photo never blinks out.
 */
function useAttachmentSource(message: Message) {
  const workspace = useWorkspace();
  const attachment = message.attachment;
  const granted = attachment ? workspace.attachmentPreviewUrls?.[attachment.id] : undefined;
  const loadPreview = workspace.loadAttachmentPreview;
  const ready = attachment ? attachmentReady(attachment) : false;
  const remote = attachment?.downloadUrl ?? granted;
  const uri = remote ?? attachment?.localUri;
  const wantsGrant = ready && !remote && Boolean(loadPreview);
  useEffect(() => {
    if (wantsGrant) void loadPreview?.(message);
  }, [loadPreview, message, wantsGrant]);
  const [shown, setShown] = useState<string | undefined>(uri);
  useEffect(() => {
    if (uri) setShown(uri);
  }, [uri]);
  // A signed URL that has lapsed loads nothing and looks like a broken photo.
  // Asking again is the whole recovery: the workspace hands out a fresh grant.
  const retry = useCallback(() => {
    if (ready) void loadPreview?.(message);
  }, [loadPreview, message, ready]);
  return { uri: uri ?? shown, ready, retry };
}

/**
 * A photo is just the photo: sized to its own aspect ratio inside the bubble
 * limits, rounded, tap to open the viewer. While uploading it shows dimmed
 * under a progress ring; a failed upload gets a small retry/cancel row.
 */
export function ImageAttachment({
  message,
  maxWidth,
  onDownload,
  footer,
}: {
  message: Message;
  maxWidth: number;
  onDownload: () => void;
  footer?: ReactNode;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const attachment = message.attachment;
  const { uri, ready, retry } = useAttachmentSource(message);
  // The natural size arrives with the same request that paints the photo
  // (onLoad), so the frame settles on the true aspect ratio without a second
  // fetch; until then the default 4:3 frame holds the place.
  const [ratio, setRatio] = useState<number | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  if (!attachment) return null;
  const frame = mediaFrame(ratio, maxWidth);
  const transfer = attachment.transfer;
  const transferring = transfer?.state === 'preparing' || transfer?.state === 'uploading';
  const interrupted = transfer?.state === 'failed' || transfer?.state === 'cancelled';
  const progress = Math.max(0, Math.min(1, transfer?.progress ?? 0));
  const percent = Math.round(progress * 100);
  return (
    <>
      <View style={[styles.frame, frame]}>
        {uri ? (
          <Pressable
            accessibilityLabel={ready ? t('chat.imageOpen') : t('chat.attachmentUploading')}
            accessibilityRole={ready ? 'imagebutton' : 'image'}
            disabled={!ready}
            onPress={() => setViewerOpen(true)}
            style={styles.fill}>
            <Image
              accessibilityIgnoresInvertColors
              onError={retry}
              onLoad={(event) => {
                const source = event.nativeEvent?.source;
                if (source && source.width > 0 && source.height > 0) setRatio(source.width / source.height);
              }}
              resizeMode="contain"
              source={{ uri }}
              style={[styles.fill, (transferring || interrupted) && styles.dimmed]}
            />
          </Pressable>
        ) : (
          <View accessibilityLabel={attachment.name} style={[styles.fill, styles.center]}>
            {ready
              ? <ActivityIndicator color={colors.mintDark} />
              : <Ionicons name="image-outline" size={26} color={colors.inkSubtle} />}
          </View>
        )}
        {transferring ? (
          <View pointerEvents="none" style={[styles.fill, styles.center, styles.overlay]}>
            <ProgressRing label={`${t('chat.attachmentProgress')} ${percent}%`} progress={progress} />
          </View>
        ) : null}
        {interrupted ? (
          <View style={styles.interrupted}>
            <TransferControls message={message} tone="light" />
          </View>
        ) : null}
        {footer}
      </View>
      {viewerOpen && uri ? (
        <ImageViewerModal
          name={attachment.name}
          onClose={() => setViewerOpen(false)}
          onDownload={ready ? onDownload : undefined}
          uri={uri}
          visible
        />
      ) : null}
    </>
  );
}

/** A received video plays inline once the signed source is granted. */
export function VideoMessageAttachment({
  message,
  maxWidth,
  onDownload,
}: {
  message: Message;
  maxWidth: number;
  onDownload: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const workspace = useWorkspace();
  const attachment = message.attachment;
  const { uri, ready } = useAttachmentSource(message);
  if (!attachment) return null;
  const frame = mediaFrame(VIDEO_RATIO, maxWidth);
  if (!uri || !ready) {
    return (
      <View accessibilityLabel={attachment.name} style={[styles.frame, styles.center, styles.videoPlaceholder, frame]}>
        <ActivityIndicator color={colors.white} />
      </View>
    );
  }
  const readyLabel = t(isPersonalRealm(workspace.organizationId) ? 'chat.fileReady' : 'chat.fileClean');
  return (
    <VideoAttachment
      downloadLabel={`${attachment.name}, ${readyLabel}`}
      height={frame.height}
      label={`${t('chat.videoAttachment')} · ${attachment.name}`}
      onDownload={onDownload}
      uri={uri}
      width={frame.width}
    />
  );
}

/**
 * A determinate ring drawn from two clipped half-arcs (no SVG dependency): the
 * right half fills over 0-50%, the left half over 50-100%.
 */
export function ProgressRing({
  progress,
  label,
  size = 44,
  thickness = 3,
}: {
  progress: number;
  label: string;
  size?: number;
  thickness?: number;
}) {
  const styles = useThemedStyles(buildStyles);
  const clamped = Math.max(0, Math.min(1, progress));
  const percent = Math.round(clamped * 100);
  const angle = clamped * 360;
  const rightArc = Math.min(180, angle);
  const leftArc = Math.max(0, angle - 180);
  const half = size / 2;
  const circle = { width: size, height: size, borderRadius: half, borderWidth: thickness };
  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: percent, text: `${percent}%` }}
      style={[styles.ring, { width: size, height: size }]}>
      <View style={[styles.ringTrack, circle]} />
      <View style={[styles.ringWindow, { left: half, width: half, height: size }]}>
        <View
          style={[
            styles.ringArc,
            circle,
            styles.ringArcLeftHalf,
            { left: -half, transform: [{ rotate: `${45 + rightArc}deg` }] },
          ]}
        />
      </View>
      <View style={[styles.ringWindow, { left: 0, width: half, height: size }]}>
        <View
          style={[
            styles.ringArc,
            circle,
            styles.ringArcRightHalf,
            { left: 0, transform: [{ rotate: `${45 + leftArc}deg` }] },
          ]}
        />
      </View>
      <Text style={styles.ringText}>{percent}%</Text>
    </View>
  );
}

/** Retry / cancel controls for an upload that is running, failed, or awaiting cleanup. */
export function TransferControls({ message, tone }: { message: Message; tone: 'light' | 'default' }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const workspace = useWorkspace();
  const { t } = useI18n();
  const transfer = message.attachment?.transfer;
  if (!transfer) return null;
  const clientMessageId = message.clientMessageId ?? '';
  const retryBusy = workspace.actionBusy === `attachment-retry:${clientMessageId}`;
  const cancelBusy = workspace.actionBusy === `attachment-cancel:${clientMessageId}`;
  const failed = transfer.state === 'failed';
  const cancelled = transfer.state === 'cancelled';
  const light = tone === 'light';
  const retryDisabled = retryBusy || workspace.connectivity !== 'online';
  return (
    <View style={styles.controls}>
      {failed ? (
        <Text
          accessibilityLiveRegion="assertive"
          numberOfLines={2}
          style={[styles.failureText, light && styles.failureTextLight]}>
          {message.failureReason ?? t('chat.attachmentFailureBody')}
        </Text>
      ) : cancelled ? (
        <Text
          accessibilityLiveRegion="polite"
          numberOfLines={2}
          style={[styles.failureText, light && styles.failureTextLight]}>
          {t('chat.attachmentCleanupBody')}
        </Text>
      ) : null}
      <View style={styles.controlRow}>
        {failed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: retryDisabled }}
            disabled={retryDisabled}
            onPress={() => void workspace.retryAttachmentUpload(message)}
            style={({ pressed }) => [styles.control, pressed && styles.pressed]}>
            <Ionicons name="refresh-outline" size={13} color={light ? colors.white : colors.mintDark} />
            <Text style={[styles.controlText, light && styles.controlTextLight]}>
              {retryBusy ? t('chat.attachmentRetrying') : t('chat.attachmentRetry')}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: cancelBusy }}
          disabled={cancelBusy}
          onPress={() => void workspace.cancelAttachmentUpload(message)}
          style={({ pressed }) => [styles.control, pressed && styles.pressed]}>
          <Ionicons
            name={cancelled ? 'trash-outline' : 'close-circle-outline'}
            size={13}
            color={light ? '#FFD4C7' : colors.red}
          />
          <Text style={[styles.controlText, styles.controlDanger, light && styles.failureTextLight]}>
            {cancelBusy
              ? t('chat.attachmentCancelling')
              : cancelled
                ? t('chat.attachmentFinishCleanup')
                : t('chat.attachmentCancel')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  frame: { borderRadius: 14, overflow: 'hidden', backgroundColor: colors.tintFaint },
  fill: { width: '100%', height: '100%' },
  center: { alignItems: 'center', justifyContent: 'center' },
  overlay: { position: 'absolute', top: 0, left: 0 },
  dimmed: { opacity: 0.45 },
  videoPlaceholder: { backgroundColor: '#000' },
  interrupted: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.xs,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  ring: { alignItems: 'center', justifyContent: 'center' },
  ringTrack: { position: 'absolute', top: 0, left: 0, borderColor: 'rgba(255,255,255,0.35)' },
  ringWindow: { position: 'absolute', top: 0, overflow: 'hidden' },
  ringArc: { position: 'absolute', top: 0, borderColor: colors.white },
  ringArcLeftHalf: { borderTopColor: 'transparent', borderRightColor: 'transparent' },
  ringArcRightHalf: { borderBottomColor: 'transparent', borderLeftColor: 'transparent' },
  ringText: { color: colors.white, fontSize: 10, fontWeight: '800' },
  controls: { gap: 4 },
  controlRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  control: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: 4 },
  controlText: { color: colors.mintDark, fontSize: 12, fontWeight: '700' },
  controlTextLight: { color: colors.white },
  controlDanger: { color: colors.red },
  failureText: { color: colors.red, fontSize: 11, lineHeight: 15 },
  failureTextLight: { color: '#FFD4C7' },
  pressed: { opacity: 0.7 },
});
