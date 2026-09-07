import { Ionicons } from '@expo/vector-icons';
import { createContext, useContext, useEffect, useState } from 'react';
import {
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { type EdgeInsets, SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { useI18n } from '@/i18n/provider';
import { spacing } from '@/theme/tokens';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme/provider';

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 900;
// A sideways drag past this much means "the next one", not a wobbly dismiss.
const STEP_DISTANCE = 60;
const SNAP = { duration: 140 };
// The safe-area hook throws outside its provider (tests, detached trees); the
// viewer reads the context directly and simply pads nothing when it is absent.
const NoInsetsContext = createContext<EdgeInsets | null>(null);

/**
 * Full-screen viewer for an image attachment, fed by the same signed preview
 * URL the bubble already uses, so nothing is downloaded to Files just to look
 * at a photo. Pinch-to-zoom and pan run on the gesture handler on both
 * platforms (Android never zoomed on the plain scroll view), a double tap
 * toggles zoom, a single tap toggles the bar, and a swipe down dismisses.
 */
export function ImageViewerModal({
  visible,
  uri,
  name,
  onClose,
  onDownload,
  onNext,
  onPrevious,
}: {
  visible: boolean;
  uri: string | null | undefined;
  name?: string | null;
  onClose: () => void;
  onDownload?: () => void;
  /** Given when the viewer sits on a list: a swipe, a chevron or an arrow key
   * moves along it. Left undefined for a single photo in a bubble. */
  onNext?: () => void;
  onPrevious?: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(buildStyles);
  const { t } = useI18n();
  const { width, height } = useWindowDimensions();
  // A modal window gets no safe-area view insets of its own; the root
  // provider's insets keep the bar below the status bar, where taps arrive.
  const insets = useContext(SafeAreaInsetsContext ?? NoInsetsContext);
  const topInset = insets?.top ?? 0;
  const [chromeVisible, setChromeVisible] = useState(true);
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  const dismissY = useSharedValue(0);

  useEffect(() => {
    if (!visible) return;
    setChromeVisible(true);
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedX.value = 0;
    savedY.value = 0;
    dismissY.value = 0;
  }, [dismissY, savedScale, savedX, savedY, scale, translateX, translateY, uri, visible]);

  // A mouse has no swipe: the arrow keys walk the same list on the web app.
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return undefined;
    if (typeof globalThis.addEventListener !== 'function') return undefined;
    const onKey = (event: { key?: string; preventDefault?: () => void }) => {
      const step = event.key === 'ArrowRight'
        ? onNext
        : event.key === 'ArrowLeft'
          ? onPrevious
          : undefined;
      if (!step) return;
      event.preventDefault?.();
      step();
    };
    globalThis.addEventListener('keydown', onKey as EventListener);
    return () => globalThis.removeEventListener('keydown', onKey as EventListener);
  }, [onNext, onPrevious, visible]);

  const toggleChrome = () => setChromeVisible((current) => !current);

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      scale.value = Math.min(MAX_SCALE, Math.max(1, savedScale.value * event.scale));
    })
    .onEnd(() => {
      if (scale.value <= 1.02) {
        scale.value = withTiming(1, SNAP);
        translateX.value = withTiming(0, SNAP);
        translateY.value = withTiming(0, SNAP);
        savedScale.value = 1;
        savedX.value = 0;
        savedY.value = 0;
        return;
      }
      savedScale.value = scale.value;
    });

  const pan = Gesture.Pan()
    .onUpdate((event) => {
      if (savedScale.value > 1) {
        translateX.value = savedX.value + event.translationX;
        translateY.value = savedY.value + event.translationY;
        return;
      }
      dismissY.value = Math.max(0, event.translationY);
    })
    .onEnd((event) => {
      if (savedScale.value > 1) {
        savedX.value = translateX.value;
        savedY.value = translateY.value;
        return;
      }
      if (dismissY.value > DISMISS_DISTANCE || event.velocityY > DISMISS_VELOCITY) {
        dismissY.value = 0;
        scheduleOnRN(onClose);
        return;
      }
      // Sideways beats downwards: moving along the grid must not close it.
      if (Math.abs(event.translationX) > STEP_DISTANCE
        && Math.abs(event.translationX) > Math.abs(event.translationY)) {
        const step = event.translationX < 0 ? onNext : onPrevious;
        dismissY.value = withTiming(0, SNAP);
        if (step) scheduleOnRN(step);
        return;
      }
      dismissY.value = withTiming(0, SNAP);
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const next = savedScale.value > 1 ? 1 : DOUBLE_TAP_SCALE;
      scale.value = withTiming(next, SNAP);
      savedScale.value = next;
      if (next === 1) {
        translateX.value = withTiming(0, SNAP);
        translateY.value = withTiming(0, SNAP);
        savedX.value = 0;
        savedY.value = 0;
      }
    });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      scheduleOnRN(toggleChrome);
    });

  const gesture = Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, singleTap));

  const imageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value + dismissY.value },
      { scale: scale.value },
    ],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0.35, 1 - dismissY.value / 320),
  }));

  if (!uri) return null;
  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={visible}>
      <GestureHandlerRootView style={styles.root}>
        <Animated.View pointerEvents="none" style={[styles.backdrop, backdropStyle]} />
        <GestureDetector gesture={gesture}>
          <Animated.View style={[styles.stage, imageStyle]}>
            <Image
              accessibilityIgnoresInvertColors
              accessibilityLabel={name ?? t('chat.imageViewerImage')}
              accessibilityRole="image"
              resizeMode="contain"
              source={{ uri }}
              style={{ width, height }}
            />
          </Animated.View>
        </GestureDetector>
        {chromeVisible ? (
          <View pointerEvents="box-none" style={[styles.chrome, { paddingTop: topInset }]}>
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
              {onPrevious ? (
                <Pressable
                  accessibilityLabel={t('chat.imageViewerPrevious')}
                  accessibilityRole="button"
                  hitSlop={12}
                  onPress={onPrevious}
                  style={({ pressed }) => [styles.barButton, pressed && styles.pressed]}>
                  <Ionicons name="chevron-back" size={24} color={colors.white} />
                </Pressable>
              ) : null}
              {onNext ? (
                <Pressable
                  accessibilityLabel={t('chat.imageViewerNext')}
                  accessibilityRole="button"
                  hitSlop={12}
                  onPress={onNext}
                  style={({ pressed }) => [styles.barButton, pressed && styles.pressed]}>
                  <Ionicons name="chevron-forward" size={24} color={colors.white} />
                </Pressable>
              ) : null}
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
          </View>
        ) : null}
      </GestureHandlerRootView>
    </Modal>
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1 },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  chrome: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  barButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  title: { flex: 1, color: colors.white, fontSize: 15, fontWeight: '600', textAlign: 'center', marginHorizontal: spacing.sm },
  pressed: { opacity: 0.6 },
});
