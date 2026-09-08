#!/usr/bin/env bash
# jobbot-agent-rotate.sh — keep the fill agent's conversation below the cliff.
#
# WHY (2026-09-08). The nanoclaw agent (nanoclaw-v2-jobbot-*) keeps one Claude Code
# conversation across wakes. Compaction is reactive (runs DURING a turn once the
# window is full) but a wake is greedy (reads the whole tail first), so when the
# tail after the last `compact_boundary` outgrows the window the agent can no
# longer open the conversation at all: every wake ends in "Prompt is too long".
# Measured: dead at 0.73 MB (05.09), dead at 0.70 MB (08.09, Promon run); each
# application adds ~130-140k tokens, so the cliff comes back within ~5 rows.
# The portfolio factory solved the same thing with fresh_session() before every
# wave (commit 76547e9 there). This is the jobbot equivalent, run by a timer.
#
# WHAT. When the tail is above ROTATE_TAIL_MB and the agent is idle (its last
# wake has produced a Result), move the transcript to <sid>-ROTATED-<stamp>.jsonl.bak
# and delete the session pointer. The next wake answers "No conversation found"
# and the runner clears its continuation; the wake after that starts clean. Two
# empty ticks (~10 min) is the whole cost. Nothing is deleted: the .bak stays.
#
# Runs on the VPS as user stuar every 5 minutes (jobbot-agent-rotate.timer).
set -u
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
BASE="${JOBBOT_AGENT_BASE:-/home/stuar/nanoclaw-v2/data/v2-sessions/ag-1784275710688-s87c7v/.claude-shared}"
PROJ="$BASE/projects/-workspace-agent"
SESS="$BASE/sessions"
LIMIT_MB="${ROTATE_TAIL_MB:-0.25}"
LOG="${ROTATE_LOG:-/home/stuar/jobbot-agent-rotate.log}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

log() { echo "$(date -u +%FT%TZ) $*" >>"$LOG"; }

# newest live transcript (rotated ones carry ROTATED in the name and live one dir up)
JSONL=$(ls -t "$PROJ"/*.jsonl 2>/dev/null | grep -v ROTATED | head -1)
[ -z "$JSONL" ] && exit 0

TAIL_MB=$(python3 - "$JSONL" <<'EOF'
import sys
data = open(sys.argv[1], "rb").read()
i = data.rfind(b"compact_boundary")
tail = len(data) - (i if i >= 0 else 0)
print(f"{tail/1e6:.2f}")
EOF
)
over=$(python3 -c "import sys; print(1 if float('$TAIL_MB') > float('$LIMIT_MB') else 0)")
[ "$over" = "1" ] || exit 0

# Idle? The agent is busy when its last wake has no Result after it.
C=$(docker ps --format '{{.Names}}' | grep '^nanoclaw-v2-jobbot' | head -1)
if [ -n "$C" ]; then
  last=$(docker logs --since 120m "$C" 2>&1 | grep -E 'wakeAgent=true|Result:' | tail -1)
  case "$last" in
    *wakeAgent=true*) log "tail ${TAIL_MB} MB > ${LIMIT_MB} but agent busy (last line: wake) — wait"; exit 0;;
  esac
fi

sid=$(basename "$JSONL" .jsonl)
if [ "$DRY" = "1" ]; then
  echo "DRY-RUN: would rotate ${sid} (tail ${TAIL_MB} MB > ${LIMIT_MB} MB), agent idle"; exit 0
fi
mv "$JSONL" "$BASE/projects/${sid}-ROTATED-${STAMP}.jsonl.bak" || { log "mv failed for $JSONL"; exit 1; }
rm -f "$SESS"/*.json
log "ROTATED ${sid} (tail ${TAIL_MB} MB > ${LIMIT_MB} MB) -> projects/${sid}-ROTATED-${STAMP}.jsonl.bak; next two wakes will be empty"
# Tell the tech bot so the two empty wakes are not read as a failure.
# The unit loads worker/.env + ENV-FILES/jobbot-analyze.env (same as jobbot-daily).
TOKEN="${TELEGRAM_TECH_BOT_TOKEN:-}"; CHAT="${TELEGRAM_TECH_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}"
if [ -z "$CHAT" ] && [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_KEY:-}" ]; then
  # neither env file carries a chat id; the analyzer sends tech messages to the
  # owner's own telegram_chat_id — do the same
  CHAT=$(curl -s -m 15 "${SUPABASE_URL}/rest/v1/user_settings?select=telegram_chat_id&user_id=eq.${JOBBOT_OWNER_USER_ID:-f92ee73e-786a-4990-b434-23f67203eb53}"     -H "apikey: ${SUPABASE_SERVICE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" | sed -n 's/.*"telegram_chat_id":"\{0,1\}\([0-9-]*\).*/\1/p')
fi
if true; then
  if [ -n "$TOKEN" ] && [ -n "$CHAT" ]; then
    curl -s -m 15 "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${CHAT}" \
      --data-urlencode "text=🔄 Розмову агента заповнення ротовано (хвіст ${TAIL_MB} МБ > ${LIMIT_MB}). Наступні два пробудження будуть порожні — це не збій." >/dev/null
  fi
fi
exit 0
