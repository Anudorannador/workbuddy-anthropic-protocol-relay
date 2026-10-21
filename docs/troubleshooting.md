# Troubleshooting

Start here: run with `RELAY_DUMP=1` and watch one request line.

```
claude-haiku-5-5-1m-high -> claude-haiku-5-5 effort=high max=32000 msgs=3(ua u) system=y tools=4 tool_choice=auto stream=true
```

If that line never appears, the client is not reaching the relay. If it appears
with a suspicious shape (wrong model, no tools, `max=32000`), the translation is
the problem. If it appears correct, the upstream or the client parser is.

## The client shows no reply at all

**Symptom** — `Empty stream: upstream gateway sent only placeholder chunks
(chunks=0, bytes=0, elapsed=0ms)` or a silently stalled message.

**Cause** — the client is parsing OpenAI SSE but received Anthropic SSE. This
happens when a model URL points at `/v1/messages` instead of the relay.

**Fix** — set the model `url` to `http://127.0.0.1:8787/v1/chat/completions` and
restart the client. Some clients cache the model list, so a full restart is
required.

## HTTP 400 from the upstream

**Symptom** — `{"error":{"message":"...invalid request..."}}`.

**Cause** — a field that the upstream does not accept reached it, or the message
sequence violates a rule.

**Check**

1. Is the error about `thinking`? Some models only accept
   `thinking:{type:"adaptive"}`. The relay emits adaptive whenever an effort is
   present; remove the `-<effort>` suffix to send no reasoning at all.
2. Is it about `tools`? Ensure the client sends `parameters`, not
   `input_schema`, so the relay can map it.
3. Is it about message roles? The relay merges same-role turns and seeds a
   leading user turn, but an empty `messages` array is still invalid.

## HTTP 401 / 403

**Cause** — the key never reached the upstream.

**Check** — the relay forwards `x-api-key` or `Authorization: Bearer …`. If your
client injects the key elsewhere, add a header rewrite at the client or send the
key explicitly:

```bash
curl -H "x-api-key: $KEY" http://127.0.0.1:8787/v1/chat/completions ...
```

## HTTP 502

| Body | Meaning |
| --- | --- |
| `upstream connection failed: …` | DNS, TLS, or the upstream host is unreachable |
| `upstream response parse failed: …` | Upstream returned non-JSON for a non-stream request |
| `request translation failed: …` | Malformed input the translator could not map |

Check `RELAY_UPSTREAM_HOST` and outbound connectivity first.

## Tools are never called

1. Confirm the request line shows a non-zero `tools=` count.
2. Confirm the upstream actually returns `stop_reason: tool_use`. If it returns
   text, the model chose not to call a tool; `tool_choice` forcing is not
   honoured by every gateway.
3. Make sure the client sends `role:"tool"` messages with a `tool_call_id` that
   matches the `id` it received in `tool_calls`.

## No reasoning output

- The response only contains `reasoning_content` when the upstream emits
  `thinking_delta` events.
- Some clients ignore `reasoning_content` entirely; the text answer still works.
- If you need reasoning guaranteed, keep the `-<effort>` suffix on the model id.

## Streams cut off at ~60 seconds

A proxy or load balancer in front of the relay is buffering or timing out. Set
`proxy_buffering off` and raise `proxy_read_timeout` (see
[deployment](deployment.md#reverse-proxy)).

## Images are ignored

- Base64 data URLs are translated directly.
- Remote URLs are fetched by the relay with a 10 second timeout and an 8 MiB cap.
  A failed fetch becomes a text note. Check outbound access to the image host.
- Audio input has no upstream equivalent and is always replaced with a note.

## Collecting a useful bug report

Include:

1. The `RELAY_DUMP` line for the failing request (no secrets in it).
2. The upstream status and error body (the relay logs the first 240 characters).
3. `node --version`, relay version from `/_health`, and the client name.
4. Whether the same payload works against the upstream with `curl`.
