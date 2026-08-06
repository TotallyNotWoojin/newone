import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { renderHook } from '@testing-library/react-native';
import * as ReactNative from 'react-native';

import { useHydrationSafeWindowDimensions } from '@/hooks/use-hydration-safe-window-dimensions';

type SnapshotMode = 'client' | 'server';
let mockSnapshotMode: SnapshotMode = 'client';
let mockDimensions: {
  fontScale: number;
  height: number;
  scale: number;
  width: number;
};
const mockSubscriptionCleanup = jest.fn();

jest.mock('react', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    ...React,
    useSyncExternalStore: (
      subscribe: (onChange: () => void) => () => void,
      getSnapshot: () => boolean,
      getServerSnapshot: () => boolean,
    ) => {
      const cleanup = subscribe(() => undefined);
      cleanup();
      mockSubscriptionCleanup();
      return mockSnapshotMode === 'client' ? getSnapshot() : getServerSnapshot();
    },
  };
});

jest.mock('react-native', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return new Proxy(ReactNative, {
    get(target, property, receiver) {
      if (property === 'useWindowDimensions') return () => mockDimensions;
      return Reflect.get(target, property, receiver);
    },
  });
});

beforeEach(() => {
  mockSnapshotMode = 'client';
  mockDimensions = { fontScale: 1.15, height: 844, scale: 3, width: 390 };
  mockSubscriptionCleanup.mockClear();
  Object.defineProperty(ReactNative.Platform, 'OS', { configurable: true, value: 'web' });
});

describe('hydration-safe window dimensions', () => {
  test('returns the live viewport after the browser hydration boundary', async () => {
    const { result } = await renderHook(() => useHydrationSafeWindowDimensions());

    expect(result.current).toBe(mockDimensions);
    expect(mockSubscriptionCleanup).toHaveBeenCalledTimes(1);
  });

  test('reuses the zero-width static-render snapshot during web hydration', async () => {
    mockSnapshotMode = 'server';
    const { result } = await renderHook(() => useHydrationSafeWindowDimensions());

    expect(result.current).toEqual({ fontScale: 1, height: 0, scale: 1, width: 0 });
  });

  test.each(['ios', 'android'] as const)(
    'keeps native first-render dimensions on %s because native has no web SSR pass',
    async (platform) => {
      Object.defineProperty(ReactNative.Platform, 'OS', { configurable: true, value: platform });
      mockSnapshotMode = 'server';

      const { result } = await renderHook(() => useHydrationSafeWindowDimensions());

      expect(result.current).toBe(mockDimensions);
    },
  );
});
