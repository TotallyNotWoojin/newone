import { useEffect } from 'react';

interface NotificationNavigationOptions {
  enabled: boolean;
  organizationId: string | null;
  badgeCount: number;
}

// The same mint pill the chat list puts on an unread row (palette.light.mint
// on palette.light.onAccent), so the tab and the list say the same thing.
const BADGE_FILL = '#35C48D';
const BADGE_INK = '#102E27';
// The PNG, not the SVG: a canvas can draw it, and the service worker keeps it.
const ICON_SOURCE = '/gist-icon-192.png';
const ICON_SIZE = 64;

interface RememberedIcon {
  link: HTMLLinkElement;
  href: string;
  type: string | null;
}

// What the page shipped with, remembered the first time a count is painted
// so the icon can go back exactly once everything is read.
let shipped: RememberedIcon[] | null = null;
let iconImage: Promise<HTMLImageElement | null> | null = null;
let generation = 0;

function iconLinks(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
}

function loadIcon(): Promise<HTMLImageElement | null> {
  iconImage ??= new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = ICON_SOURCE;
  });
  return iconImage;
}

/** The app icon with the count on a mint disc at its bottom-right corner, as a PNG data URL. */
export async function paintBadgedIcon(count: number): Promise<string | null> {
  const image = await loadIcon();
  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const context = canvas.getContext('2d');
  if (!context) return null;
  if (image) context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
  const label = String(count);
  const radius = ICON_SIZE * 0.32;
  const centreX = ICON_SIZE - radius - 2;
  const centreY = ICON_SIZE - radius - 2;
  // A dark ring first: the icon's own letterform is the same mint, and
  // without the ring the two merged into one shape at 64px.
  context.fillStyle = BADGE_INK;
  context.beginPath();
  context.arc(centreX, centreY, radius + 3, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = BADGE_FILL;
  context.beginPath();
  context.arc(centreX, centreY, radius, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = BADGE_INK;
  context.font = `900 ${label.length > 1 ? 24 : 30}px system-ui, -apple-system, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, centreX, centreY + 1);
  return canvas.toDataURL('image/png');
}

function restoreShippedIcon() {
  if (!shipped) return;
  for (const { link, href, type } of shipped) {
    link.href = href;
    if (type === null) link.removeAttribute('type');
    else link.type = type;
  }
  shipped = null;
}

/**
 * Puts `count` on every icon the browser shows for the app: the installed
 * app's icon through the Badging API where the browser has one, and the tab's
 * favicon everywhere. Zero takes both away again.
 */
export async function applyWebBadge(count: number): Promise<void> {
  const ownGeneration = ++generation;
  const badging = navigator as Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  if (count > 0) await badging.setAppBadge?.(count).catch(() => undefined);
  else await badging.clearAppBadge?.().catch(() => undefined);

  if (count <= 0) {
    restoreShippedIcon();
    return;
  }
  const painted = await paintBadgedIcon(count);
  // A newer count landed while this one was being drawn; it will paint its own.
  if (painted === null || ownGeneration !== generation) return;
  const links = iconLinks();
  shipped ??= links.map((link) => ({
    link,
    href: link.getAttribute('href') ?? '',
    type: link.getAttribute('type'),
  }));
  for (const link of links) {
    link.href = painted;
    link.type = 'image/png';
  }
}

/** Only for tests: forgets the remembered favicon and the cached icon image. */
export function resetWebBadgeForTests() {
  shipped = null;
  iconImage = null;
  generation = 0;
}

/**
 * The web half of the notification bridge. A browser has no push to route
 * and no cold-start tap to replay; what it has is a tab and, once installed,
 * an icon -- both of which carry the unread count here.
 */
export function useNotificationNavigation({
  enabled,
  organizationId,
  badgeCount,
}: NotificationNavigationOptions) {
  useEffect(() => {
    if (!enabled || !organizationId || typeof document === 'undefined') return;
    const boundedBadgeCount = Math.min(99, Math.max(0, Math.trunc(badgeCount)));
    void applyWebBadge(boundedBadgeCount).catch(() => undefined);
  }, [badgeCount, enabled, organizationId]);
}
