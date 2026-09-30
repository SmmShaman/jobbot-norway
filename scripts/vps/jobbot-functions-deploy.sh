#!/usr/bin/env bash
# jobbot-functions-deploy.sh — pull-based deployer for the self-hosted Edge Functions.
#
# WHY (2026-09-30). The self-hosted Supabase stack (~/supabase-selfhost) has no
# `supabase functions deploy`; a push touching supabase/functions/** never reached the
# runtime until someone copied the files by hand (DEPLOY GAP in the runbook). The
# GitHub Action that deployed to the managed project is dead (project removed).
# Same design as portfolio-functions-deploy.sh in vitalii-no-platform.
#
# WHAT. Fast-forward the VPS clone to origin/main (never over local edits: an agent
# may be working in this clone), rsync supabase/functions into the stack's volume by
# checksum, and restart the functions container only when something changed.
# Idempotent: it deploys on content drift, not on commit ids.
#
# Runs on the VPS as user stuar every 5 minutes (jobbot-functions-deploy.timer).
set -uo pipefail

CLONE=/home/stuar/Projects/Jobbot-NO
STACK=/home/stuar/supabase-selfhost
VOLUME="$STACK/volumes/functions"
LOG=/home/stuar/jobbot-functions-deploy.log

log() { printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"; }

cd "$CLONE" || { log "FATAL clone missing: $CLONE"; exit 1; }

git fetch --quiet origin main || log "WARN git fetch failed, continuing with local state"

local_head=$(git rev-parse HEAD)
remote_head=$(git rev-parse origin/main)

if [ "$local_head" != "$remote_head" ]; then
  # Untracked files (form-filling site notes, worker logs) do not block a pull;
  # modified tracked files or a diverged history do.
  if git diff --quiet && git diff --cached --quiet \
     && git merge-base --is-ancestor "$local_head" "$remote_head"; then
    if git merge --ff-only --quiet origin/main; then
      log "pulled ${local_head:0:7} -> ${remote_head:0:7}"
    else
      log "ERROR ff-only merge failed"
    fi
  else
    log "SKIP pull: clone dirty or diverged (HEAD=${local_head:0:7} origin=${remote_head:0:7})"
  fi
fi

# No --delete: volumes/functions/main (the edge-runtime router) and hello/ live only
# on the VPS. Deleting main boot-errors the whole functions container.
changed=$(rsync -rc --out-format='%n' --exclude='main/' \
  "$CLONE/supabase/functions/" "$VOLUME/")

if [ -z "$changed" ]; then
  exit 0
fi

log "synced: $(echo "$changed" | tr '\n' ' ')"

cd "$STACK" || { log "FATAL stack missing: $STACK"; exit 1; }
if docker compose -p supabase restart functions >>"$LOG" 2>&1; then
  log "restarted functions"
else
  log "ERROR restart failed"
  exit 1
fi

sleep 8
log "container: $(docker ps --filter name=supabase-edge-functions --format '{{.Status}}')"
