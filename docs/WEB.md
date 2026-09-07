# Newone on the web (desktop browser)

The Expo app exports to a static site (`expo-router`, `web.output: static`). This
document covers how that static build authenticates, what the backend must allow,
how to export it, and how it is hosted on GitHub Pages.

## Auth model: static site + Edge Functions with bearer tokens

Two web modes exist in `apps/newone/src/config/runtime.ts`, selected at build time:

| `EXPO_PUBLIC_WEB_AUTH_MODE` | Transport | Needs |
| --- | --- | --- |
| `cookie` (default, unchanged) | Same-origin `/api` gateway sets `__Host-newone_*` HttpOnly cookies (`SameSite=Strict`) and a CSRF cookie. | A server-side proxy on the app's own origin (`api/[...path].mjs` on Vercel). |
| `direct` | The browser calls the Supabase Edge Functions directly and carries the session as `Authorization: Bearer` + `apikey`, exactly like the iOS/Android apps. | A static host only. |

The cookie design cannot work from a static host: the cookies are `__Host`-prefixed
and `SameSite=Strict`, so a browser at `totallynotwoojin.github.io` never stores or
sends them for `*.supabase.co`, and GitHub Pages cannot run the proxy. `direct` mode
reuses the native contract instead:

- Sign-in/sign-up/recovery use the token-returning routes (`/v2/auth/native/*`).
  The client sends `X-Newone-Client-Platform: web` and `X-Newone-Installation-Id`
  (a per-browser UUID from `localStorage`).
- The Supabase client (`src/lib/supabase.ts`) is created on web only in this mode.
  Its session is stored through `src/lib/web-session-storage.ts` in the existing
  encrypted IndexedDB client store (`client-store.web.ts`: AES-GCM under a
  non-extractable key, never `localStorage`), with an in-memory fallback when
  storage is blocked. Token refresh is handled by supabase-js against GoTrue.
- Reads/commands (`WebReadRepository`, `BffCommandRepository`, search, recovery,
  moderation) pick the transport per call via `src/lib/session-transport.ts`
  (`usesCookieSession()`), so the cookie path is byte-for-byte unchanged.
- Realtime keeps the token-only web socket client and is fed the access token.

Why this is acceptable for a consumer chat app: it is the same trust model as the
installed apps (the refresh token lives on the device), the bundle loads no
third-party script except Cloudflare Turnstile when configured, and the Edge
Functions still enforce Origin allow-listing, rate limits, and session binding.
The trade-off versus the cookie gateway is that a same-origin XSS could read the
tokens; keep the web bundle free of third-party scripts and inline handlers.

## Backend configuration (integrator sets secrets)

Server changes in this stream (no deploy performed here):

- `supabase/functions/_shared/http.ts`: CORS `Access-Control-Allow-Headers` now
  includes `x-newone-client-platform` and `x-newone-installation-id`.
- `supabase/functions/newone-auth/handler.ts`: the `/v2/auth/native/*/verify`
  routes accept `X-Newone-Client-Platform: web` only when the request carries an
  allow-listed browser `Origin`; origin-less requests stay iOS/Android only, and a
  browser claiming a native platform gets `400 bad_request`. The session
  installation is bound with `platform = 'web'` (already permitted by the DB
  check constraints).

Required secrets (all functions share `loadRuntimeConfig`):

- `NEWONE_ALLOWED_WEB_ORIGINS` must include `https://totallynotwoojin.github.io`
  now and `https://newonechat.com` once the custom domain is live (comma-separated,
  canonical HTTPS origins, no path). Every function that a browser calls
  (`newone-auth`, `newone-read`, `newone-api`) reads this list.
- `NEWONE_AUTH_CAPTCHA_REQUIRED`: with `web`, the token-returning routes are not
  challenged (they were designed for the apps), so the browser build is not
  challenged either. To require Turnstile on web set it to `true` and build with
  `EXPO_PUBLIC_TURNSTILE_SITE_KEY` (the widget then also gates native requests).

