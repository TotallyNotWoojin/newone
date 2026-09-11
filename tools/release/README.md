# Release tooling

These scripts build and publish Newone. They live in the repository on purpose:
the copies that lived in the session scratchpad under `/private/tmp` were
pruned by the operating system on Sep 9 2026, taking the App Store Connect
issuer id with them and stopping a release that was otherwise ready.

Nothing here is a secret. Credentials are read from `~/.config/newone`:

| File | Holds |
| --- | --- |
| `asc.json` | App Store Connect issuer id, key id, key path, app id |
| `android-upload.properties` | the upload keystore's passwords (read by build.gradle) |
| `android-upload.jks` | the upload keystore |
| `play-service-account.json` | the Play Developer API service account |
| `google-services.json` | the Firebase client config for the Android app |

The Apple API key itself is at `~/.appstoreconnect/private_keys/AuthKey_<id>.p8`.

### The Firebase client config

`apps/newone/google-services.json` is gitignored and `android-build.sh` copies
it in from `~/.config/newone` at build time, via `sync-firebase-config.sh`,
which refuses a file registered to any package but
`com.totallynotwoojin.newone`. `verify-repository-security.mjs` fails the build
if the file is ever tracked again, ignore rule or not.

It was committed to this public repository until Sep 11 2026 and the Android
API key in it was revoked as a result. Worth being exact about why that
mattered: the key ships inside every APK, so it is readable by anyone who
downloads the app, and Google treats it as public. What protects it is an
**Android application restriction** on the key — package name plus release
signing SHA-1 — set in the Cloud console, not the fact that it is kept out of
git. Keeping it out of git is what stops the scanners from flagging the repo
and forcing another rotation.

To check whether the key in a given file is alive:

```sh
KEY=$(python3 -c "import json;print(json.load(open('apps/newone/google-services.json'))['client'][0]['api_key'][0]['current_key'])")
APPID=$(python3 -c "import json;print(json.load(open('apps/newone/google-services.json'))['client'][0]['client_info']['mobilesdk_app_id'])")
curl -s -X POST https://firebaseinstallations.googleapis.com/v1/projects/newline-38a60/installations \
  -H "Content-Type: application/json" -H "x-goog-api-key: $KEY" \
  -d "{\"appId\":\"$APPID\",\"sdkVersion\":\"a:17.0.0\",\"fid\":\"cZcCiXjQR0qPxIRTest12x\"}"
```

A live key returns a registration document. A revoked one returns
`API_KEY_INVALID`, which is what a build will turn into "no push on Android"
— the app cannot register for a token at all.

## Doing a release

    tools/release/ios-archive-upload.sh 32          # archive, export, upload
    node tools/release/wait-build.mjs 32            # wait for processing, add to both beta groups
    node tools/release/attach-build.mjs 32          # attach to the App Store version
    node tools/release/asc-build-notes.mjs 32 <en.json> <es.json> <ko.json>
    tools/release/android-build.sh 22               # bundle and apk
    node tools/release/play-upload.mjs <aab> internal "newone v3.5"
    node tools/release/play-notes.mjs internal 22 <en.json> <es.json> <ko.json>

Artifacts are written to `~/.cache/newone-release` (override with
`NEWONE_RELEASE_OUT`), which is also outside `/private/tmp`.
