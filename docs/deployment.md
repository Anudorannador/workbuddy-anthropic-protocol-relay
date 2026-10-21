# Deployment

## Requirements

- Node.js 20 or newer
- Network access to your Anthropic-compatible endpoint

## Run in the foreground

```bash
npm start
```

Logs go to stdout. Press `Ctrl+C` to stop; the process closes the listener
gracefully.

## Run detached

```bash
./scripts/start.sh    # writes .relay.pid, logs to relay.log
./scripts/status.sh   # prints the health payload
./scripts/stop.sh     # SIGTERM, then SIGKILL after a short grace period
```

`start.sh` is idempotent: if the pid file points at a live process it exits 0
without spawning a second instance.

## macOS login item

Some managed macOS environments cannot load `launchd` user agents
(`launchctl bootstrap` fails with `Input/output error`). For those machines the
repository ships an app-bundle builder:

```bash
./scripts/build-macos-app.sh
open dist/WorkBuddyRelay.app
```

The bundle is background-only (`LSUIElement`), ad-hoc signed, and starts the
relay through `scripts/start.sh`. Add it to **System Settings → General → Login
Items** to start the relay at login.

If `launchd` does work on your machine, a plain user agent is a cleaner option:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string><string>node</string>
    <string>/absolute/path/to/bin/relay.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>RELAY_PORT</key><string>8787</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

## systemd (Linux)

```ini
[Unit]
Description=workbuddy-protocol-relay
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/relay/bin/relay.mjs
Environment=RELAY_PORT=8787
Restart=on-failure
User=relay

[Install]
WantedBy=default.target
```

## Reverse proxy

The relay speaks plain HTTP/1.1. If you must put it behind a reverse proxy,
disable response buffering so SSE frames reach the client immediately. Nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

## Verification

```bash
curl -s http://127.0.0.1:8787/_health
```

Then send a minimal streamed request:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "x-api-key: $UPSTREAM_KEY" \
  -d '{"model":"claude-haiku-5-5-1m-high","stream":true,
       "messages":[{"role":"user","content":"say OK"}]}'
```

Expect `data: {...delta.content":"OK"}` followed by `data: [DONE]`.

## Upgrades

```bash
git pull
npm test
./scripts/stop.sh && ./scripts/start.sh
```

No build step and no dependencies, so an upgrade is a restart.
