import type { RegisterDeviceInput } from '@/data/repositories/contracts';

export async function getCurrentInstallationId(): Promise<string | null> {
  return null;
}

export async function getExistingDeviceRegistration(
  _organizationId: string,
): Promise<RegisterDeviceInput | null> {
  return null;
}

export async function requestDeviceRegistration(
  _organizationId: string,
): Promise<RegisterDeviceInput | null> {
  return null;
}

export async function configureNotificationChannels() {}

export function addPushTokenRefreshListener(
  _organizationId: string,
  _onRegistration: (registration: RegisterDeviceInput) => void | Promise<void>,
) {
  return { remove() {} };
}

export function noteRegisteredPushToken(_token: string | null | undefined) {}
export function resetPushTokenMemoryForTests() {}

export type NotificationPermissionState = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export async function getNotificationPermissionState(): Promise<NotificationPermissionState> {
  return 'unavailable';
}

export async function openNotificationSettings(): Promise<void> {}
