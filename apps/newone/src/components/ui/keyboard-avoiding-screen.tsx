import { useCallback, useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

// React Native's KeyboardAvoidingView pads by (its own bottom edge, measured
// relative to its PARENT) minus the keyboard's top edge (measured on SCREEN).
// Any view that does not start at the top of the window therefore under-pads
// by exactly its distance from the window top. Inside AppScaffold that is the
// safe-area top (≈62pt on an iPhone 17), which left the conversation composer
// and its send button underneath the iOS 26 keyboard's predictive bar: taps
// on "Send message" landed on the keyboard and nothing was sent.
//
// This wrapper measures its own window position and feeds it back as the
// offset, so the padding is right wherever the screen places it.
/**
 * Android 15 renders edge-to-edge, which defeats adjustResize: the window keeps
 * its size and the composer ends up under the keyboard (first real Android
 * user, Z Flip). Padding from the keyboard frame works on both platforms; where
 * the window does resize the measured overlap is zero, so nothing is padded
 * twice.
 */
export const KEYBOARD_AVOIDING_BEHAVIOR = 'padding' as const;

type Props = {
  children: ReactNode;
  extraOffset?: number;
  style?: StyleProp<ViewStyle>;
};

export function KeyboardAvoidingScreen({ children, extraOffset = 0, style }: Props) {
  const ref = useRef<View>(null);
  const [windowTop, setWindowTop] = useState(0);
  const onLayout = useCallback(() => {
    ref.current?.measureInWindow((_x, y) => {
      if (!Number.isFinite(y)) return;
      const next = Math.max(0, Math.round(y));
      setWindowTop((previous) => (previous === next ? previous : next));
    });
  }, []);
  return (
    <View collapsable={false} onLayout={onLayout} ref={ref} style={style}>
      <KeyboardAvoidingView
        behavior={KEYBOARD_AVOIDING_BEHAVIOR}
        keyboardVerticalOffset={windowTop + extraOffset}
        style={styles.fill}
        testID="keyboard-avoiding-screen">
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
