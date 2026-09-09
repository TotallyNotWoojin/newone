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

The Apple API key itself is at `~/.appstoreconnect/private_keys/AuthKey_<id>.p8`.

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
