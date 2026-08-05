# Newone universal client

Expo Router SDK 57 application for iOS, Android, and responsive web.

## Commands

```bash
npm install
npm run web
npm run ios
npm run android
npm run check
```

Demo fixtures are never inferred from missing configuration. They load only when an operator sets the exact opt-in flag below. Use that flag only for an isolated local development process:

```bash
EXPO_PUBLIC_DEMO_MODE=true npm run web
```

With demo mode off, the client uses the configured Newone BFF/Supabase contracts or fails closed when required routing is absent. The source-level flag can be enabled in an arbitrary custom build, so release controls must enforce it as false; every checked EAS profile does. See the repository root documentation for the development deployment boundary, architecture, security gates, and release status.
