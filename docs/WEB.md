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
