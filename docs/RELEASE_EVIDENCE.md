# Newone release evidence

Status: working evidence ledger; no immutable release candidate, deployment, or production acceptance is claimed

This file records only observed results. Every final entry must identify the immutable revision, environment, runner, date/time zone, command or procedure, result, and retained artifact. Preliminary results are useful during implementation but must be rerun from the exact release candidate.

## Candidate identity

| Field | Current value |
|---|---|
| Evidence date | August 4, 2026, America/Denver |
| Repository base | `0d95bb6` with an intentionally dirty replacement-product worktree |
| Immutable release revision | Not assigned |
| Local runner | macOS arm64 |
| Required Node baseline | 22.13.0, pinned in engines, `.nvmrc`, `.node-version`, and CI |
| Current local Node/npm | System default Node 22.11.0 / npm 11.6.2; an exact temporary Node 22.13.0 runtime is available and its version was observed, but the final immutable chain must explicitly select it |
| Deno | 2.9.1 |
| Supabase CLI | 2.109.0 with telemetry disabled for sandbox-safe local execution |
| AI policy | `2026-08-03.1`; employee-data egress disabled |
| Linked Supabase project | Healthy Free development project; remote schema/functions not yet deployed in this ledger |
| Production environment | Not provisioned or claimed |

## Preliminary automated results

These results were observed during implementation on August 4, 2026 from the intentionally dirty worktree. They are not substitutes for the final clean chain because database, backend, client, browser, and documentation source was still changing. A green preliminary row does not make the current worktree an immutable candidate.

| Check | Observed result | Final disposition |
|---|---|---|
| Exact Node baseline availability | A temporary runtime reported `v22.13.0`; the shell default remains Node 22.11.0 / npm 11.6.2 | Select the exact runtime explicitly for every final Node/npm command |
| `node --test tests/*.test.mjs` | 119/119 Node contract tests passed | Rerun from a clean checkout on Node 22.13.0 |
| `npm run backend:functions:check` and `npm run backend:functions:test` | Edge modules type-checked and 135/135 Deno tests passed | Rerun on the immutable candidate |
| Clean local reset, database contracts, and pgTAP | Clean reset succeeded through `20260804155917_complete_search_filters.sql`; 413/413 assertions passed; database lint reported zero findings; generated types matched and the Edge/database contract verified 122 called RPCs against 370 SQL functions | Rerun the complete database chain on the immutable candidate and retain logs |
| SEARCH-01 focused contracts | Exact Node 22.13.0 ran 5/5 client/DTO tests; the focused Edge read suite passed 10/10; focused search pgTAP passed 39/39 with conversation/language filters, cursor binding, Korean/Spanish, literal alias, quoted phrase, and equipment-ID fixtures; client lint/typecheck passed | Rerun on the immutable candidate and complete browser/native result-open, accessibility, and load evidence |
| Universal-client deterministic exports | Web, iOS, and Android exports completed successfully | Rerun all client alignment/lint/type/export gates on the immutable candidate |
| Repository security, environment, and documentation gates | Security scan and environment contract passed at the implementation checkpoint; after this reconciliation, `npm run docs:check` passed over 16 delivery files | Rerun after source freeze and inspect built artifacts/source maps |
| Browser/Playwright suite | No final pass is recorded; the current E2E suite is being repaired | Keep open until phone/tablet/desktop journeys, axe, keyboard/focus, and screenshot review all pass |
| `npm run ai:policy:check` | The public OpenRouter ZDR endpoint reported the pinned Qwen route healthy, structured-output capable, and within configured price ceilings; employee-data egress remained disabled | Rerun at release and retain response metadata without employee content |
| Production dependency audits | Root/release-tooling and universal-client production graphs each reported zero known vulnerabilities | Rerun from clean installs; audit output is not a license or signature review |
| npm registry signature checks | 6 root/release-tooling and 838 universal-client packages had verified registry signatures; 5 and 198 respectively also had attestations | Rerun in CI; signature and attestation presence do not replace vulnerability or license review |
| `npm run supply-chain:evidence` | Combined lockfile inventory covered 887 entries. The production license report classified 625 allowed, 14 review, and 0 denied entries. CycloneDX production component counts were 0 root/release-tooling, 527 universal client, and 9 Edge. | Rerun from the immutable lockfiles, retain all reports, and resolve or explicitly accept the 14 review classifications |
| `git diff --check -- docs/CONTRACT_TRACEABILITY.md docs/RELEASE_EVIDENCE.md` | Passed after this documentation reconciliation | Rerun repository-wide immediately before revision freeze |

