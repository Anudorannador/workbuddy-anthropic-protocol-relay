# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-10-22

### Changed

- The context marker in a model id is no longer limited to `-1m`: any
  `-<number>k` / `-<number>m` suffix is recognised and stripped (`-512k-high`,
  `-200k`), so a client-side budget below 1M can be labelled in the id without
  leaking into the upstream model name. Matching is case-insensitive and the
  decoded effort is lower-cased.
- Ids whose trailing token is not a context marker are left untouched
  (`gpt-4o`, `qwen2.5-72b`, `claude-haiku-5-5-high`).

## [1.2.0] - 2026-10-22

### Added

- Reasoning effort is accepted from `reasoning.effort`, the field a client with an
  effort selector actually sends (WorkBuddy writes it from
  `reasoning.supportedEfforts`). Precedence is id suffix, then `reasoning.effort`,
  then `reasoning_effort`, so one model entry per upstream model is now enough and
  the `-1m-<effort>` presets become optional rather than required.

### Changed

- `config/models.example.json` demonstrates the single-entry shape (effort chosen
  in the client), with one fixed-preset entry kept as a second example.
- README no longer implies that context length or effort must be encoded in the
  model id; `contextWindow`/`supportedLengths` are documented as client-side
  declarations that are never sent upstream.

## [1.1.1] - 2026-10-22

### Fixed

- `usage.prompt_tokens` now includes cache reads and cache writes. Anthropic
  reports `input_tokens` as the *uncached remainder* only, so a fully cached
  prompt used to report a handful of tokens (observed in production: 4 instead
  of 7775) and understated the real input size by three orders of magnitude.
  `prompt_tokens_details.cached_tokens` still reports only the cache read.
- Streaming usage is no longer lost when the gateway leaves the prompt counts out
  of `message_start` and reports them in `message_delta` instead. On the affected
  gateway every streamed reply reported `prompt_tokens: 0`, which is the path an
  agent client actually takes.

## [1.1.0] - 2026-10-21

### Added

- Prompt caching. The OpenAI schema cannot express caching, so the relay injects
  `cache_control: {type: "ephemeral"}` breakpoints itself: the system prompt
  moves into a cached text block and up to four breakpoints (three by default)
  sit on the newest turns. Controlled by `RELAY_CACHE_CONTROL` and
  `RELAY_CACHE_BREAKPOINTS`.
- `RELAY_MODEL_MAP` rewrites the model name sent upstream, applied after
  `-1m-<effort>` decoding so one entry covers every preset. `*` is a catch-all.
- `RELAY_MAX_TOKENS_MAP` and `RELAY_MAX_TOKENS` supply an output cap for clients
  that never send one. Precedence: request, map, global, 32000; clamped to
  128000.
- Startup log line reporting cache mode and map sizes. The per-request dump line
  now also reports `mapped from …` and the number of cache breakpoints.

### Changed

- `toAnthropic` accepts `modelMap`, `maxTokensMap`, `defaultMaxTokens` and
  `cacheControl`, and returns `mappedFrom` and `cacheBreakpoints`.
- Translation logic split further: `src/cache-control.mjs` and
  `src/model-options.mjs`, both pure and dependency free.
- Unit tests: 31 to 60.

## [1.0.0] - 2026-10-21

### Added

- Bidirectional translation between OpenAI Chat Completions and Anthropic
  Messages, for both streaming and non-streaming responses.
- Request mapping: system/developer merging, role-alternation normalisation,
  tools and `input_schema`, legacy `functions`/`function_call`, `tool_choice`,
  `parallel_tool_calls`, assistant `tool_calls`, `role:"tool"` results, base64
  and remote images, PDF documents, sampling parameters, stop sequences,
  `reasoning_effort`, and `response_format` emulation.
- Response mapping: `content_block_delta` to `delta.content`, thinking deltas to
  `reasoning_content`, `tool_use` to accumulating `tool_calls`, `stop_reason` to
  `finish_reason`, usage with cached-token detail, and a single `[DONE]`
  terminator.
- Model id convention `<model>-1m-<effort>` with a `raw:` escape hatch.
- Loopback-only HTTP server with a `/_health` endpoint and a 64 MiB body cap.
- Startup, shutdown, status scripts and a macOS background-app builder.
- 31 unit tests covering both translation directions.
- Documentation: protocol mapping table, deployment guide, troubleshooting.

### Notes

- Parameters with no upstream equivalent (`presence_penalty`,
  `frequency_penalty`, `logit_bias`, `seed`, `logprobs`, `top_logprobs`, `n`,
  `stream_options`) are dropped deliberately instead of forwarded.
- `tool_choice` forcing is translated but not honoured by every gateway.
