# Newone Relay

Newone Relay is a private Korean ↔ Spanish operations messenger for plant teams. It sends the employee’s original message first, adds an in-line translation as a separate step, preserves both versions, creates source-linked bilingual shift briefs, tracks confirmed action items, and searches original and translated text together.

The repository includes a working local demo, production-oriented D1 persistence, Sign in with ChatGPT identity support for private Sites deployments, an OpenRouter/Qwen adapter, generated migrations, API tests, and operational documentation.

## What is implemented

- Responsive desktop and mobile web workspace
- Korean/Spanish language detection and automatic routing
- Original-first delivery with independent translation status
- OpenRouter Qwen translation with strict JSON output
- Exact provider/region pinning, ZDR routing, data-collection denial, cache disabled, and no model fallback
- Separate company approval switch before any AI data egress
- Search across source text, translations, names, and equipment IDs
- Source-linked bilingual shift briefs with automatic refresh after eight new messages or a handoff
- Human-confirmed action items with manager-only changes and an audit trail
- Offline outbox for the current browser tab with automatic retry
- Company allowlist, roles, explicit thread membership, account deactivation, and private no-store APIs
- Atomic, fail-closed first-owner provisioning into one code-approved empty operations channel
- Seeded, human-reviewed local demo data only; production never receives demo records

## Start locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Local development seeds a fictional, human-reviewed demo workspace. AI is intentionally off unless both an OpenRouter key and the company approval flag are present.

```bash
cp .env.example .env.local
```

During `npm run dev`, only the documented server runtime keys are forwarded from
`.env.local` into the local Worker. Production values remain managed by the host.

## Verify

```bash
npm run typecheck
npm run lint
npm test
npm audit --omit=dev
```

## Production release gate

Do not send live employee messages to OpenRouter merely because an API key has been added. Production AI remains disabled until `NEWONE_AI_DATA_EGRESS_APPROVED=true` is deliberately set after all of these are complete:

1. Written Company approval of OpenRouter, the exact model, provider endpoint, and region.
2. An agreement/DPA amendment explicitly authorizing the employee or employment data involved.
3. Account-level OpenRouter ZDR and logging controls are verified.
4. A Korean/Spanish bilingual quality evaluation passes on deidentified workplace examples.
5. Personnel allowlists, roles, explicit thread assignments, retention, offboarding, and incident procedures are approved.

ChatGPT Pro does not supply OpenRouter or OpenAI API credits. OpenRouter uses its own API key and credits.

## Documentation

- [User guide](docs/USER_GUIDE.md)
- [Deployment and provisioning](docs/DEPLOYMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Privacy and safety](docs/PRIVACY_AND_SAFETY.md)
- [Model selection and evaluation](docs/MODEL_EVALUATION.md)
- [Acceptance tests](docs/ACCEPTANCE_TESTS.md)
- [Contract traceability](docs/CONTRACT_TRACEABILITY.md)

## Technology

- Vinext/Next.js 16, React 19, TypeScript
- Cloudflare Workers and D1 through Sites
- Drizzle schema and generated SQLite migrations
- OpenRouter Chat Completions with pinned Qwen models

The original contractor agreement remains local in the workspace as the product source document. It is ignored from hosted source and is not required at runtime.
