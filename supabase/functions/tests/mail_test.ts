import { ApiError } from '../_shared/errors.ts';
import { sendCodeEmail } from '../_shared/mail.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const recipient = 'newcomer@example.com';
const code = '135790';
const apiKey = 'resend-key-that-is-long-enough';
const mailFrom = 'Newone <no-reply@newone.example>';

interface RecordedSend {
  url: string;
  init: RequestInit | undefined;
  body: Record<string, unknown>;
}

async function withMailEnvironment(
  values: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const names = ['RESEND_API_KEY', 'NEWONE_MAIL_FROM'] as const;
  const previous = new Map<string, string | undefined>(
    names.map((name) => [name, Deno.env.get(name)]),
  );
  try {
    for (const name of names) {
      const value = values[name];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

function configured(run: () => Promise<void>): Promise<void> {
  return withMailEnvironment({ RESEND_API_KEY: apiKey, NEWONE_MAIL_FROM: mailFrom }, run);
}

function recordingFetcher(
  sends: RecordedSend[],
  respond: () => Response = () => new Response('{"id":"mail-1"}', { status: 200 }),
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    sends.push({
      url: input instanceof Request ? input.url : input.toString(),
      init,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Promise.resolve(respond());
  }) as typeof fetch;
}

Deno.test('code email posts branded localized subject and body to Resend', async () => {
  await configured(async () => {
    const cases = [
      ['en', 'Your Newone verification code'],
      ['es', 'Tu código de verificación de Newone'],
      ['ko', 'Newone 인증 코드'],
    ] as const;
    for (const [locale, subject] of cases) {
      const sends: RecordedSend[] = [];
      await sendCodeEmail({ to: recipient, code, locale }, recordingFetcher(sends));
      assertEquals(sends.length, 1);
      const send = sends[0] as RecordedSend;
      assertEquals(send.url, 'https://api.resend.com/emails');
      assertEquals(send.init?.method, 'POST');
      assert(send.init?.signal instanceof AbortSignal, 'send must carry a timeout signal');
      const headers = new Headers(send.init?.headers);
      assertEquals(headers.get('Authorization'), `Bearer ${apiKey}`);
      assertEquals(headers.get('Content-Type'), 'application/json');
      assertEquals(send.body.from, mailFrom);
      assertEquals(send.body.to, [recipient]);
      assertEquals(send.body.subject, subject);
      const text = send.body.text;
      assert(typeof text === 'string');
      assert(text.includes(code), 'body must carry the six-digit code');
      assert(text.includes('10'), 'body must carry the ten-minute validity note');
    }
  });
});

Deno.test('BCP 47 locale tags select copy by primary language subtag', async () => {
  await configured(async () => {
    const cases = [
      ['ko-KR', 'Newone 인증 코드'],
      ['KO', 'Newone 인증 코드'],
      ['es-419', 'Tu código de verificación de Newone'],
      ['es_MX', 'Tu código de verificación de Newone'],
      ['en-GB', 'Your Newone verification code'],
      ['fr-CA', 'Your Newone verification code'],
    ] as const;
    for (const [locale, subject] of cases) {
      const sends: RecordedSend[] = [];
      await sendCodeEmail({ to: recipient, code, locale }, recordingFetcher(sends));
      assertEquals(sends[0]?.body.subject, subject);
    }
  });
});

Deno.test('unknown or missing locales fall back to English copy', async () => {
  await configured(async () => {
    for (const locale of [null, 'fr']) {
      const sends: RecordedSend[] = [];
      await sendCodeEmail({ to: recipient, code, locale }, recordingFetcher(sends));
      assertEquals(sends[0]?.body.subject, 'Your Newone verification code');
    }
  });
});

Deno.test('non-2xx provider responses map to 503 dependency_unavailable', async () => {
  await configured(async () => {
    for (const status of [400, 401, 429, 500]) {
      const sends: RecordedSend[] = [];
      await assertRejects(
        () =>
          sendCodeEmail(
            { to: recipient, code, locale: 'en' },
            recordingFetcher(sends, () => new Response('{"error":"rejected"}', { status })),
          ),
        (error) =>
          error instanceof ApiError && error.status === 503 &&
          error.code === 'dependency_unavailable',
      );
    }
  });
});

Deno.test('network failures map to 503 dependency_unavailable', async () => {
  await configured(async () => {
    const failing = (() => Promise.reject(new TypeError('connection reset'))) as typeof fetch;
    await assertRejects(
      () => sendCodeEmail({ to: recipient, code, locale: 'en' }, failing),
      (error) =>
        error instanceof ApiError && error.status === 503 &&
        error.code === 'dependency_unavailable',
    );
  });
});

Deno.test('missing or malformed mail configuration fails as 503 without any provider call', async () => {
  const invalid: Array<Record<string, string | undefined>> = [
    { NEWONE_MAIL_FROM: mailFrom },
    { RESEND_API_KEY: apiKey },
    { RESEND_API_KEY: 'short', NEWONE_MAIL_FROM: mailFrom },
    { RESEND_API_KEY: 'key with spaces that is long', NEWONE_MAIL_FROM: mailFrom },
    { RESEND_API_KEY: apiKey, NEWONE_MAIL_FROM: 'a\nb' },
  ];
  for (const values of invalid) {
    await withMailEnvironment(values, async () => {
      const sends: RecordedSend[] = [];
      await assertRejects(
        () => sendCodeEmail({ to: recipient, code, locale: 'en' }, recordingFetcher(sends)),
        (error) =>
          error instanceof ApiError && error.status === 503 &&
          error.code === 'dependency_unavailable',
      );
      assertEquals(sends.length, 0);
    });
  }
});

Deno.test('the mailer never logs the code or the recipient', async () => {
  await configured(async () => {
    const logged: string[] = [];
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    const capture = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    console.log = capture;
    console.info = capture;
    console.warn = capture;
    console.error = capture;
    console.debug = capture;
    try {
      await sendCodeEmail({ to: recipient, code, locale: 'ko' }, recordingFetcher([]));
      await assertRejects(() =>
        sendCodeEmail(
          { to: recipient, code, locale: 'ko' },
          recordingFetcher([], () => new Response('provider down', { status: 500 })),
        )
      );
      await assertRejects(() =>
        sendCodeEmail(
          { to: recipient, code, locale: 'ko' },
          (() => Promise.reject(new TypeError('connection reset'))) as typeof fetch,
        )
      );
    } finally {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
      console.debug = original.debug;
    }
    assertEquals(logged.filter((line) => line.includes(code)), []);
    assertEquals(logged.filter((line) => line.includes(recipient)), []);
    assertEquals(logged, []);
  });
});
