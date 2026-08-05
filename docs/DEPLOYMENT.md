# Deployment and environment runbook

This runbook covers the independent Newone Expo/Supabase product. It intentionally contains no ChatGPT Sites or D1 deployment path.

## Environment model

| Environment | Data | Purpose | Hosted plan |
|---|---|---|---|
| Local | Synthetic only | Development, migrations, pgTAP, function tests | Free local Docker |
| Development | Synthetic only | Shared-device, Auth, Realtime, Storage, and bounded integration testing | Current Free `newone` project; reserved origin `https://dev.newone.invalid` |
| Staging | Synthetic/deidentified | Release candidates, restore drills, load and adversarial tests | Persistent branch or isolated project before employee pilot |
| Production | Approved employee data | Live service | Separate paid project after launch gates pass |

Never reuse project references, API keys, Auth users, Storage objects, push tokens, model keys, or seed data across environments.

Current development snapshot, not a production release:

- all 34 repository migrations are in remote parity;
- PostgreSQL SSL enforcement is enabled and remained healthy after reboot;
- database IP restrictions remain open pending a stable developer/CI egress range;
- nine versioned Edge Functions exist in source, while only `newone-api`, `newone-read`, `newone-outbox-worker`, and `newone-maintenance-worker` are deployed to development and fail closed; recorded post-reboot Edge health/readiness probes remain HTTP 200;
- the custom access-token hook and hosted session hardening are enabled, but `newone-auth` is withheld until a real web domain, Turnstile, and custom SMTP are configured;
- bootstrap, AI, attachment-scan, and push-receipt functions are withheld, push dispatch is disabled, and employee AI data egress remains false; and
- `https://dev.newone.invalid` is a reserved non-routable Auth origin, not a deployed website or an acceptable employee redirect.

## 1. Local verification

Requirements: Node.js 22.13+, Docker, and Supabase CLI 2.109.0 or the repository-pinned replacement.

The latest preliminary Edge source check passed type checking and 194/194 Deno tests. It remains preliminary until rerun from an immutable release candidate with retained artifacts.

```bash
npm ci
npm ci --prefix apps/newone
supabase start
npm run verify:full
# Native source/bundle parity gates:
npm --prefix apps/newone exec expo install -- --check
npm --prefix apps/newone exec expo export -- --platform ios --output-dir .expo/verify-ios --clear
npm --prefix apps/newone exec expo export -- --platform android --output-dir .expo/verify-android --clear
```

Do not continue if a Critical/High security issue, failing denial test, schema lint error, client type error, or production dependency vulnerability remains unresolved.

## 2. Public client configuration

The checked [public environment example](../apps/newone/.env.example) is authoritative. An ignored `apps/newone/.env.local` may contain only public routing values:

```dotenv
EXPO_PUBLIC_SUPABASE_URL=https://project-ref.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_me
EXPO_PUBLIC_API_URL=/api
EXPO_PUBLIC_TURNSTILE_SITE_KEY=public-site-key
EXPO_PUBLIC_TURNSTILE_CHALLENGE_ORIGIN=https://app.example.com/
EXPO_PUBLIC_SUPPORT_CONTACT_LABEL=Company support desk
EXPO_PUBLIC_SUPPORT_CONTACT_URL=https://support.example/newone
EXPO_PUBLIC_EAS_PROJECT_ID=exact-eas-project-uuid
EXPO_PUBLIC_PUSH_ENVIRONMENT=development
EXPO_PUBLIC_OFFLINE_CACHE_ENABLED=false
EXPO_PUBLIC_DEMO_MODE=false
```

Production web uses a same-origin path such as `EXPO_PUBLIC_API_URL=/api`; native builds use the direct HTTPS Edge Function origin. Turnstile's site key is public, but its secret remains in the Supabase Auth configuration. The native challenge origin must be a dedicated allowed HTTPS origin and must exactly match the deployed challenge document. Add the exact hostname from `EXPO_PUBLIC_TURNSTILE_CHALLENGE_ORIGIN` to that Turnstile widget's hostname allowlist; adding only the main web-app hostname does not authorize the hosted mobile challenge page.

Never place service-role/secret keys, database passwords, OpenRouter credentials, APNs/FCM credentials, SMTP secrets, scanner keys, or signing secrets in `EXPO_PUBLIC_*`.

## 3. Server-only configuration

Edge Function secrets are environment-specific. The checked [server environment example](../.env.example) is authoritative. Its contract includes:

