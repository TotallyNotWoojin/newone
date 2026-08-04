# Newone

Newone is an independent, company-owned workplace messenger for multilingual frontline teams. It combines a WhatsApp-familiar inbox with verified company identity, private DMs, groups, official updates, shift handoffs, acknowledgements, and Korean-Spanish translation.

This repository now contains a new universal Expo application for iOS, Android, and web plus a Supabase backend foundation. It does not use ChatGPT identity, ChatGPT hosting, or ChatGPT Pro for runtime inference.

## Current state

| Area | Status |
|---|---|
| Universal Expo client | Implemented local UI foundation; web export, lint, and typecheck pass |
| Chats | Local demo UI: mixed DM/group inbox, filters, search, simulated message state, replies, reactions, attachment presentation, translation/original presentation, and responsive conversation views |
| People | Local demo UI: synthetic company directory, profile fields, connection state, and language/site/team context |
| Updates | Local in-memory demo interaction: targeted update presentation and acknowledgement distinct from read state |
| Handoffs | Static local demo surface for source-aware drafts, outgoing sign-off, and incoming acknowledgement; workflow actions are not backend-wired |
| Admin/security | Static local demo surfaces for identity, devices, groups, retention, audit, and launch gates; controls are not backend-wired |
| Authentication | The `newone` Supabase project is configured locally for the native client and responds successfully; invite-only Auth hardening and the production web BFF are not deployed |
| Database | Local Supabase foundation with forced RLS, checked mutation RPCs, and 74 passing pgTAP tests; the migration has not been pushed to the remote `newone` project |
| Realtime/API/attachments/push | Minimal private-Realtime and attachment authorization primitives exist; BFF, workers, scanning, notification delivery, and end-to-end adversarial verification remain incomplete |
| OpenRouter translation | Production adapter is not enabled in the new app; legal approval, DPA, provider controls, and quality evaluation remain hard gates |
| Production deployment | Not performed; the old private Sites build is a legacy prototype, not Newone V2 |

The Chats, People, Updates, Handoffs, and Admin rows describe UX rendered from in-memory synthetic fixtures. They are not claims that the corresponding production APIs, authorization, persistence, delivery, scanning, notification, or audit workflows are operational. Do not enter real employee information until every launch gate in [SECURITY_ARCHITECTURE_V2.md](docs/SECURITY_ARCHITECTURE_V2.md) passes.

## Run the new app

Requirements: Node.js 22.13 or newer.

```bash
npm --prefix apps/newone install
npm run web
```

For native development:

```bash
npm run ios
npm run android
```

The application source is in [`apps/newone`](apps/newone). The same Expo Router codebase renders the responsive web client and native iOS/Android clients.

## Verify

```bash
npm run lint
npm run typecheck
npm run build
npm run backend:reset
npm run backend:test
npm run backend:lint
```

Or run all three client checks:

```bash
npm test
```

## Configure the backend

Copy the public client configuration only:

```bash
cp apps/newone/.env.example apps/newone/.env.local
```

Never place a Supabase secret/service-role key, OpenRouter key, APNs key, FCM credential, or database credential in `EXPO_PUBLIC_*`. Production web authentication is designed to terminate at the Newone API/BFF with an HttpOnly cookie; native refresh tokens use OS secure storage.

The ignored local environment now points the native client at the remote `newone` Supabase project. The publishable client key is intentionally public; secret/service-role credentials must remain server-side. The database migration and production Auth configuration have not been pushed, because the project must first be designated as disposable development/pilot or production.

## Product and security specifications

- [WhatsApp and workplace research](docs/RESEARCH_WHATSAPP_AND_WORKPLACE.md)
- [Full product requirements](docs/FULL_PRODUCT_REQUIREMENTS.md)
- [Platform architecture](docs/PLATFORM_ARCHITECTURE_V2.md)
- [Security architecture and threat model](docs/SECURITY_ARCHITECTURE_V2.md)

The original contract traceability, model evaluation, and privacy notes remain in `docs/` for source history. The single-channel Vinext/D1 ChatGPT Sites runtime has been removed from the active source tree; Git history preserves it if forensic comparison is ever needed. The legacy Sites preview is owner-only, has no external visitors, and is visibly marked decommissioned. The available Sites integration cannot permanently delete the project, so its owner-only URL still exists; it is not Newone V2 and must not be presented as the current product.
