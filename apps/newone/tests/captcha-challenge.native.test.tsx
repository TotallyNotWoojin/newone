import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';

import { CaptchaChallenge } from '@/components/security/captcha-challenge.native';

const mockRuntimeConfig = {
  turnstileChallengeOrigin: 'https://auth.example.test',
  turnstileSiteKey: 'controlled-turnstile-site-key',
};
const mockCreateClientId = jest.fn();
let mockWebViewProps: Record<string, unknown> | null = null;

jest.mock('@/config/runtime', () => ({
  get publicRuntimeConfig() {
    return mockRuntimeConfig;
  },
}));

jest.mock('@/lib/client-id', () => ({
  createClientId: () => mockCreateClientId(),
}));

jest.mock('react-native-webview', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    WebView: (mockProps: Record<string, unknown>) => {
      mockWebViewProps = mockProps;
      return React.createElement(View, { testID: 'controlled-turnstile-webview' });
    },
  };
});

const nonce = 'nonce_ABC-123!unsafe<script>';
const validToken = 'controlled-token-1234567890';

function webViewProps() {
  if (!mockWebViewProps) throw new Error('WebView did not render.');
  return mockWebViewProps as {
    onContentProcessDidTerminate: () => void;
    onError: () => void;
    onHttpError: () => void;
    onMessage: (event: { nativeEvent: { data: string; url: string } }) => void;
    onShouldStartLoadWithRequest: (request: { url: string }) => boolean;
    originWhitelist: string[];
    source: { baseUrl: string; html: string };
    [key: string]: unknown;
  };
}

function message(data: unknown, url = 'https://auth.example.test/challenge') {
  webViewProps().onMessage({
    nativeEvent: {
      data: typeof data === 'string' ? data : JSON.stringify(data),
      url,
    },
  });
}

beforeEach(() => {
  mockRuntimeConfig.turnstileChallengeOrigin = 'https://auth.example.test';
  mockRuntimeConfig.turnstileSiteKey = 'controlled-turnstile-site-key';
  mockCreateClientId.mockImplementation(() => nonce);
  mockWebViewProps = null;
});

describe('native Turnstile challenge boundary', () => {
  test.each([
    ['', 'https://auth.example.test'],
    ['controlled-turnstile-site-key', ''],
  ])('fails closed when native challenge configuration is incomplete', async (siteKey, origin) => {
    mockRuntimeConfig.turnstileSiteKey = siteKey;
    mockRuntimeConfig.turnstileChallengeOrigin = origin;
    const onError = jest.fn();
    const onToken = jest.fn();
    const view = await render(
      <CaptchaChallenge label="Human verification" onError={onError} onToken={onToken} />,
    );
    expect(screen.getByLabelText('Human verification')).toBeTruthy();
    expect(screen.queryByTestId('controlled-turnstile-webview')).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onToken).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('builds a locked-down challenge document and hardened WebView configuration', async () => {
    const view = await render(
      <CaptchaChallenge label="Human verification" onError={jest.fn()} onToken={jest.fn()} />,
    );
    expect(screen.getByTestId('controlled-turnstile-webview')).toBeTruthy();
    const props = webViewProps();
    expect(props).toMatchObject({
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      cacheEnabled: false,
      cacheMode: 'LOAD_NO_CACHE',
      domStorageEnabled: true,
      incognito: true,
      javaScriptEnabled: true,
      javaScriptCanOpenWindowsAutomatically: false,
      mixedContentMode: 'never',
      setSupportMultipleWindows: false,
      sharedCookiesEnabled: false,
      thirdPartyCookiesEnabled: true,
    });
    expect(props.originWhitelist).toEqual([
      'https://auth.example.test',
      'https://challenges.cloudflare.com',
      'about:blank',
      'about:srcdoc',
    ]);
    expect(props.source.baseUrl).toBe('https://auth.example.test');
    expect(props.source.html).toContain("default-src 'none'");
    expect(props.source.html).toContain('sitekey:"controlled-turnstile-site-key"');
    expect(props.source.html).toContain('nonce-nonce_ABC-123unsafescript');
    expect(props.source.html).toContain('nonce:"nonce_ABC-123!unsafe<script>"');
    expect(props.source.html).toContain("action:'workplace_sign_in'");
    await view.unmount();
  });

  test('permits navigation only to the configured origin, Cloudflare, and inert documents', async () => {
    const view = await render(
      <CaptchaChallenge label="Human verification" onError={jest.fn()} onToken={jest.fn()} />,
    );
    const allow = webViewProps().onShouldStartLoadWithRequest;
    expect(allow({ url: 'about:blank' })).toBe(true);
    expect(allow({ url: 'about:srcdoc' })).toBe(true);
    expect(allow({ url: 'https://auth.example.test/turnstile' })).toBe(true);
    expect(allow({ url: 'https://challenges.cloudflare.com/cdn-cgi/challenge' })).toBe(true);
    expect(allow({ url: 'https://auth.example.test.attacker.invalid/turnstile' })).toBe(false);
    expect(allow({ url: 'javascript:alert(1)' })).toBe(false);
    expect(allow({ url: 'not a valid URL' })).toBe(false);
    await view.unmount();
  });

  test('rejects messages from unauthorized origins and malformed envelopes', async () => {
    const onError = jest.fn();
    const onToken = jest.fn();
    const view = await render(
      <CaptchaChallenge label="Human verification" onError={onError} onToken={onToken} />,
    );
    message({ nonce, type: 'token', value: validToken }, 'https://attacker.invalid');
    expect(onToken).toHaveBeenLastCalledWith(null);
    expect(onError).toHaveBeenCalledTimes(1);

    message('{not-json');
    expect(onError).toHaveBeenCalledTimes(2);
    message(null);
    message('plain string');
    message({ nonce: 'wrong-nonce', type: 'token', value: validToken });
    message({ type: 'token', value: validToken });
    expect(onToken).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  test('accepts only a bounded non-whitespace token tied to the document nonce', async () => {
    const onError = jest.fn();
    const onToken = jest.fn();
    const view = await render(
      <CaptchaChallenge label="Human verification" onError={onError} onToken={onToken} />,
    );
    message({ nonce, type: 'token', value: validToken });
    expect(onToken).toHaveBeenLastCalledWith(validToken);

    for (const invalidValue of [
      'too-short',
      'contains whitespace 1234567890',
      'x'.repeat(4097),
      42,
    ]) {
      message({ nonce, type: 'token', value: invalidValue });
    }
    message({ nonce, type: 'unknown', value: validToken });
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('clears expired and failed tokens and forwards native WebView process failures', async () => {
    const onError = jest.fn();
    const onToken = jest.fn();
    const view = await render(
      <CaptchaChallenge label="Human verification" onError={onError} onToken={onToken} />,
    );
    message({ nonce, type: 'expired', value: '' });
    message({ nonce, type: 'error', value: 'challenge' });
    expect(onToken).toHaveBeenNthCalledWith(1, null);
    expect(onToken).toHaveBeenNthCalledWith(2, null);
    expect(onError).toHaveBeenCalledTimes(1);

    webViewProps().onError();
    webViewProps().onHttpError();
    webViewProps().onContentProcessDidTerminate();
    expect(onError).toHaveBeenCalledTimes(4);
    await view.unmount();
  });
});
