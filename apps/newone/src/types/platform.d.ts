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
  export type SummaryShareOutcome = 'shared' | 'dismissed' | 'copied' | 'saved';
  export function shareSummary(input: SummaryShareInput): Promise<SummaryShareOutcome>;
  /** A finished PDF or Word file from the service, ready to save. */
  export interface SummaryFileInput {
    fileName: string;
    title: string;
    bytes: Uint8Array;
    mimeType: string;
  }
  /** Browser: straight into downloads. Phones: the share sheet, where Files and Drive save it. */
  export function saveSummaryFile(input: SummaryFileInput): Promise<SummaryShareOutcome>;
}

declare module '@/components/ui/anchored-popover' {
  import type { ReactNode, RefObject } from 'react';
  import type { View } from 'react-native';
  export interface AnchoredPopoverProps {
    /** The control the card belongs to; it opens beside it. */
    anchor: RefObject<View | null>;
    visible: boolean;
    width: number;
    onClose: () => void;
    onPointerEnter?: () => void;
    onPointerLeave?: () => void;
    accessibilityLabel?: string;
    testID?: string;
    children: ReactNode;
  }
  /** A card beside its control on the web; nothing on a phone, which uses a sheet. */
  export function AnchoredPopover(props: AnchoredPopoverProps): ReactNode;
}

declare module 'react-dom' {
  import type { ReactNode, ReactPortal } from 'react';
  export function createPortal(children: ReactNode, container: Element | DocumentFragment): ReactPortal;
}

declare module '@/features/chat/attachment-save' {
  export interface AttachmentSaveInput {
    /** A signed link to the file. */
    url: string;
    fileName: string;
    mimeType: string;
  }
  /** photos: in the photo library; shared: handed to the share sheet; opened: the browser has it; denied: no permission to add photos. */
  export type AttachmentSaveOutcome = 'photos' | 'shared' | 'opened' | 'denied';
  export function saveAttachment(input: AttachmentSaveInput): Promise<AttachmentSaveOutcome>;
}
