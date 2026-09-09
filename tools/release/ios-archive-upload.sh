#!/bin/zsh
# Archive, export and upload an iOS build. Usage: ios-archive-upload.sh <build> [upload]
#
# Signing settings come from tools/release/ExportOptions.plist; the App Store
# Connect key and issuer come from ~/.config/newone/asc.json. Nothing here is a
# secret, which is why it lives in the repository — the copy that lived in the
# session scratchpad was pruned with it on Sep 9 2026.
set -e
HERE=${0:a:h}
ROOT=${HERE}/../..
OUT=${NEWONE_RELEASE_OUT:-$HOME/.cache/newone-release}
mkdir -p "$OUT"
cd "$ROOT/apps/newone"

export EXPO_PUBLIC_PUSH_ENVIRONMENT=production
export EXPO_PUBLIC_EAS_PROJECT_ID=2300fd06-3789-4d86-a2bb-856d57dca912
export EXPO_PUBLIC_OFFLINE_CACHE_ENABLED=false
export EXPO_PUBLIC_API_URL=/api
export EXPO_PUBLIC_SUPABASE_URL=https://sfbkmnpduweusynopbig.supabase.co
export EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_zp2CRMddXG_cKKo1cXvjMQ_iGKTNXHc

BUILD_NUMBER=${1:?build number}
UPLOAD=${2:-yes}
PLIST=ios/Newone/Info.plist
ORIG=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$PLIST")
trap '/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $ORIG" "$PLIST"' EXIT
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$PLIST"

echo "=== archive build $BUILD_NUMBER $(date +%H:%M:%S) ==="
# The team and profile are named here because the project itself carries no
# team: the archive fails with "requires a development team" otherwise.
xcodebuild -workspace ios/Newone.xcworkspace -scheme Newone -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' -archivePath "$OUT/Newone.xcarchive" archive \
  DEVELOPMENT_TEAM=XAD7U9U737 CODE_SIGN_STYLE=Manual \
  PROVISIONING_PROFILE_SPECIFIER="Newone App Store 1788301805177" \
  CODE_SIGN_IDENTITY="iPhone Distribution" \
  | grep -E "ARCHIVE (SUCCEEDED|FAILED)|error:" || true

echo "=== export $(date +%H:%M:%S) ==="
rm -rf "$OUT/export"
xcodebuild -exportArchive -archivePath "$OUT/Newone.xcarchive" \
  -exportOptionsPlist "$HERE/ExportOptions.plist" -exportPath "$OUT/export" \
  | grep -E "EXPORT (SUCCEEDED|FAILED)|Exported|error:" || true
ls -la "$OUT/export"/*.ipa

if [ "$UPLOAD" = "yes" ]; then
  echo "=== upload $(date +%H:%M:%S) ==="
  KEY_ID=$(node -e "console.log(require(process.env.HOME + '/.config/newone/asc.json').keyId)")
  ISSUER=$(node -e "console.log(require(process.env.HOME + '/.config/newone/asc.json').issuerId)")
  xcrun altool --upload-app -f "$OUT/export"/Newone.ipa -t ios \
    --apiKey "$KEY_ID" --apiIssuer "$ISSUER"
fi
echo "=== done $(date +%H:%M:%S) ==="
