import { Platform, Vibration } from 'react-native';

/**
 * The tick the reply gesture plays the moment it passes its threshold.
 *
 * Android gets a real 10 ms tap from the vibrator. iOS has nothing this short
 * in React Native itself — its only vibration is the full 400 ms buzz, which
 * would be worse than silence on every reply — so it stays quiet until
 * expo-haptics is part of the build, at which point this whole function becomes
 * `Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)`.
 */
export function replyHapticTick(platform: string = Platform.OS): void {
  if (platform !== 'android') return;
  Vibration.vibrate(10);
}
