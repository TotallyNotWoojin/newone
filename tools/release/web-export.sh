#!/bin/zsh
# Export the browser build for GitHub Pages. Usage: web-export.sh [baseUrl]
#
# experiments.baseUrl is read from the Expo config at export time, so the
# project path goes in through a temporary dynamic config rather than an edit
# to app.json. Pages serves the app under /newone-legal/app; a root domain
# would pass an empty base.
set -e
HERE=${0:a:h}
ROOT=${HERE}/../..
OUT=${NEWONE_RELEASE_OUT:-$HOME/.cache/newone-release}/web
BASE=${1-/newone-legal/app}
cd "$ROOT/apps/newone"
cat > app.config.js <<'JS'
module.exports = ({ config }) => ({
  ...config,
  experiments: { ...config.experiments, baseUrl: process.env.NEWONE_WEB_BASE_URL || undefined },
});
JS
trap 'rm -f "$ROOT/apps/newone/app.config.js"' EXIT
rm -rf "$OUT"
NEWONE_WEB_BASE_URL=$BASE \
EXPO_PUBLIC_WEB_AUTH_MODE=direct \
EXPO_PUBLIC_OFFLINE_CACHE_ENABLED=false \
EXPO_PUBLIC_API_URL=/api \
EXPO_PUBLIC_SUPABASE_URL=https://sfbkmnpduweusynopbig.supabase.co \
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_zp2CRMddXG_cKKo1cXvjMQ_iGKTNXHc \
  npx expo export --platform web --output-dir "$OUT" --clear
cd "$ROOT" && node scripts/verify-web-export.mjs "$OUT"
# verify-web-export.mjs already scans the bundle for server credentials with
# patterns that do not fire on the app's own "reject a secret key" guards.
echo "base $BASE -> $OUT"
