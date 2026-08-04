# Third-party components and services

Status: source and release inventory
Last updated: August 3, 2026

This document identifies material third-party software and hosted services used or anticipated by Newone. It is an engineering inventory, not legal advice. The Company must approve contracts, data-processing terms, subprocessors, regions, licenses, retention, and recurring charges before live employee data is enabled.

The exhaustive JavaScript dependency graph and integrity hashes are pinned in [`package-lock.json`](../package-lock.json) and [`apps/newone/package-lock.json`](../apps/newone/package-lock.json). The server-side Deno graph is pinned in [`supabase/functions/deno.lock`](../supabase/functions/deno.lock). `npm run supply-chain:evidence` generates separate CycloneDX documents for release tooling, the universal client, and Edge Functions plus a combined license/integrity inventory and a machine-readable license-policy report. The policy blocks prohibited production licenses and separately identifies attribution, weak-copyleft, or unclassified expressions for owner/legal review. Those lockfiles, the release commit, and generated reports are the authoritative transitive inventory for a release; this summary lists direct and operationally material components.

## Included runtime libraries

| Component | Resolved/declaration | License | Purpose |
|---|---:|---|---|
| Expo | 57.0.9 package / 57.0.11 CLI | MIT | Universal iOS, Android, and web runtime/build framework |
| React | 19.2.3 | MIT | Component runtime |
| React DOM | 19.2.3 | MIT | Web renderer |
| React Native | 0.86.2 | MIT | Native UI/runtime |
| React Native Web | 0.21.2 | MIT | Web implementation of React Native primitives |
| Expo Router | 57.0.9 | MIT | File-based universal navigation and deep links |
| Supabase JavaScript | 2.110.9 | MIT | Auth, Realtime, Storage, and API client; also the sole direct Deno runtime import |
| Zod | 4.4.3 | MIT | Runtime command and model-output validation |
| React Native Gesture Handler | 2.32.0 | MIT | Native gestures |
| React Native Reanimated | 4.5.1 | MIT | UI animation/runtime worklets |
| React Native Worklets | 0.10.1 | MIT | Reanimated/worklet runtime |
| React Native Screens | 4.26.2 | MIT | Native screen/navigation primitives |
| React Native Safe Area Context | 5.7.0 | MIT | Device safe-area handling |
| React Native WebView | 13.16.1 | MIT | Native Turnstile challenge host; not a general browser surface |
| React Native URL Polyfill | 4.0.0 | MIT | URL APIs on native platforms |
| Expo Vector Icons | 15.1.1 resolved (`^15.0.2` declared) | MIT; bundled font licenses also apply | Application iconography |

## Expo modules included directly

All modules below are resolved at Expo SDK 57-compatible versions and are MIT licensed in the installed packages. Exact versions and hashes remain in the application lockfile.

| Module | Version | Purpose |
|---|---:|---|
| `@expo/ui` | 57.0.8 | Platform-adaptive UI primitives |
| `expo-asset` | 57.0.8 | Bundled/static assets |
| `expo-clipboard` | 57.0.1 | User-invoked copy action |
| `expo-constants` | 57.0.8 | Build/runtime configuration |
| `expo-crypto` | 57.0.1 | Client cryptographic primitives and random IDs |
| `expo-dev-client` | 57.0.10 | Development builds only |
| `expo-device` | 57.0.1 | Device/session metadata |
| `expo-document-picker` | 57.0.1 | User-selected document attachments |
| `expo-font` | 57.0.1 | Font loading |
| `expo-glass-effect` | 57.0.1 | Optional native visual treatment |
| `expo-image` | 57.0.1 | Image rendering/cache control |
| `expo-image-manipulator` | 57.0.7 | Bandwidth-aware image processing |
| `expo-image-picker` | 57.0.7 | Camera/gallery attachments |
| `expo-linking` | 57.0.4 | Auth and notification deep links |
| `expo-notifications` | 57.0.8 | Push token and notification client |
| `expo-secure-store` | 57.0.1 | Native refresh credential/device-secret storage |
| `expo-splash-screen` | 57.0.5 | Native launch screen |
| `expo-sqlite` | 57.0.1 | Native durable local/outbox storage |
| `expo-status-bar` | 57.0.1 | Native system status bar |
| `expo-symbols` | 57.0.1 | Native symbol rendering |
| `expo-system-ui` | 57.0.2 | Native system UI configuration |
| `expo-web-browser` | 57.0.2 | Restricted external/system browser handoff |

## Development and verification tooling

| Component | Version | License | Purpose / production inclusion |
|---|---:|---|---|
| TypeScript | 6.0.3 | Apache-2.0 | Static checking; not a production service |
| ESLint / Expo config | lockfile-pinned | MIT | Source linting; not a production service |
| Playwright Test | 1.62.1 | Apache-2.0 | Browser/E2E testing; not shipped in the app |
| axe-core Playwright | 4.12.1 | MPL-2.0 | Automated accessibility checks; not shipped in the app |
| Deno | validated locally with 2.9.1 | MIT | Edge Function check/test/runtime tool; hosted runtime version is provider-controlled |
| Supabase CLI | validated locally with 2.109.0 | MIT | Local stack, migration, test, deploy, and advisory tooling |
| Node.js / npm | release and CI target Node 22.13.0; this local shell currently reports Node 22.11.0 and npm 11.6.2 | project-specific open-source licenses | Builds, scripts, BFF tests, and web tooling; `.nvmrc`, `.node-version`, package engines, and CI pin the release baseline, so this local version mismatch must be corrected or transparently recorded before final evidence |

