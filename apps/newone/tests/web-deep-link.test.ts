import { afterEach, describe, expect, test } from '@jest/globals';
import { Platform } from 'react-native';

import {
  consumeWebDeepLink,
  restoreDeepLinkPath,
  WEB_DEEP_LINK_STORAGE_KEY,
} from '@/lib/web-deep-link';

const originalPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (originalPlatform) Object.defineProperty(Platform, 'OS', originalPlatform);
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('static-host deep link restore', () => {
  test('strips the app base and keeps the in-app route and query', () => {
    expect(restoreDeepLinkPath('/newone-legal/app/conversation/abc', '/newone-legal/app'))
      .toBe('/conversation/abc');
    expect(restoreDeepLinkPath('/app/conversation/abc?messageId=m1#frag', '/app'))
      .toBe('/conversation/abc?messageId=m1');
    expect(restoreDeepLinkPath('/conversation/abc', '')).toBe('/conversation/abc');
    expect(restoreDeepLinkPath('/conversation/abc', undefined)).toBe('/conversation/abc');
  });

  test('ignores paths outside the base, the root, sign-in, and anything unsafe', () => {
    expect(restoreDeepLinkPath('/privacy.html', '/newone-legal/app')).toBeNull();
    expect(restoreDeepLinkPath('/newone-legal/app', '/newone-legal/app')).toBeNull();
    expect(restoreDeepLinkPath('/newone-legal/app/', '/newone-legal/app')).toBeNull();
    expect(restoreDeepLinkPath('/newone-legal/app/sign-in', '/newone-legal/app')).toBeNull();
    expect(restoreDeepLinkPath('//evil.example/x', '')).toBeNull();
    expect(restoreDeepLinkPath('https://evil.example/x', '')).toBeNull();
    expect(restoreDeepLinkPath('/x\\y', '')).toBeNull();
    expect(restoreDeepLinkPath(`/${'a'.repeat(2100)}`, '')).toBeNull();
    expect(restoreDeepLinkPath(null, '')).toBeNull();
  });

  test('consumes the stored link exactly once on web and never on native', () => {
    const values = new Map<string, string>([[WEB_DEEP_LINK_STORAGE_KEY, '/conversation/abc']]);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        sessionStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          removeItem: (key: string) => values.delete(key),
        },
      },
    });

    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    expect(consumeWebDeepLink()).toBeNull();
    expect(values.size).toBe(1);

    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    expect(consumeWebDeepLink()).toBe('/conversation/abc');
    expect(values.size).toBe(0);
    expect(consumeWebDeepLink()).toBeNull();
  });

  test('treats blocked storage as no deep link', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        get sessionStorage(): Storage {
          throw new Error('SecurityError');
        },
      },
    });
    expect(consumeWebDeepLink()).toBeNull();
  });
});
