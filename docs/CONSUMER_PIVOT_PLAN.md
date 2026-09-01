# Newone consumer pivot plan

Status: active implementation plan, decided September 1, 2026. Supersedes the workplace-only product scope in FULL_PRODUCT_REQUIREMENTS.md where they conflict; the security architecture, testing bar, and evidence discipline in SECURITY_ARCHITECTURE_V2.md and RELEASE_EVIDENCE.md remain binding.

## Product decisions (owner-confirmed)

1. Newone becomes a **general consumer messenger** — anyone can create an account, find people, and message them. Target experience: seamless transition for WhatsApp users.
2. **Workspaces remain an optional mode.** The consumer experience is the default surface; organizations (with the existing admin, updates, handoffs machinery) remain joinable/creatable on top.
3. **Identity: email + password-less OTP signup with a unique username** for discovery. No phone identity in 1.0.
4. **Message-requests model**: anyone can send a first message to any discoverable user; it arrives as a request; the full conversation unlocks when the recipient accepts. Friend (contact) connections continue to exist and auto-accept implies friendship.
5. **Languages: English, Spanish, Korean.** The user picks their language during onboarding; it drives both UI locale and translation target. Message translation is automatic between the three languages.
6. **No voice/video calls in 1.0** (planned 1.1). 1.0 WhatsApp-parity scope: text, media (images/video/docs), voice notes, reactions, replies, forwarding, groups, read receipts, typing indicators, pins, search, translation, block/report, push notifications.
7. **Post-1.0, design now:** a per-user chat assistant that answers questions about the user's own conversation history ("summarize the project discussion with Ana", "where did we talk about X") with links back to source messages.
8. OpenRouter inference cost is explicitly not a constraint right now.

## Architecture: the personal realm

Every consumer feature runs inside one reserved, platform-managed organization (the **personal realm**, fixed UUID `11111111-1111-4111-8111-111111111111`), created by migration and never listed as a joinable workspace. Rationale: all 37 migrations of RLS, RPC authorization, retention, moderation, and audit machinery are org-scoped and tested; a parallel un-tenanted model would duplicate them. Workspaces stay ordinary organizations.

Personal-realm configuration that makes this safe:

- `dm_policy = 'request_first'` — the existing `private.direct_pair_policy_permitted` predicate then requires an accepted `contact_connections` row to open a DM. The message-requests feature is a controlled carve-out on top (below).
- Every consumer membership gets `directory_visibility = 'private'` — nobody appears in any org-wide directory; people are found only by exact/prefix **username search**, mutual conversations, or connections.
- `role = 'member'` for everyone; owner/admin roles in the personal realm are held only by platform operations. Admin surfaces stay hidden in the client for the personal realm.
- Personal-realm `organization_ai_policies` row enables `language_detection`, `translation`, `summary` with the pinned provider allowlist so consumer translation works.

### Scale hazards inherited from the workplace design (must fix in Slice 1–2)

- `bff_bootstrap_messaging_state` directory block scans all org memberships per launch (and a superseded v2 block runs the same scan a second time). In the personal realm the directory must be assembled from the actor's connections and shared conversations only — indexed lookups, never an org-wide scan.
- `profiles` and `organization_memberships` have direct PostgREST `select` grants guarded by per-row plpgsql predicates; with private visibility this stays correct, but enumeration paging is a DoS surface — revoke or bound before real scale.
- `bff-network:` rate-limit keys become global per-IP budgets in a single giant org; consumer-tuned limits and bucket-table indexing are required before launch.

## Identity and signup

- `public.profiles` gains `username citext` with a case-insensitive unique index, format `^[a-z0-9](?:[a-z0-9_]{2,28})[a-z0-9]$` (4–30 chars), plus a reserved-names table.
- Signup flow (new `signup` intent in `newone-auth`, alongside the untouched invite/member flows):
  1. `POST /v2/auth/signup/request` — email + username + display name + language; Turnstile-gated on web; validates and reserves the username, creates the `auth.users` row via the admin API with `app_metadata.newone_signup_state = 'pending'`, sends the email OTP. Destination-keyed and IP-keyed rate-limit buckets (already the right shape from the invite flow, retuned for consumer volume).
  2. `POST /v2/auth/signup/verify` — OTP verify; on success a new `private.redeem_signup_impl` atomically creates the profile (with `preferred_language`), claims the username, and inserts the active personal-realm membership with `directory_visibility='private'`.
- `private.bff_authorize_member_otp_impl` keeps its active-membership requirement — every completed signup has a personal-realm membership, so returning-user OTP works unchanged. A parallel `bff_authorize_signup_otp_impl` authorizes the pending-signup window only.
- Supabase GoTrue public signup **stays disabled**; account creation continues to flow exclusively through the Edge gateway (CAPTCHA, rate limits, username atomicity).
- In-app **account deletion** (Apple 5.1.1(v)): self-service RPC that tombstones the profile, releases the username after a quarantine period, removes memberships, purges device registrations, and deletes the auth user; queued hard-delete of message bodies per the existing retention machinery.