## Hosted services and processors

| Service | Data/purpose | Current repository state | Live-data gate / cost owner |
|---|---|---|---|
| Supabase | Postgres, Auth, Realtime, private Storage, Edge Functions | Local implementation linked to a healthy Free development project; remote schema/functions are not evidence of production readiness until deployment and smoke proof are recorded | Company selects paid production/staging topology, backup/PITR/object restore path, regions, SMTP/Auth policy, quotas, DPA, and billing |
| Vercel | Same-origin web hosting and `/v2` BFF proxy | Gateway and security headers are source-controlled; no production deployment/account/domain is claimed | Company controls account, domain, region/options, logs, firewall/bot controls, and billing |
| OpenRouter | Optional server-only language detection, Korean–Spanish translation, and authorized summary generation | Exact model/provider route is policy-pinned; employee-data egress defaults off; a synthetic test key does not constitute live-data approval | Company approves DPA/subprocessors/region/use cases/budget and the per-organization kill switch; usage is token-billed separately from ChatGPT Pro |
| Qwen model through Google Vertex via OpenRouter | Structured translation/detection/summary inference | Policy currently pins `qwen/qwen3-235b-a22b-2507` to `google-vertex/us-south1`, ZDR/data-denial/fallback-off | Same AI approval plus bilingual quality gate; route drift fails closed |
| Cloudflare Turnstile | Bot/CAPTCHA challenge token and limited security/network signals | Web and native challenge adapters/CSP are implemented; production site/secret keys are not committed | Company provisions site/secret keys, allowed origins/hostnames, privacy notice, and account |
| Expo Application Services / Apple / Google | Native signing, builds, store distribution, app links, push credentials | Universal project source exists; no store account, signing identity, production binary, or review approval is claimed | Company owns Apple/Google/Expo accounts, legal/store listings, signing, entitlements, fees, and review timing |
| Expo Push Service and APNs/FCM | Opaque device push tokens and minimal notification routing metadata | Client/worker contracts are implemented or tested locally as release work; production credentials and delivery evidence remain environment gates | Company selects/configures push path, retention/privacy policy, credentials, quotas, and incident owner |
| SMTP or Supabase Send Email Auth Hook | Invitation, OTP, recovery, and security email | Local mailbox/template tests are available; production custom SMTP/hook is not configured | Required before arbitrary employee email enrollment on the linked Free project; Company chooses provider/domain/DKIM/DMARC, credentials, DPA, and fees |
| Malware/content scanner | Quarantined attachment validation before clean promotion | Fail-closed scan worker contract exists; no production scanner vendor/credential is claimed | Company selects provider or isolated scanner, signatures/update SLA, region, limits, DPA, failure policy, and cost |
| SMS provider | Optional identity verification and policy-controlled critical-notice fallback | Provider-neutral requirement/API boundary only; no production SMS provider is selected | Company chooses provider, sender registration, consent/compliance, regions, templates, limits, escalation policy, and per-message fees |

## Data-flow boundaries

- Public clients receive only intentionally public configuration such as a Supabase publishable key, service origin, and Turnstile site key. Service-role/secret keys, model keys, push credentials, scanner credentials, SMTP/SMS credentials, database passwords, and signing keys remain server-side.
- OpenRouter receives message/source content only when the organization-level AI-egress approval is enabled and the exact route policy passes. The original messaging path does not depend on AI.
- Turnstile challenge tokens are exchanged for bot verification; they are not identity credentials and do not replace Auth, membership checks, MFA, rate limits, or authorization.
- Push notifications use opaque resource identifiers and minimal preview data. Opening a notification performs ordinary authentication and authorization.
- Attachments remain quarantined and unavailable until the configured scanner records an acceptable result. A missing or failed scanner never promotes an object to clean.

## Release inventory procedure

For every release candidate:

1. Run clean installs from both lockfiles and reject unexplained lock drift.
2. Generate SBOMs, the resolved license inventory, and the license-policy report; archive them with the release commit and build IDs. A zero-denied result is automated evidence, while every `reviewRequired` entry still needs the named release approver before production distribution.
3. Run production dependency and vulnerability audits, document reviewed exceptions with owner/expiry, and fail on unresolved Critical/High issues.
4. Record all hosted service versions/configurations that are externally controlled, their environment/region, data categories, DPA/subprocessor approval, credential owner, renewal/budget owner, and kill switch.
5. Verify public client bundles and source maps contain no server credential.
6. Reconcile this document, package manifests, Deno imports, native build manifests, and deployed service inventory. A dependency present only in source documentation is not evidence that it is deployed; a deployed undeclared component blocks release.
7. Preserve third-party license notices required by the resolved packages and store-distributed native artifacts.

## Not included or claimed

- ChatGPT, a ChatGPT app, ChatGPT identity, ChatGPT hosting, and a ChatGPT Pro subscription are not Newone runtime components.
- WhatsApp code, APIs, accounts, contacts, or message data are not included; WhatsApp only informed interaction research.
- No custom end-to-end encryption protocol is claimed. Transport and at-rest protections are platform/provider controls, while authorized server processing remains possible by design.
- Provider availability, app-store approval, legal interpretation, bilingual safety approval, backup/PITR, SMTP deliverability, phone/SMS registration, and production security review cannot be created solely by committing source code.
