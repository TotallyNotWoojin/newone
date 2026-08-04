# Newone architecture entrypoint

Newone is an independent universal Expo application backed by Supabase. It has no ChatGPT identity, ChatGPT Sites runtime, D1 database, or legacy Relay authorization dependency.

The authoritative architecture is [PLATFORM_ARCHITECTURE_V2.md](PLATFORM_ARCHITECTURE_V2.md). The authoritative threat model and release gates are [SECURITY_ARCHITECTURE_V2.md](SECURITY_ARCHITECTURE_V2.md).

## Runtime shape

```text
iOS / Android Expo app
  |  native PKCE session in OS secure storage
  |
Responsive Expo web app
  |  HttpOnly SameSite session through the Newone BFF
  v
Newone /v2 command API and BFF (Supabase Edge Functions initially)
  |-- active membership, current session, MFA, schema, quota, and idempotency checks
  |-- server-only OpenRouter, push, scanner, and administrative adapters
  v
Supabase Auth + Postgres/RLS + private Realtime + private Storage
  |
  `-- durable outbox/jobs -> moderation, translation, push, scan, retention, and audit workers
```

## Non-negotiable boundaries

- The publishable Supabase key may be present in clients. Secret/service-role, OpenRouter, push, scanner, and database credentials may not.
- Supabase Auth proves the person; an active organization membership determines access.
- Ordinary admins cannot browse private DMs.
- Original messages commit before translation or any other model operation.
- Mutations cross the `/v2` command boundary. Clients do not gain a raw-write fallback when the API is unavailable.
- Reads are constrained by explicit grants, forced RLS, tenant-scoped relationships, and conversation membership.
- Realtime topics are private and carry identifiers/minimal state; durable rows are refetched under authorization.
- Attachments remain quarantined and unreadable until server-side validation and scanning mark them clean.
- Web refresh credentials terminate in an HttpOnly cookie boundary. Native refresh credentials use OS secure storage.
- AI employee-data egress remains off unless the separate approval policy, exact route policy, and server secret are all present.
- A private report commits one content-free moderation intent. The outbox worker resolves the full current authorized investigator set after commit and creates only recipient-specific inbox invalidations. The reporter, reported member/message sender, and group conversation topic are never recipients.

## Source tree

```text
apps/newone/                 Expo Router client for web, iOS, and Android
supabase/migrations/         Authoritative schema, constraints, RLS, and RPC contracts
supabase/functions/          Versioned command API, BFF, and server-only adapters
supabase/tests/              pgTAP authorization and security regressions
docs/                        Product, architecture, security, research, and operations
```

The legacy Vinext/D1 implementation is retained only in Git history. It is not a fallback runtime.
