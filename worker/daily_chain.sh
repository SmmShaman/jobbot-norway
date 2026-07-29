#!/usr/bin/env bash
#
# daily_chain.sh — the whole intake, once a day, in one pass.
#
# Owner's decision (2026-07-29): one scan starts everything. Until now the three
# stages were scheduled independently and did not know about each other — the
# scanner wrote jobs and went quiet, while analysis waited on a GitHub Actions
# cron that fired every six hours. A job found at 08:56 could sit unscored until
# midday. Chaining them means a vacancy is scanned, scored and queued within the
# same run, and the only thing that follows on its own schedule is the agent
# filling forms (capped at max_applications_per_day).
#
# Stages are deliberately independent: a failure in one is reported and the next
# still runs, because a broken scan should not also block scoring of yesterday's
# leftovers.
#
# Env comes from the unit: worker/.env (database, telegram) plus jobbot-analyze.env
# (GROQ_API_KEY, which worker/.env does not carry).

set -u
cd /home/stuar/Projects/Jobbot-NO || exit 1
PY=worker/venv-vps/bin/python

run() {
  local label="$1"; shift
  echo "=== ${label} ==="
  if "$@"; then
    echo "=== ${label}: ok ==="
  else
    echo "=== ${label}: FAILED (rc=$?) — continuing ==="
  fi
}

# 1a. NAV / FINN. These live behind the scheduled-scanner edge function, not the
#     Python scraper, and until 2026-07-29 they were driven only by an hourly
#     GitHub workflow that fires the scan at each user's scan_time_utc (13:28 UTC
#     for Vitalii). That is why a 10:30 chain could find LinkedIn jobs and nothing
#     from NAV: NAV simply had not been scanned yet that day. forceRun makes the
#     chain the trigger, so one run really does cover every source.
run "scan nav/finn" curl -sS -m 300 -X POST \
  "${SUPABASE_URL}/functions/v1/scheduled-scanner" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  -d '{"source":"daily-chain","forceRun":true}'
echo

# 1b. LinkedIn. The scraper reads the dashboard's own search terms and location,
#     and refuses to run twice within 10h on its own — harmless once a day.
run "scan linkedin" "$PY" worker/linkedin_scraper.py

# 2. Score everything still marked NEW (not only today's — leftovers included).
run "analyse" "$PY" worker/analyze_worker.py --limit 60

# 3. Queue: promote applications that already have a form URL, look for the ones
#    that do not. Free — no model involved.
run "queue" "$PY" worker/ats_resolver.py --limit 12

echo "=== daily chain done ==="
