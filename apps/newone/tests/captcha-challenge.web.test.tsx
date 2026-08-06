import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { ReactTestRenderer } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';

import { CaptchaChallenge } from '@/components/security/captcha-challenge.web';

const mockRuntimeConfig = {
  turnstileSiteKey: 'controlled-turnstile-site-key',
};

jest.mock('@/config/runtime', () => ({
  get publicRuntimeConfig() {
    return mockRuntimeConfig;
  },
}));

type ControlledScript = {
  addEventListener: jest.MockedFunction<(type: string, listener: () => void) => void>;
  async: boolean;
  defer: boolean;
  id: string;
  invoke: (type: 'error' | 'load') => void;
  listeners: Map<string, Set<() => void>>;
  removeEventListener: jest.MockedFunction<(type: string, listener: () => void) => void>;
  src: string;
};

const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const mockContainer = { id: 'controlled-turnstile-container' } as unknown as HTMLDivElement;
const mockAppendChild = jest.fn<(script: ControlledScript) => ControlledScript>();
const mockCreateElement = jest.fn();
const mockGetElementById = jest.fn();
const mockTurnstileRender = jest.fn();
const mockTurnstileRemove = jest.fn();
let mockScriptInDocument: ControlledScript | null = null;

function controlledScript(): ControlledScript {
  const listeners = new Map<string, Set<() => void>>();
  const script: ControlledScript = {
    addEventListener: jest.fn((type: string, listener: () => void) => {
      const typeListeners = listeners.get(type) ?? new Set<() => void>();
      typeListeners.add(listener);
      listeners.set(type, typeListeners);
    }),
    async: false,
    defer: false,
    id: '',
    invoke: (type) => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    listeners,
    removeEventListener: jest.fn((type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    }),
    src: '',
  };
  return script;
}

function installDom(turnstileAvailable: boolean) {
  const controlledWindow = {
    turnstile: turnstileAvailable
      ? { render: mockTurnstileRender, remove: mockTurnstileRemove }
      : undefined,
  };
  const controlledDocument = {
    createElement: mockCreateElement,
    getElementById: mockGetElementById,
    head: { appendChild: mockAppendChild },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: controlledWindow,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: controlledDocument,
  });
  return controlledWindow;
}

async function mountChallenge(onError = jest.fn(), onToken = jest.fn()) {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <CaptchaChallenge label="Human verification" onError={onError} onToken={onToken} />,
      {
        createNodeMock: (element) => element.type === 'div' ? mockContainer : null,
      },
    );
  });
  if (!renderer) throw new Error('Captcha challenge did not mount.');
  return renderer;
}

beforeEach(() => {
  mockRuntimeConfig.turnstileSiteKey = 'controlled-turnstile-site-key';
  mockScriptInDocument = null;
  mockGetElementById.mockImplementation(() => mockScriptInDocument);
  mockCreateElement.mockImplementation(() => controlledScript());
  mockAppendChild.mockImplementation((script: ControlledScript) => {
    mockScriptInDocument = script;
    return script;
  });
  mockTurnstileRender.mockImplementation(() => 'controlled-widget-id');
  mockTurnstileRemove.mockImplementation(() => undefined);
});

