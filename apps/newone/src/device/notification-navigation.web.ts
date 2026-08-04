interface NotificationNavigationOptions {
  enabled: boolean;
  organizationId: string | null;
  badgeCount: number;
}

export function useNotificationNavigation(_options: NotificationNavigationOptions) {}
