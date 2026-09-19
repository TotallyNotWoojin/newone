/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from '@testing-library/react-native';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
  applyWebBadge,
  paintBadgedIcon,
  resetWebBadgeForTests,
  useNotificationNavigation,
} from '@/device/notification-navigation.web';

const organizationId = '10000000-0000-4000-8000-000000000001';

// jsdom has no 2D canvas and never loads an image, so both are stood in for:
// the context records what was drawn, the image "loads" as soon as it has a
// source.
const drawn: string[] = [];
const fakeContext = {
  drawImage: (...args: unknown[]) => drawn.push(`drawImage:${args.slice(1).join(',')}`),
  beginPath: () => drawn.push('beginPath'),
  arc: (...args: unknown[]) => drawn.push(`arc:${args.join(',')}`),
  fill: () => drawn.push('fill'),
  fillText: (text: string) => drawn.push(`fillText:${text}`),
  set fillStyle(value: string) { drawn.push(`fillStyle:${value}`); },
  set font(value: string) { drawn.push(`font:${value}`); },
  set textAlign(_value: string) {},
  set textBaseline(_value: string) {},
};
let contextAvailable = true;
let imageLoads = true;
const setAppBadge = jest.fn<(count?: number) => Promise<void>>();
const clearAppBadge = jest.fn<() => Promise<void>>();

function installIconLinks() {
  document.head.innerHTML = [
    '<link href="/gist-icon.svg" rel="icon" type="image/svg+xml"/>',
    '<link href="/gist-icon-192.png" rel="apple-touch-icon" sizes="192x192"/>',
    '<link rel="icon" href="/favicon.ico"/>',
  ].join('');
}

function icons() {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
}

beforeEach(() => {
  resetWebBadgeForTests();
  drawn.length = 0;
  contextAvailable = true;
  imageLoads = true;
  installIconLinks();
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => (contextAvailable ? fakeContext : null) as unknown as CanvasRenderingContext2D,
  );
  jest.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,BADGED');
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => (imageLoads ? this.onload?.() : this.onerror?.()));
      }
    },
  });
  setAppBadge.mockResolvedValue(undefined);
  clearAppBadge.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge });
  Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: clearAppBadge });
});

describe('web notification bridge', () => {
  test('paints the count on a mint disc over the app icon', async () => {
    const painted = await paintBadgedIcon(7);
    expect(painted).toBe('data:image/png;base64,BADGED');
    expect(drawn).toEqual(expect.arrayContaining([
      'drawImage:0,0,64,64',
      'fillStyle:#35C48D',
      'fillStyle:#102E27',
      'fillText:7',
    ]));
    // Two digits shrink to fit the disc.
    drawn.length = 0;
    await paintBadgedIcon(42);
    expect(drawn.some((step) => step.startsWith('font:900 24px'))).toBe(true);
  });

  test('a missing icon image still paints the disc; a missing canvas paints nothing', async () => {
    imageLoads = false;
    expect(await paintBadgedIcon(2)).toBe('data:image/png;base64,BADGED');
    expect(drawn.some((step) => step.startsWith('drawImage'))).toBe(false);
    contextAvailable = false;
    expect(await paintBadgedIcon(2)).toBeNull();
  });

  test('swaps every icon link to the badged PNG and puts the shipped ones back at zero', async () => {
    await applyWebBadge(3);
    expect(setAppBadge).toHaveBeenCalledWith(3);
    const badged = icons();
    expect(badged).toHaveLength(2);
    for (const link of badged) {
      expect(link.href).toBe('data:image/png;base64,BADGED');
      expect(link.type).toBe('image/png');
    }
    // The touch icon is not a favicon and is left alone.
    expect(document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.getAttribute('href'))
      .toBe('/gist-icon-192.png');

    await applyWebBadge(0);
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    const restored = icons();
    expect(restored[0]?.getAttribute('href')).toBe('/gist-icon.svg');
    expect(restored[0]?.getAttribute('type')).toBe('image/svg+xml');
    expect(restored[1]?.getAttribute('href')).toBe('/favicon.ico');
    expect(restored[1]?.hasAttribute('type')).toBe(false);
  });

  test('a count that lands while an older one is still drawing wins', async () => {
    contextAvailable = true;
    const first = applyWebBadge(1);
    const second = applyWebBadge(2);
    await Promise.all([first, second]);
    // Both painted the same stub URL; what matters is that the last call's
    // number is the one drawn last and nothing from the first overwrote it.
    expect(drawn.filter((step) => step.startsWith('fillText')).pop()).toBe('fillText:2');
    expect(setAppBadge).toHaveBeenLastCalledWith(2);
  });

  test('survives a browser without the Badging API and without a canvas', async () => {
    Reflect.deleteProperty(navigator, 'setAppBadge');
    Reflect.deleteProperty(navigator, 'clearAppBadge');
    contextAvailable = false;
    await expect(applyWebBadge(5)).resolves.toBeUndefined();
    expect(icons()[1]?.getAttribute('href')).toBe('/favicon.ico');
    await expect(applyWebBadge(0)).resolves.toBeUndefined();
  });

  test('the hook applies the bounded count once the workspace is ready', async () => {
    const { rerender } = await renderHook(
      (props: { enabled: boolean; organizationId: string | null; badgeCount: number }) =>
        useNotificationNavigation(props),
      { initialProps: { enabled: false, organizationId: null, badgeCount: 5 } },
    );
    expect(setAppBadge).not.toHaveBeenCalled();
    await rerender({ enabled: true, organizationId, badgeCount: 120 });
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(99));
    await rerender({ enabled: true, organizationId, badgeCount: -3 });
    await waitFor(() => expect(clearAppBadge).toHaveBeenCalled());
  });
});