## Client configuration and export

Build-time env (`apps/newone/.env.local` values; never commit or print them):

- `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (required).
- `EXPO_PUBLIC_API_URL`: `/api` or `https://<project>.supabase.co/functions/v1`;
  in direct mode both resolve to the project's Edge Functions.
- `EXPO_PUBLIC_WEB_AUTH_MODE=direct` (the export script sets this).
- Optional: `EXPO_PUBLIC_TURNSTILE_SITE_KEY`, `EXPO_PUBLIC_TURNSTILE_CHALLENGE_ORIGIN`,
  support contact. Leave `EXPO_PUBLIC_PUSH_ENVIRONMENT` unset (no web push).

`experiments.baseUrl` is read from the Expo config at export time, so a project
path is applied with a temporary dynamic config instead of editing `app.json`:

```sh
cd apps/newone
cat > app.config.js <<'JS'
module.exports = ({ config }) => ({
  ...config,
  experiments: { ...config.experiments, baseUrl: process.env.NEWONE_WEB_BASE_URL || undefined },
});
JS
set -a; . ./.env.local; set +a
EXPO_PUBLIC_WEB_AUTH_MODE=direct NEWONE_WEB_BASE_URL=/newone-legal/app \
  npx expo export --platform web --output-dir /tmp/newone-web/app --clear
rm app.config.js
```

`builds/web-export.sh` (integrator scratchpad) automates exactly this, validates
the env file (refuses `sb_secret_` keys), checks that `index.html`,
`conversation/[id].html`, and `sign-in.html` exist and reference
`<base>/_expo/`, and greps the output for server credential patterns.
Switching hosts later is one variable: `NEWONE_WEB_BASE_URL=/app` for
`https://newonechat.com/app/`, or `NEWONE_WEB_BASE_URL=` for a root domain.
`src/app/+html.tsx` prefixes its fixed assets with `process.env.EXPO_BASE_URL`,
which Expo inlines from `experiments.baseUrl`.

## Hosting on GitHub Pages (TotallyNotWoojin/newone-legal)

The landing site already lives at `https://totallynotwoojin.github.io/newone-legal/`
(later `https://newonechat.com`). The app is served from `/app/` beside it:

1. Export with `NEWONE_WEB_BASE_URL=/newone-legal/app` and copy the output to
   `app/` in the Pages repo (replace the directory wholesale on each release).
2. Add an empty `.nojekyll` at the repo root: the bundles live under `_expo/`,
   which Jekyll would otherwise drop.
3. Add `404.html` at the repo root (see `builds/site-root/404.html`). Pages has no
   rewrites, so `/app/conversation/<id>` on a reload is a 404; that page stores the
   path in `sessionStorage` and opens `/app/`, and `src/lib/web-deep-link.ts`
   restores the route once the session is ready. Non-app 404s show a plain page.
4. Landing page: add the primary button `Open Newone in your browser` linking to
   the relative `app/` (works on both the project path and the custom domain);
   keep the iPhone/Android links. `/privacy`, `/terms`, `/support` stay put.
5. Add the origin to `NEWONE_ALLOWED_WEB_ORIGINS` and redeploy the functions.
6. Custom domain later: add `CNAME` (`newonechat.com`) to the Pages repo, rebuild
   with `NEWONE_WEB_BASE_URL=/app`, and add `https://newonechat.com` to the
   allow-list (keep the github.io origin until traffic has moved).

Local check without a browser (mirrors the Pages path):

```sh
mkdir -p /tmp/pages/newone-legal && ln -sfn /tmp/newone-web/app /tmp/pages/newone-legal/app
(cd /tmp/pages && python3 -m http.server 4173 >/dev/null 2>&1 &)
curl -sI http://127.0.0.1:4173/newone-legal/app/index.html | head -1
curl -sI "http://127.0.0.1:4173/newone-legal/app/conversation/%5Bid%5D.html" | head -1
```

