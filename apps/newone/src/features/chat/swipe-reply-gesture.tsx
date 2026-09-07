import { Ionicons } from '@expo/vector-icons';
import { type ReactNode, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { desktopMessageProps } from '@/features/chat/desktop-message-actions';
import { replyHapticTick } from '@/features/chat/reply-haptics';
import {
  swipeReplyArrowOpacity,
  swipeReplyMinIntentPx,
  swipeReplyTranslation,
  swipeReplyTriggered,
} from '@/features/chat/swipe-to-reply';
import { useI18n } from '@/i18n/provider';
import { colors, spacing } from '@/theme/tokens';

const SNAP = { duration: 160 };

/**
 * Drag a bubble to the right to reply to it.
 *
 * The list under it must stay the easier thing to do, so the gesture only
 * activates once the finger has gone {@link swipeReplyMinIntentPx} sideways and
 * gives up the moment it goes as far up or down. An arrow appears in the gap the
 * bubble leaves behind and is fully drawn exactly when releasing would reply.
 *
 * A mouse has no swipe, so on web this stands aside and the row's own hover
 * affordance takes over; the actions sheet keeps its Reply on every platform.
 */
export function SwipeToReply({
  children,
  enabled,
  own,
  onReply,
  onOpenActions,
}: {
  children: ReactNode;
  enabled: boolean;
  own: boolean;
  onReply: () => void;
  onOpenActions: () => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const translateX = useSharedValue(0);
  const ticked = useSharedValue(false);

  const pan = Gesture.Pan()
    .withTestId('swipe-to-reply')
    .enabled(enabled && Platform.OS !== 'web')
    // Sideways only, and only rightwards: the vertical list keeps every drag
    // that is not clearly a swipe across the bubble.
    .activeOffsetX([-swipeReplyMinIntentPx * 4, swipeReplyMinIntentPx])
    .failOffsetY([-swipeReplyMinIntentPx, swipeReplyMinIntentPx])
    .onUpdate((event) => {
      const travel = swipeReplyTranslation(event.translationX);
      translateX.value = travel;
      if (!ticked.value && swipeReplyTriggered(event.translationX)) {
        ticked.value = true;
        scheduleOnRN(replyHapticTick);
      }
    })
    .onEnd((event) => {
      const triggered = swipeReplyTriggered(event.translationX);
      translateX.value = withTiming(0, SNAP);
      ticked.value = false;
      if (triggered) scheduleOnRN(onReply);
    })
    .onFinalize(() => {
      translateX.value = withTiming(0, SNAP);
      ticked.value = false;
    });

  const bubbleStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));
  const arrowStyle = useAnimatedStyle(() => ({
    opacity: swipeReplyArrowOpacity(translateX.value),
  }));

  // A mouse has neither gesture, so on the web build hovering the row shows its
  // Reply where the swipe's arrow would have appeared, and right-clicking opens
  // the sheet a long press opens on a phone.
  if (Platform.OS === 'web') {
    return (
      <View
        style={styles.row}
        {...desktopMessageProps({ onHoverChange: setHovered, onContextMenu: onOpenActions })}>
        {enabled && hovered ? (
          <Pressable
            accessibilityLabel={t('chat.reply')}
            accessibilityRole="button"
            hitSlop={6}
            onPress={onReply}
            style={[styles.arrow, own && styles.arrowOwn]}>
            <Ionicons color={colors.inkSubtle} name="arrow-undo-outline" size={16} />
          </Pressable>
        ) : null}
        {children}
      </View>
    );
  }

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.row}>
        <Animated.View pointerEvents="none" style={[styles.arrow, own && styles.arrowOwn, arrowStyle]}>
          <Ionicons color={colors.inkSubtle} name="arrow-undo-outline" size={16} />
        </Animated.View>
        <Animated.View style={bubbleStyle}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  row: { justifyContent: 'center' },
  arrow: {
    alignItems: 'center',
    height: 28,
    justifyContent: 'center',
    left: spacing.xs,
    position: 'absolute',
    top: '50%',
    marginTop: -14,
    width: 28,
  },
  arrowOwn: { left: undefined, right: spacing.xs },
});
