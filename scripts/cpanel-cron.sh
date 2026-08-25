#!/bin/bash
# =============================================================================
# XIT Token — Daily ROI cron (12:00 AM India / IST)
# =============================================================================
#
# cPanel → Cron Jobs → Add New Cron Job
#
#   Minute:  30
#   Hour:    18
#   Day:     *
#   Month:   *
#   Weekday: *
#
# (Server timezone must be UTC — 18:30 UTC = 00:00 IST midnight)
#
# Command (replace USER and path with your account):
#   /bin/bash /home/USER/back.xittoken.co/scripts/cpanel-cron.sh
#
# Server .env required:
#   AUTO_ROI_CRON=false
#   CRON_SECRET=your_strong_secret
# =============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/cron.log"
API_URL="${CRON_API_URL:-https://back.xittoken.co/api/cron/daily-payout}"

mkdir -p "$LOG_DIR"
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*" | tee -a "$LOG_FILE"
}

get_env() {
  local key="$1"
  local file="$APP_DIR/.env"
  if [ ! -f "$file" ]; then
    echo ""
    return
  fi
  grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- | tr -d '\r' | sed 's/^["'\'']//;s/["'\'']$//'
}

log "==== Daily payout cron (12 AM IST) started ===="
cd "$APP_DIR" || {
  log "ERROR: cannot cd to $APP_DIR"
  exit 1
}

SECRET="$(get_env CRON_SECRET)"

if [ -z "$SECRET" ]; then
  log "ERROR: CRON_SECRET missing in $APP_DIR/.env — aborting (no Node fallback to avoid double runs)"
  exit 1
fi

TMP_BODY="$(mktemp 2>/dev/null || echo "$LOG_DIR/.cron_last_response.txt")"
HTTP_CODE="$(curl -sS --max-time 180 -o "$TMP_BODY" -w "%{http_code}" "${API_URL}?secret=${SECRET}" 2>>"$LOG_FILE")" || HTTP_CODE="000"
RESPONSE="$(cat "$TMP_BODY" 2>/dev/null || true)"
rm -f "$TMP_BODY" 2>/dev/null || true

log "HTTP $HTTP_CODE — $API_URL"
log "$RESPONSE"

if [ "$HTTP_CODE" = "200" ]; then
  log "==== Cron finished OK (HTTP 200) ===="
  exit 0
fi

log "ERROR: Cron HTTP call failed (code $HTTP_CODE). Fix API URL / CRON_SECRET / server."
exit 1
