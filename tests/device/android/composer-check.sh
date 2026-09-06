#!/bin/zsh
# Android composer check on the "Newone Pixel" emulator (three-button navigation,
# the Samsung Z Flip setup the first real user reported). Signs in as the
# showcase account, opens a conversation, focuses the composer and screenshots
# it with the keyboard up. Usage: composer-check.sh <apk> [shot-dir]
set -u
APK="$1"; OUT="${2:-tests/device/.artifacts/android-$(date +%Y%m%dT%H%M%S)}"
SDK="$HOME/Library/Android/sdk"; ADB="$SDK/platform-tools/adb"; DEV=emulator-5554
EMAIL="${NEWONE_SHOT_EMAIL:-lsctshzb@guerrillamailblock.com}"; PEER="${NEWONE_SHOT_PEER:-Diego Ruiz}"
mkdir -p "$OUT"
export NEWONE_DEVICE_MINT_CODES=1
"$ADB" -s $DEV shell cmd overlay enable com.android.internal.systemui.navbar.threebutton >/dev/null 2>&1
"$ADB" -s $DEV install -r "$APK" | tail -1
"$ADB" -s $DEV shell pm clear com.totallynotwoojin.newone >/dev/null
# The common flows expect the app already open (the iOS harness warms it up).
"$ADB" -s $DEV shell monkey -p com.totallynotwoojin.newone -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 15
run() { maestro --device $DEV test "$@" 2>&1 | grep -E "COMPLETED|FAILED|Error|✅|❌" | tail -3; }
run -e EMAIL="$EMAIL" tests/device/suite/common/returning-request.yaml
CODE=$(node --input-type=module -e "import { mintCode } from './tests/device/lib/mailbox.mjs'; console.log((await mintCode('$EMAIL')).code)")
run -e EMAIL="$EMAIL" -e CODE="$CODE" -e SHOT="$OUT/shot" tests/device/android/returning-verify.yaml
# Dismiss the first-launch notification card if it shows, then open the thread.
cat > "$OUT/open-and-focus.yaml" <<YAML
appId: com.totallynotwoojin.newone
---
- tapOn:
    text: "Not now"
    optional: true
- runFlow:
    file: $PWD/tests/device/suite/common/open-conversation.yaml
    env:
      PEER: "$PEER"
- tapOn: ".*Write a message.*"
- waitForAnimationToEnd:
    timeout: 3000
- takeScreenshot: $OUT/composer-keyboard
YAML
run "$OUT/open-and-focus.yaml"
"$ADB" -s $DEV exec-out screencap -p > "$OUT/composer-keyboard-adb.png"
echo "shots in $OUT"; ls "$OUT"