```dotenv
SUPABASE_URL=https://project-ref.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_me
SUPABASE_SECRET_KEY=server-secret
NEWONE_ALLOWED_WEB_ORIGINS=https://app.newone.example
NEWONE_PUBLIC_APP_URL=https://app.newone.example
NEWONE_SUPABASE_FUNCTIONS_ORIGIN=https://project-ref.supabase.co/functions/v1
NEWONE_ALLOW_HTTP_LOCAL=false
NEWONE_MAX_JSON_BYTES=65536
NEWONE_ACCESS_COOKIE_NAME=__Host-newone_access
NEWONE_REFRESH_COOKIE_NAME=__Host-newone_refresh
NEWONE_CSRF_COOKIE_NAME=__Host-newone_csrf
NEWONE_NETWORK_HASH_KEY=independent-32-byte-or-longer-secret
NEWONE_RECOVERY_EVIDENCE_HASH_KEY=independent-32-byte-or-longer-secret
NEWONE_WEB_GATEWAY_SHARED_SECRET=independent-32-byte-or-longer-secret
NEWONE_CURSOR_SIGNING_KEY=independent-32-byte-or-longer-secret
NEWONE_PUSH_TOKEN_KEY_V1=independent-32-byte-base64url-key
NEWONE_WORKER_TOKEN=independent-32-byte-or-longer-secret
NEWONE_BOOTSTRAP_TOKEN=temporary-independent-32-byte-or-longer-secret
NEWONE_AUTH_CAPTCHA_REQUIRED=true
NEWONE_AUTH_PHONE_OTP_ENABLED=false
NEWONE_OUTBOX_TOPICS=moderation,realtime_control,storage_purge,session_revoke,dynamic_group_sync
NEWONE_AI_DATA_EGRESS_APPROVED=false
NEWONE_AI_WORKLOADS=language_detection,translation,summary
OPENROUTER_API_KEY=server-secret
OPENROUTER_MANAGEMENT_API_KEY=server-management-secret
NEWONE_OPENROUTER_API_KEY_HASH=reviewed-completion-key-hash
NEWONE_OPENROUTER_WORKSPACE_ID=dedicated-workspace-id
NEWONE_OPENROUTER_POLICY_JSON={versioned-reviewed-route-policy}
NEWONE_OPENROUTER_APP_NAME=Newone
NEWONE_EXPO_ACCESS_TOKEN=server-secret-when-push-is-enabled
NEWONE_EXPO_PROJECT_ID=exact-eas-project-uuid
NEWONE_PUSH_ENVIRONMENT=production
NEWONE_ATTACHMENT_SCANNER_URL=https://scanner.example/v1/scan
NEWONE_ATTACHMENT_SCANNER_TOKEN=server-secret
```

Generate every secret independently per environment and never print it into release evidence. Do not reuse `NEWONE_RECOVERY_EVIDENCE_HASH_KEY` for network fingerprints, cookies, cursors, or any other purpose. Install the same `NEWONE_WEB_GATEWAY_SHARED_SECRET` value in Vercel and Supabase only; it signs the Vercel-observed network peer so a later Supabase proxy hop cannot collapse all web users into one rate-limit bucket. The bootstrap token is temporary and the bootstrap endpoint is service-only, owner-bound, idempotent, and disabled/404 when the token is absent; remove it immediately after initial owner provisioning. Add `push` to `NEWONE_OUTBOX_TOPICS` only when Expo submission and receipt processing are configured. A model key alone cannot enable AI processing. Employee content additionally requires the global approval flag, an approved organization policy, the exact model/provider allowlist, zero-data-retention/data-denial and budget controls, exact completion-key/workspace identity, no BYOK or content-mutating guardrails, a successful management-control-plane preflight, an uncached ZDR endpoint, a synthetic route probe, and completed owner review.

Before promoting a Vercel deployment, verify the ingress contract from two client networks. On a direct Vercel preview, use a temporary one-shot diagnostic that records only whether `X-Forwarded-For` is exactly one syntactically valid IP and whether the two probes produce distinct keyed network buckets; do not record or return either raw IP, and remove the diagnostic before promotion. If another CDN or reverse proxy sits in front of Vercel, stop: Vercel documents that ordinary proxy setups overwrite the original address, which can collapse users into a shared availability bucket. Configure and verify Vercel Trusted Proxy or omit the extra proxy before launch. This network signal is supplemental rate limiting only and is never authentication.

