import { Platform } from 'react-native';

/** The subset of a key event the composer needs; matches both RN and DOM shapes. */
export interface ComposerKeyEvent {
  key?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * Desktop browsers: Enter sends, Shift+Enter inserts a newline (governed by
 * the device preference `enterSends`). Native keyboards keep their own
 * return-key behaviour. An Enter that merely commits an IME composition
 * (Korean, Japanese) must never send half a word, so composing keystrokes are
 * ignored.
 */
export function shouldSendOnEnter(
  event: ComposerKeyEvent,
  options: { enterSends: boolean; platform?: string },
): boolean {
  const platform = options.platform ?? Platform.OS;
  if (platform !== 'web' || !options.enterSends) return false;
  if (event.key !== 'Enter' || event.shiftKey === true) return false;
  if (event.isComposing === true || event.keyCode === 229) return false;
  return true;
}
