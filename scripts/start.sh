#!/usr/bin/env bash
# Start the relay detached. Idempotent: exits 0 if it is already healthy.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Optional local configuration (git-ignored). Never commit this file.
if [ -f "$DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$DIR/.env"
  set +a
fi

PORT="${RELAY_PORT:-8787}"
HOST="${RELAY_HOST:-127.0.0.1}"
PIDFILE="$DIR/.relay.pid"
LOGFILE="${RELAY_LOG_FILE:-$DIR/relay.log}"

# Resolve a Node binary. Launch agents run with a minimal PATH, so probe the
# usual install locations and allow an explicit override via RELAY_NODE.
resolve_node() {
  if [ -n "${RELAY_NODE:-}" ] && [ -x "$RELAY_NODE" ]; then
    printf '%s\n' "$RELAY_NODE"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.workbuddy/binaries/node/versions/*/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(resolve_node)" || {
  echo "error: node not found; set RELAY_NODE to an absolute node path" >&2
  exit 1
}

if curl -fsS -m 2 "http://$HOST:$PORT/_health" >/dev/null 2>&1; then
  echo "already running on http://$HOST:$PORT"
  exit 0
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running (pid $(cat "$PIDFILE"))"
  exit 0
fi

cd "$DIR"
nohup "$NODE_BIN" bin/relay.mjs >>"$LOGFILE" 2>&1 &
echo $! >"$PIDFILE"
sleep 1

if curl -fsS -m 3 "http://$HOST:$PORT/_health" >/dev/null 2>&1; then
  echo "started pid $(cat "$PIDFILE") on http://$HOST:$PORT (log: $LOGFILE)"
else
  echo "failed to start; last log lines:" >&2
  tail -20 "$LOGFILE" >&2 || true
  exit 1
fi
