# workbuddy-protocol-relay

[![ci](https://github.com/Anudorannador/workbuddy-anthropic-protocol-relay/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Anudorannador/workbuddy-anthropic-protocol-relay/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A small local relay that lets **OpenAI-only chat clients** talk to
**Anthropic-only model endpoints** — translating the request body in one
direction and the streaming response in the other.

It exists because some desktop agents (Tencent WorkBuddy among them) always
serialise custom-model traffic as OpenAI Chat Completions — including
`stream_options` — while the model gateway you actually want to use only
accepts the Anthropic Messages schema. Pointing the client straight at
`/v1/messages` produces an empty-looking stream, because the client cannot
recognise `content_block_delta` frames.

```
 ┌──────────────┐   OpenAI Chat Completions    ┌───────────────┐   Anthropic Messages   ┌──────────────────┐
 │  Desktop app │ ───────────────────────────► │ Protocol relay│ ─────────────────────► │ Model endpoint   │
 │ (OpenAI-only)│ ◄─────────────────────────── │  (loopback)   │ ◄───────────────────── │ (/v1/messages)   │
 └──────────────┘      OpenAI SSE frames       └───────────────┘  Anthropic SSE frames  └──────────────────┘
```

## Features

- **Full request translation** — `system`/`developer` merging, role alternation,
  tools and tool results, legacy `functions`, `tool_choice`, images (including
  remote URLs fetched and inlined), PDF documents, sampling parameters.
- **Full response translation** — text deltas, reasoning, accumulating
  `tool_calls`, `finish_reason`, `usage`, and `data: [DONE]`.
- **Deliberate parameter dropping** — fields the upstream rejects
  (`presence_penalty`, `logit_bias`, `n`, `stream_options`, …) are removed instead
  of being forwarded, so requests do not fail with HTTP 400.
- **Reasoning presets in the model id** — `<model>-1m-<effort>` lets a client
  that cannot set effort per request offer one entry per preset.
- **Prompt caching on by default** — OpenAI has no `cache_control`, so a client
  that speaks only OpenAI never asks for caching. The relay adds breakpoints at
  the tail of the conversation, which is what makes a long agent session
  affordable.
- **Per-model overrides** — rewrite model names and supply a `max_tokens` the
  client never sends, without editing per-client configuration.
- **Streaming-safe** — SSE frames are parsed incrementally and are resilient to
  arbitrary TCP chunk boundaries.
- **Loopback only, zero credential storage** — the relay forwards the API key
  it receives and never writes it to disk.
- **No runtime dependencies** — `node:` standard library only.

## Quick start

Requires Node.js 20 or newer.

```bash
git clone <this-repo>
cd workbuddy-protocol-relay

npm test           # 60 unit tests, no network required
npm start          # starts on http://127.0.0.1:8787
```

Health check:

```bash
curl -s http://127.0.0.1:8787/_health
# {"ok":true,"service":"workbuddy-protocol-relay","version":"1.1.1"}
```

Then point your client at `http://127.0.0.1:8787/v1/chat/completions` and supply
the upstream API key as either `x-api-key` or `Authorization: Bearer <key>`.

## Configuring a client

Most clients let you add a custom OpenAI-compatible model. See
[`config/models.example.json`](config/models.example.json) for a WorkBuddy-style
entry. The essential fields:

| Field | Value |
| --- | --- |
| `url` | `http://127.0.0.1:8787/v1/chat/completions` |
| `apiKey` | your upstream key (**do not commit this file**) |
| `useCustomProtocol` | `true` (the relay already serves the exact path) |
| `maxInputTokens` | whatever the upstream model really supports |
| `maxOutputTokens` | `128000` for current Claude 1M-context models |

Copy the example to `config/models.json` and fill in your key. That filename is
git-ignored on purpose.

### Model id convention

```
<upstream-model>-1m-<effort>
```

| Id | Upstream model | Reasoning |
| --- | --- | --- |
| `claude-haiku-5-5-1m-high` | `claude-haiku-5-5` | `high` |
| `claude-sonnet-5-5-1m` | `claude-sonnet-5-5` | upstream default |
| `raw:some-1m-model` | `some-1m-model` | none (decoding disabled) |

The effort maps to `thinking: {type: "adaptive"}` plus
`output_config: {effort: …}`. Prefix an id with `raw:` if a genuine model name
ends in `-1m`.

## Prompt caching

OpenAI's request schema has no way to say "cache this prefix", so an
OpenAI-only client re-sends the whole conversation at full price on every turn.
The relay adds `cache_control: {type: "ephemeral"}` breakpoints itself:

| Breakpoint | Where | Why |
| --- | --- | --- |
| 1 | last block of the system prompt | most stable prefix |
| 2, 3 | last block of the newest turns | grows the reusable prefix every turn |

Rules the implementation follows, because the upstream rejects anything else:

- at most **4** breakpoints per request (`RELAY_CACHE_BREAKPOINTS`)
- a breakpoint sits on a content block, never on a message
- only `text`, `image`, `document`, `tool_use` and `tool_result` are cacheable
- a prefix shorter than the model's minimum simply is not cached — that is not
  an error, so short chats behave exactly as before

Caching pays off from roughly the second turn of a conversation, and is most
visible in agent sessions that resend tens of thousands of tokens of tools and
history. Turn it off with `RELAY_CACHE_CONTROL=off` if your gateway rejects the
field.

## Per-model overrides

Two things a client often cannot express:

```bash
# rewrite the name the client asks for
RELAY_MODEL_MAP="claude-sonnet-5-5=claude-sonnet-5-5-20260101,fast=claude-haiku-5-5"

# supply max_tokens when the client omits it
RELAY_MAX_TOKENS_MAP="claude-haiku-5-5:32000,claude-opus-5-5:64000"

# global fallback for everything else
RELAY_MAX_TOKENS=32000
```

`*` works as a catch-all in both maps. Precedence for `max_tokens` is: value in
the request, then the map, then `RELAY_MAX_TOKENS`, then 32000 — always clamped
to 128000. The model map is applied **after** `-1m-<effort>` decoding, so one
entry covers every preset of that model.

## Configuration

All configuration is environment based:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAY_HOST` | `127.0.0.1` | Bind address. Do not expose publicly. |
| `RELAY_PORT` | `8787` | Bind port. |
| `RELAY_UPSTREAM_HOST` | `api.anthropic.com` | Anthropic-compatible host. |
| `RELAY_UPSTREAM_PATH` | `/v1/messages` | Messages endpoint path. |
| `RELAY_UPSTREAM_PORT` | `443` | Upstream port. |
| `RELAY_UPSTREAM_PROTO` | `https` | `https` or `http`. |
| `RELAY_DUMP` | unset | `1` logs one line per translated request. |
| `RELAY_LOG_FILE` | unset | Append logs to a file. |
| `RELAY_MODEL_MAP` | unset | `from=to,from=to` name rewriting. `*` is a catch-all. |
| `RELAY_MAX_TOKENS_MAP` | unset | `model:64000,model:32000` per-model output cap. |
| `RELAY_MAX_TOKENS` | `32000` | Fallback `max_tokens` when the request has none. |
| `RELAY_CACHE_CONTROL` | `auto` | `auto` adds prompt-cache breakpoints, `off` disables. |
| `RELAY_CACHE_BREAKPOINTS` | `3` | Breakpoints per request, clamped to 4. |
| `RELAY_NODE` | auto-detected | Absolute `node` path. Required when started by a launch agent with a minimal `PATH`. |

### Local configuration file

The scripts under `scripts/` source an optional `.env` in the repository root, so
you can keep machine-specific settings out of your shell profile:

```bash
cp .env.example .env
$EDITOR .env
```

`.env` is git-ignored. Never place an API key in it — the key always comes from
the inbound request header.

## Long-running use

```bash
./scripts/start.sh      # detached, writes .relay.pid
./scripts/stop.sh
./scripts/status.sh
```

On macOS, `./scripts/build-macos-app.sh` wraps the launcher in a background-only
`.app` bundle (no Dock icon) that can be added to **Login Items**. This is needed
because `launchd` user agents are unreliable in some managed environments.

## Security

Read [SECURITY.md](SECURITY.md) before exposing this to anything beyond your own
machine. In short:

- Binds to loopback by default and is **not** an authentication boundary.
- The upstream key travels in request headers; the relay does not persist it.
- Never commit `config/models.json`, `.env`, or anything holding a real key.

## Limitations

- `tool_choice` forcing (`{"type":"tool", "name": …}`) is translated, but some
  gateways ignore the constraint and answer in plain text instead.
- Audio input has no upstream equivalent and is replaced with a note block.
- `response_format` is emulated with a system instruction; JSON is strongly
  encouraged, not guaranteed by the API.
- One relay instance maps to one upstream endpoint and one credential per
  request. Multi-tenant routing is out of scope.

## Project layout

```
bin/relay.mjs              CLI entry point
src/relay.mjs              HTTP server, upstream forwarding
src/translate-request.mjs  OpenAI -> Anthropic
src/translate-response.mjs Anthropic -> OpenAI (stream + non-stream)
src/model-id.mjs           model id suffix decoding
src/model-options.mjs      name rewriting, max_tokens resolution
src/cache-control.mjs      prompt-cache breakpoint placement
test/                      node:test unit suites
docs/                      protocol mapping, deployment, troubleshooting
scripts/                   start / stop / status / macOS app builder
```

## Documentation

- [Protocol mapping](docs/protocol-mapping.md) — the complete field-by-field table.
- [Deployment](docs/deployment.md) — start/stop, macOS app, login item.
- [Troubleshooting](docs/troubleshooting.md) — empty streams, 400s, timeouts.

## License

MIT — see [LICENSE](LICENSE).