afterEach(() => {
  if (originalDocumentDescriptor) {
    Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'document');
  }
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

describe('web Turnstile challenge boundary', () => {
  test('fails closed when the public site key is unavailable', async () => {
    installDom(false);
    mockRuntimeConfig.turnstileSiteKey = '';
    const onError = jest.fn();
    const onToken = jest.fn();
    const renderer = await mountChallenge(onError, onToken);
    expect(onError).toHaveBeenCalled();
    expect(mockCreateElement).not.toHaveBeenCalled();
    expect(mockTurnstileRender).not.toHaveBeenCalled();
    const host = renderer.root.findByType('div');
    expect(host.props).toMatchObject({
      role: 'group',
      'aria-label': 'Human verification',
      style: { minHeight: 65, width: '100%' },
    });
    await act(async () => renderer.unmount());
  });

  test('renders through a preloaded Turnstile API and forwards all challenge outcomes', async () => {
    installDom(true);
    const onError = jest.fn();
    const onToken = jest.fn();
    const renderer = await mountChallenge(onError, onToken);
    expect(mockTurnstileRender).toHaveBeenCalledTimes(1);
    const [container, options] = mockTurnstileRender.mock.calls[0] as [
      HTMLDivElement,
      {
        sitekey: string;
        action: string;
        callback: (token: string) => void;
        'error-callback': () => void;
        'expired-callback': () => void;
        theme: string;
      },
    ];
    expect(container).toBe(mockContainer);
    expect(options).toMatchObject({
      sitekey: 'controlled-turnstile-site-key',
      action: 'workplace_sign_in',
      theme: 'light',
    });
    onToken.mockClear();
    options.callback('controlled-token-1234567890');
    options['expired-callback']();
    options['error-callback']();
    expect(onToken).toHaveBeenNthCalledWith(1, 'controlled-token-1234567890');
    expect(onToken).toHaveBeenNthCalledWith(2, null);
    expect(onToken).toHaveBeenNthCalledWith(3, null);
    expect(onError).toHaveBeenCalledTimes(1);

    await act(async () => renderer.unmount());
    expect(mockTurnstileRemove).toHaveBeenCalledWith('controlled-widget-id');
    expect(onToken).toHaveBeenLastCalledWith(null);
  });

  test('subscribes to an existing loader once and ignores its callback after teardown', async () => {
    const controlledWindow = installDom(false);
    const existing = controlledScript();
    existing.id = 'newone-turnstile-script';
    mockScriptInDocument = existing;
    const onToken = jest.fn();
    const renderer = await mountChallenge(jest.fn(), onToken);
    expect(existing.addEventListener).toHaveBeenCalledWith('load', expect.any(Function));
    controlledWindow.turnstile = {
      render: mockTurnstileRender,
      remove: mockTurnstileRemove,
    };
    existing.invoke('load');
    existing.invoke('load');
    expect(mockTurnstileRender).toHaveBeenCalledTimes(1);

    await act(async () => renderer.unmount());
    expect(existing.removeEventListener).toHaveBeenCalledWith('load', expect.any(Function));
    const callsBeforeLateLoad = mockTurnstileRender.mock.calls.length;
    existing.invoke('load');
    expect(mockTurnstileRender).toHaveBeenCalledTimes(callsBeforeLateLoad);
    expect(onToken).toHaveBeenLastCalledWith(null);
  });

  test('creates the official loader with fixed attributes and handles script load and failure', async () => {
    const controlledWindow = installDom(false);
    const onError = jest.fn();
    const onToken = jest.fn();
    const renderer = await mountChallenge(onError, onToken);
    expect(mockCreateElement).toHaveBeenCalledWith('script');
    expect(mockAppendChild).toHaveBeenCalledTimes(1);
    const created = mockScriptInDocument;
    if (!created) throw new Error('The Turnstile loader was not appended.');
    expect(created).toMatchObject({
      id: 'newone-turnstile-script',
      src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
      async: true,
      defer: true,
    });
    created.invoke('error');
    expect(onError).toHaveBeenCalledTimes(1);

    created.invoke('load');
    expect(mockTurnstileRender).not.toHaveBeenCalled();
    controlledWindow.turnstile = {
      render: mockTurnstileRender,
      remove: mockTurnstileRemove,
    };
    created.invoke('load');
    created.invoke('load');
    expect(mockTurnstileRender).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
    expect(mockTurnstileRemove).toHaveBeenCalledWith('controlled-widget-id');
    expect(onToken).toHaveBeenLastCalledWith(null);
  });

  test('cleans up safely when the loader never exposes an API', async () => {
    installDom(false);
    const onToken = jest.fn();
    const renderer = await mountChallenge(jest.fn(), onToken);
    const created = mockScriptInDocument;
    if (!created) throw new Error('The Turnstile loader was not appended.');
    created.invoke('load');
    expect(mockTurnstileRender).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
    expect(mockTurnstileRemove).not.toHaveBeenCalled();
    expect(onToken).toHaveBeenLastCalledWith(null);
  });
});