## 4. Database release

1. Confirm the target project and environment explicitly.
2. Back up any non-disposable target before schema mutation.
3. Compare local and remote migration history.
4. Run the full local reset, pgTAP suite, lint, advisors, and generated-type check.
5. Link the exact target project non-interactively and review the pending migration plan.
6. Push migrations only after the review is clean.
7. Re-run security/performance advisors and safe remote smoke probes.

The Free `newone` project remains a development target. All 34 migrations are currently in parity and PostgreSQL SSL enforcement is enabled. Database IP restrictions are not yet closed because a stable developer/CI egress range has not been selected. No production data may be imported merely because migrations, SSL, or public routing values are configured.

## 5. Auth release

Before inviting any employee:

The development project currently has the custom access-token hook and session hardening enabled. That does not make employee sign-in ready: `newone-auth` is intentionally not deployed, the Auth origin is the reserved `https://dev.newone.invalid`, and the real web domain, Turnstile secret/hostname policy, custom SMTP, redirect proof, and end-to-end synthetic enrollment evidence remain required.

- disable open email/phone signup;
- apply migrations before Auth configuration, enable the versioned
  `hook_newone_custom_access_token` hook, and verify initial OTP, MFA upgrade,
  and refresh succeed only for a canonical current member or the exact subject
  of a live invitation. The hook is available on Supabase Free and Pro, but it
  is not active in a hosted project merely because its SQL and local
  `config.toml` exist;
- configure verified redirect URLs for `newone://auth/callback` and each web origin;
- configure trusted SMTP/SMS delivery and generic enumeration-safe responses;
- enable hosted Supabase Auth CAPTCHA with provider `turnstile`, install the matching secret, and keep `NEWONE_AUTH_CAPTCHA_REQUIRED=true`;
- add every exact web challenge hostname and the exact hosted mobile challenge-page hostname to the Turnstile widget allowlist, then prove an allowed-host token succeeds and a token from an unlisted host cannot trigger delivery;
- pass each challenge token once as Supabase Auth's `captchaToken`. GoTrue owns the Siteverify exchange; Newone must not call Cloudflare Siteverify a second time or attempt to reuse the single-use token;
- record that the widget requests Turnstile action `workplace_sign_in`, but the current Supabase GoTrue CAPTCHA integration does not let Newone configure or prove an expected-action comparison. Treat the action as non-enforced metadata unless the Auth provider adds that control or a separately reviewed single-owner verification design replaces this flow;
- verify OTP/recovery limits and generic responses;
- probe the public Auth endpoint directly with a synthetic unrelated principal
  and prove token issuance fails. Then prove that disabling or expiring a
  membership blocks refresh without relying on the Newone Edge gateway;
- prove recovery request and verification consume their separate destination, network, and installation budgets, and prove an unknown destination cannot create an Auth user;
- exercise self-service recovery end to end: bind the new installation before access, preserve only the new session, revoke all other sessions/devices/push destinations, and inspect immutable security/audit records;
- approve a named human-verification procedure and trained recovery-manager roster. Newone records only the keyed digest of the external reference; never place identity documents or the raw reference in the app, database, request logs, or release evidence;
- exercise lost-TOTP recovery with target/verifier/approver separation, two distinct approvals for a privileged target, case expiry, exact-factor matching, stale-version rejection, ambiguous Auth-response retry, and complete session/device/push revocation;
- configure the approved out-of-band security-notice provider and retain a synthetic delivery receipt. A `pending_external_delivery` database record does not satisfy this gate;
- require MFA/AAL2 and recent authentication for privileged operations;
- test invite expiry, one-time redemption, recovery, session listing/revocation, suspension, and offboarding;
- confirm a suspended membership loses REST/RPC/Storage access immediately and private Realtime access within the release target.

On hosted Free projects created after the provider's June 3, 2026 change, custom Auth email templates cannot be used with the default SMTP service. Configure a custom SMTP provider or approved Send Email Auth Hook before relying on Newone's code-only invitation/sign-in template. Default SMTP is not a production employee-delivery path.

Do not infer hosted Auth state from `supabase/config.toml`. Export/review the actual project Auth configuration after every push and attach remote enrollment, redirect, CAPTCHA, rate-limit, template, and generic-response probes.

## 6. Functions, jobs, files, and push