## Message requests

Person-scoped requests reuse the DM machinery rather than a parallel inbox:

- `bff_send_message_request(target_user_id, body)` creates (a) a `pending` `contact_connections` row, (b) the `direct` conversation + pair, (c) the first message — one transaction.
- `private.direct_pair_policy_permitted` gains a pending-window allowance: while the connection is `pending`, only the requester may post, capped at 3 messages, and the recipient sees the thread in a **Requests** section without read receipts or presence leaking back.
- Recipient **Accept** → connection `accepted` (they are now contacts; the thread becomes a normal DM). **Decline** → connection `declined`, conversation hidden for the recipient, requester cannot re-request for the existing 7-day cooldown. **Block** works as today and wins over everything.
- Existing anti-enumeration trigger (`validate_identity_relationship_target`) is relaxed in the personal realm to "target found via username search", replacing "target visible in directory".

## Language and translation

- `en` joins `ko`/`es` as a first-class translation target (it already is in the search filters, detection enum, and client catalog; the remaining gap is push-notification copy in the outbox worker and the pivot of `employeeDataEgressEnabled` policy gating to consumer consent).
- Onboarding language choice writes UI locale (client store) + `profiles.preferred_language` + personal-realm `organization_user_preferences.ui_language`.
- Per-conversation translation off-switch already exists (`conversation_preferences.translation_mode`); it becomes a user-facing setting.
- AI route policy: rename the `employeeDataEgress` concept to consumer-data egress with per-user consent recorded at onboarding; policy file re-versioned; the Korean-Spanish(-English) human evaluation gate remains before release.

## Client (Expo) changes

- **Onboarding**: language picker (works pre-auth; I18nProvider already sits outside AuthProvider) → sign-up (email, username with live availability, display name) → OTP verify. Existing `accessMode` union gains `'signup'`.
- **People → Chats-adjacent "Friends"**: the existing four-state connection UI carries over; new username-search box (new bounded search endpoint) replaces the org directory as the discovery surface in the personal realm; new Requests inbox for incoming message requests.
- **Workspace switcher**: bootstrap payload gains `organizations[]`; `WorkspaceState.organizationId` stays a scalar that switching re-bootstraps (realtime channels, offline cache, and outbox are already keyed by `(userId, organizationId)`).
- **Branding/copy**: remove `WORKPLACE` brand tag and org-name subtitle in the personal realm; consumer permission strings (done); bundle ID `com.newone.app`, slug `newone` (done).
- **New parity features**: typing indicators (ephemeral realtime broadcast, no persistence), voice notes (expo-audio record + playback; audio MIME already allowed server-side), video attachments (extend MIME allowlist + thumbnails), camera capture.
- Admin/updates/handoffs screens remain, gated to workspace realms only.

## Chat assistant (post-1.0 groundwork)

Reuses the summary pipeline's primitives (outbox lease protocol, source-fingerprint dedupe, structured output with inline source refs, human-review ledger where applicable). New pieces: a per-user assistant conversation surface, retrieval over the user's own accessible messages (RLS-scoped search + summaries as the index), and a bot principal (`kind='system'` messages under `app.bff_service_context` until a first-class bot member type exists). Strictly opt-in, per-user, never cross-user. Not a 1.0 gate.

## Delivery slices (each lands green: pgTAP + Deno + Jest + root contracts, then deploys to the linked Pro project)

1. **S1 Identity**: personal-realm migration, username + reserved names, open signup end-to-end, onboarding UI with language picker, account deletion. ← current
2. **S2 Discovery + requests**: username search, message requests (DB carve-out + Edge + Requests UI), consumer directory assembly (kill the org-wide scans), friends surface.
3. **S3 Parity batch 1**: typing indicators, voice notes, video attachments + camera capture.
4. **S4 Realm polish**: workspace switcher, personal-realm branding/copy, admin gating, consumer rate-limit retune.
5. **S5 Translation for consumers**: English push copy, consent-based egress policy pivot, personal-realm AI policy, human language evaluation.
6. **S6 Release**: store assets, privacy policy/labels, EAS signed builds, hosted E2E rerun on the release candidate, RELEASE_EVIDENCE.md promotion, TestFlight, submission.
7. **Post-1.0**: chat assistant; voice/video calls (1.1).

## External gates (owner)

- Expo/EAS login or `EXPO_TOKEN`; App Store Connect API key (.p8 + Key ID + Issuer ID) — both requested.
- Google Play developer account (Android release).
- Production email delivery (custom SMTP or approved provider) for OTP at consumer volume — Supabase built-in email is not launch-grade.
- Real web domain if the web client ships publicly; Turnstile production site/secret.
- Privacy policy + terms URLs (required for App Store).
