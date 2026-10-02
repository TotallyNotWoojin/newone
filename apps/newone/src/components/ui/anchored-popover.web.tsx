import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import type { AnchoredPopoverProps } from '@/components/ui/anchored-popover';
import { radii } from '@/theme/tokens';
import { useThemedStyles, type ThemeColors } from '@/theme/provider';

const GAP = 6;
const MARGIN = 8;

type Place = { left: number; top: number; maxHeight: number };

function domNode(ref: { current: unknown }): HTMLElement | null {
  const node = ref.current as HTMLElement | null;
  return node && typeof node.getBoundingClientRect === 'function' ? node : null;
}

/**
 * A card beside its control, drawn on the page itself so the chat list's
 * scrolling box cannot clip it (react-native-web gives every ScrollView a
 * transform, which traps a fixed child inside it). It opens to the control's
 * right, or to its left where the window ends, and keeps inside the window as
 * the list scrolls. A press anywhere else, or Escape, closes it. Mount it
 * only while it is open, so each opening measures afresh.
 */
export function AnchoredPopover({
  anchor,
  visible,
  width,
  onClose,
  onPointerEnter,
  onPointerLeave,
  accessibilityLabel,
  testID,
  children,
}: AnchoredPopoverProps) {
  const styles = useThemedStyles(buildStyles);
  const cardRef = useRef<View>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const [height, setHeight] = useState(0);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  const measure = useCallback(() => {
    const node = domNode(anchor);
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let left = rect.right + GAP;
    if (left + width > viewportWidth - MARGIN) left = Math.max(MARGIN, rect.left - GAP - width);
    const maxHeight = Math.max(160, viewportHeight - MARGIN * 2);
    const top = Math.max(MARGIN, Math.min(rect.top - 4, viewportHeight - MARGIN - Math.min(height, maxHeight)));
    setPlace((current) => (current && current.left === left && current.top === top && current.maxHeight === maxHeight
      ? current
      : { left, top, maxHeight }));
  }, [anchor, height, width]);

  useEffect(() => {
    if (!visible) return undefined;
    // The first measurement waits a frame: the control has to be laid out.
    const frame = requestAnimationFrame(measure);
    // Capture: the chat list scrolls inside its own box, not the window.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [measure, visible]);

  useEffect(() => {
    if (!visible) return undefined;
    const press = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const card = domNode(cardRef);
      const control = domNode(anchor);
      if (target && (card?.contains(target) || control?.contains(target))) return;
      closeRef.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    document.addEventListener('pointerdown', press, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', press, true);
      document.removeEventListener('keydown', key);
    };
  }, [anchor, visible]);

  if (!visible || !place || typeof document === 'undefined') return null;
  const position = {
    position: 'fixed',
    left: place.left,
    top: place.top,
    width,
    maxHeight: place.maxHeight,
  } as unknown as ViewStyle;
  return createPortal(
    <View
      accessibilityLabel={accessibilityLabel}
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      ref={cardRef}
      role="dialog"
      style={[styles.card, position]}
      testID={testID}>
      {children}
    </View>,
    document.body,
  );
}

const buildStyles = (colors: ThemeColors) => StyleSheet.create({
  card: {
    zIndex: 40,
    overflow: 'hidden',
    borderRadius: radii.lg,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
    // It floats over the chat, so it needs more lift than a sheet's shadow.
    boxShadow: '0 14px 40px rgba(16, 32, 26, 0.22)',
  },
});
