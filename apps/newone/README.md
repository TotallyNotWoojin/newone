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

The client always uses the configured Newone BFF/Supabase contracts and fails closed when required routing is absent. It has no bundled fictional-data repository or runtime switch for an alternate client-side data path.

Workflow testing and training must use approved synthetic accounts in an isolated hosted development or staging backend. A local static export may verify only unauthenticated rendering; it is not hosted workflow or acceptance evidence. See the repository root documentation for the development deployment boundary, architecture, security gates, and release status.
