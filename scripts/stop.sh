#!/usr/bin/env bash
# Stop the relay started by start.sh.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="$DIR/.relay.pid"

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
    echo "stopped pid $PID"
  else
    echo "stale pid file"
  fi
  rm -f "$PIDFILE"
else
  echo "no pid file; nothing started by start.sh"
fi

if pgrep -f "bin/relay.mjs" >/dev/null 2>&1; then
  pkill -f "bin/relay.mjs" 2>/dev/null || true
  echo "terminated remaining relay processes"
fi
