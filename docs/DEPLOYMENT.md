# Deployment and provisioning

## Deployment target

The repository is configured for OpenAI Sites on Cloudflare Workers with a D1 binding named `DB` in `.openai/hosting.json`. Production builds use Vinext.

## 1. Verify the artifact

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm audit --omit=dev
```

The generated migration is in `drizzle/`. Apply it to the production D1 database through the Sites deployment workflow. For a separately managed Cloudflare project, configure the real D1 database and apply migrations with the corresponding Wrangler D1 migration command. Do not point production at the local placeholder database ID in `vite.config.ts`; that ID exists only for Miniflare development.

## 2. Provision conversations

Production never seeds fictional data. Create the Company’s approved threads before assigning users. Example SQL:

```sql
INSERT INTO threads
  (id, title, subtitle, kind, location, shift_key, created_at, updated_at)
VALUES
  ('operations', 'General operations', '운영 · Operaciones', 'operations',
   'Plant-wide', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
```

Set `NEWONE_DEFAULT_THREAD_IDS=operations` if every newly approved user should receive that channel on first sign-in. Use explicit D1 records for narrower access:

```sql
INSERT OR IGNORE INTO thread_members (thread_id, user_email)
VALUES ('operations', 'employee@company.example');
```

The profile must exist first. It is created when an allowlisted user signs in, or an administrator can insert it deliberately:

```sql
INSERT INTO profiles
  (email, display_name, preferred_language, role, active)
VALUES
  ('employee@company.example', 'Employee Name', 'es', 'member', 1);
```

Removing a `thread_members` row revokes that conversation and it will not be silently restored. Set `profiles.active=0` to block an account.

## 3. Configure identity and personnel

Required production values:

```dotenv
NEWONE_ALLOWED_EMAILS=manager@company.example,employee@company.example
NEWONE_MANAGER_EMAILS=manager@company.example
NEWONE_ADMIN_EMAILS=admin@company.example
NEWONE_DEFAULT_THREAD_IDS=operations
NEWONE_APP_URL=https://the-real-private-site-host
```

`NEWONE_ALLOWED_EMAILS` fails closed when absent in production. Role configuration is used when a profile is first created. Later role changes should be performed through an approved administrator process and audited.

Confirm that:

- the site is private and requires Sign in with ChatGPT;
- the platform access policy limits the intended people/workspace;
- the edge strips caller-supplied `oai-authenticated-user-*` headers and injects trusted values;
- the Worker has no direct public origin that bypasses Sites identity handling.

## 4. Configure OpenRouter only after approval

OpenRouter still requires separate credits and an API key even if the operator has ChatGPT Pro.

```dotenv
OPENROUTER_API_KEY=server-secret
OPENROUTER_TRANSLATION_MODEL=qwen/qwen3-235b-a22b-2507
OPENROUTER_SUMMARY_MODEL=qwen/qwen3-235b-a22b-2507
OPENROUTER_PROVIDER=google-vertex/us-south1
NEWONE_AI_DATA_EGRESS_APPROVED=false
```

Keep the approval value false while testing authentication, database, UI, and deployment with non-sensitive data. After every privacy, contract, endpoint, quality, and Company approval gate in `PRIVACY_AND_SAFETY.md` is complete, a separately authorized release operator may change it to true.

In OpenRouter:

1. Enable account-level ZDR for the relevant model group.
2. Keep prompt/output logging and discount-data opt-ins off.
3. Apply model and exact-provider allowlists to the production workspace/key.
4. Disable plugins, web search, routing helpers, Broadcast, and response-cache presets.
5. Use a server-only, spend-limited production key and a separate management credential.
6. Verify the exact endpoint remains in the live ZDR list immediately before enabling the approval switch.

## 5. Release smoke test

With a non-sensitive account and test channel:

1. Sign in and confirm only assigned threads appear.
2. Send Korean and Spanish messages and confirm originals appear before translations.
3. Simulate an unavailable provider and confirm the original remains delivered.
4. Search both source and translated terms.
5. Generate a manager brief, open every source link, and confirm actions begin unconfirmed.
6. Confirm a member receives 403 for summary/action mutation.
7. Remove a membership and verify the thread disappears without re-enrollment.
8. Verify API responses are `private, no-store` and page/API security headers are present.
9. Complete desktop, narrow mobile, keyboard-only, screen-reader, and bilingual human review.

## 6. Training and handoff

Train managers and employees with the user guide. Training must explicitly cover the original/translation distinction, emergency-process priority, human review, action confirmation, search/source links, and the limits of the current-tab offline outbox.

Record the production URL, D1 database, release commit, configured model/provider-region, OpenRouter workspace/key owner, Company approver, DPA/MSA version, retention policy, incident owner, and date of the last golden-set evaluation.

## Rollback

- Set `NEWONE_AI_DATA_EGRESS_APPROVED=false` to stop new AI egress while preserving originals and history.
- Deactivate affected profiles or remove thread memberships to stop access.
- Revoke/rotate the OpenRouter production key if compromise is suspected.
- Roll the Site back to the prior validated version through Sites while preserving D1.
- Do not delete original messages during an incident unless the approved retention/deletion procedure authorizes it.
