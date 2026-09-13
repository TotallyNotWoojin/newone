#!/bin/zsh
# Android device check for Gist on the "Gist_Pixel" emulator (Pixel 7, Android
# 15, three-button navigation -- the setup the first real Android user had).
#
# Boots the emulator if it is not already running, signs in as the review
# account, opens a conversation, focuses the composer and screenshots it with
# the keyboard up -- the exact spot Android 15's edge-to-edge broke once.
#
# Usage:  tests/device/android/run.sh [apk] [shot-dir]
#   apk       defaults to the newest ~/.cache/newone-release/gist-*.apk
#   shot-dir  defaults to tests/device/.artifacts/android-<timestamp>
#
# Env (all optional):
#   NEWONE_AVD            AVD name           (Gist_Pixel)
#   NEWONE_SHOT_EMAIL     account email      (review@newonechat.com)
#   NEWONE_SHOT_PASSWORD  account password   (~/.config/newone/review-account-password.txt)
#   NEWONE_SHOT_PEER      chat to open       (Diego Ruiz)
#   NEWONE_HEADLESS       1 = no window      (1)
#   NEWONE_STOP_EMULATOR  1 = kill it after  (0; leave it up for the next run)
#
# The device is always found by AVD *name*, never by port. emulator-5554 is
# simply whichever emulator booted first, and with another project's AVD on
# the same machine that used to be the wrong one.
set -u
HERE=${0:a:h}
ROOT=${HERE}/../../..
SDK="$HOME/Library/Android/sdk"
ADB="$SDK/platform-tools/adb"
EMU="$SDK/emulator/emulator"
MAESTRO="$HOME/.maestro/bin/maestro"
export MAESTRO_DRIVER_STARTUP_TIMEOUT=120000

AVD="${NEWONE_AVD:-Gist_Pixel}"
APK="${1:-$(ls -t "$HOME"/.cache/newone-release/gist-*.apk 2>/dev/null | head -1)}"
OUT="${2:-$ROOT/tests/device/.artifacts/android-$(date +%Y%m%dT%H%M%S)}"
EMAIL="${NEWONE_SHOT_EMAIL:-review@newonechat.com}"
PASSWORD="${NEWONE_SHOT_PASSWORD:-$(cat "$HOME/.config/newone/review-account-password.txt" 2>/dev/null)}"
PEER="${NEWONE_SHOT_PEER:-Diego Ruiz}"
PKG=com.totallynotwoojin.gist

[[ -f "$APK" ]] || { echo "no APK at '$APK' -- build one with tools/release/android-build.sh" >&2; exit 2; }
[[ -n "$PASSWORD" ]] || { echo "no password: set NEWONE_SHOT_PASSWORD or ~/.config/newone/review-account-password.txt" >&2; exit 2; }
mkdir -p "$OUT"

# --- find the emulator by AVD name ---------------------------------------
serial_for_avd() {
  for s in $("$ADB" devices | awk '/^emulator-/{print $1}'); do
    if [[ "$("$ADB" -s "$s" emu avd name 2>/dev/null | head -1 | tr -d '\r')" == "$AVD" ]]; then
      echo "$s"; return 0
    fi
  done
  return 1
}

DEV=$(serial_for_avd || true)
BOOTED_HERE=0
if [[ -z "$DEV" ]]; then
  "$EMU" -list-avds | grep -qx "$AVD" || { echo "AVD '$AVD' does not exist ($EMU -list-avds)" >&2; exit 2; }
  echo "booting $AVD..."
  flags=(-avd "$AVD" -no-boot-anim -no-audio -netdelay none -netspeed full)
  [[ "${NEWONE_HEADLESS:-1}" == "1" ]] && flags+=(-no-window)
  nohup "$EMU" "${flags[@]}" > "$OUT/emulator.log" 2>&1 &
  BOOTED_HERE=1
  for _ in $(seq 1 60); do
    sleep 4
    DEV=$(serial_for_avd || true)
    [[ -n "$DEV" ]] && break
  done
  [[ -n "$DEV" ]] || { echo "emulator never appeared in adb (see $OUT/emulator.log)" >&2; exit 1; }
fi
echo "device: $DEV ($AVD)"

# Wait for a real boot, not just an adb handshake.
"$ADB" -s "$DEV" wait-for-device
for _ in $(seq 1 60); do
  [[ "$("$ADB" -s "$DEV" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]] && break
  sleep 4
done
[[ "$("$ADB" -s "$DEV" shell getprop sys.boot_completed | tr -d '\r')" == "1" ]] || { echo "boot did not complete" >&2; exit 1; }

# --- make the device look like the phone that found the composer bug -------
"$ADB" -s "$DEV" shell cmd overlay enable com.android.internal.systemui.navbar.threebutton >/dev/null 2>&1
# Animations off: fewer mid-transition taps from the driver.
for k in window_animation_scale transition_animation_scale animator_duration_scale; do
  "$ADB" -s "$DEV" shell settings put global "$k" 0 >/dev/null 2>&1
done

# --- install and launch ----------------------------------------------------
"$ADB" -s "$DEV" install -r "$APK" | tail -1
"$ADB" -s "$DEV" shell pm clear "$PKG" >/dev/null
# The common flows expect the app already open (the iOS harness warms it up).
"$ADB" -s "$DEV" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 15

# --- drive it --------------------------------------------------------------
FAILED=0
run() {
  local label="$1"; shift
  local log="$OUT/$label.log"
  "$MAESTRO" --device "$DEV" test "$@" > "$log" 2>&1
  local rc=$?
  sed -e 's/\x1b\[[0-9;]*m//g' "$log" | grep -E "COMPLETED|FAILED" | tail -3
  if [[ $rc -ne 0 ]]; then echo "  ✗ $label (see $log)"; FAILED=1; else echo "  ✓ $label"; fi
}

run sign-in-email -e EMAIL="$EMAIL" "$HERE/returning-request.yaml"
run sign-in-password -e PASSWORD="$PASSWORD" -e SHOT="$OUT/shot" "$HERE/returning-verify.yaml"

cat > "$OUT/open-and-focus.yaml" <<YAML
appId: $PKG
---
- tapOn:
    text: "Not now"
    optional: true
- runFlow:
    file: $ROOT/tests/device/suite/common/open-conversation.yaml
    env:
      PEER: "$PEER"
- tapOn: ".*Write a message.*"
- waitForAnimationToEnd:
    timeout: 3000
- takeScreenshot: $OUT/composer-keyboard
YAML
run composer "$OUT/open-and-focus.yaml"
"$ADB" -s "$DEV" exec-out screencap -p > "$OUT/composer-keyboard-adb.png"

if [[ "${NEWONE_STOP_EMULATOR:-0}" == "1" ]]; then
  "$ADB" -s "$DEV" emu kill >/dev/null 2>&1
  echo "emulator stopped"
elif [[ $BOOTED_HERE -eq 1 ]]; then
  echo "emulator left running as $DEV; NEWONE_STOP_EMULATOR=1 to stop it next time"
fi

echo "shots in $OUT"; ls "$OUT"
exit $FAILED
