import { ApiError } from './errors.ts';
import { asObject, normalizedString, oneOf, onlyKeys } from './validation.ts';

const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;
const EXPO_PUSH_TOKEN_PATTERN = /^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{8,256}\]$/;

export function expoPushToken(value: unknown): string {
  const token = normalizedString(value, { min: 25, max: 300, trim: false }) as string;
  if (!EXPO_PUSH_TOKEN_PATTERN.test(token)) throw new ApiError(400, 'bad_request');
  return token;
}

export interface ExpoPushMessage {
  attemptId: string;
  to: string;
  data: Record<string, unknown>;
  title?: string;
  body?: string;
  sound?: 'default';
  channelId?: 'newone-default' | 'newone-silent';
  priority: 'normal' | 'high';
  contentAvailable: boolean;
}

export interface ExpoSubmissionResult {
  attemptId: string;
  result: 'accepted' | 'transient_failure' | 'permanent_failure' | 'device_not_registered';
  providerTicketId: string | null;
  errorCode: string | null;
}

export interface ExpoReceiptResult {
  providerTicketId: string;
  result: 'delivered' | 'pending' | 'permanent_failure' | 'device_not_registered';
  errorCode: string | null;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function providerCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(value)) {
    return 'provider_rejected';
  }
  return value;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new ApiError(503, 'provider_unavailable', undefined, response.status === 429 ? 60 : 30);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new ApiError(503, 'provider_unavailable', undefined, 30);
  }
  try {
    return asObject(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    throw new ApiError(503, 'provider_unavailable', undefined, 30);
  }
}

function individualError(value: unknown): string {
  const ticket = asObject(value);
  const details = ticket.details === undefined ? {} : asObject(ticket.details);
  return providerCode(details.error);
}

export class ExpoPushClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetcher: Fetcher = fetch,
  ) {
    if (
      accessToken.length < 20 || accessToken.length > 4096 ||
      /[\s\u0000-\u001f\u007f]/.test(accessToken)
    ) throw new Error('NEWONE_EXPO_ACCESS_TOKEN is not configured');
  }

  private async post(url: string, body: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      return await responseJson(
        await this.fetcher(url, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'provider_unavailable', undefined, 30);
    } finally {
      clearTimeout(timeout);
    }
  }

  async submit(messages: ExpoPushMessage[]): Promise<ExpoSubmissionResult[]> {
    if (messages.length < 1 || messages.length > 100) {
      throw new ApiError(503, 'provider_unavailable', undefined, 30);
    }
    for (const message of messages) expoPushToken(message.to);
    const response = await this.post(
      EXPO_SEND_URL,
      messages.map((message) => ({
        to: message.to,
        data: message.data,
        ...(message.title ? { title: message.title } : {}),
        ...(message.body ? { body: message.body } : {}),
        ...(message.sound ? { sound: message.sound } : {}),
        ...(message.channelId ? { channelId: message.channelId } : {}),
        priority: message.priority,
        _contentAvailable: message.contentAvailable,
      })),
    );
    onlyKeys(response, ['data', 'errors']);
    if (Array.isArray(response.errors) && response.errors.length > 0) {
      throw new ApiError(503, 'provider_unavailable', undefined, 60);
    }
    if (!Array.isArray(response.data) || response.data.length !== messages.length) {
      throw new ApiError(503, 'provider_unavailable', undefined, 30);
    }
    return response.data.map((value, index) => {
      const message = messages[index];
      if (!message) throw new ApiError(503, 'provider_unavailable', undefined, 30);
      const ticket = asObject(value);
      const status = oneOf(ticket.status, ['ok', 'error'] as const);
      if (status === 'ok') {
        return {
          attemptId: message.attemptId,
          result: 'accepted' as const,
          providerTicketId: normalizedString(ticket.id, { min: 1, max: 500 }) as string,
          errorCode: null,
        };
      }
      const errorCode = individualError(ticket);
      return {
        attemptId: message.attemptId,
        result: errorCode === 'DeviceNotRegistered'
          ? 'device_not_registered' as const
          : errorCode === 'MessageRateExceeded'
          ? 'transient_failure' as const
          : 'permanent_failure' as const,
        providerTicketId: null,
        errorCode,
      };
    });
  }

  async receipts(providerTicketIds: string[]): Promise<ExpoReceiptResult[]> {
    if (providerTicketIds.length < 1 || providerTicketIds.length > 1000) {
      throw new ApiError(503, 'provider_unavailable', undefined, 30);
    }
    for (const id of providerTicketIds) normalizedString(id, { min: 1, max: 500 });
    const response = await this.post(EXPO_RECEIPTS_URL, { ids: providerTicketIds });
    onlyKeys(response, ['data', 'errors']);
    if (Array.isArray(response.errors) && response.errors.length > 0) {
      throw new ApiError(503, 'provider_unavailable', undefined, 60);
    }
    const data = asObject(response.data);
    return providerTicketIds.map((id) => {
      const value = data[id];
      if (value === undefined) {
        return { providerTicketId: id, result: 'pending' as const, errorCode: null };
      }
      const receipt = asObject(value);
      const status = oneOf(receipt.status, ['ok', 'error'] as const);
      if (status === 'ok') {
        return { providerTicketId: id, result: 'delivered' as const, errorCode: null };
      }
      const errorCode = individualError(receipt);
      return {
        providerTicketId: id,
        result: errorCode === 'DeviceNotRegistered'
          ? 'device_not_registered' as const
          : errorCode === 'MessageRateExceeded'
          ? 'pending' as const
          : 'permanent_failure' as const,
        errorCode: errorCode === 'MessageRateExceeded' ? null : errorCode,
      };
    });
  }
}
