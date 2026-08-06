# Newone

Newone is an independent, company-owned workplace messenger for multilingual frontline teams. It combines a WhatsApp-familiar inbox with verified company identity, private DMs, groups, official updates, shift handoffs, acknowledgements, and Korean-Spanish translation.

This repository contains an integrated universal Expo application for iOS, Android, and web, 34 ordered Supabase migrations, and nine versioned Edge Function source packages. It does not use ChatGPT identity, ChatGPT hosting, or ChatGPT Pro for runtime inference.

## Current state

| Area | Status |
|---|---|
| Universal Expo client | Integrated responsive web/iOS/Android source with bounded BFF read and command repositories; no bundled alternate data repository or runtime switch can substitute fictional client data for the configured backend |
| Employee workflows | Chats, People, Updates, Handoffs, Search, settings, offline reconciliation, and scoped administration are backend-wired in source; real hosted simulations, signed-device acceptance, and a retained report showing greater than 90% measured coverage remain open release gates |
| Database | 34 ordered migrations implement forced RLS, checked RPCs, lifecycle authorization, retention, audit, moderation, dynamic groups, and supporting integrity controls; the linked development project is in migration parity |
| Edge Functions | Nine versioned function packages exist in source. Four fail-closed base functions are deployed to development: `newone-api`, `newone-read`, `newone-outbox-worker`, and `newone-maintenance-worker` |
| Authentication | The hosted custom access-token hook and session hardening are enabled in development. `newone-auth` remains withheld until a real web domain, Turnstile, and custom SMTP are configured and verified |
| Optional processors | AI, attachment-scanner, push-receipt, and bootstrap functions remain withheld from development; push dispatch is disabled. Employee AI egress is explicitly disabled |
| Network and delivery | PostgreSQL SSL enforcement is enabled. Database IP restrictions remain open until stable developer/CI egress ranges exist. `https://dev.newone.invalid` is a reserved non-routable Auth origin, not a web deployment |
| Production release | Not performed or claimed; production accounts, domain/TLS, provider credentials, signed binaries, independent review, restore evidence, and owner approvals remain open |

Implemented source and a fail-closed development deployment are not production acceptance. Development remains synthetic-only, withheld functions are not operational services, and the reserved `.invalid` origin is intentionally unusable by employees. Do not enter real employee information until every launch gate in [SECURITY_ARCHITECTURE_V2.md](docs/SECURITY_ARCHITECTURE_V2.md) passes.

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
npm ci
npm ci --prefix apps/newone
npm test
```

`npm test` checks Expo dependency alignment, lint, TypeScript, deterministic web/iOS/Android exports, the web artifact contract, and the root Node contract suite. A complete local chain additionally requires Docker and the pinned Supabase CLI:

```bash
npm run backend:start
npm run verify:full
npm run backend:stop
```

`npm run build` is a hosted-release check and intentionally fails without the complete release environment. It is not the ordinary unconfigured local-build command.

## Configure the backend

Copy the public client configuration only:

```bash
cp apps/newone/.env.example apps/newone/.env.local
```

Never place a Supabase secret/service-role key, OpenRouter key, APNs key, FCM credential, or database credential in `EXPO_PUBLIC_*`. Production web authentication is designed to terminate at the Newone API/BFF with an HttpOnly cookie; native refresh tokens use OS secure storage.

The linked Supabase project is development-only. Its 34 migrations are in parity, PostgreSQL SSL enforcement is enabled, and four base Edge Functions are deployed fail-closed for synthetic integration work. Database IP restrictions still require stable developer/CI egress ranges. Hosted browser Auth remains intentionally incomplete: `https://dev.newone.invalid` reserves the Auth origin while `newone-auth`, Turnstile, custom SMTP, and a real company web domain are withheld. The publishable client key is intentionally public; secret/service-role credentials must remain server-side.

## Product and security specifications

- [WhatsApp and workplace research](docs/RESEARCH_WHATSAPP_AND_WORKPLACE.md)
- [Full product requirements](docs/FULL_PRODUCT_REQUIREMENTS.md)
- [Platform architecture](docs/PLATFORM_ARCHITECTURE_V2.md)
- [Security architecture and threat model](docs/SECURITY_ARCHITECTURE_V2.md)

The original contract traceability, model evaluation, and privacy notes remain in `docs/` for source history. The single-channel Vinext/D1 ChatGPT Sites runtime and deployment path have been removed from the active source tree; Git history preserves them if forensic comparison is ever needed. Any separately hosted legacy preview is external deployment state, not Newone V2 or evidence of this repository's current release status.