## Final automated chain

All rows below remain open until executed from a clean checkout of the immutable candidate with the pinned toolchain.

| Area | Required command/evidence | Status |
|---|---|---|
| Clean installs | `npm ci` and `npm ci --prefix apps/newone`, with no lock drift | Not run on candidate |
| Universal client | Expo dependency alignment, lint, TypeScript, deterministic web export, iOS export, Android export | Preliminary web/iOS/Android exports green; immutable-candidate chain open |
| Root contracts | BFF, auth-routing, invitation, environment, documentation, web-export, AI-policy and repository-security suites | Preliminary 119/119 Node contracts plus security/environment/documentation gates green; immutable-candidate chain open |
| Edge Functions | Deno check and full Deno test suite | Preliminary type check and 135/135 tests green; immutable-candidate chain open |
| Database | Fresh local stack, clean migration/seed rebuild, full pgTAP authorization suite, database lint with warnings fatal, generated-type drift check | Preliminary clean reset, 413/413 pgTAP, zero lint findings, matching generated types, and Edge/database contract green; immutable-candidate chain open |
| Browser | Phone/tablet/desktop Playwright journeys, axe checks, keyboard/focus and visual screenshot review | Open; E2E repair is in progress and no final pass is claimed |
| Supply chain | Production audits, registry signatures, three SBOMs, combined license/integrity inventory | Preliminary artifacts generated; 14 license classifications require review and the immutable-candidate rerun is open |
| AI adapter | One paid synthetic-only production-adapter smoke using the server-only test key | Not run on candidate |
| Integrated local | Synthetic Auth users through BFF/native contracts, RLS/RPC, Realtime, Storage quarantine/scan, revocation, offline reconciliation, AI-disabled path | Not run |
| Remote development | Migration/function deploy, environment-secret/config verification, synthetic smoke, database/security/performance advisors | Not deployed |

## Manual and external gates

| Gate | Status / owner action |
|---|---|
| Qualified Korean-Spanish blind evaluation | Required; automated synthetic evidence is not human language approval |
| Web domain, Vercel project and TLS | Company account/credential required |
| Separate paid production Supabase with target RPO, PITR/equivalent, and independent Storage-object backup | Company plan/account and restore exercise required; Free development project is not production evidence |
| Custom SMTP or approved Auth email hook, DKIM/DMARC and deliverability | Company provider/domain credentials required |
| Turnstile production site/secret and hostname checks | Company Cloudflare account required |
| Account-recovery human verification and notification | Company security owner must approve the external verification procedure and trained recovery-manager roster; a trusted out-of-band provider plus synthetic delivery receipt is required because the implementation currently records `pending_external_delivery` only |
| Production malware/content scanner | Company-selected provider or isolated scanner plus credentials/signatures/SLA required |
| Expo/APNs/FCM push and optional SMS fallback | Company Apple/Google/Expo/SMS accounts, credentials, consent and device evidence required |
| Signed iOS/Android builds, deep/app links, store listings and review | Company owner accounts and physical devices required |
| Retention, investigation, legal hold/export, DM, device, critical-notice, AI, privacy/labor and employee-notice decisions | Company policy/legal/security owners required |
| Independent security review, load/abuse test, monitoring alerts, incident/rollback/provider-kill-switch and restore tabletop | Not yet performed |
| Two-hour training and acceptance certificate | Human delivery/review action; never self-certified by software |

## Deployment ledger

No database migration, Edge Function, web release, native binary, Auth template, secret, or real employee record has been deployed as part of this evidence ledger. When local gates are clean, record each development deployment below before any smoke test.

```text
Date/time and timezone:
Actor/runner:
Immutable source revision:
Environment and project reference:
Database migration versions:
Edge Function names/versions/digests:
Web deployment ID/origin:
Native build IDs:
Configuration and secret-name inventory (never secret values):
Synthetic smoke users/data set:
Commands and results:
Advisors/findings:
Rollback result:
Artifacts and reviewer:
```

See [ACCEPTANCE_TESTS.md](ACCEPTANCE_TESTS.md) for the complete verification contract and [DELIVERY_AND_ACCEPTANCE_CHECKLIST.md](DELIVERY_AND_ACCEPTANCE_CHECKLIST.md) for the human delivery record.