- The development deployment currently contains only the four fail-closed base functions: `newone-api`, `newone-read`, `newone-outbox-worker`, and `newone-maintenance-worker`. Do not infer availability of the other five source packages.
- Deploy every versioned function (`newone-api`, `newone-auth`, `newone-read`, bootstrap, AI, attachment scan, general outbox, push receipt, and maintenance workers) only after its unit/contract tests pass.
- Verify every function fails closed when a required RPC, secret, approval, or active session is absent.
- Create only private Storage buckets. Exercise pending, scanning, clean, blocked, expired-grant, nonmember, and deleted-message cases.
- Configure Expo push credentials, exact EAS project UUID, and environment binding per environment. The pilot permits generic or hidden notifications only; confidential sender, message, notice, handoff, and override-reason text never enters the provider payload.
- Verify the durable job worker is idempotent and that provider failure never rolls back an original message or private report. For `moderation`, prove one content-free intake job, service-only expansion, current authorization after offboarding/grants, target/reporter exclusion, duplicate replay, and retry after expansion or completion failure.

### Worker scheduling

Handlers do not become automatic merely because they are deployed. Configure [Supabase Cron with `pg_net` and Vault](https://supabase.com/docs/guides/functions/schedule-functions) after functions and secrets exist:

1. Store the exact project URL, secret API key, and independent worker token in Vault. Never put literal credentials in a migration or cron command history.
2. Enable `pg_cron` and `pg_net` in the target environment.
3. Schedule short, overlapping-safe POST claims with `Content-Type: application/json`, the server `apikey`, and `X-Newone-Worker-Token`. These self-authenticating handlers reject an `Authorization` header, browser Origin, and cookies; Supabase gateway JWT verification is disabled for them. The body contains only bounded limits, while topic and tenant authority remain server-derived.
4. Start with AI processing every 10 seconds, attachment scan every 10 seconds, moderation/revocation/control/purge/dynamic-group outbox every 5 seconds, push dispatch every 5 seconds when enabled, push receipts every 30 seconds, and scheduled-update/notice/handoff maintenance every minute. Adjust only from synthetic load/queue-age evidence.
5. Record `cron.job`, recent `cron.job_run_details`, Edge invocation results, queue age/dead letters, retry behavior, and kill-switch tests. Alert before the applicable delivery/revocation target is missed.
6. Unschedule a worker before rotating or removing a credential that it requires; verify non-dependent workers continue.

The scheduling SQL is environment state, not a portable schema migration. Archive a redacted export of job names/schedules and the secret names (never values) with release evidence.

## 7. Web and native delivery

- Production web must be built as a static Expo export and served on a Newone/company-controlled origin with the same-origin `/api` BFF, TLS, CSP/Turnstile directives, no-store employee-data responses, and no ChatGPT dependency. The reserved `https://dev.newone.invalid` origin is intentionally non-routable and does not satisfy this requirement. Another approved host must reproduce and re-test the BFF trust/header contract; uploading only the static files is insufficient for secure web Auth.
- Native builds use the bundle identifiers in `apps/newone/app.json` and separate development/preview/production EAS profiles.
- A release operator must complete the first interactive EAS setup and native signing configuration before CI can build non-interactively.
- OTA updates are currently disabled in `apps/newone/app.json`. Any future enablement requires environment isolation, channel policy, signing, rollback testing, and a rule that native/security-contract changes require a store build.

## 8. Release evidence

Store the commit, migration history, project reference, function versions, cron configuration/run history, web origin, native build IDs, test reports, advisors, dependency/SBOM/license audit, model policy, backup/restore result, accessibility review, bilingual evaluation, training record, and named approvals for every release candidate. Use the [delivery and acceptance checklist](DELIVERY_AND_ACCEPTANCE_CHECKLIST.md).

The complete gate checklist is in [SECURITY_ARCHITECTURE_V2.md](SECURITY_ARCHITECTURE_V2.md#launch-gates). A successful UI smoke test is not a security or production approval.

## Rollback and kill switches

- Disable `NEWONE_AI_DATA_EGRESS_APPROVED` to stop new model egress without stopping messaging.
- Disable upload grants or push dispatch independently when those processors fail.
- Suspend memberships and revoke sessions/push destinations for compromised accounts.
- Roll functions and clients back to the last verified contract-compatible release.
- Restore the database only through the reviewed recovery procedure; Storage objects require their separate backup path.
- Preserve original messages and audit evidence unless an approved deletion/retention procedure authorizes removal.
