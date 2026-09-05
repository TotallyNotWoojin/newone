declare module '@/lib/secure-storage' {
  const storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  };
  export const authStorage: typeof storage;
  export const secureStorage: typeof storage;
}

declare module '@/data/persistence/client-store' {
  import type { ClientStore } from '@/data/persistence/types';
  export const clientStore: ClientStore;
}

declare module '@/device/push-registration' {
  import type { RegisterDeviceInput } from '@/data/repositories/contracts';
  export function getCurrentInstallationId(): Promise<string | null>;
  export function getExistingDeviceRegistration(
    organizationId: string,
  ): Promise<RegisterDeviceInput | null>;
  export function requestDeviceRegistration(
    organizationId: string,
  ): Promise<RegisterDeviceInput | null>;
  export function configureNotificationChannels(): Promise<void>;
  export function addPushTokenRefreshListener(
    organizationId: string,
    onRegistration: (registration: RegisterDeviceInput) => void | Promise<void>,
  ): { remove(): void };
  export function noteRegisteredPushToken(token: string | null | undefined): void;
  export function resetPushTokenMemoryForTests(): void;
  export type NotificationPermissionState = 'granted' | 'denied' | 'undetermined' | 'unavailable';
  export function getNotificationPermissionState(): Promise<NotificationPermissionState>;
  export function openNotificationSettings(): Promise<void>;
}

declare module '@/device/notification-navigation' {
  export function useNotificationNavigation(options: {
    enabled: boolean;
    organizationId: string | null;
    badgeCount: number;
  }): void;
}

declare module '@/data/attachment-upload' {
  export interface AttachmentTransferSource {
    uri: string;
    bytes: ArrayBuffer;
  }
  export interface AttachmentTransferOptions {
    signal?: AbortSignal;
    onProgress?: (progress: number) => void;
  }
  export function transferAttachment(
    signedUrl: string,
    source: AttachmentTransferSource,
    mimeType: string,
    options?: AttachmentTransferOptions,
  ): Promise<number>;
}

declare module '@/data/attachment-cleanup' {
  export function removeTemporaryAttachment(uri: string): Promise<void>;
}

declare module '@/lib/installation-id' {
  export function getInstallationId(): Promise<string>;
}

declare module '@/components/security/captcha-challenge' {
  export function CaptchaChallenge(props: {
    label: string;
    onError: () => void;
    onToken: (token: string | null) => void;
  }): React.ReactNode;
}

declare module '@/features/chat/summary-export' {
  export interface SummaryShareInput {
    fileName: string;
    title: string;
    text: string;
  }
  export type SummaryShareOutcome = 'shared' | 'dismissed' | 'copied';
  export function shareSummary(input: SummaryShareInput): Promise<SummaryShareOutcome>;
}
