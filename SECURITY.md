# Security policy

## Threat model

This relay is a **local development and desktop-integration tool**. It is not a
multi-tenant gateway and provides no authentication of its own.

Assume anyone who can reach the listening port can spend your upstream
credentials.

## Defaults that matter

| Control | Behaviour |
| --- | --- |
| Bind address | `127.0.0.1` by default. Do not change it to `0.0.0.0` on an untrusted network. |
| Credential storage | None. The key is read from the inbound request and forwarded; it is never written to disk or logs. |
| Logging | `RELAY_DUMP=1` logs model, counts, and flags only — never message text, tool arguments, or keys. |
| Request size | Capped at 64 MiB (`DEFAULTS.maxBodyBytes`). |
| Outbound image fetch | 10 second timeout, 8 MiB cap, `http`/`https` only. |

## What is logged

With `RELAY_DUMP=1`:

```
claude-haiku-5-5-1m-high -> claude-haiku-5-5 effort=high max=32000 msgs=3(ua u) system=y tools=4 tool_choice=auto stream=true
```

Upstream failures log the status code and the first 240 characters of the error
message. Error bodies from providers may echo part of your prompt; treat logs as
sensitive if that matters to you.

## Secrets checklist for contributors

- Never commit `config/models.json`, `.env`, or any file containing a real key.
  Both patterns are git-ignored.
- Never paste a key into an issue, a test fixture, or a screenshot.
- Use `config/models.example.json` with the literal placeholder
  `<YOUR_UPSTREAM_API_KEY>`.
- If a key was ever committed, rotate it first, then rewrite history. Removing
  the file in a later commit is not sufficient.

## Reporting a vulnerability

Report privately through the GitLab project's **Issues → New issue** with the
`security` label, or contact the maintainer directly. Please do not open a public
issue for an unpatched vulnerability.

Include reproduction steps, the relay version from `/_health`, and the affected
file or endpoint. Acknowledgement is targeted within a few days.

## Supported versions

The latest tagged release receives security fixes. Older releases may be asked
to upgrade.
