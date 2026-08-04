export type DeviceNotificationPreview = 'generic' | 'hidden';

export interface DeviceNotificationPreferenceOverrides {
  notificationPreview: DeviceNotificationPreview | null;
  soundEnabled: boolean | null;
  vibrationEnabled: boolean | null;
}

export type DeviceNotificationPreferencePatch = Partial<DeviceNotificationPreferenceOverrides>;

export interface DeviceNotificationPreferences {
  registered: true;
  deviceId: string;
  installationId: string;
  platform: 'ios' | 'android' | 'web';
  preferenceVersion: number;
  overrides: DeviceNotificationPreferenceOverrides;
  effective: {
    notificationPreview: DeviceNotificationPreview;
    soundEnabled: boolean;
    vibrationEnabled: boolean;
  };
  updatedAt: string;
}

export function normalizeDeviceNotificationPreferencePatch(
  value: unknown,
): DeviceNotificationPreferencePatch;

export function parseDeviceNotificationPreferences(
  value: unknown,
): DeviceNotificationPreferences;
