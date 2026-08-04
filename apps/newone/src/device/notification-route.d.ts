export interface NotificationDestination {
  organizationId: string;
  href: `/conversation/${string}` | '/updates' | '/handoffs';
  key: string;
}

export function notificationDestination(value: unknown): NotificationDestination | null;
