import { ApiError } from './errors.ts';

// Gateway-owned signup-code delivery. GoTrue's public /otp endpoint refuses
// OTP requests for unconfirmed users while public signups stay disabled, so
// the auth gateway mints the code itself and delivers it through Resend.
// This module must never log the code or the recipient address.

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
// Resend answered slowly enough on Sep 4 2026 (delivery delays on their side)
// that a 10 s abort turned every code send into code_delivery_failed for an
// hour; the send now waits 30 s and retries once on a timeout, a network
// error, or a provider 429/5xx.
const SEND_TIMEOUT_MS = 30_000;
const SEND_ATTEMPTS = 2;

export type MailLocale = 'en' | 'es' | 'ko';

export interface SendCodeEmailInput {
  to: string;
  code: string;
  locale: string | null;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface CodeEmailCopy {
  subject: string;
  body: (code: string) => string;
}

const CODE_EMAIL_COPY: Record<MailLocale, CodeEmailCopy> = {
  en: {
    subject: 'Your Newone verification code',
    body: (code) =>
      `Your Newone verification code is ${code}.\n\n` +
      'The code is valid for 10 minutes. If you did not request it, ignore this email.',
  },
  es: {
    subject: 'Tu código de verificación de Newone',
    body: (code) =>
      `Tu código de verificación de Newone es ${code}.\n\n` +
      'El código es válido durante 10 minutos. Si no lo solicitaste, ignora este correo.',
  },
  ko: {
    subject: 'Newone 인증 코드',
    body: (code) =>
      `Newone 인증 코드는 ${code}입니다.\n\n` +
      '이 코드는 10분 동안 유효합니다. 요청하지 않으셨다면 이 이메일을 무시해 주세요.',
  },
};

function codeEmailCopy(locale: string | null): CodeEmailCopy {
  // Callers pass either a bare language ('ko') or the device's BCP 47 tag
  // ('ko-KR', 'es-419'); copy is selected by the primary language subtag and
  // falls back to English for everything else.
  const language = locale?.split(/[-_]/, 1)[0]?.toLowerCase();
  return language === 'es' || language === 'ko' ? CODE_EMAIL_COPY[language] : CODE_EMAIL_COPY.en;
}

function mailConfig(): { apiKey: string; from: string } {
  const apiKey = Deno.env.get('RESEND_API_KEY') ?? '';
  const from = Deno.env.get('NEWONE_MAIL_FROM') ?? '';
  if (
    apiKey.length < 8 || apiKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(apiKey) ||
    from.length < 3 || from.length > 320 || /[\r\n\0]/.test(from)
  ) {
    // Misconfiguration is a delivery failure, not a boot failure: the signup
    // route keeps its enumeration-safe envelope and records the outcome.
    throw new ApiError(503, 'dependency_unavailable', undefined, 30);
  }
  return { apiKey, from };
}

export async function sendCodeEmail(
  input: SendCodeEmailInput,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const { apiKey, from } = mailConfig();
  const copy = codeEmailCopy(input.locale);
  const body = JSON.stringify({
    from,
    to: [input.to],
    subject: copy.subject,
    text: copy.body(input.code),
  });
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const response = await fetcher(RESEND_EMAILS_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
      });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      // The provider's status and error name are needed to tell a quota from
      // a key problem; the recipient and the code never reach the log.
      const detail = await response.text().catch(() => '');
      console.error(JSON.stringify({
        event: 'newone_mail_provider_rejected',
        attempt,
        status: response.status,
        detail: detail.replace(/[\r\n]+/g, ' ').slice(0, 240),
      }));
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === SEND_ATTEMPTS) {
        throw new ApiError(503, 'dependency_unavailable', undefined, 30);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      console.error(JSON.stringify({
        event: 'newone_mail_send_error',
        attempt,
        name: error instanceof Error ? error.name : 'unknown',
      }));
      // Timeouts and network failures: one more try, then the generic
      // dependency error; details stay out of logs by design.
      if (attempt === SEND_ATTEMPTS) throw new ApiError(503, 'dependency_unavailable', undefined, 30);
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
