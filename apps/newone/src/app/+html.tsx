import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

// Expo inlines experiments.baseUrl here at export time, so the shell's fixed
// assets resolve when the app is hosted under a path such as /app.
const base = process.env.EXPO_BASE_URL ?? '';

export default function RootDocument({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta content="width=device-width, initial-scale=1, viewport-fit=cover" name="viewport" />
        <meta content="#102E27" name="theme-color" />
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
      </head>
      <body>{children}</body>
    </html>
  );
}
