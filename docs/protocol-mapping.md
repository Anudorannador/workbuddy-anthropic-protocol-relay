# Protocol mapping

Exhaustive mapping between the OpenAI Chat Completions API and the Anthropic
Messages API, as implemented by `src/translate-request.mjs` and
`src/translate-response.mjs`.

## Request: OpenAI → Anthropic

| OpenAI field | Anthropic field | Notes |
| --- | --- | --- |
| `model` | `model` | `-1m[-<effort>]` suffix stripped; `raw:` disables decoding |
| `messages[role=system\|developer]` | `system` | All occurrences joined with a blank line |
| `messages[role=user\|assistant]` | `messages` | Converted to content-block arrays |
| adjacent same-role messages | merged | Anthropic requires alternating roles |
| leading assistant turn | seeded user turn | Anthropic requires the first turn to be `user` |
| `messages[].content` (string) | `[{type:"text",text}]` | Empty strings are dropped |
| `content[].type=text` | `{type:"text"}` | |
| `content[].type=image_url` (data URL) | `{type:"image",source:{type:"base64"}}` | Media type parsed from the data URL |
| `content[].type=image_url` (http/https) | fetched, then base64 | Anthropic does not accept URL sources |
| `content[].type=file` (PDF data URL) | `{type:"document",source:{type:"base64"}}` | |
| `content[].type=file` (other types) | text note | Unsupported upstream |
| `content[].type=input_audio\|audio` | text note | No upstream equivalent |
| `assistant.tool_calls[]` | `{type:"tool_use", id, name, input}` | `arguments` JSON-parsed; unparsable input kept as `{_raw}` |
| `messages[role=tool]` | `{type:"tool_result", tool_use_id, content}` | Consecutive results merged into one user turn |
| `tools[type=function]` | `tools[{name, description, input_schema}]` | `parameters` → `input_schema` |
| `functions` / `function_call` (legacy) | promoted to `tools` / `tool_choice` | |
| `tool_choice="auto"` | `{type:"auto"}` | |
| `tool_choice="required"` or `"any"` | `{type:"any"}` | |
| `tool_choice="none"` | `{type:"none"}` | |
| `tool_choice={type:"function",…}` | `{type:"tool", name}` | |
| `parallel_tool_calls=false` | `tool_choice.disable_parallel_tool_use=true` | |
| `max_tokens` / `max_completion_tokens` | `max_tokens` | Default 32000, capped at 128000 |
| `stop` (string or array) | `stop_sequences` | |
| `temperature`, `top_p`, `top_k` | same names | Passed through |
| `user` | `metadata.user_id` | |
| `reasoning_effort` | `thinking:{type:"adaptive"}` + `output_config.effort` | `minimal` → `low` |
| `response_format={type:"json_object"}` | system instruction | No native JSON mode upstream |
| `response_format={type:"json_schema"}` | system instruction + schema | |
| `stream` | `stream` | |
| `stream_options.include_usage` | *control flag only* | Enables the trailing usage chunk in the response |

### Dropped parameters

These are removed before forwarding. Sending them to the upstream would fail the
request with HTTP 400:

`presence_penalty`, `frequency_penalty`, `logit_bias`, `seed`, `logprobs`,
`top_logprobs`, `n`, `stream_options`, `parallel_tool_calls`, `response_format`.

## Response: Anthropic → OpenAI

### Streaming (SSE)

| Anthropic event | Emitted OpenAI chunk |
| --- | --- |
| `message_start` | `delta: {role:"assistant", content:""}`; captures `input_tokens` and `cache_read_input_tokens` |
| `content_block_start` (`text`, non-empty) | `delta.content` |
| `content_block_start` (`tool_use`) | `delta.tool_calls[{index, id, type:"function", function:{name, arguments:""}}]` |
| `content_block_delta` (`text_delta`) | `delta.content` |
| `content_block_delta` (`thinking_delta`) | `delta.reasoning_content` |
| `content_block_delta` (`input_json_delta`) | `delta.tool_calls[index].function.arguments` |
| `message_delta` | Updates `finish_reason` and `output_tokens` |
| `message_stop` | Terminal chunk with `finish_reason`, optional usage chunk, then `data: [DONE]` |
| `error` | An error object chunk, then `data: [DONE]` |
| `ping` | Ignored |

`finish_reason` mapping:

| Anthropic `stop_reason` | OpenAI `finish_reason` |
| --- | --- |
| `end_turn` | `stop` |
| `stop_sequence` | `stop` |
| `tool_use` | `tool_calls` |
| `max_tokens` | `length` |
| `model_context_window_exceeded` | `length` |
| `refusal` | `content_filter` |

### Non-streaming

| Anthropic field | OpenAI field |
| --- | --- |
| `content[type=text]` joined | `choices[0].message.content` |
| `content[type=thinking]` joined | `choices[0].message.reasoning_content` |
| `content[type=tool_use]` | `choices[0].message.tool_calls[]` (content becomes `null` when only tools are returned) |
| `stop_reason` | `choices[0].finish_reason` |
| `usage.input_tokens` | `usage.prompt_tokens` |
| `usage.output_tokens` | `usage.completion_tokens` |
| `usage.cache_read_input_tokens` | `usage.prompt_tokens_details.cached_tokens` |

## Error mapping

Every non-2xx upstream response is re-emitted with the OpenAI error envelope:

```json
{ "error": { "message": "...", "type": "invalid_request_error", "code": 400 } }
```

| Situation | Status |
| --- | --- |
| Invalid JSON from the client | 400 |
| Body exceeds `maxBodyBytes` (64 MiB) | 413 |
| Request translation threw | 500 |
| Upstream connection failed | 502 |
| Upstream non-200 | Upstream status, preserved |

## Fields the relay injects that the client never sent

OpenAI's schema has no equivalent for these, so the relay supplies them when
the corresponding feature is enabled.

| Upstream field | Source | Notes |
| --- | --- | --- |
| `system` as a block array | a plain `string` system prompt | only when caching is on; the text moves into one `text` block so it can carry `cache_control` |
| `cache_control: {type: "ephemeral"}` | placed by the relay | up to 4 per request; last block of the system prompt, then the newest turns |
| `max_tokens` | `RELAY_MAX_TOKENS_MAP`, `RELAY_MAX_TOKENS`, or 32000 | clamped to 128000 |
| `model` | `RELAY_MODEL_MAP` | applied after `-1m-<effort>` decoding |
| `thinking` + `output_config` | `-1m-<effort>` suffix or `reasoning_effort` | `{type: "adaptive"}` and `{effort: …}` |

Because `cache_control` is a field the upstream validates rather than ignores,
caching is the one injection that can fail on a strict gateway. `RELAY_CACHE_CONTROL=off`
restores the plain-string system prompt.
