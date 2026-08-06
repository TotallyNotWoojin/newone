# Real hosted integration harness

This suite does not use demo repositories, mocks, seeded product fixtures, intercepted network
responses, or sample UI data. It creates uniquely prefixed test identities at runtime and exercises
the linked hosted Supabase Auth, Postgres, RLS, deployed Edge Functions, and durable database state.

The generated users and operational messages are test records, but the services and execution paths
are real. A repeatable end-to-end test cannot run without controlled test identities and inputs.

## Safety modes

`--dry-run` is the default. It retrieves the project keys through the Supabase CLI without printing
them, checks the deployed function inventory, verifies hosted Auth/TOTP settings, and confirms the
required database RPCs. It performs no hosted writes. A dry run reports a `BLOCK` line for each
missing execution gateway.

```bash
node tests/hosted/run.mjs --dry-run
node --test tests/hosted/harness.test.mjs
```

`--execute` creates real hosted test records. It is rejected unless the project is the explicitly
allowlisted development project, all four `newone-api`, `newone-auth`, `newone-bootstrap`, and
`newone-read` functions are active, `NEWONE_HOSTED_E2E=1` is set, and a 32-4096 character
`NEWONE_HOSTED_BOOTSTRAP_TOKEN` is supplied locally. That local value must match the deployed
`NEWONE_BOOTSTRAP_TOKEN` function secret. The harness uses it only in the Bootstrap request header;
it is redacted from diagnostics and is never written to the run artifact.

```bash
NEWONE_HOSTED_E2E=1 \
NEWONE_HOSTED_BOOTSTRAP_TOKEN='<matching deployed bootstrap secret>' \
node tests/hosted/run.mjs --execute
```

Every execution writes a secret-free, gitignored run manifest under `tests/hosted/.artifacts/`. The
manifest contains exact test user and organization IDs so a retained or interrupted run can be
reviewed before cleanup. It also records the four active function versions, update timestamps, and
JWT-gateway flags reported by the CLI so the evidence identifies the deployed code under test.
Passwords, access tokens, API keys, refresh tokens, activation tokens, Bootstrap secrets, and TOTP
secrets are never written to the artifact.

Cleanup is never implicit. It requires the exact run ID in a second confirmation variable. The SQL
cleanup validates every Auth email and organization slug against that prefix before deleting only
the corresponding organization-scoped rows. It proves target-user reference closure first, then
enables the transaction-local `app.allow_audit_maintenance=on` delete contract. It never disables
triggers or replica enforcement. Auth accounts are then deleted by exact UUID and the postconditions
are queried.

```bash
NEWONE_HOSTED_E2E_CLEANUP_CONFIRM=<run-id> \
node tests/hosted/run.mjs \
  --cleanup-artifact tests/hosted/.artifacts/<run-id>.json
```

For an execute-and-cleanup run after the cleanup code has been reviewed, choose the run ID first:

```bash
NEWONE_TEST_RUN_ID="newone-e2e-$(date -u +%Y%m%dt%H%M%Sz)-$(openssl rand -hex 4)"
NEWONE_HOSTED_E2E=1 \
NEWONE_HOSTED_BOOTSTRAP_TOKEN='<matching deployed bootstrap secret>' \
NEWONE_HOSTED_E2E_CLEANUP_CONFIRM="$NEWONE_TEST_RUN_ID" \
node tests/hosted/run.mjs --execute --cleanup --run-id "$NEWONE_TEST_RUN_ID"
```

## Real scenarios covered

- Admin-created, email-confirmed Supabase Auth owners with random strong passwords.
- Missing and structurally forged bearer credentials rejected by the real Read gateway.
- Bootstrap secret omission rejected, followed by two organizations created only through the
  deployed Bootstrap gateway.
- Real password sessions denied before installation binding, then bound to unique installations.
- A fresh AAL1 password session denied on the privileged invitation route.
- Real Supabase TOTP enrollment, challenge, verification, and AAL2 JWT assertion.
- AAL2-protected invitation issue, exact invited-principal resolution, one-time token redemption
  through the deployed Auth gateway, replay rejection, revoked-session data-plane denial, a fresh
  bound session, and authoritative read bootstrap.
- Contact request and acceptance.
- Direct and two-member group conversation creation.
- A real private Realtime WebSocket subscription, database-triggered Broadcast delivery, durable
  read-back, and cross-tenant private-topic join denial.
- Multilingual message persistence and read-back by another real user.
- Same-key/same-payload idempotent replay with a one-row database assertion.
- Same-key/changed-payload `409 idempotency_conflict` contract.
- Concurrent real message writes that exhaust the hosted atomic budget and prove both committed
  `201` writes and `429 rate_limited` responses with `Retry-After`.
- Cross-tenant API/read denial and direct raw-table non-disclosure.
- Management API aggregate checks over actual persisted rows.

## Explicitly not claimed

Missing/provider-dependent behavior is printed as `SKIP`; no stub is substituted. Current skips
include email OTP delivery through production SMTP/CAPTCHA, same-origin web hosting, attachment
malware scanning, AI translation completion, and push delivery receipts. Original message
commitment remains covered even though AI completion is not. Raw-table denial is described only as
non-disclosure; database-policy correctness remains independently covered by local PostgreSQL/RLS
tests.

The gateway headers and private-channel shape follow Supabase's current official guidance for
[Edge Function authorization headers](https://supabase.com/docs/guides/functions/auth-headers) and
[Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization).
