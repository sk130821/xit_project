#!/bin/bash
# XIT Token — Daily ROI cron (12:00 AM IST = 30 18 * * * on UTC servers)
# cPanel command:
#   /bin/bash /home/xittoken/back.xittoken.co/scripts/cpanel-cron.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/cron.log"
API_URL="${CRON_API_URL:-https://back.xittoken.co/api/cron/daily-payout}"

# cPanel cron has minimal PATH
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

CURL_BIN=""
for c in /usr/bin/curl /usr/local/bin/curl curl; do
  if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then
    CURL_BIN="$c"
    break
  fi
done

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

resolve_secret() {
  # 1) export CRON_SECRET=... in cron command
  if [ -n "${CRON_SECRET:-}" ]; then
    echo "$CRON_SECRET"
    return
  fi
  # 2) physical .env file (cPanel Node UI vars do NOT write here automatically)
  get_env CRON_SECRET
}

log "==== Daily payout cron started ===="
log "APP_DIR=$APP_DIR"
log "Server time: $(date)"

cd "$APP_DIR" || {
  log "ERROR: cannot cd to $APP_DIR"
  exit 1
}

SECRET="$(resolve_secret)"
if [ -z "$SECRET" ]; then
  if [ ! -f "$APP_DIR/.env" ]; then
    log "ERROR: .env file not found at $APP_DIR/.env"
  else
    log "ERROR: CRON_SECRET not found"
  fi
  log "NOTE: cPanel → Node.js → Environment Variables is NOT the same as .env file"
  log "FIX: Run on server:"
  log "  echo 'CRON_SECRET=your_cron_secret_sandeep' >> $APP_DIR/.env"
  log "Use the SAME value as in cPanel Environment Variables, then Restart Node app"
  exit 1
fi
log "CRON_SECRET: set (${#SECRET} chars)"

run_node_fallback() {
  local NODE_BIN=""
  local HOME_DIR
  HOME_DIR="$(dirname "$APP_DIR")"
  local APP_NAME
  APP_NAME="$(basename "$APP_DIR")"

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
    log "ERROR: Node binary not found for fallback"
    return 1
  fi

  log "Running Node fallback: $NODE_BIN scripts/cpanelCron.js"
  CRON_SECRET="$SECRET" "$NODE_BIN" "$APP_DIR/scripts/cpanelCron.js" >> "$LOG_FILE" 2>&1
  return $?
}

if [ -n "$CURL_BIN" ]; then
  TMP_BODY="$LOG_DIR/.cron_last_response.txt"
  HTTP_CODE="$("$CURL_BIN" -sS --max-time 180 \
    -o "$TMP_BODY" \
    -w "%{http_code}" \
    -H "x-cron-secret: ${SECRET}" \
    "${API_URL}?secret=${SECRET}" 2>>"$LOG_FILE")" || HTTP_CODE="000"
  RESPONSE="$(cat "$TMP_BODY" 2>/dev/null || true)"

  log "HTTP $HTTP_CODE — $API_URL"
  log "$RESPONSE"

  if [ "$HTTP_CODE" = "200" ]; then
    log "==== Cron finished OK (HTTP) ===="
    exit 0
  fi

  if [ "$HTTP_CODE" = "401" ]; then
    log "ERROR: Invalid CRON_SECRET — fix .env on server (must match exactly)"
    exit 1
  fi

  if [ "$HTTP_CODE" = "503" ]; then
    log "ERROR: CRON_SECRET not loaded in Node app — restart Node application in cPanel"
    exit 1
  fi

  log "HTTP cron failed (code $HTTP_CODE) — trying Node fallback once"
else
  log "curl not found — using Node fallback"
fi

if run_node_fallback; then
  log "==== Cron finished OK (Node) ===="
  exit 0
fi

log "==== Cron FAILED ===="
exit 1
