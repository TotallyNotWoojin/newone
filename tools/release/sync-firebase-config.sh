#!/bin/zsh
# Put the Firebase client config in place for a build.
#
# apps/newone/google-services.json is gitignored: it was committed to this
# public repository once and the Android API key in it had to be revoked. The
# canonical copy lives in ~/.config/newone/ alongside the keystore and the Play
# service account, and this script copies it in before a build.
#
# The key inside is compiled into every APK, so it is not a secret in the way
# the keystore is -- what protects it is an Android application restriction on
# the key itself, not the fact that it is kept out of the repository.
set -e
HERE=${0:a:h}
ROOT=${HERE}/../..
SRC=${NEWONE_FIREBASE_CONFIG:-$HOME/.config/newone/google-services.json}
DEST="$ROOT/apps/newone/google-services.json"

if [[ ! -f "$SRC" ]]; then
  echo "missing $SRC -- download google-services.json from the Firebase console" >&2
  echo "(project newline-38a60, Android app com.totallynotwoojin.newone)" >&2
  exit 1
fi

PACKAGE=$(python3 -c "
import json,sys
d=json.load(open('$SRC'))
print(d['client'][0]['client_info']['android_client_info']['package_name'])
")
if [[ "$PACKAGE" != "com.totallynotwoojin.newone" ]]; then
  echo "wrong app: $SRC is for $PACKAGE, not com.totallynotwoojin.newone" >&2
  exit 1
fi

cp "$SRC" "$DEST"
echo "firebase config -> apps/newone/google-services.json ($PACKAGE)"
