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
