import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * The tick the reply gesture plays the moment it passes its threshold: the
 * light impact both platforms use for a gesture that has just committed.
 * Failures are swallowed — a phone with haptics switched off, or a simulator,
 * must never turn a reply into an error.
 */
export function replyHapticTick(platform: string = Platform.OS): void {
  if (platform !== 'ios' && platform !== 'android') return;
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}
