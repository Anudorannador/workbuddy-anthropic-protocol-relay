#!/usr/bin/env bash
# Start the relay detached. Idempotent: exits 0 if it is already healthy.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${RELAY_PORT:-8787}"
HOST="${RELAY_HOST:-127.0.0.1}"
PIDFILE="$DIR/.relay.pid"
LOGFILE="${RELAY_LOG_FILE:-$DIR/relay.log}"

command -v node >/dev/null 2>&1 || { echo "error: node not found in PATH" >&2; exit 1; }

if curl -fsS -m 2 "http://$HOST:$PORT/_health" >/dev/null 2>&1; then
  echo "already running on http://$HOST:$PORT"
  exit 0
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running (pid $(cat "$PIDFILE"))"
  exit 0
fi

cd "$DIR"
nohup node bin/relay.mjs >>"$LOGFILE" 2>&1 &
echo $! >"$PIDFILE"
sleep 1

if curl -fsS -m 3 "http://$HOST:$PORT/_health" >/dev/null 2>&1; then
  echo "started pid $(cat "$PIDFILE") on http://$HOST:$PORT (log: $LOGFILE)"
else
  echo "failed to start; last log lines:" >&2
  tail -20 "$LOGFILE" >&2 || true
  exit 1
fi
