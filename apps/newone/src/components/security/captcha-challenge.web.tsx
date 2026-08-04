import { createElement, useEffect, useState } from 'react';

import { publicRuntimeConfig } from '@/config/runtime';

interface TurnstileApi {
  render(container: HTMLElement, options: {
    sitekey: string;
    action: string;
    callback: (token: string) => void;
    'error-callback': () => void;
    'expired-callback': () => void;
    theme: 'light';
  }): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const scriptId = 'newone-turnstile-script';

export function CaptchaChallenge({
  label,
  onError,
  onToken,
}: {
  label: string;
  onError: () => void;
  onToken: (token: string | null) => void;
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const siteKey = publicRuntimeConfig.turnstileSiteKey;
    if (!siteKey) {
      onError();
      return;
    }
    let active = true;
    let widgetId = '';
    const render = () => {
      if (!active || !container || !window.turnstile || widgetId) return;
      widgetId = window.turnstile.render(container, {
        sitekey: siteKey,
        action: 'workplace_sign_in',
        callback: (token) => onToken(token),
        'error-callback': () => {
          onToken(null);
          onError();
        },
        'expired-callback': () => onToken(null),
        theme: 'light',
      });
    };
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (window.turnstile) {
      render();
    } else if (existing) {
      existing.addEventListener('load', render);
    } else {
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.addEventListener('load', render);
      script.addEventListener('error', onError);
      document.head.appendChild(script);
    }
    return () => {
      active = false;
      existing?.removeEventListener('load', render);
      if (widgetId) window.turnstile?.remove(widgetId);
      onToken(null);
    };
  }, [container, onError, onToken]);

  return createElement('div', {
    ref: setContainer,
    role: 'group',
    'aria-label': label,
    style: { minHeight: 65, width: '100%' },
  });
}
