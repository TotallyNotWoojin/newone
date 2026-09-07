import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

import { darkColors, lightColors } from '@/theme/palette';

// Expo inlines experiments.baseUrl here at export time, so the shell's fixed
// assets resolve when the app is hosted under a path such as /app.
const base = process.env.EXPO_BASE_URL ?? '';

export default function RootDocument({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta content="width=device-width, initial-scale=1, viewport-fit=cover" name="viewport" />
        {/* Replaced at runtime by useSystemChrome once the stored override is known. */}
        <meta content={lightColors.canvas} name="theme-color" />
        <meta content="no-referrer" name="referrer" />
        <meta content="Newone" name="application-name" />
        <meta
          content="Private, multilingual workplace messaging, updates, and shift coordination."
          name="description"
        />
        <meta content="yes" name="mobile-web-app-capable" />
        <meta content="yes" name="apple-mobile-web-app-capable" />
        <meta content="Newone" name="apple-mobile-web-app-title" />
        <meta content="black-translucent" name="apple-mobile-web-app-status-bar-style" />
        <link href={`${base}/manifest.json`} rel="manifest" />
        <link href={`${base}/newone-icon.svg`} rel="icon" type="image/svg+xml" />
        <link href={`${base}/newone-icon-192.png`} rel="apple-touch-icon" sizes="192x192" />
        <script defer src={`${base}/register-service-worker.js`} />
        <ScrollViewStyleReset />
        {/* The document is painted from the phone's appearance before any
            JavaScript runs, so the launch is not a white flash on a dark
            phone. useSystemChrome takes over once the app has mounted. */}
        <style
          dangerouslySetInnerHTML={{
            __html: [
              `html{color-scheme:light dark;background-color:${lightColors.canvas};}`,
              'body{background-color:inherit;}',
              '@media (prefers-color-scheme: dark){',
              `html{background-color:${darkColors.canvas};}`,
              '}',
            ].join(''),
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
