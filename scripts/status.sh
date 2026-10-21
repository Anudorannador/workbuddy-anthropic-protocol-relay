#!/usr/bin/env bash
# Print relay health, or report that it is down.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${RELAY_PORT:-8787}"
HOST="${RELAY_HOST:-127.0.0.1}"

if curl -fsS -m 3 "http://$HOST:$PORT/_health" 2>/dev/null; then
  echo
  exit 0
fi

echo "relay is not responding on http://$HOST:$PORT" >&2

if [ -f "$DIR/.relay.pid" ]; then
  echo "pid file: $(cat "$DIR/.relay.pid")" >&2
fi
if [ -f "$DIR/relay.log" ]; then
  echo "last log lines:" >&2
  tail -10 "$DIR/relay.log" >&2
fi
exit 1
