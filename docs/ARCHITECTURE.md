# Architecture

## System shape

```text
Browser
  |  Sign in with ChatGPT identity headers
  v
Vinext / Next.js Worker
  |-- authorization: personnel allowlist + role + thread membership
  |-- messages/search/brief/action APIs
  |-- OpenRouter adapter (server only, approval-gated)
  v
Cloudflare D1

Worker -- approved requests only --> OpenRouter --> exact Qwen provider-region
```

The browser never receives the OpenRouter key. API responses containing workplace data are marked private and no-store. Security headers deny framing, object embedding, camera, microphone, geolocation, and payment access.

## Original-first message flow

1. The browser creates a stable `clientMessageId`.
2. `POST /api/messages` authenticates the actor, verifies thread membership, validates runtime types, and atomically stores the original.
3. The unique `(sender_email, client_message_id)` key makes retries safe. A replay with different content returns `409`.
4. Only after original acknowledgement does the browser request `POST /api/translate`.
5. D1 atomically claims `pending/retryable_failed → translating`. Parallel requests do not double-call the model.
6. Success writes translation, detected language, warning, model, exact requested provider-region, and timestamps. Failure updates translation status without changing original delivery.
7. Visible clients poll the newest 300 messages every 4.5 seconds. The query selects the latest window, then orders it chronologically.

This is near-real-time polling, not WebSocket delivery. It is intentionally simple for the MVP and works across current desktop and mobile browsers.

## Summary flow

Manager/admin authorization is enforced in the API, not only the UI. A SHA-256 fingerprint of the current authorized message set is inserted into `summary_runs`. The unique thread/fingerprint constraint prevents duplicate model calls and duplicate action creation. A two-minute stale claim can be recovered after a Worker interruption.

The model must return strict JSON. Runtime validation rejects the entire result unless:

- both language summaries and headlines are strings;
- at least one valid source message is cited;
- every cited message belongs to the supplied authorized set;
- every action has a valid source message;
- owners and due labels are either strings or null.

Generated actions are stored as `needs_confirmation`.

## Authorization model

- Sites/Sign in with ChatGPT provides the identity header at the trusted ingress.
- `NEWONE_ALLOWED_EMAILS` is mandatory in production.
- `profiles.active=0` immediately blocks an account.
- Manager and admin roles come from controlled configuration at first provisioning.
- A user sees only rows whose thread has an explicit `thread_members` record.
- Membership is never silently restored on later requests.
- New users can receive only the configured `NEWONE_DEFAULT_THREAD_IDS` once.
- Summary generation and action mutation require manager or admin.

The deployment must ensure the Sites ingress strips and replaces caller-supplied identity headers and that no direct Worker origin bypass is available.

## Tables

- `profiles`: identity, preferred language, role, active state
- `threads`: operational channels and shifts
- `thread_members`: explicit conversation access
- `messages`: source, translation, statuses, provenance, review state
- `summaries`: bilingual source-linked briefs
- `summary_runs`: concurrency and idempotency claims
- `action_items`: unconfirmed/open/done work
- `action_events`: append-only status-change audit

The Drizzle migration adds foreign keys and checks for language, role, message type, priority, translation state, action state, and summary-run state.

## Failure boundaries

- Authentication/authorization failure returns controlled 401/403 responses.
- Bad JSON and invalid runtime types return 400/415, not internal errors.
- Unexpected server failures return a generic message.
- OpenRouter retries only timeouts, 429s, and 5xx responses with jitter. Non-retryable 4xx responses are not retried.
- Original messages remain available during provider failure.
- No raw workplace content is intentionally written to application logs.

## Future production upgrades

- Realtime Durable Objects/WebSockets if sub-second delivery becomes necessary
- Encrypted, policy-approved durable device outbox for managed devices
- SCIM/directory provisioning and an administrator membership UI
- Retention/deletion jobs and employee data-subject workflows
- Direct Vertex AI or Bedrock integration to remove OpenRouter from the processor chain
- Provider health/ZDR endpoint verification at startup and scheduled intervals
