#!/bin/zsh
# The Android bundle and the sideload APK. Usage: android-build.sh <versionCode> [aab|apk|both]
# Signing comes from ~/.config/newone/android-upload.properties via build.gradle.
set -e
HERE=${0:a:h}
ROOT=${HERE}/../..
OUT=${NEWONE_RELEASE_OUT:-$HOME/.cache/newone-release}
mkdir -p "$OUT"
cd "$ROOT/apps/newone/android"

CODE=${1:?version code}
WHAT=${2:-both}
# build.gradle carries the version code literally, so set it for the build and
# put it back afterwards.
GRADLE=app/build.gradle
ORIG=$(grep -oE 'versionCode [0-9]+' $GRADLE | head -1 | awk '{print $2}')
trap 'sed -i "" "s/versionCode [0-9]*/versionCode $ORIG/" $GRADLE' EXIT
sed -i '' "s/versionCode [0-9]*/versionCode $CODE/" $GRADLE
# local.properties is not in the repository, so gradle has no SDK path unless
# the environment carries one.
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
export ANDROID_SDK_ROOT=$ANDROID_HOME
export NEWONE_ANDROID_VERSION_CODE=$CODE
export EXPO_PUBLIC_PUSH_ENVIRONMENT=production
export EXPO_PUBLIC_OFFLINE_CACHE_ENABLED=false
export EXPO_PUBLIC_API_URL=/api
export EXPO_PUBLIC_SUPABASE_URL=https://sfbkmnpduweusynopbig.supabase.co
export EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_zp2CRMddXG_cKKo1cXvjMQ_iGKTNXHc

if [ "$WHAT" = "aab" ] || [ "$WHAT" = "both" ]; then
  echo "=== bundle versionCode $NEWONE_ANDROID_VERSION_CODE $(date +%H:%M:%S) ==="
  ./gradlew --no-daemon bundleRelease
  cp "$(ls -t app/build/outputs/bundle/release/*.aab | head -1)" "$OUT/newone-$NEWONE_ANDROID_VERSION_CODE.aab"
fi
if [ "$WHAT" = "apk" ] || [ "$WHAT" = "both" ]; then
  echo "=== apk versionCode $NEWONE_ANDROID_VERSION_CODE $(date +%H:%M:%S) ==="
  ./gradlew --no-daemon assembleRelease
  cp "$(ls -t app/build/outputs/apk/release/*.apk | head -1)" "$OUT/newone-$NEWONE_ANDROID_VERSION_CODE.apk"
fi
ls -la "$OUT"/newone-$NEWONE_ANDROID_VERSION_CODE.* 2>/dev/null
echo "=== done $(date +%H:%M:%S) ==="
