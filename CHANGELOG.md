# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
