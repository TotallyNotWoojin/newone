import { afterEach, describe, expect, jest, test } from '@jest/globals';

const originalMode = process.env.EXPO_PUBLIC_WEB_AUTH_MODE;

function loadTransport(platform: 'ios' | 'android' | 'web', mode?: string) {
  jest.resetModules();
  if (mode === undefined) delete process.env.EXPO_PUBLIC_WEB_AUTH_MODE;
  else process.env.EXPO_PUBLIC_WEB_AUTH_MODE = mode;
  jest.doMock('react-native', () => ({ Platform: { OS: platform } }));
  const runtime = jest.requireActual<typeof import('@/config/runtime')>('@/config/runtime');
  const transport = jest.requireActual<typeof import('@/lib/session-transport')>('@/lib/session-transport');
  return { runtime, transport };
}

afterEach(() => {
  jest.dontMock('react-native');
  jest.resetModules();
  if (originalMode === undefined) delete process.env.EXPO_PUBLIC_WEB_AUTH_MODE;
  else process.env.EXPO_PUBLIC_WEB_AUTH_MODE = originalMode;
});

describe('session transport selection', () => {
  test('web defaults to the cookie gateway and native always uses bearer tokens', () => {
    const web = loadTransport('web');
    expect(web.runtime.webAuthMode).toBe('cookie');
    expect(web.runtime.edgeSessionTransport).toBe('cookie');
    expect(web.transport.usesCookieSession()).toBe(true);

    for (const platform of ['ios', 'android'] as const) {
      const native = loadTransport(platform, 'direct');
      expect(native.runtime.edgeSessionTransport).toBe('bearer');
      expect(native.transport.usesCookieSession()).toBe(false);
    }
  });

  test('EXPO_PUBLIC_WEB_AUTH_MODE=direct switches web to bearer tokens; junk falls back to cookie', () => {
    const direct = loadTransport('web', 'direct');
    expect(direct.runtime.webAuthMode).toBe('direct');
    expect(direct.runtime.edgeSessionTransport).toBe('bearer');
    expect(direct.transport.usesCookieSession()).toBe(false);

    const junk = loadTransport('web', 'anything-else');
    expect(junk.runtime.webAuthMode).toBe('cookie');
    expect(junk.runtime.edgeSessionTransport).toBe('cookie');
    expect(junk.transport.usesCookieSession()).toBe(true);
  });
});
