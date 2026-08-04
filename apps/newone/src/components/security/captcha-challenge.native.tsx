import { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';

import { publicRuntimeConfig } from '@/config/runtime';
import { createClientId } from '@/lib/client-id';

function allowedUrl(value: string, configuredOrigin: string) {
  if (value === 'about:blank' || value === 'about:srcdoc') return true;
  try {
    const url = new URL(value);
    return url.origin === configuredOrigin || url.origin === 'https://challenges.cloudflare.com';
  } catch {
    return false;
  }
}

export function CaptchaChallenge({
  label,
  onError,
  onToken,
}: {
  label: string;
  onError: () => void;
  onToken: (token: string | null) => void;
}) {
  const siteKey = publicRuntimeConfig.turnstileSiteKey;
  const challengeOrigin = publicRuntimeConfig.turnstileChallengeOrigin;
  const nonce = useMemo(() => createClientId(), []);
  const html = useMemo(() => {
    if (!siteKey || !challengeOrigin) return '';
    const messageNonce = JSON.stringify(nonce);
    const publicSiteKey = JSON.stringify(siteKey);
    const cspNonce = nonce.replace(/[^A-Za-z0-9_-]/g, '');
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'nonce-${cspNonce}' https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src https://challenges.cloudflare.com data:; style-src 'nonce-${cspNonce}';"><style nonce="${cspNonce}">html,body{margin:0;background:transparent;min-height:65px;display:flex;align-items:center;justify-content:center}</style><script nonce="${cspNonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script></head><body><div id="challenge"></div><script nonce="${cspNonce}">const send=(type,value)=>window.ReactNativeWebView.postMessage(JSON.stringify({nonce:${messageNonce},type,value}));window.onload=()=>{if(!window.turnstile){send('error','load');return;}window.turnstile.render('#challenge',{sitekey:${publicSiteKey},action:'workplace_sign_in',theme:'light',callback:(token)=>send('token',token),'expired-callback':()=>send('expired',''),'error-callback':()=>send('error','challenge')});};</script></body></html>`;
  }, [challengeOrigin, nonce, siteKey]);

  useEffect(() => {
    if (!siteKey || !challengeOrigin) onError();
  }, [challengeOrigin, onError, siteKey]);

  if (!siteKey || !challengeOrigin) return <View accessibilityLabel={label} style={styles.unavailable} />;

  const receive = (event: WebViewMessageEvent) => {
    if (!allowedUrl(event.nativeEvent.url, challengeOrigin)) {
      onToken(null);
      onError();
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(event.nativeEvent.data);
    } catch {
      onError();
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    const message = payload as { nonce?: unknown; type?: unknown; value?: unknown };
    if (message.nonce !== nonce) return;
    if (message.type === 'token' && typeof message.value === 'string' && message.value.length >= 20 && message.value.length <= 4096 && !/\s/.test(message.value)) {
      onToken(message.value);
    } else if (message.type === 'expired') {
      onToken(null);
    } else if (message.type === 'error') {
      onToken(null);
      onError();
    }
  };
  const allowNavigation = (request: WebViewNavigation) => allowedUrl(request.url, challengeOrigin);

  return (
    <View accessibilityLabel={label} accessibilityRole="none" style={styles.frame}>
      <WebView
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        cacheEnabled={false}
        cacheMode="LOAD_NO_CACHE"
        domStorageEnabled
        incognito
        javaScriptEnabled
        javaScriptCanOpenWindowsAutomatically={false}
        mixedContentMode="never"
        onContentProcessDidTerminate={onError}
        onError={onError}
        onHttpError={onError}
        onMessage={receive}
        onShouldStartLoadWithRequest={allowNavigation}
        originWhitelist={[challengeOrigin, 'https://challenges.cloudflare.com', 'about:blank', 'about:srcdoc']}
        setSupportMultipleWindows={false}
        sharedCookiesEnabled={false}
        source={{ html, baseUrl: challengeOrigin }}
        style={styles.webview}
        thirdPartyCookiesEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { width: '100%', minHeight: 74, overflow: 'hidden' },
  webview: { width: '100%', height: 74, backgroundColor: 'transparent' },
  unavailable: { width: '100%', minHeight: 1 },
});
