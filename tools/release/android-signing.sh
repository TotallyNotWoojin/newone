#!/bin/zsh
# Put the upload signing config back into the generated Android project.
#
# apps/newone/android is generated: `expo prebuild --clean` rewrites
# app/build.gradle from the template, and the template signs *release* with the
# debug key. Play rejects that with "APK has been signed in debug mode", which
# is how the rename's prebuild was discovered -- after a full release build.
#
# So this is not a one-time edit. Run it after any prebuild, which
# android-build.sh now does for you. It is idempotent.
set -e
HERE=${0:a:h}
ROOT=${HERE}/../..
GRADLE="$ROOT/apps/newone/android/app/build.gradle"
PROPS=${NEWONE_ANDROID_SIGNING:-$HOME/.config/newone/android-upload.properties}

if [[ ! -f "$PROPS" ]]; then
  echo "missing $PROPS -- the upload keystore's passwords" >&2
  exit 1
fi
if [[ ! -f "$GRADLE" ]]; then
  echo "missing $GRADLE -- run expo prebuild first" >&2
  exit 1
fi

if grep -q 'signingConfigs.upload' "$GRADLE"; then
  echo "android signing: already wired"
  exit 0
fi

python3 - "$GRADLE" "$PROPS" <<'PY'
import pathlib, sys
gradle = pathlib.Path(sys.argv[1])
props = sys.argv[2]
source = gradle.read_text()

block = """        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
"""
if block not in source:
    raise SystemExit('build.gradle does not look like the Expo template; wire signing by hand')

upload = block + """        upload {
            // Read at configure time from outside the repository: the keystore
            // and its passwords are never in git, and this file is regenerated
            // by prebuild anyway.
            def uploadProps = new Properties()
            def uploadFile = file("%s")
            if (uploadFile.exists()) {
                uploadFile.withInputStream { uploadProps.load(it) }
                storeFile file(uploadProps['storeFile'])
                storePassword uploadProps['storePassword']
                keyAlias uploadProps['keyAlias']
                keyPassword uploadProps['keyPassword']
            }
        }
""" % props
source = source.replace(block, upload, 1)

# The template signs release with the debug key; Play refuses that upload.
old_release = """        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug"""
new_release = """        release {
            signingConfig signingConfigs.upload"""
if old_release not in source:
    raise SystemExit('release buildType is not the template default; wire signing by hand')
source = source.replace(old_release, new_release, 1)
gradle.write_text(source)
print('android signing: upload keystore wired into release')
PY
