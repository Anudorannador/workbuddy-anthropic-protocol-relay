# Contributing

## Ground rules

1. **Never commit credentials.** `config/models.json`, `.env`, and `*.local.json`
   are git-ignored. If you need a key to reproduce something, load it from an
   environment variable in your shell.
2. **No runtime dependencies.** The relay uses `node:` built-ins only. Please
   keep it that way; it is what makes upgrades a restart.
3. **Translation changes need tests.** Any new field mapping must come with a
   case in `test/translate-request.test.mjs` or
   `test/translate-response.test.mjs`.
4. **Update the mapping table.** `docs/protocol-mapping.md` is the reference; a
   behaviour change that is not documented there is considered incomplete.

## Development flow

```bash
git switch -c feat/short-description
npm test
npm start            # manual smoke test on http://127.0.0.1:8787
```

Send a minimal streamed request:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "x-api-key: $UPSTREAM_KEY" \
  -d '{"model":"claude-haiku-5-5-1m-high","stream":true,
       "messages":[{"role":"user","content":"say OK"}]}'
```

## Style

- ES modules, tabs for indentation, double quotes, semicolons.
- Pure translation logic lives in `src/translate-*.mjs` and must stay free of
  I/O so it can be unit tested without a network.
- The server layer (`src/relay.mjs`) owns sockets, headers, and error envelopes.
- Prefer explicit field lists over spread-copying request bodies: silently
  forwarding an unknown field is what breaks upstream requests.

## Commit messages

Conventional prefixes, imperative mood, one logical change per commit:

```
feat(request): map legacy function_call to tool_choice
fix(stream): emit DONE exactly once when upstream errors mid-stream
docs(mapping): document response_format emulation
test(model-id): cover raw: escape hatch
```

## Pull requests

- Describe the protocol difference being addressed and link the upstream docs.
- State which clients you tested against, if any.
- Keep the CI green; `unit` must pass.
