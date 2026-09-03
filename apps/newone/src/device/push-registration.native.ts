import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { publicRuntimeConfig } from '@/config/runtime';
import { RepositoryError, type RegisterDeviceInput } from '@/data/repositories/contracts';
import { createClientId } from '@/lib/client-id';
// Metro selects a stable device-protected native installation identity.
// eslint-disable-next-line import/no-unresolved
import { getInstallationId } from '@/lib/installation-id';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPO_TOKEN_PATTERN = /^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{16,}\]$/;

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const visible = Boolean(notification.request.content.title || notification.request.content.body);
    return {
      shouldShowBanner: visible,
      shouldShowList: visible,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
});

export async function configureNotificationChannels() {
  if (Platform.OS !== 'android') return;
  await Promise.all([
    Notifications.setNotificationChannelAsync('newone-default', {
      name: 'Newone activity',
      importance: Notifications.AndroidImportance.HIGH,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      sound: 'default',
      vibrationPattern: [0, 250, 180, 250],
    }),
    Notifications.setNotificationChannelAsync('newone-silent', {
      name: 'Newone quiet activity',
      importance: Notifications.AndroidImportance.LOW,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      sound: null,
      enableVibrate: false,
    }),
  ]);
}

function pushBinding() {
  const projectId = publicRuntimeConfig.easProjectId ?? Constants.easConfig?.projectId ?? null;
  const environment = publicRuntimeConfig.pushEnvironment;
  if (!projectId || !UUID_PATTERN.test(projectId) || !environment) return null;
  return { projectId, environment };
}

export async function getCurrentInstallationId(): Promise<string | null> {
  if (!Device.isDevice || (Platform.OS !== 'ios' && Platform.OS !== 'android')) return null;
  return getInstallationId();
}

/** Uses an already-granted permission only. UI must request notification permission deliberately. */
export async function getExistingDeviceRegistration(
  organizationId: string,
): Promise<RegisterDeviceInput | null> {
  if (!Device.isDevice || (Platform.OS !== 'ios' && Platform.OS !== 'android')) return null;
  const permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted) return null;
  const binding = pushBinding();
  if (!binding) return null;
  await configureNotificationChannels();
  const token = await Notifications.getExpoPushTokenAsync({ projectId: binding.projectId });
  if (typeof token.data !== 'string' || !EXPO_TOKEN_PATTERN.test(token.data)) return null;
  const id = await getInstallationId();
  return {
    organizationId,
    installationId: id,
    platform: Platform.OS,
    pushToken: token.data,
    pushTokenType: 'expo',
    pushProjectId: binding.projectId,
    pushEnvironment: binding.environment,
    appVersion: Constants.expoConfig?.version,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    idempotencyKey: createClientId(),
  };
}

export function addPushTokenRefreshListener(
  organizationId: string,
  onRegistration: (registration: RegisterDeviceInput) => void | Promise<void>,
) {
  return Notifications.addPushTokenListener(() => {
    void getExistingDeviceRegistration(organizationId).then((registration) => {
      if (registration) void onRegistration(registration);
    });
  });
}

export async function requestDeviceRegistration(
  organizationId: string,
): Promise<RegisterDeviceInput | null> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  // A simulator can never obtain a push token. Fail with a stable, mappable
  // code instead of a silent null so the Settings action can explain itself.
  if (!Device.isDevice) {
    throw new RepositoryError('Push notifications need a physical device.', 'push_needs_device', false);
  }
  const current = await Notifications.getPermissionsAsync();
  const permission = current.granted ? current : await Notifications.requestPermissionsAsync();
  if (!permission.granted) return null;
  return getExistingDeviceRegistration(organizationId);
}
