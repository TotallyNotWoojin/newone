// Default jest boundary for expo-video. The native player cannot initialize
// inside jest-expo, so every suite receives this inert view and player unless
// a test overrides the boundary with an explicit jest.mock('expo-video', ...).
import { createElement } from 'react';
import { View } from 'react-native';

export function useVideoPlayer() {
  return {
    loop: false,
    muted: false,
    playing: false,
    play: () => undefined,
    pause: () => undefined,
    release: () => undefined,
  };
}

export function VideoView(props: Record<string, unknown>) {
  const { accessibilityLabel, style, testID } = props;
  return createElement(View, {
    accessibilityLabel: accessibilityLabel as string | undefined,
    style: style as never,
    testID: (testID as string | undefined) ?? 'expo-video-view',
  });
}
