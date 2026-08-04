import { useSyncExternalStore } from 'react';
import { Platform, useWindowDimensions } from 'react-native';

const SERVER_WEB_DIMENSIONS = {
  fontScale: 1,
  height: 0,
  scale: 1,
  width: 0,
} as const;

const subscribeHydration = () => () => {};
const clientHydrationSnapshot = () => true;
const serverHydrationSnapshot = () => Platform.OS !== 'web';

/**
 * React Native Web reads the real browser viewport in useWindowDimensions'
 * state initializer. Expo static rendering has no viewport and renders width
 * zero, so responsive render branches otherwise disagree during hydration.
 *
 * Native keeps its normal first render. Web deliberately reuses the server
 * snapshot for the hydration pass, then switches to the live viewport.
 */
export function useHydrationSafeWindowDimensions() {
  const dimensions = useWindowDimensions();
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientHydrationSnapshot,
    serverHydrationSnapshot,
  );

  return hydrated ? dimensions : SERVER_WEB_DIMENSIONS;
}
