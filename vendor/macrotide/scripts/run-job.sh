#!/usr/bin/env bash
# Run a macrotide job as a ONE-OFF container instead of `docker exec` into the
# live app container — so an app redeploy (`docker compose up --build`) can never
# SIGKILL an in-flight job. (Issue #115: a mid-crawl deploy recreated the app
# container and killed three nightly catalog refreshes; confirmed via dockerd
# events.)
#
# The job shares the app's image, env_file (.env.local) and ./data volume via the
# compose `macrotide` service definition; `run --rm` spins an ephemeral container,
# overrides the image CMD (`npm run start`) with the script, and removes the
# container on exit. `--no-deps` keeps it from touching the running app service.
# The host systemd timers call this instead of `docker exec`.
#
# Usage (run from anywhere; resolves the compose dir itself):
#   scripts/run-job.sh <script-basename> [args…]
#   e.g.  scripts/run-job.sh refresh-fund-catalog
#         scripts/run-job.sh prewarm-nav --range=1mo --retail-only
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <script-basename> [args…]" >&2
  exit 2
fi

job="$1"
shift
cd "$(dirname "$0")/.." # repo root = the compose project dir

# Node defaults its heap to ~half the container's 3GB cap, so a growing job
# would OOM at ~1.5GB with half its memory unused. Pin the heap just under the
# cap — a ceiling, not a reservation, so it costs nothing while jobs stay small.
#
# The in-container wrapper reads cgroup v2's memory.peak after the script exits,
# so every run ends with a greppable summary line (journalctl -t or unit logs):
#   job-summary: job=<name> exit=<code> duration=<s>s peak_mem=<MB>MB
# Memory creep then shows up in logs long before it becomes an OOM.
start=$(date +%s)
docker compose run --rm --no-deps -e NODE_OPTIONS=--max-old-space-size=2560 macrotide \
  sh -c 'npx tsx --tsconfig tsconfig.scripts.json "$@"; ec=$?;
    peak=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null);
    if [ -n "$peak" ]; then echo "job-peak-mem: $((peak / 1048576))MB"; else echo "job-peak-mem: n/a"; fi;
    exit $ec' \
  sh "scripts/${job}.ts" "$@"
ec=$?
echo "job-summary: job=${job} exit=${ec} duration=$(( $(date +%s) - start ))s"
exit $ec
