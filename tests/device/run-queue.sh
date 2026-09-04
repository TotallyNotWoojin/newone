#!/bin/zsh
# Queue runner: waits for any in-flight suite run to finish, then runs the
# remaining areas back to back, one device job at a time, pausing between
# runs until the host is calm and no stray Maestro JVMs remain.
#   zsh tests/device/run-queue.sh "translation --pool 2" "groups --pool 3" ...
cd "$(dirname "$0")/../.."
S=${QUEUE_LOG_DIR:-tests/device/.artifacts}
mkdir -p "$S"
say() { echo "[$(date +%H:%M:%S)] $*"; }
wait_calm() {
  for i in $(seq 1 60); do
    # Count real runner processes only (a shell whose command line mentions
    # the script would otherwise match itself).
    running=$(ps -Ao command | grep -c "^node .*run-suite\.mjs")
    L=$(uptime | sed 's/.*load averages: //' | awk '{print int($1)}')
    if [ "$running" = "0" ] && [ "$L" -lt "${MAX_LOAD:-60}" ]; then return 0; fi
    say "waiting: running=$running load=$L"
    sleep 60
  done
}
for spec in "$@"; do
  wait_calm
  pkill -9 -f "maestro|java" 2>/dev/null; sleep 2
  say "START $spec"
  node tests/device/run-suite.mjs --areas ${=spec} > "$S/queue-${spec%% *}.log" 2>&1
  code=$?
  R=$(ls -td tests/device/.artifacts/run-* | head -1)
  say "DONE $spec exit=$code -> $R"
  grep -E "^\*\*Totals" "$R/report.md" 2>/dev/null
  grep -E "\*\*(FAIL)\*\*" "$R/report.md" 2>/dev/null | cut -d'|' -f2-5 | cut -c1-140
done
say "QUEUE FINISHED"
