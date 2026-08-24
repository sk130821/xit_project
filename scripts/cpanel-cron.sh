#!/bin/bash
# XIT Token — cPanel daily ROI cron
# Paste this as Command:
#   /bin/bash /home/virajnandani/xit.back.virajnandanigold.com/scripts/cpanel-cron.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/cron.log"
API_URL="https://xit.back.virajnandanigold.com/api/cron/daily-payout"

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

log "==== Daily payout cron started ===="
cd "$APP_DIR" || {
  log "ERROR: cannot cd to $APP_DIR"
  exit 1
}

SECRET="$(get_env CRON_SECRET)"

if [ -n "$SECRET" ]; then
  log "Calling $API_URL"
  RESPONSE="$(curl -sS --max-time 180 "${API_URL}?secret=${SECRET}" 2>&1)" || true
  log "$RESPONSE"
  if echo "$RESPONSE" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
    log "==== Cron finished OK (HTTP) ===="
    exit 0
  fi
  log "HTTP cron did not return ok — trying Node fallback"
else
  log "CRON_SECRET missing in .env — trying Node fallback"
fi

HOME_DIR="$(dirname "$APP_DIR")"
APP_NAME="$(basename "$APP_DIR")"
NODE_BIN=""

for candidate in \
  "$HOME_DIR/nodevenv/$APP_NAME"/20/bin/node \
  "$HOME_DIR/nodevenv/$APP_NAME"/18/bin/node \
  "$HOME_DIR/nodevenv/$APP_NAME"/*/bin/node \
  /opt/alt/alt-nodejs20/root/usr/bin/node \
  /opt/alt/alt-nodejs18/root/usr/bin/node \
  /usr/bin/node
do
  if [ -x "$candidate" ]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [ -z "$NODE_BIN" ]; then
  log "ERROR: Node binary not found and HTTP cron failed"
  exit 1
fi

log "Running $NODE_BIN scripts/cpanelCron.js"
"$NODE_BIN" "$APP_DIR/scripts/cpanelCron.js" >> "$LOG_FILE" 2>&1
STATUS=$?
log "==== Cron finished (Node exit $STATUS) ===="
exit $STATUS
