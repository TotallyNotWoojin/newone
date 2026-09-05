# Store submission checklist (App Store + Google Play)

Status as of Sep 5 2026. Items marked **console** cannot be set through the
APIs and must be entered by the account owner in App Store Connect or the Play
Console; the answers to give are written out here.

## Shared facts

- App name: Newone Chat. Bundle / package: `com.totallynotwoojin.newone`.
- Category: Social Networking (secondary: Productivity). Age rating: 4+ (messaging and user-generated content declared; reporting and blocking exist).
- Pricing: free, no in-app purchases, no ads.
- Sign-in: emailed one-time code. Review account: `review@newonechat.com`; its six-digit static code lives in `~/.config/newone/review-account-code.txt` on the owner's Mac (never commit it). Enter the email on the Returning member tab, then the code.
- Hosted pages: GitHub Pages from the `newone-legal` repo (https://totallynotwoojin.github.io/newone-legal/): index, privacy, terms, support. Switch to newonechat.com once DNS is set (see below). A copy also sits in the public Supabase storage bucket `site`.

## What the app collects (for both questionnaires)

| Data | Collected | Linked to identity | Purpose | Notes |
| --- | --- | --- | --- | --- |
| Email address | yes | yes | account / sign-in codes | required |
| Name (display name), username | yes | yes | app functionality | user-provided |
| Photos or videos | yes (when shared) | yes | app functionality (messages) | optional |
| Audio (voice messages) | yes (when recorded) | yes | app functionality | optional |
| Messages (text) and other user content | yes | yes | app functionality; translation via language-model provider (zero data retention) | not end-to-end encrypted |
| Contacts (in-app connections) | yes | yes | app functionality | never the device address book |
| Device ID (installation id), push token | yes | yes | app functionality, notifications | push token stored encrypted |
| Crash / performance / diagnostics | yes | no | analytics (operational) | no message text |
| Precise location, financial info, health, browsing history, purchase history, advertising data | no | — | — | — |

Data is not sold, not used for advertising, not used for tracking across apps. Users can request deletion in-app (Settings → Delete account) and by email.

## App Store Connect

Done through the API:
- Version 1.0.0 with build 25 attached (v2.5: image viewer); content rights declared (no third-party content); categories; age rating (4+); subtitle, promotional text, description, keywords.

**console** items remaining (App Store Connect → app → App Privacy / version page):
1. App Privacy → Data Types: enter the table above. Choose "Data Linked to You" for everything except diagnostics. No tracking.
2. Screenshots: 6.9" iPhone set uploaded (5 shots: conversation with translation, chats, people, group, settings). 13" iPad set: captured by the `ipadshots` area and uploaded via `asc-screenshots.mjs`.
3. App Review Information (done via API on Sep 5: Woojin Lee, phone and email on file, demo account with the six-digit code): "Sign-in is passwordless. Choose 'Returning member', enter the review email, then enter the static code as the one-time code. Translation demo: message any account; Spanish replies show an English translation card."
4. Support URL, marketing URL, and Privacy Policy URL: set (GitHub Pages).
5. Export compliance: `ITSAppUsesNonExemptEncryption` is false in the build, so no documentation is requested.
6. Pricing: Free (price schedule created via API); availability: all 175 territories (set via API).

## Google Play Console

Done through the API:
- Listing title, short and full description; icon (512) and feature graphic (1024×500); internal-track releases up to version code 15 (v2.5); closed-testing draft release of code 15.

**console** items remaining (Play Console → app → Policy and programs / App content, and Dashboard):
1. Privacy policy URL.
2. App access: "All or some functionality is restricted" → provide the review email and the six-digit code with the same instructions as above.
3. Ads: no ads.
4. Content rating questionnaire (IARC): category Social / Communication; user-to-user communication yes; user-generated content yes; no violence, sexual content, gambling, drugs, or profanity features; personal information shared with other users (display name, username, photo) yes.
5. Target audience: 13+ (not designed for children).
6. News app: no. COVID/health: no. Government app: no. Financial features: none.
7. Data safety: enter the table above; data is encrypted in transit; users can request deletion; collection required except photos/audio which are optional.
8. Store settings: app category Communication; contact email and website are set via API (totallynotwoojin@gmail.com, GitHub Pages site).
9. Production access: a personal developer account created after Nov 13, 2023 must first run a closed test with at least 12 opted-in testers for 14 continuous days, then apply for production. If the account is an organization account, production is available immediately. Closed testing needs the Google Group from the owner.
10. Production release: promote version code 15 (or newer) to Production with a phased rollout.

## Website and domain (Sep 5 2026)

The site lives in the public GitHub repo `TotallyNotWoojin/newone-legal` (GitHub Pages, branch `main`, root): landing page, privacy, terms, support. Live now at https://totallynotwoojin.github.io/newone-legal/ and both stores point there.

To serve it at newonechat.com, add these records at the domain registrar, then tell the assistant (or set the custom domain in the repo's Pages settings and commit a `CNAME` file containing `newonechat.com`):

| Type | Host | Value |
| --- | --- | --- |
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| CNAME | www | totallynotwoojin.github.io |

After DNS resolves, enable "Enforce HTTPS" in the Pages settings and switch the store URLs to https://newonechat.com/….

## Google Play production for a personal account

Google requires a closed test with at least 12 testers opted in for 14 continuous days before a personal account (created after Nov 13, 2023) can apply for production. There is no API or policy exception. Fastest path:
1. Play Console → Testing → Closed testing → create a track (or use "alpha"), add an email list with 12+ Google accounts (friends, family, classmates), and roll out version code 14 to it.
2. Send testers the opt-in link https://play.google.com/apps/testing/com.totallynotwoojin.newone; they must accept and install once and stay opted in for 14 days.
3. On day 14, Dashboard → "Apply for production access", answer the short questionnaire, then promote the release to Production.
Meanwhile the sideload APK and the internal track (up to 100 emailed testers) keep working.

## Android sideload distribution (Sep 5 2026)

The APK is published as a GitHub Release asset on `TotallyNotWoojin/newone-legal` (GitHub Pages cannot host files over 100 MB). Stable link used on the site: https://github.com/TotallyNotWoojin/newone-legal/releases/latest/download/newone.apk — upload each new build as `newone.apk` on a new release tag (plus the versioned file name) so the link never changes. Sideloaded installs do not auto-update; if Play App Signing later signs the app with a different key, sideload users must uninstall before installing from Play.
