import { Platform, type ViewProps } from 'react-native';

/**
 * A mouse has neither a swipe nor a long press.
 *
 * On the web build the two message gestures get the two things a pointer does
 * have: hovering a message shows its Reply, and right-clicking it opens the
 * same actions sheet a long press opens on a phone. react-native-web forwards
 * these DOM events straight through a View, so nothing is needed but the
 * handlers — and on a phone this returns nothing at all, so a touch build
 * carries no extra props and no extra listeners.
 */

export interface DesktopMessageHandlers {
  onHoverChange: (hovered: boolean) => void;
  onContextMenu: () => void;
}

interface PreventableEvent {
  preventDefault?: () => void;
}

/** True where a pointer stands in for a finger. */
export function desktopPointer(platform: string = Platform.OS): boolean {
  return platform === 'web';
}

/** The hover and right-click props for one message row. Empty on a phone. */
export function desktopMessageProps(
  handlers: DesktopMessageHandlers,
  platform: string = Platform.OS,
): ViewProps {
  if (!desktopPointer(platform)) return {};
  return {
    onMouseEnter: () => handlers.onHoverChange(true),
    onMouseLeave: () => handlers.onHoverChange(false),
    onContextMenu: (event: PreventableEvent) => {
      // Right-click is the mouse's long press, so it opens our actions rather
      // than the browser's menu.
      event?.preventDefault?.();
      handlers.onContextMenu();
    },
  } as ViewProps;
}