## Desktop behaviour

- Two-pane layout at widths >= 920 (list + conversation, details at >= 1420),
  centred and capped at 1560 px on wide monitors.
- Composer: Enter sends, Shift+Enter inserts a newline, governed by the device
  preference `enterSends` (`src/state/device-preferences.tsx`, default on).
  Enter that commits an IME composition (Korean, Japanese) never sends
  (`src/features/chat/composer-keys.ts`).

## Known limitations

- No web push notifications; unread state updates while a tab is open (Realtime).
- No service worker or installable PWA under a project path: the registration
  targets the site root and fails silently. It returns when the app is served
  from a root domain.
- GitHub Pages sets no security headers (no CSP/HSTS beyond GitHub's defaults);
  the Vercel deployment keeps its CSP in `vercel.json`.
- Refresh tokens are held by the browser (encrypted IndexedDB); signing out in
  Settings revokes the local session only, as on native.
- Turnstile is not enforced on the direct path unless the server captcha mode is
  `true` (see above).
- Camera, microphone (voice notes), and file pickers depend on browser permissions;
  attachments download through short-lived signed Storage URLs.

## The browser suite (Playwright)

`playwright.config.mjs` serves the exported bundle at `http://127.0.0.1:4173`
(`npm run e2e:serve` builds it first) and runs `tests/e2e`. The export is built
with `EXPO_PUBLIC_WEB_AUTH_MODE=direct`, the mode the static host uses.

```sh
npm run e2e         # static: no backend, safe anywhere
npm run e2e:live    # static + signed-in, against the hosted project
```

`npm run e2e` runs two projects:

| Project | What it drives |
| --- | --- |
| `desktop` (1440×1000) | everything under `tests/e2e/*.spec.mjs` |
| `mobile-chromium` (Pixel 7) | `auth.spec.mjs` only — the one screen a phone browser lands on |

`npm run e2e:live` adds a third, `desktop-live`, which runs
`tests/e2e/live/*.spec.mjs`. It needs the Supabase CLI logged in (the same
credentials `tests/hosted` uses) because it creates real accounts.

### What the static half covers

- **Sign-in** (`auth.spec.mjs`): the two modes, the fields each asks for, that
  there is no phone option and no workplace wording anywhere, an invalid email
  refused before any code is sent, the three interface languages, the help link.
- **Dark mode** (`appearance.spec.mjs`): the canvas and the `theme-color` meta
  in both schemes, driven by the browser's `prefers-color-scheme`, and that
  dark ink is light ink.
- **Routes** (`routes.spec.mjs`): every protected route lands on `/sign-in`
  signed out, `/help` is public, and a conversation deep link has no file of
  its own (which is why GitHub Pages needs the repo-root `404.html`).
- **Accessibility** (`accessibility.spec.mjs`): axe (WCAG 2.0/2.1 A and AA)
  over the signed-out screens in both schemes. Serious and critical findings
  fail; the full list is attached to the run.

### What the live half covers, and how it reaches the gateway

The exported build runs in `direct` mode, so the browser calls the Edge
Functions itself and they answer a browser only from an origin in
`NEWONE_ALLOWED_WEB_ORIGINS`. That list holds the production hosts, and a test
run may not deploy, so a page at `127.0.0.1:4173` is refused with
`403 origin_not_allowed`. `tests/e2e/support/live-gateway.mjs` therefore
re-issues each Edge Function call from Node — where no CORS rule applies —
with the production `Origin`, and hands the real answer back to the page. The
server, the session, the data and the app code are all real; only the browser's
own address stands in for production. Nothing is stubbed or recorded.

`tests/e2e/support/live-account.mjs` builds the account graph through the same
hosted gateway the phone apps use: three signups, two accepted contacts, a chat
with three messages and one pinned. The browser then signs in through the real
form with an email and a password.

- **Sign-in** (`live/sign-in.spec.mjs`): the lookup, the password step, the
  "Forgot password?" and "Use a different email" ways out, a wrong password
  refused, a right one landing on Chats, and an unknown email offered the
  create-account shortcut.
- **Chats** (`live/chats.spec.mjs`): the one search field, a person tapped into
  a chip with the comma written for the next name, a name typed with its own
  comma making the same chip, a chip cleared in one tap; the "+" menu's two
  rows; hover revealing a message's Reply and right-click opening the actions
  sheet (reactions, Reply, Copy, Pin, Forward, Delete for everyone, and no
  workplace review items); the Pinned view across chats and inside one chat;
  Photos and files. Both of those last two assert that the view opens and that
  the app asks `newone-read` for it, not that rows come back — see the
  deployment note below.
- **Groups** (`live/groups.spec.mjs`): optional name, description and photo;
  Advanced options collapsed, opening onto posting mode and history, and
  closing again; the three-person rule stated on the form; the picker's
  "Your contacts" and "Search everyone" sections.
- **Consumer guards** (`live/guards.spec.mjs`): `/updates` and `/handoffs`
  turning a consumer back to Chats without drawing anything workplace-shaped,
  and a navigation of Chats · Contacts · Settings.
- **Dark mode** (`live/appearance.spec.mjs`): Chats following the browser, and
  the Settings override (System / Light / Dark) winning over it.
- **Accessibility** (`live/accessibility.spec.mjs`): axe over Chats with a chat
  open, Contacts, and group creation, in both schemes.

The accounts a run creates are real, and it does not delete them: their emails
all begin with the run's `newone-e2e-…` prefix, which is what
`tests/hosted/run.mjs --cleanup` matches (see `tests/hosted/README.md`). Run
that, or let the pre-release database wipe take them.

The live project shares one signed-in page across its tests and runs them
serially. Every returning sign-in starts with an account lookup, and the
gateway rate-limits those (20 per address-space per fifteen minutes), so
signing in per test would spend that budget; a run makes three signups and two
lookups. Back-to-back runs inside the same quarter of an hour can still be
rate-limited — the failure is a visible `429`, not a flake.

### Blocked on a deployment

`/v2/pins/query` and `/v2/conversations/<id>/media/query` answer `404` on the
hosted project. Two separate things caused that:

1. The client routing table sent both to `newone-api`, which serves neither.
   Fixed in `apps/newone/src/config/api-routing.mjs`; it affected native too.
2. The deployed `newone-read` is the version from 2026-09-05, before the
   pins-and-media reads landed in `supabase/functions/newone-read/handler.ts`,
   so it still answers `404` even now the request reaches it. Deploying
   `newone-read` (with migration `20260908050000`) is the remaining step.

`live/chats.spec.mjs` therefore carries one `test.fixme` — "the Pinned view
lists the message that was pinned" — which is the assertion to turn back on
once that deploy has happened.

### What the suite deliberately does not cover

- **The cookie web gateway.** `api/[...path].mjs` signs its upstream calls with
  `NEWONE_WEB_GATEWAY_SHARED_SECRET`, which no test run holds, so the suite
  drives `direct` mode only. The cookie path is unchanged and untested here.
- **A populated shared-media grid and its arrow-key stepping.** Putting a photo
  in a chat needs a storage grant, an upload, and an asynchronous scan that has
  to mark the file clean before the grid will show it; the suite asserts the
  empty grid and leaves the populated one to the device suite.
- **Realtime, push and offline.** No web push exists, and the suite makes no
  assertions about live updates arriving in a second tab.
- **The GitHub Pages `404.html` deep-link hand-back**, which lives in the Pages
  repository rather than here.
- **Anything on a phone browser beyond sign-in**; the desktop layout is what
  this suite is for.
